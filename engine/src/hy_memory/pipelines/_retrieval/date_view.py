"""Exact date formatting for a local reranker; never changes stored evidence."""
from datetime import date, timedelta
import re

_ISO = r"\b\d{4}-\d{2}-\d{2}\b"
_RELATIVE = re.compile(r"\b(?:the\s+)?day\s+(before|after)\s+(" + _ISO + r")", re.I)


def normalize_rerank_dates(text: str) -> str:
    def relative(match):
        try:
            when = date.fromisoformat(match.group(2))
            return (when + timedelta(days=-1 if match.group(1).lower() == "before" else 1)).isoformat()
        except (ValueError, OverflowError):
            return match.group()
    text = _RELATIVE.sub(relative, text)
    def readable(match):
        try:
            when = date.fromisoformat(match.group())
            return f"{when:%B} {when.day}, {when.year}"
        except ValueError:
            return match.group()
    return re.sub(_ISO, readable, text)


def date_view_applies(query: str, mode: str = "all") -> bool:
    """A bounded diagnostic scope: normalize only explicit calendar-day queries.

    Reuse the existing generic day parser; do not add benchmark-specific words.
    """
    if mode == "all":
        return True
    if mode == "explicit_day":
        from .ner import query_day_hints
        return bool(query_day_hints(query))
    return False
