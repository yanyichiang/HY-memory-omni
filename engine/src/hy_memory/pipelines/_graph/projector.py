"""写侧：把 VDB 里的 L2_FACT 投影进图，并建立记忆之间的关系边。

## 为什么投影成 `Memory(layer=l2_fact)` 而不是扩展 `VdbRef`

`VdbRef` 只有 `node_id` + `layer`，挂不上 tag 也挂不上 related；而 Kuzu 的 REL TABLE 是
**强类型**的（`TAGGED_WITH` 声明为 `FROM Memory TO Topic`、`RELATED_TO` 为 `FROM Memory
TO Memory`），给 `VdbRef` 加边意味着新增 rel table。投影成 `Memory` 则**零 schema 改动** ——
在 Kuzu 没有 schema 迁移能力（新 DDL 只对全新 DB 生效）的前提下这一点很值钱。

不会和 System 2 撞车：S2 的读写都按 `layer=l6_schema` 过滤。

**投影不写 embedding**：图侧不做向量检索（那是 VDB 的事），而且 Kuzu 带 HNSW 索引的列
CREATE 之后不能 SET，写了就意味着 UPDATE 时必须删节点重建。

## 边的四个来源

| 类型 | 来源 | 额外成本 |
|---|---|---|
| `co_occurs` | 同一次写入批次内的 facts 两两相连 | 0（纯本地） |
| `semantic_neighbor` | reconcile 候选池里分数 ≥ 阈值、且未被 merge/supersede 的候选 | 0（池子已在内存里） |
| `causes` / `elaborates` / `contrasts` / `same_series` | reconcile 输出的 `related` 字段（LLM 标注） | 仅输出 token |
| `TAGGED_WITH` → Topic | 每条 fact 已有的 tags | 1 次 embed / 新 tag |
| `MENTIONS` → Entity | 正文 spaCy NER（BOOST 白名单） | 0 embed（精确名归一） |

关于 `semantic_neighbor`：它零成本，但记录的正是"A 和 B 语义相近"，而这件事向量索引本来
就知道 —— 所以它对召回的增量很小，价值主要在用法 A（识别"这是一个连贯的簇"）。
真正带来新信息的是 `co_occurs`（共现与相似度正交）和 LLM 标注的 `causes` / `contrasts`
（两端余弦往往很低，向量检索永远发现不了）。详见 `docs/pro_graph_design.md` §3.4。
"""

import logging
from typing import Any, Dict, List, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

# 确定性边
RELATION_CO_OCCURS = "co_occurs"
RELATION_SEMANTIC_NEIGHBOR = "semantic_neighbor"
RELATION_TEMPORAL_NEXT = "temporal_next"  # 有向，走独立的 TEMPORAL_NEXT 边表

# LLM 可标注的关系类型（词表刻意保持小：弱模型 + 大本体 = 垃圾）
# `same_series` is deliberately not `same_event`: it links independent dated
# occurrences of one concrete activity/event type while preserving separate L2s.
# The reader may assemble these references into a query-time timeline without
# copying their bodies into another stored memory.
LLM_RELATION_TYPES = ("causes", "elaborates", "contrasts", "same_series")

def _co_occurs_weight(batch_size: int) -> float:
    """co_occurs 边权按批大小归一化：批越大，单条共现关系越不具区分度。

    一批 2-3 条（最常见）几乎必然真的相关 → 给满权；一批 9 条则每条只 0.25。
    这比统一压低先验好 —— 跨话题共现本身是**信号**（"去公园/骑车/吃饭"一起写下来，
    三者向量互不相似但关联真实），不该因为大批次里有噪声就把小批次也一起贬值。
    """
    n = max(2, int(batch_size))
    return min(1.0, 2.0 / (n - 1))


def _pairs(items: Sequence[str]) -> List[Tuple[str, str]]:
    """两两组合（无序、不含自环）。"""
    out: List[Tuple[str, str]] = []
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            if items[i] != items[j]:
                out.append((items[i], items[j]))
    return out


async def project_memories_to_graph(
    *,
    graph_store,
    embed_service,
    nodes: List[Any],
    vector_store=None,
    related_by_node: Optional[Dict[str, List[Dict[str, Any]]]] = None,
    neighbors_by_node: Optional[Dict[str, List[Tuple[str, float]]]] = None,
    edge_min_score: float = 0.55,
    co_occurs_max_batch: int = 8,
    temporal_spine: bool = False,
    temporal_spine_bulk: bool = False,
    hierarchy_topic_write: bool = False,
) -> Dict[str, int]:
    """把本次写入的 MemoryNode 投影进图并建边。

    Args:
        nodes: 本次落库的 MemoryNode 列表（调用方应只传 L2_FACT）
        related_by_node: {node_id: [{"target_id", "relation_type"}, ...]}
            来自 reconcile 输出的 LLM 标注关系
        neighbors_by_node: {node_id: [(candidate_node_id, score), ...]}
            来自 reconcile 候选池 → `semantic_neighbor` 边
        edge_min_score: `semantic_neighbor` 的建边阈值
        co_occurs_max_batch: 批内 facts 超过该数量就不建 co_occurs（避免 O(n²) 爆炸）
        vector_store: 建时序脊时用来取事件时间 memory_at（图里没有该字段）
        temporal_spine: 是否建 Topic 内的 TEMPORAL_NEXT 有向链

    Returns:
        统计 dict（nodes / tags / co_occurs / semantic / typed / errors）
    """
    stats = {
        "nodes": 0, "tags": 0, "entities": 0, "co_occurs": 0, "semantic": 0,
        "typed": 0, "temporal": 0, "errors": 0,
        "hierarchy_paths": 0, "hierarchy_nodes": 0,
    }
    if graph_store is None or not nodes:
        return stats

    node_ids: List[str] = []
    topics_by_node: Dict[str, List[str]] = {}
    tag_assignments: List[Tuple[str, str, str]] = []
    entity_assignments: List[Tuple[str, List[Tuple[str, str]], str]] = []
    batch_topic_tags = bool(
        getattr(graph_store, "_supports_batch_topic_tags", False)
        and callable(getattr(graph_store, "add_topic_tags_batch", None))
    )
    hierarchy_scopes = set()

    # 正文 NER → Entity（与 Topic 并列；PERSON 等已在 BOOST 白名单外）
    try:
        from .._retrieval.ner import extract_entities
    except Exception:
        extract_entities = None  # type: ignore
    _MAX_ENTITIES_PER_MEM = 8

    # ── 1. 节点投影 + TAGGED_WITH + MENTIONS ──
    projectable_nodes = [node for node in nodes if getattr(node, "node_id", "")]
    batch_memory_nodes = bool(
        getattr(graph_store, "_supports_batch_memory_nodes", False)
        and callable(getattr(graph_store, "upsert_memory_nodes_batch", None))
    )
    if batch_memory_nodes:
        try:
            node_ids = list(await graph_store.upsert_memory_nodes_batch(
                projectable_nodes,
            ))
            if len(node_ids) != len(projectable_nodes):
                raise RuntimeError(
                    "batch memory projection returned "
                    f"{len(node_ids)}/{len(projectable_nodes)} node ids"
                )
            stats["nodes"] = len(node_ids)
        except Exception as e:
            logger.debug("[graph] batch memory projection failed; falling back: %s", e)
            node_ids = await _upsert_nodes_individually(
                graph_store, projectable_nodes, stats,
            )
    else:
        node_ids = await _upsert_nodes_individually(
            graph_store, projectable_nodes, stats,
        )
    projected_ids = set(node_ids)

    for node in projectable_nodes:
        nid = getattr(node, "node_id", "")
        if nid not in projected_ids:
            continue

        scope_key = node.get_topic_scope_key()

        # Explicit hierarchy is separate from legacy flat tags.  A memory is
        # attached only to each path's most-specific leaf; parents are reached
        # through SUBTOPIC_OF.  This avoids turning a broad node such as "sport"
        # into an unconditional expansion bucket.
        if hierarchy_topic_write and hasattr(graph_store, "add_topic_path"):
            custom = getattr(node, "custom", None) or {}
            from ...structure import topic_assignments_from_custom
            assignments = topic_assignments_from_custom(custom)
            try:
                if hasattr(graph_store, "clear_hierarchy_memberships"):
                    await graph_store.clear_hierarchy_memberships(nid)
                hierarchy_scopes.add(scope_key)
                for assignment in assignments:
                    path = assignment["path"]
                    subject = assignment["subject"]
                    try:
                        topic_ids = await graph_store.add_topic_path(
                            nid, path, scope_key, subject,
                            node_types=assignment.get("node_types"),
                            role=assignment.get("role") or "participant",
                            embed_service=embed_service,
                        )
                    except TypeError:
                        # Third-party stores may still implement the pre-typed
                        # optional API. Keep the feature backward compatible.
                        topic_ids = await graph_store.add_topic_path(
                            nid, path, scope_key, subject,
                            embed_service=embed_service,
                        )
                    if topic_ids:
                        stats["hierarchy_paths"] += 1
                        stats["hierarchy_nodes"] += len(topic_ids)
            except Exception as e:
                stats["errors"] += 1
                logger.debug(f"[graph] hierarchy projection({nid}) failed: {e}")

        for tag in (getattr(node, "tags", None) or []):
            if not tag:
                continue
            if batch_topic_tags:
                tag_assignments.append((nid, str(tag), scope_key))
                continue
            try:
                # Topic 的隔离键**不含 session**（见 MemoryNode.get_topic_scope_key）：
                # 主题是跨会话累积的概念。用带 session 的 isolation_key 会让同名 tag
                # 在每个 session 各建一个互不相识的 Topic，连带饿死时序脊和
                # topic summary。
                _tid = await graph_store.add_topic_tag(
                    nid, str(tag), scope_key,
                    embed_service=embed_service,
                )
                if _tid:
                    topics_by_node.setdefault(nid, []).append(_tid)
                stats["tags"] += 1
            except TypeError:
                # 后端 add_topic_tag 不接 embed_service（老签名）→ 退化为不归一化
                try:
                    await graph_store.add_topic_tag(
                        nid, str(tag), scope_key,
                    )
                    stats["tags"] += 1
                except Exception as e:
                    stats["errors"] += 1
                    logger.debug(f"[graph] add_topic_tag({nid}, {tag}) failed: {e}")
            except Exception as e:
                stats["errors"] += 1
                logger.debug(f"[graph] add_topic_tag({nid}, {tag}) failed: {e}")

        # 正文 NER → Entity + MENTIONS（UPDATE 时先清再建，避免残留）
        if extract_entities is not None and hasattr(graph_store, "add_entity_mention"):
            try:
                content = getattr(node, "content", None) or ""
                ents = extract_entities(content, for_boost=True) if content else []
                seen_keys = set()
                clean_entities: List[Tuple[str, str]] = []
                for span, lab in ents[:_MAX_ENTITIES_PER_MEM]:
                    key = (str(span).strip().casefold(), (lab or "").upper())
                    if not key[0] or key in seen_keys:
                        continue
                    seen_keys.add(key)
                    clean_entities.append((str(span).strip(), str(lab)))
                entity_assignments.append((nid, clean_entities, scope_key))
            except Exception as e:
                stats["errors"] += 1
                logger.debug(f"[graph] entity mentions({nid}) failed: {e}")

    if tag_assignments:
        try:
            tagged = await graph_store.add_topic_tags_batch(
                tag_assignments,
                embed_service=embed_service,
            )
            for nid, topic_id in tagged:
                topics_by_node.setdefault(nid, []).append(topic_id)
            stats["tags"] += len(tagged)
            stats["errors"] += max(0, len(tag_assignments) - len(tagged))
        except Exception as e:
            stats["errors"] += len(tag_assignments)
            logger.debug("[graph] batch topic projection failed: %s", e)

    if entity_assignments:
        batch_entity_mentions = bool(
            getattr(graph_store, "_supports_batch_entity_mentions", False)
            and callable(getattr(graph_store, "replace_entity_mentions_batch", None))
        )
        if batch_entity_mentions:
            try:
                mentioned = await graph_store.replace_entity_mentions_batch(
                    entity_assignments,
                )
                stats["entities"] += len(mentioned)
            except Exception as e:
                logger.debug(
                    "[graph] batch entity projection failed; falling back: %s", e,
                )
                await _replace_entity_mentions_individually(
                    graph_store, entity_assignments, stats,
                )
        else:
            await _replace_entity_mentions_individually(
                graph_store, entity_assignments, stats,
            )

    if not node_ids:
        return stats

    if hierarchy_topic_write and hasattr(graph_store, "prune_hierarchy_topics"):
        for scope_key in hierarchy_scopes:
            try:
                await graph_store.prune_hierarchy_topics(scope_key)
            except Exception as e:
                stats["errors"] += 1
                logger.debug(f"[graph] hierarchy prune({scope_key}) failed: {e}")

    # ── 2. co_occurs：批内两两相连 ──
    # 同一轮对话里一起被说出来的事实之间有情节性关联，这是多跳里最有用的一类
    # （"朋友推荐的那家餐厅" —— 朋友和餐厅共现于同一批）。
    pending_edges: List[Tuple[str, str, str, float, str]] = []
    if len(node_ids) > 1:
        if len(node_ids) <= co_occurs_max_batch:
            for src, tgt in _pairs(node_ids):
                _w = _co_occurs_weight(len(node_ids))
                pending_edges.append(
                    (src, tgt, RELATION_CO_OCCURS, _w, "co_occurs")
                )
        else:
            logger.debug(
                f"[graph] batch of {len(node_ids)} facts exceeds "
                f"co_occurs_max_batch={co_occurs_max_batch}, skipping co_occurs edges"
            )

    # ── 3. semantic_neighbor：把 reconcile 候选池里被丢掉的相似度存下来 ──
    for nid, neighbors in (neighbors_by_node or {}).items():
        if nid not in node_ids:
            continue
        for cand_id, score in neighbors or []:
            if not cand_id or cand_id == nid or score < edge_min_score:
                continue
            pending_edges.append((
                nid, cand_id, RELATION_SEMANTIC_NEIGHBOR, float(score), "semantic",
            ))

    # ── 4. LLM 标注的 typed 关系 ──
    for nid, rels in (related_by_node or {}).items():
        if nid not in node_ids:
            continue
        for rel in rels or []:
            target = (rel or {}).get("target_id")
            rtype = (rel or {}).get("relation_type")
            if not target or target == nid or rtype not in LLM_RELATION_TYPES:
                continue
            pending_edges.append((nid, target, rtype, 1.0, "typed"))

    await _add_edges(graph_store, pending_edges, stats)

    # ── 5. 时序脊 ──
    # 增量写入和全量回填的前驱来源不同，见各自的 docstring
    if temporal_spine_bulk:
        stats["temporal"] += await _build_temporal_spine_bulk(
            graph_store, nodes, node_ids, topics_by_node, stats,
        )
    elif temporal_spine:
        stats["temporal"] += await _build_temporal_spine(
            graph_store, vector_store, nodes, node_ids, topics_by_node, stats,
        )

    logger.info(
        f"[graph] projected {stats['nodes']} nodes, {stats['tags']} tags, "
        f"entities={stats.get('entities', 0)}, "
        f"hierarchy_paths={stats.get('hierarchy_paths', 0)} "
        f"hierarchy_nodes={stats.get('hierarchy_nodes', 0)} "
        f"edges: co_occurs={stats['co_occurs']} semantic={stats['semantic']} "
        f"typed={stats['typed']} temporal={stats['temporal']} "
        f"errors={stats['errors']}"
    )
    return stats


async def _upsert_nodes_individually(
    graph_store, nodes: List[Any], stats: Dict[str, int],
) -> List[str]:
    """Original per-node projection path, also used after a batch failure."""
    node_ids: List[str] = []
    for node in nodes:
        nid = getattr(node, "node_id", "")
        try:
            # 不写 embedding：图侧不做向量检索，且 Kuzu 索引列 CREATE 后不能 SET
            await graph_store.upsert_memory_node(node)
            node_ids.append(nid)
            stats["nodes"] += 1
        except Exception as e:
            stats["errors"] += 1
            logger.debug(f"[graph] upsert_memory_node({nid}) failed: {e}")
    return node_ids


async def _replace_entity_mentions_individually(
    graph_store,
    assignments: List[Tuple[str, List[Tuple[str, str]], str]],
    stats: Dict[str, int],
) -> None:
    """Original clear-then-add behavior, preserving its per-memory boundary."""
    for nid, entities, scope_key in assignments:
        try:
            if hasattr(graph_store, "clear_entity_mentions"):
                await graph_store.clear_entity_mentions(nid)
            for name, label in entities:
                eid = await graph_store.add_entity_mention(
                    nid, name, label, scope_key,
                )
                if eid:
                    stats["entities"] += 1
        except Exception as e:
            stats["errors"] += 1
            logger.debug(f"[graph] entity mentions({nid}) failed: {e}")


async def resolve_memory_times(
    vector_store, node_ids: List[str],
) -> Dict[str, float]:
    """回 VDB 取这些节点的**事件时间** `memory_at`（unix 秒），缺失回退 `gmt_created`。

    为什么必须回 VDB：图里的 `Memory` 表只有 `created_at`（落库时间），**没有
    `memory_at`**，而 Kuzu 新增列对已有 DB 不生效。所以事件时间一律以 VDB 为准 ——
    这也和 `created_after` 按事件时间过滤的口径一致
    （见 `data/vector_store_base.node_effective_time`）。
    """
    if vector_store is None or not node_ids:
        return {}
    try:
        nodes = await vector_store.get_by_ids(list(node_ids))
    except Exception as e:
        logger.debug(f"[graph] resolve_memory_times failed: {e}")
        return {}
    out: Dict[str, float] = {}
    for n in (nodes or []):
        if n is None:
            continue
        t = getattr(n, "memory_at", None) or getattr(n, "gmt_created", None)
        if t is None:
            continue
        try:
            out[n.node_id] = t.timestamp()
        except (AttributeError, TypeError, OSError):
            continue
    return out


async def _build_temporal_spine_bulk(
    graph_store,
    nodes: List[Any],
    node_ids: List[str],
    topics_by_node: Dict[str, List[str]],
    stats: Dict[str, int],
) -> int:
    """全量回填用：整批按 Topic 分组、按事件时间排序，逐对相连成链。

    和增量版（`_build_temporal_spine`）的区别在**前驱从哪来**：
    - 增量写入：本批只有一两条，前驱在库里 → 要查图 + 回 VDB 取时间，
      且批内两两关系由 `co_occurs` 表达，不能当成时序前驱；
    - 全量回填：整批就是全部历史，前驱就在批内 → 直接排序连边，一次 I/O 都不用查。

    如果回填走增量版，会因为"排除批内节点"而找不到任何前驱、一条边都建不出来。
    """
    by_topic: Dict[str, List[Tuple[float, str]]] = {}
    new_ids = set(node_ids)
    for node in nodes:
        nid = getattr(node, "node_id", "")
        if nid not in new_ids:
            continue
        memory_at = getattr(node, "memory_at", None) or getattr(node, "gmt_created", None)
        if memory_at is None:
            continue
        try:
            ts = memory_at.timestamp()
        except (AttributeError, TypeError, OSError):
            continue
        for tid in topics_by_node.get(nid) or []:
            by_topic.setdefault(tid, []).append((ts, nid))

    edges: List[Tuple[str, str, str]] = []
    for tid, items in by_topic.items():
        items.sort()
        for (_t_prev, prev_id), (_t_next, next_id) in zip(items, items[1:]):
            edges.append((prev_id, next_id, tid))
    return await _add_temporal_edges(graph_store, edges, stats)


async def _build_temporal_spine(
    graph_store,
    vector_store,
    nodes: List[Any],
    node_ids: List[str],
    topics_by_node: Dict[str, List[str]],
    stats: Dict[str, int],
    max_topic_members: int = 200,
) -> int:
    """把每条新记忆接到同 Topic 下事件时间更早的最近一条之后。

    实现分两步：图给出同 Topic 的成员 id，VDB 给出这些成员的 `memory_at`
    （图里没有事件时间，见 `resolve_memory_times`），前驱在 Python 侧选。

    ⚠️ 已知局限：只往回接（prev → new），**不修复乱序插入**。记忆基本按时间顺序写入，
    所以链多数正确；但如果补写了一条落在链中间的旧记忆，它只会接到自己的前驱后面，
    原本的 prev → next 边不会被拆开，链会出现分叉。
    时序问答除了走脊，读侧还有按 memory_at 排序兜底，所以这个不完美是可接受的。
    """
    edges: List[Tuple[str, str, str]] = []
    new_ids = set(node_ids)
    for node in nodes:
        nid = getattr(node, "node_id", "")
        if nid not in new_ids:
            continue
        topic_ids = topics_by_node.get(nid) or []
        memory_at = getattr(node, "memory_at", None)
        if memory_at is None:
            continue
        if not topic_ids:
            continue
        try:
            ts = memory_at.timestamp()
            # 同 Topic 的候选成员（排除自己和本批其他节点 —— 批内关系由 co_occurs 表达）
            members: List[str] = []
            for tid in topic_ids:
                for m in await graph_store.get_topic_memories(
                    tid, limit=max_topic_members,
                ):
                    mid = m.get("node_id")
                    if mid and mid != nid and mid not in new_ids:
                        members.append(mid)
            if not members:
                continue

            times = await resolve_memory_times(vector_store, members)
            prev_id, prev_ts = None, None
            for mid, mts in times.items():
                if mts < ts and (prev_ts is None or mts > prev_ts):
                    prev_id, prev_ts = mid, mts
            if prev_id:
                edges.append((prev_id, nid, topic_ids[0]))
        except Exception as e:
            stats["errors"] += 1
            logger.debug(f"[graph] temporal spine for {nid} failed: {e}")
    return await _add_temporal_edges(graph_store, edges, stats)


async def _add_temporal_edges(
    graph_store,
    edges: List[Tuple[str, str, str]],
    stats: Dict[str, int],
) -> int:
    if not edges:
        return 0
    batch_temporal = bool(
        getattr(graph_store, "_supports_batch_temporal_edges", False)
        and callable(getattr(graph_store, "add_temporal_edges_batch", None))
    )
    if batch_temporal:
        try:
            results = await graph_store.add_temporal_edges_batch(edges)
            if len(results) != len(edges):
                raise RuntimeError(
                    f"batch temporal projection returned {len(results)}/{len(edges)} results"
                )
            return sum(bool(ok) for ok in results)
        except Exception as e:
            logger.debug("[graph] batch temporal edges failed; falling back: %s", e)

    count = 0
    for prev_id, next_id, topic_id in edges:
        try:
            if await graph_store.add_temporal_edge(prev_id, next_id, topic_id):
                count += 1
        except Exception as e:
            stats["errors"] += 1
            logger.debug(f"[graph] temporal spine {prev_id}->{next_id} failed: {e}")
    return count


async def _add_edge(
    graph_store, src: str, tgt: str, relation_type: str, weight: float, stats: Dict[str, int],
) -> bool:
    try:
        ok = await graph_store.add_edge(
            src, tgt, "RELATED_TO",
            {"relation_type": relation_type, "weight": float(weight)},
        )
        return bool(ok)
    except Exception as e:
        stats["errors"] += 1
        logger.debug(f"[graph] add_edge({src}->{tgt}, {relation_type}) failed: {e}")
        return False


async def _add_edges(
    graph_store,
    edges: List[Tuple[str, str, str, float, str]],
    stats: Dict[str, int],
) -> None:
    if not edges:
        return
    batch_related = bool(
        getattr(graph_store, "_supports_batch_related_edges", False)
        and callable(getattr(graph_store, "add_edges_batch", None))
    )
    if batch_related:
        payload = [
            (src, tgt, "RELATED_TO", {
                "relation_type": relation_type, "weight": float(weight),
            })
            for src, tgt, relation_type, weight, _counter in edges
        ]
        try:
            results = await graph_store.add_edges_batch(payload)
            if len(results) != len(edges):
                raise RuntimeError(
                    f"batch related projection returned {len(results)}/{len(edges)} results"
                )
            for ok, edge in zip(results, edges):
                if ok:
                    stats[edge[4]] += 1
            return
        except Exception as e:
            logger.debug("[graph] batch related edges failed; falling back: %s", e)

    for src, tgt, relation_type, weight, counter in edges:
        if await _add_edge(graph_store, src, tgt, relation_type, weight, stats):
            stats[counter] += 1


# ================================================================
# 同步契约：VDB 侧状态变化必须反映到图，否则图会腐烂
# ================================================================
#
# | VDB 动作 | 图侧 |
# |---|---|
# | ADD               | project_memories_to_graph（建节点 + 边） |
# | UPDATE（原地）     | project_memories_to_graph（upsert 覆盖 content/tags） |
# | SUPERSEDE         | 新节点入图；旧节点标 superseded，**边保留**（历史仍可走） |
# | dedup → SHADOW    | 标 shadow，读侧扩展时过滤掉 |
# | delete / purge    | graph_store.delete_node / delete_by_metadata（已有实现） |
#
# 读侧必须过滤 status，否则被判重删掉的记忆会从图里绕回来。

async def sync_graph_on_supersede(graph_store, old_node_ids: List[str]) -> int:
    """SUPERSEDE：把旧节点标记为 superseded（边保留，历史链仍可遍历）。"""
    return await _mark_status(graph_store, old_node_ids, "superseded")


async def sync_graph_on_shadow(graph_store, node_ids: List[str]) -> int:
    """判重/逻辑删除：标记为 shadow，读侧一律过滤。"""
    return await _mark_status(graph_store, node_ids, "shadow")


async def _mark_status(graph_store, node_ids: List[str], status: str) -> int:
    if graph_store is None or not node_ids:
        return 0
    n = 0
    for nid in node_ids:
        if not nid:
            continue
        try:
            if await graph_store.update_node(nid, {"status": status}):
                n += 1
        except Exception as e:
            logger.debug(f"[graph] mark {nid} status={status} failed: {e}")
    return n
