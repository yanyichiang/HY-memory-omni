"""Topic-scoped summary：按**主题**切摘要，而不是按时间窗切。

固定窗口摘要按时间攒 buffer，所以产出只能是
"这段对话说了啥" —— 检索价值有限，因为一个时间窗里的内容通常横跨多个不相关话题。

有了 Topic 图之后可以换个切法：**某个 Topic 下的记忆累积到阈值就总结一次**，
产出"关于你的工作，我知道这些"。这才是有检索价值的摘要粒度。

状态存在摘要节点自己的 `custom` 里，不额外建表：
    custom = {
        "summary_kind": "topic",      # 与其他摘要类型区分
        "topic_id": ..., "topic_name": ...,
        "covered_count": N,           # 本次总结覆盖了该 Topic 下多少条记忆
        "source_memory_ids": [...],
    }
下次判断是否要重新总结时，回读该 Topic 最新一条摘要的 `covered_count`，
和当前 Topic 度数比较即可。

旧摘要置 SHADOW，不进 supersedes 演化链。
"""

import asyncio
import json
import logging
import threading
import weakref
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

SUMMARY_KIND_TOPIC = "topic"


_TOPIC_LOCKS_GUARD = threading.Lock()
_TOPIC_LOCKS_BY_LOOP = weakref.WeakKeyDictionary()


def _graph_store_scope(graph_store) -> tuple:
    """Build a process-local stable scope for graph-store instances."""
    if hasattr(graph_store, "_db_path"):
        return (type(graph_store).__qualname__, str(graph_store._db_path))
    if hasattr(graph_store, "_url"):
        return (
            type(graph_store).__qualname__,
            str(graph_store._url),
            str(getattr(graph_store, "_database", "")),
        )
    return (type(graph_store).__qualname__, id(graph_store))


def _topic_lock(graph_store, isolation_key: str, topic_id: str) -> asyncio.Lock:
    """Return an event-loop-local lock for one graph scope and Topic."""
    loop = asyncio.get_running_loop()
    key = (_graph_store_scope(graph_store), isolation_key, topic_id)
    with _TOPIC_LOCKS_GUARD:
        locks = _TOPIC_LOCKS_BY_LOOP.get(loop)
        if locks is None:
            locks = weakref.WeakValueDictionary()
            _TOPIC_LOCKS_BY_LOOP[loop] = locks
        lock = locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            locks[key] = lock
        return lock


TOPIC_SUMMARY_PROMPT = """You are summarizing everything known about ONE topic.

## Topic

{topic_name}

## Memories under this topic (oldest → newest)

{memories}

---

Write a single dense summary of what is known about the user with respect to this
topic.

Rules:

* 2–4 sentences, third person, starting with "The user ..." (or the named person
  if the memories are about someone else).
* Cover the topic as a whole — state the current situation, and mention how it
  developed only when the change matters.
* Preserve concrete details: names, places, numbers, dates.
* Do NOT invent anything that is not in the memories.
* Do NOT enumerate the memories one by one; synthesize them.
* Output language must match the language of the memories.

Return ONLY the summary text, no preamble, no JSON, no quotes."""


TOPIC_SUMMARY_PROMPT_ZH = """你在为**一个主题**总结已知的全部信息。

## 主题

{topic_name}

## 该主题下的记忆（时间正序）

{memories}

---

写一段关于用户在这个主题上的高密度摘要。

要求：

* 2–4 句，第三人称，以"用户…"开头（若记忆讲的是别人，则以那个人的名字开头）。
* 覆盖整个主题 —— 说明当前状况；只在变化本身重要时才提它是怎么演变过来的。
* 保留具体细节：人名、地点、数字、日期。
* 绝不编造记忆里没有的内容。
* 不要逐条罗列记忆，要综合成一段。
* 输出语言与记忆的语言一致。

只返回摘要正文，不要任何前言、不要 JSON、不要引号。"""


async def find_latest_topic_summary(
    *, vector_store, user_id: str, agent_id: Optional[str], topic_id: str,
) -> Optional[Any]:
    """找该 Topic 最新的一条 topic summary 节点（没有则 None）。

    VDB 的 filter 表达不了 `custom` 里的字段，所以拉该 user 的 L3 在 Python 侧过滤。
    L3 的量级很小（每个 Topic 至多一条 active），这个代价可以接受。
    """
    from ...models.memory import MemoryLayer, MemoryStatus

    try:
        nodes = await vector_store.list_by_user(
            user_id=user_id,
            agent_id=agent_id,
            layers=[MemoryLayer.L3_SUMMARY],
            status_filter=[MemoryStatus.ACTIVE],
            limit=500,
            with_vectors=False,
        )
    except Exception as e:
        logger.debug(f"[topic-summary] list L3 failed: {e}")
        return None

    matched = []
    for n in (nodes or []):
        custom = getattr(n, "custom", None) or {}
        if isinstance(custom, str):
            try:
                custom = json.loads(custom)
            except Exception:
                continue
        if custom.get("summary_kind") != SUMMARY_KIND_TOPIC:
            continue
        if custom.get("topic_id") != topic_id:
            continue
        matched.append(n)

    if not matched:
        return None
    from datetime import datetime as _dt
    matched.sort(key=lambda n: n.gmt_created or _dt.min)
    return matched[-1]


def covered_count_of(node: Any) -> int:
    custom = getattr(node, "custom", None) or {}
    if isinstance(custom, str):
        try:
            custom = json.loads(custom)
        except Exception:
            return 0
    try:
        return int(custom.get("covered_count") or 0)
    except (TypeError, ValueError):
        return 0


async def maybe_summarize_topics(
    *,
    graph_store,
    vector_store,
    embed_service,
    llm_provider,
    user_id: str,
    agent_id: Optional[str],
    session_id: str,
    isolation_key: str,
    touched_topic_ids: List[str],
    min_memories: int = 5,
    step: int = 5,
    max_memories: int = 60,
    max_concurrency: int = 3,
    temperature: Optional[float] = None,
    trace=None,
) -> Dict[str, Any]:
    """对本次写入触达的 Topic，按需有界并发生成 / 刷新 summary。

    触发条件：Topic 下 active 记忆数 ≥ `min_memories`，且比上次总结时多了 ≥ `step` 条。
    这样既不会每写一条就重算（贵），也不会一直不更新（陈旧）。

    Returns:
        {"checked", "summarized", "skipped", "errors", "topics": [...]}
    """
    stats: Dict[str, Any] = {
        "checked": 0, "summarized": 0, "skipped": 0, "errors": 0, "topics": [],
    }
    if graph_store is None or llm_provider is None or not touched_topic_ids:
        return stats

    topic_names = {}
    try:
        from ...models.memory import MemoryNode

        # Topic 建在 user::agent 上（不含 session），查询必须用同一个键
        for t in await graph_store.get_all_topics(
            MemoryNode.topic_scope_of(isolation_key)
        ):
            topic_names[t.get("topic_id")] = t.get("name") or ""
    except Exception as e:
        logger.debug(f"[topic-summary] get_all_topics failed: {e}")

    topic_ids = [topic_id for topic_id in dict.fromkeys(touched_topic_ids) if topic_id]
    stats["checked"] = len(topic_ids)
    semaphore = asyncio.Semaphore(max(1, min(16, int(max_concurrency or 1))))

    async def summarize_one(topic_id: str):
        # Lock before the semaphore: duplicate work on one Topic waits without
        # consuming capacity intended for independent Topics.
        async with _topic_lock(graph_store, isolation_key, topic_id):
            async with semaphore:
                try:
                    # Re-read after acquiring the Topic lock. Another graph task
                    # may have refreshed this Topic while this task was waiting.
                    mems = await graph_store.get_topic_memories(
                        topic_id, limit=max_memories
                    )
                    if len(mems) < min_memories:
                        return "skipped", None

                    prev = await find_latest_topic_summary(
                        vector_store=vector_store, user_id=user_id,
                        agent_id=agent_id, topic_id=topic_id,
                    )
                    prev_covered = covered_count_of(prev) if prev is not None else 0
                    if len(mems) - prev_covered < step:
                        return "skipped", None

                    from datetime import datetime as _dt

                    _t0 = _dt.now()
                    summary, _prompt, _tokens = await _generate(
                        llm_provider=llm_provider,
                        topic_name=topic_names.get(topic_id) or topic_id,
                        memories=[m.get("content") or "" for m in mems],
                        temperature=temperature,
                    )
                    if trace is not None:
                        await trace(
                            prompt=_prompt,
                            response=summary,
                            parsed={
                                "topic_id": topic_id,
                                "topic_name": topic_names.get(topic_id) or topic_id,
                                "covered_count": len(mems),
                                "skipped": not summary,
                            },
                            memory_ids=[
                                m.get("node_id") for m in mems if m.get("node_id")
                            ],
                            elapsed_ms=(_dt.now() - _t0).total_seconds() * 1000,
                            tokens=_tokens,
                        )
                    if not summary:
                        return "error", None

                    await _store(
                        vector_store=vector_store,
                        embed_service=embed_service,
                        summary=summary,
                        topic_id=topic_id,
                        topic_name=topic_names.get(topic_id) or "",
                        source_memory_ids=[m["node_id"] for m in mems],
                        covered_count=len(mems),
                        user_id=user_id,
                        agent_id=agent_id,
                        session_id=session_id,
                        prev_node=prev,
                    )
                    return "summarized", {
                        "topic_id": topic_id,
                        "topic_name": topic_names.get(topic_id) or "",
                        "covered": len(mems),
                    }
                except Exception as e:
                    logger.debug(f"[topic-summary] topic {topic_id} failed: {e}")
                    return "error", None

    results = await asyncio.gather(*(summarize_one(topic_id) for topic_id in topic_ids))
    for status, topic in results:
        if status == "summarized":
            stats["summarized"] += 1
            stats["topics"].append(topic)
        elif status == "skipped":
            stats["skipped"] += 1
        else:
            stats["errors"] += 1

    if stats["summarized"]:
        logger.info(
            f"[topic-summary] {stats['summarized']} topic summaries written "
            f"(checked={stats['checked']} skipped={stats['skipped']})"
        )
    return stats


async def _generate(
    *, llm_provider, topic_name: str, memories: List[str],
    temperature: Optional[float] = None,
) -> tuple:
    """返回 (摘要文本, 实际 prompt, token 用量) —— 后两个供埋点，线上要能复盘。"""
    from ...utils.lang_detect import is_chinese

    body = "\n".join(f"- {c}" for c in memories if c)
    if not body:
        return "", "", {}
    tpl = TOPIC_SUMMARY_PROMPT_ZH if is_chinese(body) else TOPIC_SUMMARY_PROMPT
    prompt = tpl.format(topic_name=topic_name, memories=body)
    resp = await llm_provider.complete(
        prompt=prompt,
        max_tokens=400,
        temperature=temperature,
    )
    tokens = {
        "prompt": getattr(resp, "prompt_tokens", 0) or 0,
        "completion": getattr(resp, "completion_tokens", 0) or 0,
        "total": getattr(resp, "total_tokens", 0) or 0,
    }
    text = (getattr(resp, "content", "") or "").strip()
    # LLM 偶尔会包一层引号或 markdown 围栏
    if text.startswith("```"):
        parts = text.split("```")
        text = parts[1] if len(parts) > 1 else text
        text = text.strip()
    return text.strip().strip('"').strip("'").strip(), prompt, tokens


async def _store(
    *,
    vector_store,
    embed_service,
    summary: str,
    topic_id: str,
    topic_name: str,
    source_memory_ids: List[str],
    covered_count: int,
    user_id: str,
    agent_id: Optional[str],
    session_id: str,
    prev_node: Optional[Any],
) -> str:
    from ...models.memory import (
        MemoryLayer, MemoryNode, MemoryStatus, SourceType,
    )
    from datetime import datetime

    embedding = await embed_service.embed_queued(summary)
    from ...utils.source_filter import merge_sources
    source_nodes = await vector_store.get_by_ids(source_memory_ids)
    node = MemoryNode(
        user_id=user_id,
        agent_id=agent_id or "default_agent",
        session_id=session_id or "default_session",
        source=merge_sources(
            getattr(source_node, "source", None) for source_node in source_nodes
        ),
        layer=MemoryLayer.L3_SUMMARY,
        content=summary,
        embedding=embedding,
        memory_at=datetime.now(),
        source_type=SourceType.INFERRED,
        status=MemoryStatus.ACTIVE,
        is_latest=True,
        tags=[topic_name] if topic_name else [],
        custom={
            "summary_kind": SUMMARY_KIND_TOPIC,
            "topic_id": topic_id,
            "topic_name": topic_name,
            "covered_count": covered_count,
            "source_memory_ids": list(source_memory_ids),
            # 仅作审计：topic summary 按设计无 chain，不进 supersedes 演化链
            "supersedes_summary_id": getattr(prev_node, "node_id", "") or "",
        },
    )
    nid = await vector_store.upsert(node)

    # 旧摘要置 SHADOW，避免同一 Topic 多条摘要重复召回
    if prev_node is not None and getattr(prev_node, "node_id", ""):
        try:
            await vector_store.update_payload(
                prev_node.node_id,
                {"status": MemoryStatus.SHADOW.value, "is_latest": False},
            )
        except Exception as e:
            logger.debug(f"[topic-summary] shadow prev summary failed: {e}")
    return nid
