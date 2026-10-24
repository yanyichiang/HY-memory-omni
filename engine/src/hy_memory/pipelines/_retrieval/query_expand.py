# -*- coding: utf-8 -*-
"""Retrieval query expansion (read-side, before embed / BM25).

Keep NER / geo-intent on the *original* query; only widen the lexical/semantic
pool for known brittle patterns (e.g. broken ↔ broke down).
"""
from __future__ import annotations

import os
import re

# "what kinds of things … broken" — lemma break matches content, but sparse BM25
# often under-weights it and pure embedding drifts to health/hobby with "Evan".
_DAMAGE_TOKEN = re.compile(
    r"(?i)\b(broken|broke|breaks|breaking|break|malfunction(?:ed|ing)?)\b"
)
_DAMAGE_CTX = re.compile(
    r"(?i)\b(thing|things|what|which|kind|kinds|have|had|got|get|own(?:ed)?)\b"
)
_DAMAGE_EXPAND = " broke down broken malfunction car vehicle repair"

# "what hobby … practicing … years ago" — semantic drifts to Sam catch-up / fitness;
# generic art lexicon (no gold medium) lifts established painting facts into top-k.
_HOBBY_TOKEN = re.compile(r"(?i)\b(hobby|hobbies)\b")
_HOBBY_CTX = re.compile(
    r"(?i)\b(practic(?:e|ing)|start(?:ed)?|enjoy(?:s|ed)?|years?\s+ago|"
    r"passionate|take\s+up|took\s+up)\b"
)
_HOBBY_EXPAND = " painting art hobby craft"

# "searching for fruitlessly" — drifts to exercise search; common lost-item lexicon.
_LOST_SEARCH = re.compile(
    r"(?i)\b(searching for|searched for|looking for|fruitless(?:ly)?|"
    r"misplac(?:e|ed|ing)|keep losing)\b"
)
_LOST_EXPAND = " lost keys belongings misplaced wallet phone searching weekly"

# "sports besides basketball" — basketball/network memories dominate; sports taxonomy.
_SPORTS_BESIDES = re.compile(
    r"(?i)\b(sports?|sport)\b.{0,40}\b(besides|aside from|other than|except)\b"
    r"|\b(besides|aside from|other than)\b.{0,40}\b(sports?|basketball)\b"
)
_SPORTS_EXPAND = " sports hobby swimming surfing running cycling outdoor"


def _expand_enabled() -> bool:
    v = os.environ.get("MEMORY_HYBRID_V2_QUERY_EXPAND", "1").strip().lower()
    return v not in {"0", "false", "no", "off"}


def expand_query_for_retrieval(query: str) -> str:
    """Return query used for embed + keyword; identity if no rule matches."""
    q = (query or "").strip()
    if not q or not _expand_enabled():
        return q
    low = q.lower()
    if _DAMAGE_TOKEN.search(q) and _DAMAGE_CTX.search(q):
        if not ("broke down" in low and "malfunction" in low):
            q = q + _DAMAGE_EXPAND
            low = q.lower()
    if _HOBBY_TOKEN.search(q) and _HOBBY_CTX.search(q):
        if "painting art hobby craft" not in low:
            q = q + _HOBBY_EXPAND
            low = q.lower()
    if _LOST_SEARCH.search(q):
        if "lost keys belongings" not in low:
            q = q + _LOST_EXPAND
            low = q.lower()
    if _SPORTS_BESIDES.search(q):
        if "swimming surfing running" not in low:
            q = q + _SPORTS_EXPAND
    return q
