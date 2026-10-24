"""Deterministic owner-name gate for L6 Schema retrieval.

The search API exposes L0 basic information and L6 schemas in the same profile
bucket.  When enabled, this helper keeps L6 schemas only if the owner's name,
read from L0, occurs as a complete token sequence in the query.  It performs no
LLM or embedding calls and leaves L0 untouched.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Optional, Sequence, Tuple, List


_OWNER_NAME = re.compile(r"(?:user's name is|name is)\s+([^\.\n]+)", re.I)


def _content(item: Dict[str, Any]) -> str:
    value = item.get("content")
    if value:
        return str(value)
    node = item.get("node")
    return str(getattr(node, "content", "") or "") if node is not None else ""


def owner_name_from_l0(l0_results: Sequence[Dict[str, Any]]) -> Optional[str]:
    """Return the first explicit owner name found in L0 or its visible history."""
    for item in l0_results or []:
        texts = [_content(item)] + [
            str(entry.get("content") or "")
            for entry in item.get("evolution_chain") or []
            if isinstance(entry, dict)
        ]
        for text in texts:
            match = _OWNER_NAME.search(text)
            if match:
                name = match.group(1).strip()
                if name:
                    return name
    return None


def query_mentions_full_name(query: str, name: Optional[str]) -> bool:
    """Case-insensitive full-token-sequence match; ``Tim`` does not match Timothy."""
    if not query or not name:
        return False
    return re.search(
        r"(?<!\w)" + re.escape(name) + r"(?!\w)", query, re.I,
    ) is not None


def gate_l6_schemas(
    query: str,
    l0_results: Sequence[Dict[str, Any]],
    l6_results: Sequence[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Return L6 unchanged on an exact owner-name hit, otherwise suppress it."""
    owner_name = owner_name_from_l0(l0_results)
    matched = query_mentions_full_name(query, owner_name)
    selected = list(l6_results) if matched else []
    return selected, {
        "enabled": True,
        "policy": "owner_name_exact_v1",
        "owner_name_found": bool(owner_name),
        "owner_name_matched": matched,
        "l6_candidates": len(l6_results or []),
        "l6_returned": len(selected),
    }
