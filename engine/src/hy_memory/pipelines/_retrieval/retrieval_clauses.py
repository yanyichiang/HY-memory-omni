"""Hidden retrieval clauses for long, aggregated L2 memories.

The clauses are search-only aliases.  They never become MemoryNode objects and are
never returned by get/list/search; a hit is immediately mapped back to its parent L2.
"""
from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List

from ...models.memory import MemoryLayer


def split_retrieval_clauses(content: str) -> List[str]:
    sentences = [
        part.strip()
        for part in re.split(r"(?<=[.!?])\s+|;\s+", str(content or "").strip())
        if part.strip()
    ]
    clauses: List[str] = []
    for sentence in sentences:
        comma_parts = [
            part.strip()
            for part in re.split(
                r",\s+(?=(?:and |but |while |which |who |he |she |they |the user|Evan|Sam|John|Tim))",
                sentence,
            )
            if part.strip()
        ]
        parts = comma_parts if len(sentence.split()) >= 35 and len(comma_parts) > 1 else [sentence]
        for part in parts:
            if clauses and len(part.split()) < 5:
                clauses[-1] += ", " + part
            else:
                clauses.append(part)
    return list(dict.fromkeys(clauses))


def eligible_retrieval_clauses(node: Any, *, min_words: int) -> List[str]:
    layer = getattr(node, "layer", None)
    layer_value = getattr(layer, "value", layer)
    content = str(getattr(node, "content", "") or "").strip()
    if layer_value != MemoryLayer.L2_FACT.value or len(content.split()) < min_words:
        return []
    clauses = split_retrieval_clauses(content)
    return clauses if len(clauses) > 1 else []


def select_retrieval_clause_hits(
    aliases: Iterable[Dict[str, Any]],
    *,
    existing_parent_ids: Iterable[str],
    semantic_cutoff: float,
    min_margin: float,
    cap: int,
    eligible_parent_ids: Iterable[str] | None = None,
) -> List[Dict[str, Any]]:
    """Select a bounded set of aliases that add missing parents only."""
    seen = {str(value) for value in existing_parent_ids if value}
    eligible = (
        {str(value) for value in eligible_parent_ids if value}
        if eligible_parent_ids is not None else None
    )
    selected: List[Dict[str, Any]] = []
    for alias in sorted(
        aliases or [], key=lambda item: float(item.get("score") or 0.0), reverse=True
    ):
        parent_id = str(alias.get("parent_id") or "")
        score = float(alias.get("score") or 0.0)
        if not parent_id or parent_id in seen:
            continue
        if eligible is not None and parent_id not in eligible:
            continue
        if score < float(semantic_cutoff) + float(min_margin):
            continue
        selected.append(alias)
        seen.add(parent_id)
        if len(selected) >= max(0, int(cap)):
            break
    return selected


async def sync_retrieval_clause_index(
    *,
    vector_store: Any,
    embed_service: Any,
    nodes: Iterable[Any],
    enabled: bool,
    min_words: int,
    clear_empty: bool = False,
) -> Dict[str, int]:
    """Replace aliases for the supplied parents; unsupported stores are a no-op."""
    if not enabled:
        return {"parents": 0, "clauses": 0}
    replace = getattr(vector_store, "replace_retrieval_clauses", None)
    if (
        not getattr(vector_store, "_supports_retrieval_clauses", False)
        or not callable(replace)
    ):
        return {"parents": 0, "clauses": 0}

    prepared = []
    texts = []
    for node in nodes:
        clauses = eligible_retrieval_clauses(node, min_words=min_words)
        prepared.append((node, clauses))
        texts.extend(clauses)
    embeddings = await embed_service.embed_batch(texts) if texts else []
    offset = 0
    total = 0
    for node, clauses in prepared:
        clause_embeddings = embeddings[offset:offset + len(clauses)]
        offset += len(clauses)
        # Fresh ADDs shorter than the threshold cannot have stale aliases. UPDATE
        # callers still pass the same parent id and must clear old aliases when a
        # formerly long memory becomes short; stores may expose a dedicated delete.
        if not clauses:
            delete = getattr(vector_store, "delete_retrieval_clauses", None)
            if clear_empty and callable(delete):
                await delete(node.node_id)
            continue
        await replace(node, clauses, clause_embeddings)
        total += len(clauses)
    return {"parents": len(prepared), "clauses": total}
