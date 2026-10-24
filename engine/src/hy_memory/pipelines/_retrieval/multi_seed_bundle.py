"""Question-blind pool-wide Episode/Tag bundle planning before local BGE.

The planner treats every post-MMR candidate as a seed.  Write-time hierarchy
and static tag memberships may nominate additional canonical L2 memories, but
the structural labels are navigation-only: only canonical L2 bodies are
rendered in the final bundle.  All decisions are deterministic and bounded.
"""

from __future__ import annotations

from collections import defaultdict
import math
import re
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from .hierarchy_bundle import cosine, estimate_tokens_no_io
from .lemmatize import lemmatize_for_bm25


_GENERIC_TAGS = {
    "activity", "activities", "event", "events", "family", "friend",
    "friends", "health", "life", "memory", "personal", "people",
    "relationship", "relationships", "social", "thing", "things", "work",
}

_COMPOSITE_FIELDS = (
    "_bundle_items", "_graph_merged_items", "related_memories",
    "_capsule_memories", "_timeline_member_ids", "_timeline",
    "graph_merged", "graph_merged_ids",
)


def _node_id(item: Mapping[str, Any]) -> str:
    node = item.get("node")
    return str(item.get("node_id") or getattr(node, "node_id", "") or "")


def _content(item: Mapping[str, Any]) -> str:
    node = item.get("node")
    return str(item.get("content") or getattr(node, "content", "") or "")


def _active_latest_l2(node: Any) -> bool:
    layer = getattr(getattr(node, "layer", None), "value", getattr(node, "layer", None))
    status = getattr(
        getattr(node, "status", None), "value", getattr(node, "status", None)
    )
    return (
        str(layer or "") == "l2_fact"
        and str(status or "active") == "active"
        and bool(getattr(node, "is_latest", True))
    )


def _canonical_singleton(item: Mapping[str, Any]) -> bool:
    node = item.get("node")
    if node is None or not _active_latest_l2(node):
        return False
    return not any(item.get(field) for field in _COMPOSITE_FIELDS)


def canonical_seed_view(items: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Expand graph composites into unique canonical L2 candidates.

    This is a parallel planning view only.  Callers retain the original items as
    the byte-for-byte fallback when no multi-seed admission succeeds.
    """
    output: List[Dict[str, Any]] = []
    index_by_id: Dict[str, int] = {}
    for original in items or []:
        pieces = original.get("_graph_merged_items") or [original]
        for piece in pieces:
            item = dict(piece)
            for field in _COMPOSITE_FIELDS:
                item.pop(field, None)
            memory_id = _node_id(item)
            if not memory_id or not _canonical_singleton(item):
                continue
            previous_index = index_by_id.get(memory_id)
            if previous_index is None:
                index_by_id[memory_id] = len(output)
                output.append(item)
                continue
            if float(item.get("score") or 0.0) > float(
                output[previous_index].get("score") or 0.0
            ):
                output[previous_index] = item
    return output


def _unit(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(number):
        return 0.0
    return max(0.0, min(1.0, number))


def bounded_noisy_or(values: Iterable[float]) -> float:
    remaining = 1.0
    for value in values:
        remaining *= 1.0 - _unit(value)
    return 1.0 - remaining


def _terms(text: str) -> set[str]:
    normalized = lemmatize_for_bm25(str(text or ""))
    return {
        token.casefold() for token in re.findall(r"[\w'-]+", normalized)
        if len(token) > 1
    }


def lexical_overlap(query: str, document: str) -> float:
    query_terms = _terms(query)
    if not query_terms:
        return 0.0
    return len(query_terms & _terms(document)) / float(len(query_terms))


def lightweight_hybrid_score(
    query: str,
    document: str,
    *,
    semantic_score: Optional[float],
    lexical_weight: float = 0.35,
) -> float:
    """Fixed additive light scorer on stored vectors plus lexical overlap."""
    semantic = _unit(semantic_score)
    lexical = lexical_overlap(query, document)
    return _unit(semantic + max(0.0, float(lexical_weight)) * lexical)


def _tag_eligible(
    tag: str,
    ner: str,
    *,
    excluded: set[str],
    df: int,
    max_df: int,
) -> bool:
    folded = str(tag or "").strip().casefold()
    if not folded or folded in excluded or folded in _GENERIC_TAGS:
        return False
    if str(ner or "").strip().upper() == "PERSON":
        return False
    return 0 < int(df) <= max(1, int(max_df))


def _bundle_item(
    members: Sequence[Dict[str, Any]],
    *,
    group_id: str,
    group_type: str,
    group_score: float,
) -> Dict[str, Any]:
    anchor = dict(members[0])
    return {
        **anchor,
        "source": "multi_seed_bundle",
        "_bundle_items": list(members),
        "_multi_seed_group_id": group_id,
        "_multi_seed_group_type": group_type,
        "_multi_seed_group_score": float(group_score),
    }


async def build_multi_seed_bundle_pool(
    *,
    graph_store,
    vector_store,
    isolation_key: str,
    query: str,
    query_embedding: Sequence[float],
    seed_pool: Sequence[Dict[str, Any]],
    fallback_pool: Optional[Sequence[Dict[str, Any]]] = None,
    mode: str = "episode_single",
    tag_hits: Sequence[Dict[str, Any]] = (),
    excluded_tags: Sequence[str] = (),
    alpha: float = 0.6,
    beta: float = 0.4,
    gamma: float = 0.4,
    member_floor: float = 0.20,
    group_floor: float = 0.35,
    tag_s1_floor: float = 0.0,
    tau: float = 0.45,
    lexical_weight: float = 0.35,
    max_tag_df: int = 8,
    scan_limit: int = 50,
    max_members: int = 8,
    max_bundles: int = 0,
    min_episode_seeds: int = 1,
    single_tag_seed_ceiling: float = 1.01,
    token_budget: int = 400,
    expected_seed_count: Optional[int] = None,
    min_units: int = 1,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Return rerank units or the exact input pool when admission fails closed."""
    seeds = list(seed_pool or [])
    baseline = list(fallback_pool) if fallback_pool is not None else list(seeds)
    info: Dict[str, Any] = {
        "enabled": True,
        "applied": False,
        "mode": mode,
        "seed_count": len(seeds),
        "fallback_count": len(baseline),
        "tag_s1_floor": float(tag_s1_floor),
        "min_episode_seeds": max(1, int(min_episode_seeds)),
        "single_tag_seed_ceiling": float(single_tag_seed_ceiling),
    }
    if not seeds or not query_embedding:
        return baseline, {**info, "reason": "empty_pool_or_embedding"}
    if expected_seed_count is not None and len(seeds) != int(expected_seed_count):
        return baseline, {
            **info, "reason": "unexpected_seed_count",
            "expected_seed_count": int(expected_seed_count),
        }
    if not all(_canonical_singleton(item) for item in seeds):
        return baseline, {**info, "reason": "noncanonical_seed"}
    valid_modes = {"episode_single", "episode_multi", "tag_multi", "episode_tag"}
    if mode not in valid_modes:
        return baseline, {**info, "reason": "invalid_mode"}
    seed_by_id = {_node_id(item): item for item in seeds if _node_id(item)}
    if len(seed_by_id) != len(seeds):
        return baseline, {**info, "reason": "invalid_or_duplicate_seed"}

    use_episode = mode in {"episode_single", "episode_multi", "episode_tag"}
    use_tag = mode in {"tag_multi", "episode_tag"}
    group_meta: Dict[str, Dict[str, Any]] = {}
    members_by_group: Dict[str, set[str]] = defaultdict(set)
    groups_by_member: Dict[str, set[str]] = defaultdict(set)

    if use_episode:
        topics = await graph_store.get_hierarchy_topics(isolation_key)
        memberships = await graph_store.get_hierarchy_memberships(isolation_key)
        episode_topics = {
            str(topic.get("topic_id") or ""): topic for topic in topics or []
            if str(topic.get("topic_id") or "")
            and str(topic.get("node_type") or "").casefold() == "episode"
        }
        for relation in memberships or []:
            memory_id = str(relation.get("node_id") or "")
            topic_id = str(relation.get("topic_id") or "")
            if memory_id and topic_id in episode_topics:
                group_id = f"episode:{topic_id}"
                members_by_group[group_id].add(memory_id)
                groups_by_member[memory_id].add(group_id)
                topic = episode_topics[topic_id]
                group_meta[group_id] = {
                    "type": "episode",
                    "title": str(topic.get("name") or ""),
                    "semantic": cosine(query_embedding, topic.get("embedding") or []),
                }

    all_nodes: Dict[str, Any] = {
        memory_id: item.get("node") for memory_id, item in seed_by_id.items()
    }
    tag_scores = {
        str(hit.get("tag") or "").strip().casefold(): _unit(hit.get("score"))
        for hit in tag_hits or [] if str(hit.get("tag") or "").strip()
    }
    if use_tag:
        if not tag_hits and not use_episode:
            return baseline, {**info, "reason": "tag_index_unavailable"}
        if tag_hits:
            # Enumerate the user's active/latest corpus exactly; do not silently turn
            # the safety limit into a semantic top-k cutoff.  Only query-matched tag
            # vectors may form groups: treating every tag on every seed as a match
            # assigns s1=0 to unscored groups and lets seed corroboration alone flood
            # the candidate set with unrelated tags.
            listed = await vector_store.list_by_user(
                user_id=getattr(next(iter(all_nodes.values()), None), "user_id", None),
                agent_id=getattr(next(iter(all_nodes.values()), None), "agent_id", None),
                limit=2000,
                with_vectors=False,
            )
            for node in listed or []:
                if not _active_latest_l2(node):
                    continue
                all_nodes[str(node.node_id)] = node
            raw_df: Dict[str, int] = defaultdict(int)
            for node in all_nodes.values():
                for tag in set(str(value or "").strip().casefold() for value in getattr(node, "tags", []) or []):
                    if tag:
                        raw_df[tag] += 1
            excluded = {str(value or "").strip().casefold() for value in excluded_tags if value}
            for memory_id, node in all_nodes.items():
                tags = list(getattr(node, "tags", None) or [])
                ners = list(getattr(node, "tag_ners", None) or [])
                for index, tag in enumerate(tags):
                    folded = str(tag or "").strip().casefold()
                    ner = ners[index] if index < len(ners) else ""
                    if folded not in tag_scores or not _tag_eligible(
                        tag, ner, excluded=excluded, df=raw_df.get(folded, 0),
                        max_df=max_tag_df,
                    ):
                        continue
                    group_id = f"tag:{folded}"
                    members_by_group[group_id].add(memory_id)
                    groups_by_member[memory_id].add(group_id)
                    group_meta[group_id] = {
                        "type": "tag", "title": str(tag),
                        "semantic": tag_scores[folded], "df": raw_df[folded],
                    }

    seed_groups: Dict[str, List[str]] = defaultdict(list)
    for memory_id in seed_by_id:
        for group_id in groups_by_member.get(memory_id, ()):
            seed_groups[group_id].append(memory_id)
    if not seed_groups:
        return baseline, {**info, "reason": "no_seed_groups"}

    group_scores: Dict[str, float] = {}
    group_s1_scores: Dict[str, float] = {}
    group_rows = []
    for group_id in sorted(seed_groups):
        group_seed_ids = sorted(seed_groups[group_id])
        seed_values = [
            _unit(seed_by_id[memory_id].get("score"))
            for memory_id in group_seed_ids
        ]
        s2 = max(seed_values, default=0.0) if mode == "episode_single" else bounded_noisy_or(seed_values)
        meta = group_meta[group_id]
        s1 = lightweight_hybrid_score(
            query, meta.get("title", ""), semantic_score=meta.get("semantic"),
            lexical_weight=lexical_weight,
        )
        c1 = max(0.0, float(alpha)) * s1 + max(0.0, float(beta)) * s2
        group_s1_scores[group_id] = s1
        group_scores[group_id] = c1
        group_rows.append({
            "group_id": group_id, "group_type": meta["type"],
            "seed_count": len(group_seed_ids),
            "seeds": [
                {"node_id": mid, "h": value}
                for mid, value in zip(group_seed_ids, seed_values)
            ],
            "s1": s1, "s2": s2, "c1": c1,
        })

    min_episode_seed_count = max(1, int(min_episode_seeds))

    def meets_seed_consensus(group_id: str) -> bool:
        return (
            group_meta[group_id]["type"] != "episode"
            or len(set(seed_groups[group_id])) >= min_episode_seed_count
        )

    def preserves_high_confidence_single_tag_seed(group_id: str) -> bool:
        if group_meta[group_id]["type"] != "tag":
            return True
        group_seed_ids = seed_groups[group_id]
        if len(set(group_seed_ids)) != 1:
            return True
        seed_score = max(
            _unit(seed_by_id[memory_id].get("score"))
            for memory_id in group_seed_ids
        )
        return seed_score < float(single_tag_seed_ceiling)

    viable_seed_groups = {
        group_id for group_id in seed_groups
        if meets_seed_consensus(group_id)
        and preserves_high_confidence_single_tag_seed(group_id)
        and group_scores[group_id] >= float(group_floor)
        and (
            group_meta[group_id]["type"] != "tag"
            or group_s1_scores[group_id] >= float(tag_s1_floor)
        )
    }
    if not viable_seed_groups:
        return baseline, {
            **info, "reason": "no_member_admitted", "groups": group_rows,
            "novel_candidate_count": 0, "members": [],
        }
    novel_ids = sorted({
        memory_id for group_id in viable_seed_groups
        for memory_id in members_by_group.get(group_id, ())
        if memory_id not in seed_by_id
    })
    if len(novel_ids) > max(0, int(scan_limit)):
        return baseline, {
            **info, "reason": "candidate_overflow", "novel_candidate_count": len(novel_ids),
            "scan_limit": max(0, int(scan_limit)), "groups": group_rows,
        }
    missing_nodes = [memory_id for memory_id in novel_ids if memory_id not in all_nodes]
    if missing_nodes:
        fetched = await vector_store.get_by_ids(missing_nodes)
        all_nodes.update({str(node.node_id): node for node in fetched or []})
    if any(memory_id not in all_nodes for memory_id in novel_ids):
        return baseline, {**info, "reason": "missing_member", "groups": group_rows}
    ineligible_novel_ids = sorted(
        memory_id for memory_id in novel_ids
        if not _active_latest_l2(all_nodes[memory_id])
    )
    novel_ids = [
        memory_id for memory_id in novel_ids if memory_id not in ineligible_novel_ids
    ]
    if not novel_ids:
        return baseline, {
            **info, "reason": "no_active_latest_novel_member",
            "groups": group_rows,
            "ineligible_novel_ids": ineligible_novel_ids,
        }
    embeddings = await vector_store.get_embeddings(novel_ids)
    if any(memory_id not in embeddings for memory_id in novel_ids):
        return baseline, {**info, "reason": "missing_member_embedding", "groups": group_rows}

    admitted: Dict[str, Dict[str, Any]] = {}
    member_rows = []
    for memory_id in novel_ids:
        node = all_nodes[memory_id]
        semantic = cosine(query_embedding, embeddings[memory_id])
        s3 = lightweight_hybrid_score(
            query, getattr(node, "content", ""), semantic_score=semantic,
            lexical_weight=lexical_weight,
        )
        eligible_groups = [
            group for group in groups_by_member[memory_id]
            if group in seed_groups
        ]
        support_groups = [
            group for group in eligible_groups if group in viable_seed_groups
        ]
        if not support_groups:
            continue
        # Admission support and final bundle ownership are intentionally
        # separate.  The contract defines b(m) as the strongest supporting
        # group, regardless of type, while overlap ownership is Episode-first.
        # Coupling the two makes a weaker Episode suppress a stronger Tag and
        # can incorrectly reject an otherwise eligible canonical L2.
        boost_group = min(
            support_groups,
            key=lambda group: (-group_scores[group], group),
        )
        ownership_groups = [
            group for group in eligible_groups
            if meets_seed_consensus(group)
            and preserves_high_confidence_single_tag_seed(group)
        ]
        owner_group = min(
            ownership_groups,
            key=lambda group: (
                0 if group_meta[group]["type"] == "episode" else 1,
                -group_scores[group], group,
            ),
        )
        boost = group_scores[boost_group]
        final_score = s3 + max(0.0, float(gamma)) * boost
        passed = (
            s3 >= float(member_floor)
            and boost >= float(group_floor)
            and final_score >= float(tau)
        )
        member_rows.append({
            "node_id": memory_id,
            "group_id": owner_group,
            "boost_group_id": boost_group,
            "s3": s3,
            "group_boost": boost, "final_score": final_score, "admitted": passed,
        })
        if passed:
            admitted[memory_id] = {
                "group_id": owner_group,
                "boost_group_id": boost_group,
                "score": final_score,
                "item": {
                    "node_id": memory_id, "node": node,
                    "content": getattr(node, "content", ""),
                    "score": s3, "source": "multi_seed_member",
                    "_multi_seed_member_score": final_score,
                },
            }
    if not admitted:
        return baseline, {
            **info, "reason": "no_member_admitted", "groups": group_rows,
            "novel_candidate_count": len(novel_ids), "members": member_rows,
        }

    active_groups = {value["group_id"] for value in admitted.values()}
    if max(0, int(max_bundles)) and len(active_groups) > int(max_bundles):
        return baseline, {
            **info,
            "reason": "bundle_count_exceeded",
            "bundle_count": len(active_groups),
            "max_bundles": int(max_bundles),
            "groups": group_rows,
            "members": member_rows,
        }
    seed_assignment: Dict[str, str] = {}
    for memory_id in seed_by_id:
        eligible = [group for group in groups_by_member.get(memory_id, ()) if group in active_groups]
        if eligible:
            seed_assignment[memory_id] = min(
                eligible,
                key=lambda group: (
                    0 if group_meta[group]["type"] == "episode" else 1,
                    -group_scores[group], group,
                ),
            )
    grouped: Dict[str, List[Tuple[float, Dict[str, Any]]]] = defaultdict(list)
    for memory_id, group_id in seed_assignment.items():
        grouped[group_id].append((float(seed_by_id[memory_id].get("score") or 0.0), seed_by_id[memory_id]))
    for value in admitted.values():
        grouped[value["group_id"]].append((float(value["score"]), value["item"]))

    invalid_groups = set()
    for group_id, rows in grouped.items():
        items = [item for _, item in rows]
        tokens = sum(estimate_tokens_no_io(_content(item)) for item in items)
        if len(items) > max(2, int(max_members)) or tokens > max(1, int(token_budget)):
            invalid_groups.add(group_id)
    if invalid_groups:
        return baseline, {
            **info, "reason": "bundle_budget_exceeded",
            "invalid_groups": sorted(invalid_groups), "groups": group_rows,
            "members": member_rows,
        }

    units: List[Dict[str, Any]] = []
    emitted_groups = set()
    for seed in seeds:
        memory_id = _node_id(seed)
        group_id = seed_assignment.get(memory_id)
        if not group_id:
            units.append(seed)
            continue
        if group_id in emitted_groups:
            continue
        emitted_groups.add(group_id)
        rows = sorted(grouped[group_id], key=lambda row: (-row[0], _node_id(row[1])))
        units.append(_bundle_item(
            [item for _, item in rows], group_id=group_id,
            group_type=group_meta[group_id]["type"],
            group_score=group_scores[group_id],
        ))
    if len(units) > len(seeds):
        return baseline, {**info, "reason": "unit_count_invariant", "groups": group_rows}
    if len(units) < max(1, int(min_units)):
        return baseline, {
            **info, "reason": "insufficient_rerank_units", "groups": group_rows,
            "members": member_rows, "unit_count": len(units),
        }
    return units, {
        **info, "applied": True, "reason": "bundled",
        "group_count": len(seed_groups), "groups": group_rows,
        "novel_candidate_count": len(novel_ids), "members": member_rows,
        "ineligible_novel_ids": ineligible_novel_ids,
        "admitted_count": len(admitted), "bundle_count": len(emitted_groups),
        "bundle_widths": [len(grouped[group]) for group in sorted(emitted_groups)],
        "unit_count": len(units),
    }
