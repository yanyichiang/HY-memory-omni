"""Opt-in record-date text for BGE only; stored and returned L2 stay unchanged."""
from datetime import datetime
import math
from typing import Any, Dict


def record_date_text(item: Dict[str, Any], original: str) -> str:
    """Append a known root date only if BGE sees the exact single-root content.

    Composite/chain/clause/normalized views keep their existing text. Numeric
    dates follow the SDK's local-time conversion, not a new UTC interpretation.
    Unsupported or malformed metadata leaves the original text untouched.
    """
    node = item.get("node")
    content = getattr(node, "content", "") or ""
    at = getattr(node, "memory_at", None)
    if not content or original != content or at is None:
        return original
    if isinstance(at, bool):
        return original
    if isinstance(at, (int, float)):
        if not math.isfinite(at):
            return original
        try:
            at = datetime.fromtimestamp(at)
        except (ValueError, OverflowError, OSError):
            return original
    if not isinstance(at, datetime):
        return original
    return original + f"\nRecord date: {at:%B} {at.day}, {at.year}."
