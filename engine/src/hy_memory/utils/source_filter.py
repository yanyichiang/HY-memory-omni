"""Canonical caller-source handling shared by API, stores, and readers."""

from typing import Iterable, List, Optional, Tuple


DEFAULT_SOURCE = "default"
MIXED_SOURCE = "mixed"


def normalize_source(value: Optional[str], *, default: str = DEFAULT_SOURCE) -> str:
    """Return the stable persisted form of a caller source."""
    normalized = str(value or "").strip().lower()
    return normalized or default


def normalize_source_filters(
    include_sources: Optional[Iterable[str]] = None,
    exclude_sources: Optional[Iterable[str]] = None,
) -> Tuple[List[str], List[str]]:
    """Normalize and de-duplicate filters while preserving caller order."""

    def _normalize(values: Optional[Iterable[str]]) -> List[str]:
        out: List[str] = []
        seen = set()
        for value in values or ():
            normalized = normalize_source(value, default="")
            if normalized and normalized not in seen:
                seen.add(normalized)
                out.append(normalized)
        return out

    include = _normalize(include_sources)
    exclude = _normalize(exclude_sources)
    # A mixed derived memory may contain evidence from any source. With any
    # caller filter active, fail closed unless the caller explicitly includes
    # "mixed". This prevents an aggregate from bypassing a source blacklist.
    if (include or exclude) and MIXED_SOURCE not in include and MIXED_SOURCE not in exclude:
        exclude.append(MIXED_SOURCE)
    return include, exclude


def source_allowed(
    source: Optional[str],
    include_sources: Optional[Iterable[str]] = None,
    exclude_sources: Optional[Iterable[str]] = None,
) -> bool:
    """Apply include AND NOT exclude semantics; exclusion always wins."""
    normalized = normalize_source(source)
    include, exclude = normalize_source_filters(include_sources, exclude_sources)
    if normalized in set(exclude):
        return False
    return not include or normalized in set(include)


def merge_sources(values: Iterable[Optional[str]]) -> str:
    """Return the sole normalized source, or ``mixed`` for multi-source data."""
    sources = {
        normalize_source(value)
        for value in values
        if value is not None and str(value).strip()
    }
    if not sources:
        return DEFAULT_SOURCE
    if len(sources) == 1:
        return next(iter(sources))
    return MIXED_SOURCE
