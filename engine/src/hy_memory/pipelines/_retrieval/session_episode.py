"""Selection helpers for first-class session episodes plus atomic fact hints."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from ...models.memory import MemoryLayer
SESSION_EPISODE_KIND = "session_episode"
DYNAMIC_EPISODE_KIND = "dynamic_episode"
SERIES_EPISODE_KIND = "series_episode"


def _normalized_content(value: Any) -> str:
    """Stable exact-content key used only to prevent nested response duplication."""
    return " ".join(str(value or "").split()).casefold()


def _canonical_item_content(item: Dict[str, Any]) -> str:
    """Return the selected node's own body, never a pre-rendered graph composite."""
    node = item.get("node")
    item_id = str(item.get("node_id") or getattr(node, "node_id", "") or "")
    for piece in item.get("_graph_merged_items") or []:
        piece_node = piece.get("node")
        piece_id = str(piece.get("node_id") or getattr(piece_node, "node_id", "") or "")
        if item_id and piece_id == item_id:
            return str(
                piece.get("content") or getattr(piece_node, "content", "") or ""
            )
    return str(getattr(node, "content", "") or item.get("content") or "")


def is_session_episode(item: Dict[str, Any]) -> bool:
    node = item.get("node")
    if node is None or getattr(node, "layer", None) != MemoryLayer.L3_SUMMARY:
        return False
    return (getattr(node, "custom", None) or {}).get("summary_kind") == SESSION_EPISODE_KIND


def parent_episode_id(item: Dict[str, Any]) -> str:
    ids = parent_episode_ids(item)
    return ids[0] if ids else ""


def parent_episode_ids(item: Dict[str, Any]) -> List[str]:
    """Return all episode memberships, preserving the legacy primary parent."""
    node = item.get("node")
    if node is None:
        return []
    custom = getattr(node, "custom", None) or {}
    values = [
        str(value) for value in custom.get("parent_episode_ids") or [] if value
    ]
    legacy = str(custom.get("parent_episode_id") or "")
    if legacy and legacy not in values:
        values.insert(0, legacy)
    return list(dict.fromkeys(values))


def add_parent_episode_membership(
    custom: Optional[Dict[str, Any]],
    episode_id: str,
    *,
    similarity: float | None = None,
    method: str = "",
) -> Dict[str, Any]:
    """Append one episode membership without replacing prior memberships."""
    out = dict(custom or {})
    episode_id = str(episode_id or "")
    if not episode_id:
        return out
    ids = [str(value) for value in out.get("parent_episode_ids") or [] if value]
    legacy = str(out.get("parent_episode_id") or "")
    if legacy and legacy not in ids:
        ids.insert(0, legacy)
    if episode_id not in ids:
        ids.append(episode_id)
    out["parent_episode_ids"] = ids
    if not out.get("parent_episode_id"):
        out["parent_episode_id"] = ids[0]

    links = [
        dict(value) for value in out.get("parent_episode_links") or []
        if isinstance(value, dict) and value.get("episode_id")
    ]
    links = [value for value in links if str(value["episode_id"]) != episode_id]
    link = {"episode_id": episode_id}
    if similarity is not None:
        link["similarity"] = float(similarity)
    if method:
        link["method"] = method
    links.append(link)
    out["parent_episode_links"] = links
    if out.get("parent_episode_id") == episode_id:
        if similarity is not None:
            out["parent_episode_similarity"] = float(similarity)
        if method:
            out["parent_episode_link_method"] = method
    return out


def remove_parent_episode_memberships(
    custom: Optional[Dict[str, Any]], episode_ids: set[str],
) -> Dict[str, Any]:
    """Remove stale derived containers while preserving live legacy metadata."""
    out = dict(custom or {})
    remove = {str(value) for value in episode_ids if value}
    ids = [
        str(value) for value in out.get("parent_episode_ids") or []
        if value and str(value) not in remove
    ]
    legacy = str(out.get("parent_episode_id") or "")
    if legacy and legacy not in remove and legacy not in ids:
        ids.insert(0, legacy)
    links = [
        dict(value) for value in out.get("parent_episode_links") or []
        if isinstance(value, dict)
        and value.get("episode_id")
        and str(value["episode_id"]) not in remove
    ]
    if ids:
        out["parent_episode_ids"] = list(dict.fromkeys(ids))
        out["parent_episode_id"] = out["parent_episode_ids"][0]
        primary = next(
            (value for value in links
             if str(value.get("episode_id")) == out["parent_episode_id"]),
            None,
        )
        if primary is not None:
            if "similarity" in primary:
                out["parent_episode_similarity"] = float(primary["similarity"])
            if primary.get("method"):
                out["parent_episode_link_method"] = str(primary["method"])
        else:
            out.pop("parent_episode_similarity", None)
            out.pop("parent_episode_link_method", None)
    else:
        for key in (
            "parent_episode_ids", "parent_episode_id",
            "parent_episode_similarity", "parent_episode_link_method",
        ):
            out.pop(key, None)
    if links:
        out["parent_episode_links"] = links
    else:
        out.pop("parent_episode_links", None)
    return out


def parent_episode_similarity(item: Dict[str, Any], episode_id: str) -> float:
    node = item.get("node")
    custom = getattr(node, "custom", None) or {}
    for link in custom.get("parent_episode_links") or []:
        if isinstance(link, dict) and str(link.get("episode_id") or "") == episode_id:
            return float(link.get("similarity") or 0.0)
    if str(custom.get("parent_episode_id") or "") == episode_id:
        return float(custom.get("parent_episode_similarity") or 0.0)
    return 0.0


def is_dynamic_episode(item: Dict[str, Any]) -> bool:
    node = item.get("node")
    if node is None or getattr(node, "layer", None) != MemoryLayer.L3_SUMMARY:
        return False
    return (getattr(node, "custom", None) or {}).get("summary_kind") == DYNAMIC_EPISODE_KIND


def is_episode_container(item: Dict[str, Any]) -> bool:
    """True for compact L3 nodes whose bodies must not replace visible L2s."""
    node = item.get("node")
    if node is None or getattr(node, "layer", None) != MemoryLayer.L3_SUMMARY:
        return False
    return (getattr(node, "custom", None) or {}).get("summary_kind") in {
        DYNAMIC_EPISODE_KIND, SERIES_EPISODE_KIND,
    }


def is_series_episode(item: Dict[str, Any]) -> bool:
    node = item.get("node")
    if node is None or getattr(node, "layer", None) != MemoryLayer.L3_SUMMARY:
        return False
    return (getattr(node, "custom", None) or {}).get("summary_kind") == SERIES_EPISODE_KIND


def select_episode_capsule_context(
    items: List[Dict[str, Any]],
    parent_items: Dict[str, Dict[str, Any]],
    parent_query_similarities: Dict[str, float],
    *,
    query_min: float = 0.65,
    assignment_min: float = 0.60,
    first_rank_max: int = 3,
    member_limit: int = 3,
    render_mode: str = "full",
) -> tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Fold one high-confidence L3 parent and its matched facts into one slot.

    The original top-k list is preserved unless a top-ranked L2 fact explicitly
    links to a dynamic episode and both write-time assignment confidence and
    query-to-parent similarity pass conservative gates.
    """
    grouped: Dict[str, List[tuple[int, Dict[str, Any], float]]] = {}
    for rank, item in enumerate(items, 1):
        node = item.get("node")
        if node is None or getattr(node, "layer", None) != MemoryLayer.L2_FACT:
            continue
        for parent_id in parent_episode_ids(item):
            parent = parent_items.get(parent_id)
            if parent is None or not is_episode_container(parent):
                continue
            grouped.setdefault(parent_id, []).append((
                rank, item, parent_episode_similarity(item, parent_id),
            ))

    candidates = []
    for parent_id, members in grouped.items():
        first_rank = min(rank for rank, _, _ in members)
        assignment = min(score for _, _, score in members)
        query_sim = float(parent_query_similarities.get(parent_id) or 0.0)
        if (first_rank <= max(1, first_rank_max)
                and assignment >= assignment_min and query_sim >= query_min):
            candidates.append((query_sim, -first_rank, parent_id, members))
    if not candidates:
        return items, {}

    query_sim, neg_rank, parent_id, members = max(candidates)
    members = sorted(members, key=lambda row: row[0])[:max(1, member_limit)]
    selected_ranks = {rank for rank, _, _ in members}
    first_rank = min(selected_ranks)
    parent = parent_items[parent_id]
    parent_node = parent["node"]
    parent_content = (getattr(parent_node, "content", "") or "").strip()
    parent_content_key = _normalized_content(parent_content)
    parent_custom = getattr(parent_node, "custom", None) or {}
    parent_title = str(parent_custom.get("title") or "").strip()
    parent_time = getattr(parent_node, "memory_at", None)
    capsule_memories = []
    seen_member_ids = set()
    seen_member_contents = set()
    seen_nested_ids = {parent_id}
    seen_nested_contents = {parent_content_key} if parent_content_key else set()
    # All selected L2 items are top-level members of this capsule. Reserve their
    # identities before walking graph expansions so one fact cannot be nested under
    # another fact and then rendered again in its own top-level position.
    for _, selected, _ in members:
        selected_node = selected.get("node")
        selected_id = str(
            selected.get("node_id")
            or getattr(selected_node, "node_id", "")
            or ""
        )
        selected_content = (
            selected.get("content")
            or getattr(selected_node, "content", "")
            or ""
        )
        if selected_id:
            seen_nested_ids.add(selected_id)
        selected_key = _normalized_content(selected_content)
        if selected_key:
            seen_nested_contents.add(selected_key)
    for _, item, _ in members:
        node = item.get("node")
        item_id = str(item.get("node_id") or getattr(node, "node_id", "") or "")
        # Graph rerank may have pre-rendered seed + expansions into item["content"].
        # A capsule already walks the structured _graph_merged_items below, so using
        # that merged string here would duplicate the seed/parent evidence. Keep the
        # selected L2's canonical body as the top-level member.
        item_content = _canonical_item_content(item)
        item_content_key = _normalized_content(item_content)
        # Top-level facts are judged by their own identity/content. Using
        # build_rerank_text() here is wrong because it includes graph-expanded
        # siblings; a fact that references another selected fact would then make the
        # sibling look like a duplicate and silently remove it from the capsule.
        if ((item_id and item_id in seen_member_ids)
                or (item_content_key and item_content_key in seen_member_contents)):
            continue
        if item_id:
            seen_member_ids.add(item_id)
        if item_content_key:
            seen_member_contents.add(item_content_key)
        if item_content_key:
            memory_at = item.get("memory_at")
            if memory_at is None and node is not None and getattr(node, "memory_at", None):
                memory_at = int(node.memory_at.timestamp())
            gmt_created = item.get("gmt_created")
            if gmt_created is None and node is not None and getattr(node, "gmt_created", None):
                gmt_created = int(node.gmt_created.timestamp())
            related_memories = []
            for related in item.get("_graph_merged_items") or []:
                related_node = related.get("node")
                related_id = str(
                    related.get("node_id")
                    or related.get("memory_id")
                    or getattr(related_node, "node_id", "")
                    or ""
                )
                related_content = (
                    related.get("content")
                    or getattr(related_node, "content", "")
                    or ""
                )
                related_content_key = _normalized_content(related_content)
                # Graph expansion may lead from a child fact back to the dynamic
                # episode that is already the capsule root. It may also return the
                # child itself through another path. Neither is additional evidence;
                # nesting it would print the same memory twice in one answer slot.
                if ((related_id and related_id in seen_nested_ids)
                        or (related_content_key
                            and related_content_key in seen_nested_contents)):
                    continue
                if related_id:
                    seen_nested_ids.add(related_id)
                if related_content_key:
                    seen_nested_contents.add(related_content_key)
                related_memory_at = related.get("memory_at")
                if (related_memory_at is None and related_node is not None
                        and getattr(related_node, "memory_at", None)):
                    related_memory_at = int(related_node.memory_at.timestamp())
                related_gmt_created = related.get("gmt_created")
                if (related_gmt_created is None and related_node is not None
                        and getattr(related_node, "gmt_created", None)):
                    related_gmt_created = int(related_node.gmt_created.timestamp())
                related_memories.append({
                    "memory_id": related_id,
                    "content": related_content,
                    "memory_at": related_memory_at,
                    "gmt_created": related_gmt_created,
                    "evolution_chain": list(related.get("evolution_chain") or []),
                })
            capsule_memories.append({
                "memory_id": item_id,
                "content": item_content,
                "memory_at": memory_at,
                "gmt_created": gmt_created,
                "evolution_chain": list(item.get("evolution_chain") or []),
                "related_memories": related_memories,
            })
    stored_timeline = list(parent_custom.get("timeline") or [])
    capsule_timeline = stored_timeline or [{
        "episode_id": parent_id,
        "memory_at": (
            int(parent_time.timestamp())
            if hasattr(parent_time, "timestamp") else parent_time
        ),
        "member_ids": [
            str(item.get("node_id") or getattr(item.get("node"), "node_id", "") or "")
            for _, item, _ in members
            if item.get("node_id") or getattr(item.get("node"), "node_id", "")
        ],
    }]
    capsule = {
        **parent,
        "content": parent_content,
        "score": max(float(parent.get("score") or 0.0), query_sim),
        "source": "episode_capsule",
        "_episode_render_mode": render_mode,
        "_episode_title": parent_title,
        "_episode_timeline": capsule_timeline,
        "_fact_ids": [item.get("node_id", "") for _, item, _ in members],
        "_capsule_memories": capsule_memories,
    }
    output = []
    for rank, item in enumerate(items, 1):
        if rank == first_rank:
            output.append(capsule)
        elif rank not in selected_ranks:
            output.append(item)
    return output, {
        "parent_episode_id": parent_id,
        "query_similarity": query_sim,
        "assignment_similarity": min(score for _, _, score in members),
        "first_rank": -neg_rank,
        "fact_ids": capsule["_fact_ids"],
        "render_mode": render_mode,
        "title": parent_title,
        "timeline": capsule["_episode_timeline"],
        "capsule_memories": capsule_memories,
    }


def rank_session_episode_hits(
    semantic_hits: List[Dict[str, Any]], keyword_hits: List[Dict[str, Any]],
    *, limit: int, rrf_k: int = 60,
) -> List[Dict[str, Any]]:
    """RRF-rank first-class session episodes from dedicated L3 recall pools."""
    by_id: Dict[str, Dict[str, Any]] = {}
    scores: Dict[str, float] = {}
    for hits in (semantic_hits, keyword_hits):
        rank = 0
        seen = set()
        for item in hits or []:
            if not is_session_episode(item):
                continue
            node_id = item.get("node_id")
            if not node_id or node_id in seen:
                continue
            seen.add(node_id)
            rank += 1
            by_id.setdefault(node_id, item)
            scores[node_id] = scores.get(node_id, 0.0) + 1.0 / (rrf_k + rank)
    ordered = sorted(by_id, key=lambda node_id: (-scores[node_id], node_id))[:max(0, limit)]
    return [{**by_id[node_id], "score": scores[node_id],
             "source": "session_episode_rrf"} for node_id in ordered]


def rank_dynamic_episode_hits(
    semantic_hits: List[Dict[str, Any]], keyword_hits: List[Dict[str, Any]],
    *, limit: int, semantic_min: float = 0.0, rrf_k: int = 60,
    series_only: bool = False,
) -> List[Dict[str, Any]]:
    """Rank compact dynamic episodes without making L3 an answer candidate.

    Semantic scores gate broad title/centroid matches. A lexical title hit may
    independently admit an episode because it often carries the exact named
    event that a centroid smooths away. RRF is used only to choose containers;
    its score is never added to a member L2 score.
    """
    semantic_by_id = {
        str(item.get("node_id") or ""): float(item.get("score") or 0.0)
        for item in semantic_hits or []
        if (is_series_episode(item) if series_only else is_episode_container(item))
    }
    keyword_ids = {
        str(item.get("node_id") or "")
        for item in keyword_hits or []
        if (is_series_episode(item) if series_only else is_episode_container(item))
    }
    allowed = {
        node_id for node_id, score in semantic_by_id.items()
        if node_id and score >= semantic_min
    } | {node_id for node_id in keyword_ids if node_id}

    by_id: Dict[str, Dict[str, Any]] = {}
    scores: Dict[str, float] = {}
    for hits in (semantic_hits, keyword_hits):
        rank = 0
        seen = set()
        for item in hits or []:
            if not (is_series_episode(item) if series_only else is_episode_container(item)):
                continue
            node_id = str(item.get("node_id") or "")
            if not node_id or node_id not in allowed or node_id in seen:
                continue
            seen.add(node_id)
            rank += 1
            by_id.setdefault(node_id, item)
            scores[node_id] = scores.get(node_id, 0.0) + 1.0 / (rrf_k + rank)
    from ...utils.keyword_ties import memory_content_key
    ordered = sorted(by_id, key=lambda node_id: (
        -scores[node_id], memory_content_key(by_id[node_id]),
    ))[:max(0, limit)]
    return [{
        **by_id[node_id],
        "score": scores[node_id],
        "source": "dynamic_episode_member_seed",
        "_episode_semantic": semantic_by_id.get(node_id, 0.0),
        "_episode_keyword_hit": node_id in keyword_ids,
    } for node_id in ordered]


def merge_episode_members_into_pool(
    base_items: List[Dict[str, Any]], member_items: List[Dict[str, Any]],
    *, pool_limit: int,
) -> List[Dict[str, Any]]:
    """Reserve bounded rerank-pool tail slots for unique episode member L2s.

    The base prefix remains untouched. Episode members replace only the tail and
    are judged by the same downstream cross-encoder as ordinary candidates.
    """
    if pool_limit <= 0:
        return []
    base = list(base_items[:pool_limit])
    import os
    if os.getenv("MEMORY_EPISODE_MEMBER_POOL_REPLACE_ENABLED", "true").lower() != "true":
        return base
    seen = {
        str(item.get("node_id") or "") for item in base if item.get("node_id")
    }
    additions = []
    for item in member_items:
        node_id = str(item.get("node_id") or "")
        if not node_id or node_id in seen:
            continue
        seen.add(node_id)
        additions.append(item)
    additions = additions[:pool_limit]
    if not additions:
        return base
    keep = max(0, pool_limit - len(additions))
    return base[:keep] + additions


def select_episode_fact_context(
    items: List[Dict[str, Any]], *, episode_limit: int, fact_limit: int,
) -> List[Dict[str, Any]]:
    """Return ranked narratives followed by one compact atomic-fact bundle.

    If no first-class session episode is present, return the original list so the
    feature can be enabled during a rolling migration without changing old banks.
    """
    episode_by_id = {}
    for item in items:
        if is_session_episode(item) and item.get("node_id"):
            current = episode_by_id.get(item["node_id"])
            if current is None or float(item.get("score") or 0.0) > float(current.get("score") or 0.0):
                episode_by_id[item["node_id"]] = item
    episodes = list(episode_by_id.values())
    if not episodes:
        return items
    episodes.sort(key=lambda item: float(item.get("score") or 0.0), reverse=True)
    selected_episodes = episodes[:max(0, episode_limit)]

    facts = []
    seen = set()
    for item in sorted(items, key=lambda x: float(x.get("score") or 0.0), reverse=True):
        node = item.get("node")
        if node is None or getattr(node, "layer", None) != MemoryLayer.L2_FACT:
            continue
        content = (getattr(node, "content", "") or "").strip()
        if not content or content in seen:
            continue
        seen.add(content)
        facts.append(item)
        if len(facts) >= max(0, fact_limit):
            break
    if not facts:
        return selected_episodes

    bundle = "Matched atomic facts:\n" + "\n".join(
        f"- {item['node'].content.strip()}"
        for item in facts
    )
    return selected_episodes + [{
        "node_id": "",
        "node": None,
        "content": bundle,
        "layer": MemoryLayer.L2_FACT.value,
        "score": max(float(item.get("score") or 0.0) for item in facts),
        "source": "session_episode_fact_bundle",
        "_fact_ids": [item.get("node_id", "") for item in facts],
        "_bundle_items": list(facts),
    }]
