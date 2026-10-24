"""Display one grounded supplemental proposition after ranking is complete."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Sequence, Set, Tuple

from .candidate_guards import semantic_query_terms
from .lemmatize import lemmatize_for_bm25
from .topic_candidates import query_subjects


_NESTED_FIELDS = (
    "_bundle_items", "_graph_merged_items", "related_memories",
    "_capsule_memories",
)


def _node_id(item: Dict[str, Any]) -> str:
    node = item.get("node")
    return str(
        item.get("node_id")
        or item.get("memory_id")
        or getattr(node, "node_id", "")
        or ""
    )


def _canonical_content(item: Dict[str, Any]) -> str:
    node = item.get("node")
    return str(getattr(node, "content", "") or item.get("content") or "").strip()


def _leading_subject(content: str, owner_name: str) -> str:
    user_match = re.match(
        r"(?i)^\s*the user(?:\s*\(([^)]+)\))?(?:'s|\b)", content or "",
    )
    if user_match:
        return str(user_match.group(1) or owner_name or "").casefold()
    named_match = re.match(r"^\s*([A-Z][a-z]+)(?:'s|\b)", content or "")
    return str(named_match.group(1) if named_match else "").casefold()


def _subject_supported(
    query: str, content: str, owner_name: str,
) -> Tuple[bool, Dict[str, Any]]:
    subjects = query_subjects(query, owner_name or None)
    supplement_subject = _leading_subject(content, owner_name)
    subject_present = not subjects or any(
        re.search(r"(?<!\w)" + re.escape(subject) + r"(?!\w)", content or "", re.I)
        for subject in subjects
    )
    accepted = bool(
        not subjects
        or not supplement_subject
        or supplement_subject in subjects
        or subject_present
    )
    return accepted, {
        "subjects": subjects,
        "supplement_subject": supplement_subject,
        "subject_present": subject_present,
    }


def _clone_items(items: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Copy mutable wrappers without copying vector-heavy MemoryNode objects."""
    memo: Dict[int, Dict[str, Any]] = {}

    def clone(original: Dict[str, Any]) -> Dict[str, Any]:
        identity = id(original)
        if identity in memo:
            return memo[identity]
        result = dict(original)
        memo[identity] = result
        for field in _NESTED_FIELDS:
            if result.get(field):
                result[field] = [
                    clone(child) if isinstance(child, dict) else child
                    for child in result[field]
                ]
        return result

    return [clone(item) for item in items]


def _rendered_root(item: Dict[str, Any]) -> Dict[str, Any]:
    """Return the nested object that renders this item's canonical root."""
    target_id = _node_id(item)
    seen: Set[int] = set()

    def find(current: Dict[str, Any]) -> Dict[str, Any] | None:
        identity = id(current)
        if identity in seen:
            return None
        seen.add(identity)
        for field in ("_graph_merged_items", "related_memories", "_capsule_memories"):
            for child in current.get(field) or []:
                if not isinstance(child, dict) or child is current:
                    continue
                if _node_id(child) == target_id:
                    return child
                nested = find(child)
                if nested is not None:
                    return nested
        return None

    return find(item) or item


def apply_semantic_single_supplement(
    query: str,
    items: Sequence[Dict[str, Any]],
    *,
    owner_name: str = "",
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Decorate one final canonical parent without changing ranking or order.

    All gates are uniform content checks. No question-form, benchmark category,
    qid, reference, or verdict is available here.
    """
    output = _clone_items(items)
    qterms = set(semantic_query_terms(query or ""))
    decisions: List[Dict[str, Any]] = []
    eligible: List[Tuple[Tuple[Any, ...], Dict[str, Any], Dict[str, Any]]] = []
    visited: Set[int] = set()

    def visit(item: Dict[str, Any]) -> None:
        identity = id(item)
        if identity in visited:
            return
        visited.add(identity)
        bundle_items = [
            child for child in (item.get("_bundle_items") or [])
            if isinstance(child, dict) and child is not item
        ]
        # The frozen dev195 materialization exposes top-level canonical L2 and
        # explicit A4 bundle members. Graph-attached children are not separately
        # identified by the public capture, so recursively considering them here
        # would broaden the intervention after independent validation.
        bundle_ids = {_node_id(child) for child in bundle_items if _node_id(child)}
        inspect_self = not bundle_items or _node_id(item) not in bundle_ids
        node = item.get("node")
        custom = (getattr(node, "custom", None) or {}) if node is not None else {}
        base = _canonical_content(item)
        parent_terms = set(lemmatize_for_bm25(base).split())
        parent_query_terms = qterms & parent_terms
        for index, supplement in enumerate(
            (custom.get("supplemental_propositions") or []) if inspect_self else []
        ):
            if not isinstance(supplement, dict):
                continue
            content = " ".join(str(supplement.get("content") or "").split())
            patch_terms = set(lemmatize_for_bm25(content).split())
            overlap = qterms & patch_terms
            added_query_terms = overlap - parent_query_terms
            subject_ok, subject_info = _subject_supported(query, content, owner_name)
            reasons = []
            if not content:
                reasons.append("empty_content")
            if not subject_ok:
                reasons.append("subject_conflict")
            if len(overlap) < 2:
                reasons.append("fewer_than_two_query_terms")
            if qterms and parent_query_terms == qterms:
                reasons.append("parent_already_covers_all_query_terms")
            if content and content.casefold() in base.casefold():
                reasons.append("already_in_parent")
            accepted = not reasons
            words = len(re.findall(r"\b\w+\b", content))
            decision = {
                "node_id": _node_id(item),
                "index": index,
                "source_case_id": str(supplement.get("source_case_id") or ""),
                "content": content,
                "accepted": accepted,
                "selected": False,
                "rejection_reasons": reasons,
                "query_terms": sorted(qterms),
                "overlap_terms": sorted(overlap),
                "parent_query_terms": sorted(parent_query_terms),
                "added_query_terms": sorted(added_query_terms),
                "coverage": len(overlap) / max(1, len(qterms)),
                "word_count": words,
                **subject_info,
            }
            decisions.append(decision)
            if accepted:
                rank = (
                    -len(added_query_terms), -len(overlap),
                    -decision["coverage"], words,
                    decision["node_id"], decision["source_case_id"], content,
                    index,
                )
                eligible.append((rank, item, decision))
        for child in bundle_items:
            visit(child)

    for item in output:
        visit(item)
    if not eligible:
        return output, {
            "enabled": True,
            "applied": False,
            "policy": "semantic_single_supplement_v1",
            "selected_count": 0,
            "decisions": decisions,
        }

    _, selected_item, selected = min(eligible, key=lambda value: value[0])
    base = _canonical_content(selected_item)
    _rendered_root(selected_item)["_display_content"] = (
        f"{base} {selected['content']}"
    )
    selected["selected"] = True
    return output, {
        "enabled": True,
        "applied": True,
        "policy": "semantic_single_supplement_v1",
        "selected_count": 1,
        "selected_node_id": selected["node_id"],
        "decisions": decisions,
    }
