"""Remap structured memory references without rewriting user-authored text."""
from copy import deepcopy


MEMORY_REFERENCE_KEYS = frozenset({
    "episode_id", "parent_episode_id", "parent_episode_ids", "series_episode_ids",
    "source_episode_ids", "member_memory_ids", "member_ids",
    "source_raw_memory_id", "source_raw_memory_ids", "evidence_chain",
    "supersedes", "superseded_by", "source_fact_ids", "evidence_ids",
})


def remap_memory_references(value, id_map):
    """Copy metadata, mapping only known references that belong to this clone.

    Legacy episode labels and references outside an agent-scoped clone retain
    their existing meaning. Free text, session IDs and request IDs are untouched.
    """
    if isinstance(value, dict):
        result = {}
        for key, child in value.items():
            if key in MEMORY_REFERENCE_KEYS and isinstance(child, str):
                result[key] = id_map.get(child, child)
            elif key in MEMORY_REFERENCE_KEYS and isinstance(child, list):
                result[key] = [id_map.get(item, item) if isinstance(item, str)
                               else remap_memory_references(item, id_map) for item in child]
            else:
                result[key] = remap_memory_references(child, id_map)
        return result
    if isinstance(value, list):
        return [remap_memory_references(item, id_map) for item in value]
    return deepcopy(value)
