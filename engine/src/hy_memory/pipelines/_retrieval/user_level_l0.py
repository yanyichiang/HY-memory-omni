"""User-level L0 Basic Info retrieval helpers.

L0 is a global user profile. It must not be filtered by agent/session. Historical
agent-level chains may still coexist, so readers defensively collapse them to one
profile hit per user until the next write lazily migrates them to a canonical chain.

Because L0 recall intentionally drops agent/session isolation, ``user_ids`` is the
only remaining tenancy boundary. ``require_user_scope`` therefore refuses to build
an unscoped L0 query instead of silently scanning every user's profile.
"""
from __future__ import annotations

import logging
from dataclasses import replace
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional

from ...models.memory import MemoryLayer

logger = logging.getLogger(__name__)


def require_user_scope(*candidates: Optional[List[str]]) -> Optional[List[str]]:
    """Return the first non-empty user scope, or None if L0 recall must be skipped.

    L0 has no agent/session isolation left, so an empty scope would return every
    user's profile. Callers must treat None as "skip the L0 query".
    """
    for candidate in candidates:
        if candidate:
            return list(candidate)
    logger.warning(
    "[user_level_l0] skipped L0 recall: no user scope provided; "
    "L0 has no agent/session isolation so an unscoped query would leak profiles"
    )
    return None


def _timestamp(node: Any) -> float:
    value = getattr(node, "gmt_created", None) or getattr(node, "valid_from", None)
    if isinstance(value, datetime):
        try:
            return value.timestamp()
        except (OSError, ValueError):
            return 0.0
    return 0.0


def collapse_user_level_l0_hits(hits: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Keep at most one L0 hit per user; preserve all non-L0 profile hits.

    Canonical user-level nodes (empty agent_id) win over historical agent-level
    nodes. Within the same scope, latest/newest wins. The retained score is the
    maximum score among that user's L0 candidates so deduplication does not hurt
    ranking.
    """
    non_l0: List[Dict[str, Any]] = []
    grouped: Dict[str, List[Dict[str, Any]]] = {}

    for hit in hits or []:
        node = hit.get("node")
        layer = getattr(node, "layer", None) if node is not None else hit.get("layer")
        layer_value = getattr(layer, "value", layer)
        if layer_value != MemoryLayer.L0_BASIC_INFO.value:
            non_l0.append(hit)
            continue
        user_id = getattr(node, "user_id", "") if node is not None else hit.get("user_id", "")
        grouped.setdefault(user_id or "", []).append(hit)

    collapsed: List[Dict[str, Any]] = []
    for user_hits in grouped.values():
        def priority(hit: Dict[str, Any]):
            node = hit.get("node")
            return (
                (getattr(node, "agent_id", "") or "") == "",
                bool(getattr(node, "is_latest", False)),
                _timestamp(node),
                float(hit.get("score", 0.0) or 0.0),
            )

        best = max(user_hits, key=priority)
        max_score = max(float(h.get("score", 0.0) or 0.0) for h in user_hits)
        best = {**best, "score": max_score}

        # 历史 agent-level 多链可能各自保存不同字段。仅挑一条会丢画像字段，
        # 因此在读侧合并 KV 并生成一个临时 user-level 节点；下一次写入会把它们
        # 惰性迁移为真实的 canonical 链头。
        if len(user_hits) > 1 and best.get("node") is not None:
            merged_kv: Dict[str, Any] = {}
            ordered = sorted(
                user_hits,
                key=lambda h: (
                    (getattr(h.get("node"), "agent_id", "") or "") == "",
                    _timestamp(h.get("node")),
                ),
            )
            for hit in ordered:
                custom = getattr(hit.get("node"), "custom", None) or {}
                kv = custom.get("basic_info_kv") or {}
                if isinstance(kv, dict):
                    merged_kv.update(kv)
            if merged_kv:
                node = best["node"]
                content = "The user's " + ", ".join(
                    f"{key} is {value}" for key, value in merged_kv.items()
                ) + "."
                best["node"] = replace(
                    node,
                    agent_id="",
                    session_id="",
                    content=content,
                    custom={**(getattr(node, "custom", None) or {}), "basic_info_kv": merged_kv},
                    supersedes=None,
                    superseded_by=None,
                )
                best["user_level_merged"] = True
        collapsed.append(best)

    return collapsed + non_l0
