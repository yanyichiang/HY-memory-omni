"""Canonical structural metadata for organizing L2 memories.

The fields in this module are write-time semantics, not query-shape features.
They deliberately describe what a memory is about (topic hierarchy and event
facets) without encoding how a future question might be phrased.
"""

from __future__ import annotations

import json
import uuid
from typing import Any, Dict, List


EVENT_STATES = {"planned", "ongoing", "completed", "unknown"}
PARTICIPANT_ROLES = {"actor", "participant", "recipient", "affected", "subject"}
HIERARCHY_NODE_TYPES = {"topic", "facet", "series", "episode"}
HIERARCHY_NODE_TYPE_ORDER = {
    "topic": 0, "facet": 1, "series": 2, "episode": 3,
}
_HIERARCHY_NODE_TYPE_ALIASES = {
    "subtopic": "facet",
    "sub_topic": "facet",
    "activity": "facet",
    "event_series": "series",
    "event": "episode",
}


def _clean_text(value: Any, *, max_len: int = 160) -> str:
    if value is None:
        return ""
    text = " ".join(str(value).strip().split())
    return text[:max_len]


def _clean_text_list(value: Any, *, limit: int = 8) -> List[str]:
    if not isinstance(value, list):
        value = [value] if value else []
    out: List[str] = []
    seen = set()
    for item in value:
        text = _clean_text(item)
        key = text.casefold()
        if not text or key in seen:
            continue
        seen.add(key)
        out.append(text)
        if len(out) >= limit:
            break
    return out


def normalize_topic_paths(value: Any) -> List[List[str]]:
    """Validate broad-to-specific topic paths while preserving their wording.

    A flat list of strings is accepted as one path for tolerant parsing.  The
    function never invents a parent from a tag: uncertain hierarchy stays absent.
    """
    if not isinstance(value, list) or not value:
        return []
    raw_paths = [value] if all(isinstance(x, str) for x in value) else value
    out: List[List[str]] = []
    seen_paths = set()
    for raw_path in raw_paths:
        if not isinstance(raw_path, list):
            continue
        path: List[str] = []
        seen_segments = set()
        for raw_segment in raw_path:
            segment = _clean_text(raw_segment, max_len=80)
            key = segment.casefold()
            if not segment or key in seen_segments:
                continue
            seen_segments.add(key)
            path.append(segment)
            if len(path) >= 4:
                break
        path_key = tuple(segment.casefold() for segment in path)
        if not path or path_key in seen_paths:
            continue
        seen_paths.add(path_key)
        out.append(path)
        if len(out) >= 3:
            break
    return out


def normalize_event_facet(value: Any) -> Dict[str, Any]:
    """Return the small, model-authored event facet vocabulary used by Search."""
    if not isinstance(value, dict):
        return {}
    state = _clean_text(value.get("state"), max_len=24).casefold()
    if state not in EVENT_STATES:
        state = "unknown"
    participants = _clean_text_list(value.get("participants"))
    result: Dict[str, Any] = {
        "subject": _clean_text(value.get("subject")),
        "action": _clean_text(value.get("action")),
        "objects": _clean_text_list(value.get("objects")),
        "locations": _clean_text_list(value.get("locations")),
        "state": state,
    }
    # Preserve the old payload exactly when no additional participant exists.
    if participants:
        result["participants"] = participants
    if not any(
        result.get(key)
        for key in ("subject", "participants", "action", "objects", "locations")
    ) and state == "unknown":
        return {}
    return result


def normalize_topic_assignments(value: Any) -> List[Dict[str, Any]]:
    """Validate subject-specific hierarchy memberships for one canonical L2."""
    if not isinstance(value, list):
        return []
    out: List[Dict[str, Any]] = []
    seen = set()
    for raw in value:
        if not isinstance(raw, dict):
            continue
        subject = _clean_text(raw.get("subject"))
        raw_path = raw.get("path")
        names: List[str] = []
        inline_types: List[str] = []
        if isinstance(raw_path, list) and raw_path and all(
            isinstance(segment, dict) for segment in raw_path
        ):
            seen_segments = set()
            for segment in raw_path:
                name = _clean_text(segment.get("name"), max_len=80)
                key = name.casefold()
                if not name or key in seen_segments:
                    continue
                seen_segments.add(key)
                names.append(name)
                inline_types.append(_normalize_hierarchy_node_type(
                    segment.get("type") or segment.get("kind")
                ))
                if len(names) >= 4:
                    break
        else:
            paths = normalize_topic_paths(raw_path)
            names = paths[0] if paths else []
        if not subject or not names:
            continue
        role = _clean_text(raw.get("role"), max_len=24).casefold()
        if role not in PARTICIPANT_ROLES:
            role = "participant"
        raw_types = inline_types or raw.get("node_types") or raw.get("types") or []
        node_types = normalize_hierarchy_node_types(raw_types, len(names))
        if raw_types and not valid_hierarchy_node_type_sequence(node_types):
            continue
        key = (
            subject.casefold(),
            tuple(part.casefold() for part in names),
            tuple(node_types),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "subject": subject,
            "role": role,
            "path": names,
            "node_types": node_types,
        })
        if len(out) >= 6:
            break
    return out


def normalize_structure_references(value: Any) -> List[Dict[str, str]]:
    """Validate references used to canonicalize a new path from an old one."""
    if not isinstance(value, list):
        return []
    out: List[Dict[str, str]] = []
    seen = set()
    for raw in value:
        if not isinstance(raw, dict):
            continue
        memory_id = _clean_text(
            raw.get("memory_id") or raw.get("source_memory_id"), max_len=160,
        )
        subject = _clean_text(raw.get("subject"))
        through = _normalize_hierarchy_node_type(raw.get("through"))
        key = (memory_id, subject.casefold(), through)
        if not memory_id or not subject or not through or key in seen:
            continue
        seen.add(key)
        out.append({
            "memory_id": memory_id,
            "subject": subject,
            "through": through,
        })
        if len(out) >= 6:
            break
    return out


def canonicalize_assignments_from_references(
    assignments: Any,
    event_facet: Any,
    references: Any,
    existing_custom_by_id: Any,
) -> List[Dict[str, Any]]:
    """Reuse exact existing path prefixes while preserving explicit new suffixes.

    A reference is accepted only when its memory is in the caller-provided
    candidate map, its subject is explicit in the new fact, and exactly one
    source assignment contains the requested boundary type. Ambiguity fails
    closed. The function never performs fuzzy text matching.
    """
    current = normalize_topic_assignments(assignments)
    facet = normalize_event_facet(event_facet)
    allowed_subjects = {
        str(value).strip().casefold()
        for value in [facet.get("subject"), *(facet.get("participants") or [])]
        if str(value or "").strip()
    }
    source_map = existing_custom_by_id if isinstance(existing_custom_by_id, dict) else {}
    for reference in normalize_structure_references(references):
        wanted_subject = reference["subject"].casefold()
        if wanted_subject not in allowed_subjects:
            continue
        source_custom = source_map.get(reference["memory_id"])
        if not isinstance(source_custom, dict):
            continue
        matches = []
        for source_assignment in topic_assignments_from_custom(source_custom):
            if str(source_assignment.get("subject") or "").casefold() != wanted_subject:
                continue
            types = list(source_assignment.get("node_types") or [])
            if reference["through"] not in types:
                continue
            boundary = types.index(reference["through"]) + 1
            matches.append({
                "subject": source_assignment["subject"],
                "role": source_assignment.get("role") or "participant",
                "path": list(source_assignment["path"][:boundary]),
                "node_types": types[:boundary],
            })
        if len(matches) != 1:
            continue
        source_prefix = matches[0]
        replacements = [
            (index, assignment)
            for index, assignment in enumerate(current)
            if str(assignment.get("subject") or "").casefold() == wanted_subject
            and reference["through"] in (assignment.get("node_types") or [])
        ]
        if len(replacements) == 1:
            index, assignment = replacements[0]
            boundary = list(assignment["node_types"]).index(reference["through"]) + 1
            current[index] = {
                **assignment,
                "path": source_prefix["path"] + list(assignment["path"][boundary:]),
                "node_types": (
                    source_prefix["node_types"]
                    + list(assignment["node_types"][boundary:])
                ),
            }
        # A reference canonicalizes an explicitly authored new assignment; it
        # never invents a missing assignment or copies an old participation role.
    return normalize_topic_assignments(current)


def _normalize_hierarchy_node_type(value: Any) -> str:
    kind = _clean_text(value, max_len=24).casefold().replace("-", "_")
    kind = _HIERARCHY_NODE_TYPE_ALIASES.get(kind, kind)
    return kind if kind in HIERARCHY_NODE_TYPES else ""


def normalize_hierarchy_node_types(value: Any, path_length: int) -> List[str]:
    """Return one explicit structural type per path segment.

    Legacy untyped paths remain valid and conservatively become Topic -> Facet.
    Series and Episode are never inferred from depth; they must be authored.
    """
    if path_length <= 0:
        return []
    raw = value if isinstance(value, list) else []
    normalized = [_normalize_hierarchy_node_type(item) for item in raw[:path_length]]
    out: List[str] = []
    for index in range(path_length):
        explicit = normalized[index] if index < len(normalized) else ""
        out.append(explicit or ("topic" if index == 0 else "facet"))
    return out


def valid_hierarchy_node_type_sequence(value: Any) -> bool:
    """Typed paths may skip levels but must never repeat or reverse them."""
    if not isinstance(value, list) or not value:
        return False
    ranks = [HIERARCHY_NODE_TYPE_ORDER.get(str(item), -1) for item in value]
    return all(rank >= 0 for rank in ranks) and all(
        left < right for left, right in zip(ranks, ranks[1:])
    )


def strip_series_from_assignments(value: Any) -> List[Dict[str, Any]]:
    """Remove Series from one-write extraction while preserving deeper Episode.

    A single extraction call cannot prove repeated independent occurrences.
    Reconcile, which sees earlier stored writes, owns Series confirmation.
    """
    cleaned = []
    for assignment in normalize_topic_assignments(value):
        path = list(assignment.get("path") or [])
        node_types = list(assignment.get("node_types") or [])
        if "series" in node_types:
            index = node_types.index("series")
            del path[index]
            del node_types[index]
        cleaned.append({
            **assignment,
            "path": path,
            "node_types": node_types,
        })
    return normalize_topic_assignments(cleaned)


def hierarchy_path_payload(path: Any, node_types: Any = None) -> str:
    """Serialize typed paths inside the existing path_json graph property."""
    paths = normalize_topic_paths(path)
    if not paths:
        return ""
    names = paths[0]
    return json.dumps({
        "names": names,
        "types": normalize_hierarchy_node_types(node_types, len(names)),
    }, ensure_ascii=False, separators=(",", ":"))


def parse_hierarchy_path_payload(value: Any) -> Dict[str, List[str]]:
    """Read typed path_json while accepting the legacy JSON string list."""
    raw = value
    if isinstance(value, str):
        try:
            raw = json.loads(value)
        except (TypeError, ValueError):
            raw = []
    if isinstance(raw, dict):
        paths = normalize_topic_paths(raw.get("names"))
        names = paths[0] if paths else []
        return {
            "path": names,
            "node_types": normalize_hierarchy_node_types(
                raw.get("types"), len(names),
            ),
        }
    paths = normalize_topic_paths(raw)
    names = paths[0] if paths else []
    return {
        "path": names,
        "node_types": normalize_hierarchy_node_types([], len(names)),
    }


def topic_assignments_from_custom(custom: Any) -> List[Dict[str, Any]]:
    """Read assignments, falling back to legacy single-subject fields."""
    source = custom if isinstance(custom, dict) else {}
    assignments = normalize_topic_assignments(source.get("topic_assignments"))
    if assignments:
        return assignments
    facet = normalize_event_facet(source.get("event_facet"))
    subject = facet.get("subject") or ""
    return [
        {
            "subject": subject,
            "role": "subject",
            "path": path,
        }
        for path in normalize_topic_paths(source.get("topic_paths"))
        if subject
    ]


def structural_custom(
    topic_paths: Any,
    event_facet: Any,
    topic_assignments: Any = None,
) -> Dict[str, Any]:
    """Build the VDB custom fragment for explicit L2 organization metadata."""
    custom: Dict[str, Any] = {}
    paths = normalize_topic_paths(topic_paths)
    facet = normalize_event_facet(event_facet)
    assignments = normalize_topic_assignments(topic_assignments)
    if paths:
        custom["topic_paths"] = paths
    if facet:
        custom["event_facet"] = facet
    if assignments:
        custom["topic_assignments"] = assignments
    return custom


def merge_structural_custom(
    base: Any,
    *,
    topic_paths: Any = None,
    event_facet: Any = None,
    topic_assignments: Any = None,
    topic_paths_provided: bool = False,
    event_facet_provided: bool = False,
    topic_assignments_provided: bool = False,
) -> Dict[str, Any]:
    """Merge structure while distinguishing omitted fields from explicit clears."""
    merged = dict(base or {})
    if topic_paths_provided:
        paths = normalize_topic_paths(topic_paths)
        if paths:
            merged["topic_paths"] = paths
        else:
            merged.pop("topic_paths", None)
    if event_facet_provided:
        facet = normalize_event_facet(event_facet)
        if facet:
            merged["event_facet"] = facet
        else:
            merged.pop("event_facet", None)
    if topic_assignments_provided:
        assignments = normalize_topic_assignments(topic_assignments)
        if assignments:
            merged["topic_assignments"] = assignments
        else:
            merged.pop("topic_assignments", None)
    return merged


def hierarchy_topic_id(
    isolation_key: str, subject: str, path: List[str], node_types: Any = None,
) -> str:
    """Stable identity for one subject-scoped, full-path hierarchy node."""
    paths = normalize_topic_paths(path)
    if not paths:
        return ""
    identity = [
        # Isolation keys can legitimately exceed the display-field limit.
        # Truncating them aliases long project/experiment namespaces that share
        # a prefix, causing one scope to reuse another scope's graph nodes.
        " ".join(str(isolation_key or "").strip().split()),
        _clean_text(subject).casefold(),
        [segment.casefold() for segment in paths[0]],
    ]
    # Preserve IDs created by the original untyped experimental hierarchy.
    # Explicitly typed assignments include type identity so an identically
    # named Facet and Episode cannot collapse into one node.
    if node_types is not None:
        identity.append(normalize_hierarchy_node_types(node_types, len(paths[0])))
    canonical = json.dumps(
        identity,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return f"htopic_{uuid.uuid5(uuid.NAMESPACE_URL, canonical).hex[:16]}"
