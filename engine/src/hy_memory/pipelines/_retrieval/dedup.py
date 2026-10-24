# -*- coding: utf-8 -*-
"""
记忆去重核心逻辑（纯函数，无 I/O，可单测）。

线上 L2_FACT / L4_IDENTITY 经常出现重复（extractor 抽重 / reconcile 漏合并）。
本模块用 embedding cosine 相似度（> 阈值，默认 0.95）识别重复组，并按确定性
规则决定保留/删除，供 extractor / reconcile / search 三条链路共用。

判重范围（调用方负责传入）：
  只在「普通 memory + 链头（is_latest=True）」之间判重；链身（SUPERSEDED，
  is_latest=False）不参与——它们是历史，由其链头代表。

隔离维度按 **owner** 决定（见 group_items_by_owner）：
  owner='user'（含空值）→ 按 (user_id,) 分批，**跨 agent 合并**：同一用户在不同
    agent 下说的同一件事是同一条事实。
  owner='agent'         → 按 (user_id, agent_id) 分批，**按 agent 隔离**：不同
    assistant 说过的话是独立记忆。

删除决策（每个重复组，确定性，非随机）：
  - 全是非链节点          → 保留 gmt_created 最早的一条，删其余
  - 1 个链头 + 其余非链   → 保留链头，删非链
  - n 个链头(n≥2) + 非链  → 保留 gmt_created 最早的链头，删其余链头 + 非链；
                            被删链头**连带删除其整条 SUPERSEDED 历史链**
                            （chain_node_ids 由调用方用 _trace_full_chain 预先补全）

"删除"是**逻辑删除**：置 status=SHADOW + is_latest=False（不被检索召回），
而非硬删，可恢复。见 _shadow_nodes。

相似度计算：把参与节点的向量堆成矩阵一次算 M @ M.T（行先 L2 归一化），
30 条 4096 维约 0.3ms，不调 embedding API、不需预筛。
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

try:
    import numpy as np
except Exception:  # pragma: no cover
    np = None

logger = logging.getLogger(__name__)

DEDUP_LOG_STEP = "DEDUP"

DEFAULT_DEDUP_THRESHOLD = 0.95


def get_dedup_threshold() -> float:
    """去重 cosine 阈值，env MEMORY_DEDUP_THRESHOLD 覆盖，默认 0.95。"""
    try:
        return float(os.environ.get("MEMORY_DEDUP_THRESHOLD", DEFAULT_DEDUP_THRESHOLD))
    except (TypeError, ValueError):
        return DEFAULT_DEDUP_THRESHOLD


@dataclass
class DedupItem:
    """去重输入项（调用方组装）。

    is_chain_head / chain_node_ids 由调用方预先判定/补全：
      - 普通节点：is_chain_head=False, chain_node_ids=[node_id]
      - 链头：    is_chain_head=True,  chain_node_ids=[head, ...SUPERSEDED bodies]
    """
    node_id: str
    embedding: List[float]
    content: str = ""
    is_latest: bool = True
    is_chain_head: bool = False
    gmt_created: Optional[float] = None  # Unix ts；用于确定性保留（越小越早）
    chain_node_ids: List[str] = field(default_factory=list)
    # 分批用（见 group_items_by_owner）：owner 决定隔离维度，user_id/agent_id
    # 决定批次键。三者缺失时由调用方的 default_* 兜底，行为退化为"全部一批"，
    # 与加入分批之前等价。
    owner: Optional[str] = None
    user_id: str = ""
    agent_id: str = ""
    source: str = "default"


def _gmt_key(item: DedupItem) -> float:
    """gmt_created 排序键：缺失视为 +inf（最晚），保证有时间的优先被保留。"""
    return item.gmt_created if item.gmt_created is not None else float("inf")


# owner 归一化：空 owner 一律按 'user' 处理。
#
# owner 字段 2026-06-16（commit a240189）才引入，之前写入的 L2 节点没有该字段；
# 此外 LLM 也可能漏填。extractor/reconcile prompt 的约定都是 "When unsure,
# default to user"，`reconciler.py` 组装 existing_mem_list 时同样用
# `owner or "user"` 兜底 —— 此处沿用同一约定，保持全链路一致。
OWNER_USER = "user"
OWNER_AGENT = "agent"


def _owner_bucket(owner: Optional[str]) -> str:
    """归一化 owner 到 'user' / 'agent' 两个桶；空值/未知值归 'user'。"""
    if not owner:
        return OWNER_USER
    v = str(owner).strip().lower()
    return OWNER_AGENT if v == OWNER_AGENT else OWNER_USER


def group_items_by_owner(
    items: List[DedupItem],
    *,
    default_user_id: str = "",
    default_agent_id: str = "",
) -> List[Dict[str, Any]]:
    """按 owner 语义把候选分成若干互不判重的批次。

    去重的隔离维度应当由 **owner** 决定，而不是无差别地按 agent_id 切分：

      - owner='user'（含空值）：记忆属于**用户**这一侧。同一个用户在 agent_a
        和 agent_b 下说的同一件事是同一条事实，必须放进同一批判重，否则
        "The user is a vegetarian." 会在每个 agent 下各存一份且永远无法合并。
        → 批次键 = (user_id,)，**跨 agent 合并**
      - owner='agent'：记忆是某个 assistant 提供/被要求做的事。agent_a 说过的话
        和 agent_b 说过的话是两条独立记忆，即使语义相近也不应互删。
        → 批次键 = (user_id, agent_id)，**按 agent 隔离**

    L4_IDENTITY 的 owner 恒为空（仅 L2_FACT / L7_INTENTION 写 owner），按上面的
    兜底规则落进 user 桶 —— identity 本就是用户画像，跨 agent 合并是正确语义。

    同时解决审计归属错误：此前调用方只能传一个 user_id/agent_id（取
    `effective_user_ids[0]`），跨 user/跨 agent 检索时 DEDUP log 记的归属是错的。
    分批后每批的 user_id/agent_id 是确定的，日志自然准确。

    Args:
        items: 候选项，需带 user_id / agent_id / owner（缺失则用 default_*）。
        default_user_id / default_agent_id: item 上没有对应字段时的兜底值。

    Returns:
        [{"user_id": ..., "agent_id": ..., "owner": "user"|"agent",
          "items": [DedupItem, ...]}, ...]
        只返回 len(items) >= 2 的批次（单条无从判重）。
    """
    buckets: Dict[tuple, Dict[str, Any]] = {}
    for it in items:
        uid = it.user_id or default_user_id
        aid = it.agent_id or default_agent_id
        from ...utils.source_filter import normalize_source
        source = normalize_source(it.source)
        bucket = _owner_bucket(it.owner)
        # user 桶不带 agent_id → 同一 user 的所有 agent 归一批
        key = (
            (uid, "", OWNER_USER, source)
            if bucket == OWNER_USER else (uid, aid, OWNER_AGENT, source)
        )
        entry = buckets.get(key)
        if entry is None:
            entry = {
                "user_id": uid,
                # user 桶跨 agent，没有单一归属的 agent_id：用调用方给的默认值
                # 落审计日志（代表"本次触发去重的 agent"），不参与分批。
                "agent_id": default_agent_id if bucket == OWNER_USER else aid,
                "owner": bucket,
                "source": source,
                "items": [],
            }
            buckets[key] = entry
        entry["items"].append(it)

    return [b for b in buckets.values() if len(b["items"]) >= 2]


def _pairwise_cosine(vectors: List[List[float]]):
    """行 L2 归一化后 M @ M.T，返回相似度矩阵（numpy）。"""
    M = np.asarray(vectors, dtype=np.float32)
    norms = np.linalg.norm(M, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    M = M / norms
    return M @ M.T


def _union_find_groups(n: int, sim, threshold: float) -> List[List[int]]:
    """对 sim > threshold 的成对索引做并查集连通，返回每组的 index 列表（含单点）。"""
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for i in range(n):
        for j in range(i + 1, n):
            if float(sim[i][j]) > threshold:
                union(i, j)

    groups: Dict[int, List[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return list(groups.values())


def _decide_group(members: List[DedupItem]) -> Dict[str, Any]:
    """对一个重复组决定保留/删除，返回组明细（含审计字段）。"""
    heads = [m for m in members if m.is_chain_head]

    if heads:
        # 有链头：保留 gmt 最早的链头；其余（含其他链头 + 非链）全删
        kept = min(heads, key=_gmt_key)
        reason = "earliest_chain_head" if len(heads) > 1 else "chain_head"
    else:
        # 全非链：保留 gmt 最早的一条
        kept = min(members, key=_gmt_key)
        reason = "earliest_gmt"

    deleted = []
    delete_ids: List[str] = []
    for m in members:
        if m.node_id == kept.node_id:
            continue
        # 被删链头连带删除整条历史链（chain_node_ids 含 head 自身 + bodies）
        cascade = [cid for cid in (m.chain_node_ids or [m.node_id]) if cid != kept.node_id]
        if not cascade:
            cascade = [m.node_id]
        also = [cid for cid in cascade if cid != m.node_id]
        deleted.append({
            "node_id": m.node_id,
            "content": m.content,
            "is_chain_head": m.is_chain_head,
            "also_deleted_chain": also,
        })
        delete_ids.extend(cascade)

    return {
        "members": [
            {
                "node_id": m.node_id,
                "content": m.content,
                "is_latest": m.is_latest,
                "is_chain_head": m.is_chain_head,
            }
            for m in members
        ],
        "kept": {"node_id": kept.node_id, "content": kept.content, "reason": reason},
        "deleted": deleted,
        "delete_ids": delete_ids,
    }


def plan_dedup(
    items: List[DedupItem],
    *,
    threshold: Optional[float] = None,
) -> Dict[str, Any]:
    """
    对一组候选项做去重规划（纯函数，不执行删除）。

    只比较 is_latest=True 的项（普通节点 + 链头）；is_latest=False 的链身被忽略
    （但若某链头被删，其 chain_node_ids 里的链身会进 delete_ids 连带删）。

    Returns:
        {
          "threshold": float,
          "groups": [ {members, kept, deleted, delete_ids}, ... ]  # 只含有删除的组
          "delete_ids": [所有待删 node_id（含连带链），去重后],
          "kept_ids":   [所有保留的代表 node_id],
        }
    """
    thr = threshold if threshold is not None else get_dedup_threshold()
    empty = {"threshold": thr, "groups": [], "delete_ids": [], "kept_ids": [],
             "compared_count": 0, "max_cosine": None, "avg_cosine": None}

    if np is None or not items:
        return empty

    # 只参与 is_latest=True 且有 embedding 的项
    parts = [it for it in items if it.is_latest and it.embedding]
    if len(parts) < 2:
        return {**empty, "compared_count": len(parts)}

    sim = _pairwise_cosine([it.embedding for it in parts])
    idx_groups = _union_find_groups(len(parts), sim, thr)

    # 上三角余弦统计（排除对角 1.0），供审计：最高 / 平均
    n = len(parts)
    iu = np.triu_indices(n, k=1)
    pair_cos = sim[iu]
    max_cos = float(pair_cos.max()) if pair_cos.size else None
    avg_cos = float(pair_cos.mean()) if pair_cos.size else None

    groups_out: List[Dict[str, Any]] = []
    all_delete: List[str] = []
    all_kept: List[str] = []
    seen_del = set()

    for idxs in idx_groups:
        if len(idxs) < 2:
            continue  # 非重复，跳过
        members = [parts[i] for i in idxs]
        decided = _decide_group(members)
        all_kept.append(decided["kept"]["node_id"])
        for did in decided["delete_ids"]:
            if did not in seen_del:
                seen_del.add(did)
                all_delete.append(did)
        groups_out.append({
            "members": decided["members"],
            "kept": decided["kept"],
            "deleted": decided["deleted"],
        })

    return {
        "threshold": thr,
        "groups": groups_out,
        "delete_ids": all_delete,
        "kept_ids": all_kept,
        "compared_count": len(parts),
        "max_cosine": max_cos,
        "avg_cosine": avg_cos,
    }


def _build_dedup_content(trigger: str, plan: Dict[str, Any]) -> str:
    """构造 DEDUP step 的人类可读 content。

    无删除：trigger + 比较条数 + max/avg cosine + 阈值。
    有删除：上面这些 + 每个重复组「重复的是哪些 / 删了哪些 / 保留哪条」。
    """
    thr = plan.get("threshold")
    compared = plan.get("compared_count", 0)
    max_c = plan.get("max_cosine")
    avg_c = plan.get("avg_cosine")
    delete_ids = plan.get("delete_ids", [])

    def _fmt(v):
        return f"{v:.4f}" if isinstance(v, (int, float)) else "n/a"

    lines = [
        f"[DEDUP] trigger={trigger} threshold={thr}",
        f"compared_count={compared} max_cosine={_fmt(max_c)} avg_cosine={_fmt(avg_c)}",
        f"deleted_count={len(delete_ids)}",
    ]

    groups = plan.get("groups", [])
    if groups:
        for gi, g in enumerate(groups):
            members = g.get("members", [])
            kept = g.get("kept", {})
            deleted = g.get("deleted", [])
            lines.append(f"-- group#{gi} ({len(members)} duplicates) --")
            for m in members:
                lines.append(
                    f"   dup: id={m.get('node_id')} head={m.get('is_chain_head')} "
                    f"content={(m.get('content') or '')[:120]}"
                )
            lines.append(
                f"   KEEP: id={kept.get('node_id')} reason={kept.get('reason')} "
                f"content={(kept.get('content') or '')[:120]}"
            )
            for d in deleted:
                also = d.get("also_deleted_chain") or []
                also_s = f" also_chain={also}" if also else ""
                lines.append(
                    f"   DELETE: id={d.get('node_id')} head={d.get('is_chain_head')}{also_s} "
                    f"content={(d.get('content') or '')[:120]}"
                )
        lines.append(f"all_deleted_ids={delete_ids}")

    return "\n".join(lines)


async def _emit_dedup_log(
    cache: Any,
    *,
    request_id: str,
    user_id: str,
    agent_id: str,
    trigger: str,
    plan: Dict[str, Any],
    extra_parsed: Optional[Dict[str, Any]] = None,
) -> None:
    """写 DEDUP pipeline log（删除审计明细）。best-effort。"""
    if cache is None or not getattr(cache, "store_pipeline_log", None):
        return
    try:
        parsed = {
            "trigger": trigger,
            "threshold": plan.get("threshold"),
            "groups": plan.get("groups", []),
            "deleted_count": len(plan.get("delete_ids", [])),
            "kept_count": len(plan.get("kept_ids", [])),
            "compared_count": plan.get("compared_count", 0),
            "max_cosine": plan.get("max_cosine"),
            "avg_cosine": plan.get("avg_cosine"),
        }
        if extra_parsed:
            parsed.update(extra_parsed)
        await cache.store_pipeline_log(
            request_id=request_id or "",
            user_id=user_id or "",
            agent_id=agent_id or "default_agent",
            step=DEDUP_LOG_STEP,
            prompt="",
            response=_build_dedup_content(trigger, plan),
            parsed=json.dumps(parsed, ensure_ascii=False, default=str),
            memory_ids=plan.get("delete_ids", []) or None,
        )
    except Exception as e:
        logger.debug(f"[dedup] emit DEDUP log failed: {e}")


async def _shadow_nodes(
    vector_store: Any,
    node_ids: List[str],
    *,
    kept_id: str,
    trigger: str,
) -> int:
    """把重复节点置 SHADOW（逻辑删除），而不是硬删。

    此前走 `vector_store.delete(nid)` 真删、不可恢复 —— 而被删的可能是一整条
    演化链（链头被判重时连带删 chain_node_ids），一次阈值误判就永久抹掉一条
    记忆的全部演化轨迹。search 链路的 dedup 还是 fire-and-forget 后台任务，
    用户完全无感知，出错也无从恢复。

    改为 SHADOW 后语义等价（SHADOW 不被任何检索召回，等于逻辑删除）但可恢复，
    与 reconciler UPDATE / L1_RAW 降级用的是同一套状态位。

    用 update_payload 而非 upsert：只改状态位，不重写向量（DedupItem 手里只有
    embedding，没有完整节点；整节点 upsert 会破坏 payload）。
    """
    from ...models.memory import MemoryStatus

    ok = 0
    for nid in node_ids:
        try:
            await vector_store.update_payload(
                nid,
                {
                    "is_latest": False,
                    "status": MemoryStatus.SHADOW.value,
                    # 审计：这条为什么不见了、被哪条取代
                    "shadow_reason": f"dedup:{trigger}",
                    "dedup_kept_id": kept_id,
                },
            )
            ok += 1
        except Exception as e:
            logger.warning(f"[dedup] shadow {nid} failed (trigger={trigger}): {e}")
    return ok


async def execute_dedup(
    items: List[DedupItem],
    *,
    vector_store: Any,
    cache: Any = None,
    trigger: str,
    request_id: str = "",
    user_id: str = "",
    agent_id: str = "",
    delete_from_store: bool = True,
    threshold: Optional[float] = None,
    extra_parsed: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    去重编排：plan → （可选）删库 → 写 DEDUP log。整体 best-effort，绝不抛错影响主流程。

    Args:
        items: 同一 isolation 范围内的候选（调用方保证不跨 user/agent）。
        delete_from_store: True 时把 plan.delete_ids 置 SHADOW（逻辑删除，可恢复；
            不是硬删——见 _shadow_nodes）；extractor 阶段（结果还没入库）传 False，
            只记录被丢弃项。
        trigger: "extractor" / "reconcile" / "search"，落进 DEDUP log。
        extra_parsed: 额外写入 DEDUP log.parsed 的字段（如 embed 耗时 / provider meta）。

    Returns:
        plan dict（含 delete_ids / kept_ids / groups）。无重复时 delete_ids 为空。
    """
    try:
        plan = plan_dedup(items, threshold=threshold)
    except Exception as e:
        logger.warning(f"[dedup] plan_dedup failed (trigger={trigger}): {e}")
        return {"threshold": threshold, "groups": [], "delete_ids": [], "kept_ids": []}

    delete_ids = plan.get("delete_ids", [])
    if not delete_ids:
        # 无重复：仍落一条 DEDUP step（记录 compared_count / max_cosine / avg_cosine），
        # 方便确认 dedup 确实跑过、最接近的一对离阈值有多远。
        await _emit_dedup_log(
            cache,
            request_id=request_id,
            user_id=user_id,
            agent_id=agent_id,
            trigger=trigger,
            plan=plan,
            extra_parsed=extra_parsed,
        )
        return plan

    if delete_from_store and vector_store is not None:
        # 逻辑删除（SHADOW），不硬删。每个组的 kept_id 单独记，便于事后追溯
        # "这条被哪条取代"。
        for g in plan.get("groups", []):
            _kept = (g.get("kept") or {}).get("node_id", "")
            _gids: List[str] = []
            for d in (g.get("deleted") or []):
                if d.get("node_id"):
                    _gids.append(d["node_id"])
                _gids.extend(d.get("also_deleted_chain") or [])
            if _gids:
                await _shadow_nodes(
                    vector_store, _gids, kept_id=_kept, trigger=trigger,
                )

    await _emit_dedup_log(
        cache,
        request_id=request_id,
        user_id=user_id,
        agent_id=agent_id,
        trigger=trigger,
        plan=plan,
        extra_parsed=extra_parsed,
    )

    logger.info(
        f"[dedup] trigger={trigger} groups={len(plan.get('groups', []))} "
        f"shadowed={len(delete_ids)} (apply={delete_from_store})"
    )
    return plan
