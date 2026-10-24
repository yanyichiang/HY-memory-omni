"""
Lemmatization / Word Segmentation for BM25 Keyword Search.

Provides text preprocessing for the keyword search channel:
- English: spaCy lemmatization (en_core_web_sm)
- Chinese: jieba word segmentation
- Mixed text: split and process each part separately

Graceful fallback: if NLP libraries are not installed, applies basic tokenization.
"""

import re
import logging
from functools import lru_cache
from typing import Tuple

logger = logging.getLogger(__name__)

# ========================================================================
# Lazy-loaded NLP backends
# ========================================================================

_spacy_nlp = None
_spacy_available = None
_jieba_available = None


def _get_spacy_nlp():
    """Lazy-load spaCy NLP pipeline (English lemmatizer only)."""
    global _spacy_nlp, _spacy_available
    if _spacy_available is False:
        return None
    if _spacy_nlp is not None:
        return _spacy_nlp
    try:
        import spacy
        _spacy_nlp = spacy.load("en_core_web_sm", disable=["ner", "parser"])
        _spacy_available = True
        logger.info("[lemmatize] spaCy en_core_web_sm loaded")
        return _spacy_nlp
    except Exception as e:
        _spacy_available = False
        logger.debug(f"[lemmatize] spaCy not available, English fallback to raw text: {e}")
        return None


def _check_jieba():
    """Check if jieba is available."""
    global _jieba_available
    if _jieba_available is not None:
        return _jieba_available
    try:
        import jieba  # noqa: F401
        _jieba_available = True
        logger.info("[lemmatize] jieba available")
        return True
    except ImportError:
        _jieba_available = False
        logger.debug("[lemmatize] jieba not available, Chinese fallback to raw text")
        return False


# ========================================================================
# Text classification helpers
# ========================================================================

# CJK Unicode ranges
_CJK_PATTERN = re.compile(r'[一-鿿㐀-䶿豈-﫿]')
_EN_PATTERN = re.compile(r'[a-zA-Z]{2,}')


def _is_cjk_char(char: str) -> bool:
    """Check if a character is CJK."""
    return bool(_CJK_PATTERN.match(char))


def _split_mixed_text(text: str) -> Tuple[str, str]:
    """
    Split text into English and Chinese parts.
    Returns (english_parts, chinese_parts).
    """
    en_parts = []
    cn_parts = []

    # Split by whitespace first, then classify each token
    for token in text.split():
        if _CJK_PATTERN.search(token):
            cn_parts.append(token)
        elif _EN_PATTERN.search(token):
            en_parts.append(token)
        else:
            # Punctuation or other - include in both for coverage
            en_parts.append(token)
            cn_parts.append(token)

    return " ".join(en_parts), "".join(cn_parts)


# ========================================================================
# Lemmatization
# ========================================================================

# 月份名：spaCy 把 May 标成 AUX stopword 会丢掉时间线索；一律保留。
_MONTH_TOKENS = {
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept",
    "oct", "nov", "dec",
}


def _lemmatize_english(text: str) -> str:
    """
    English lemmatization via spaCy.

    - Lowercases text
    - Removes stopwords and punctuation（**保留月份名**，避免 May→modal 被滤）
    - Lemmatizes remaining tokens
    - Preserves -ing forms alongside lemma for ambiguity (meeting/meet)
    """
    nlp = _get_spacy_nlp()
    if nlp is None:
        # Keep the fallback useful for BM25: lowercase and strip punctuation
        # while preserving words, numbers, and common apostrophized forms.
        return " ".join(
            re.findall(r"[a-z0-9]+(?:['’-][a-z0-9]+)*", text.lower())
        )

    doc = nlp(text.lower())
    tokens = []

    for token in doc:
        raw = token.text
        # 月份优先保留（即使 is_stop）
        if raw in _MONTH_TOKENS:
            tokens.append(raw)
            continue

        if token.is_punct or token.is_stop:
            continue

        lemma = token.lemma_
        if lemma.isalnum():
            tokens.append(lemma)

        # Preserve -ing original form for ambiguity (meeting vs meet)
        if (token.text.endswith("ing") and token.text != lemma
                and token.text.isalnum()):
            tokens.append(token.text)

    return " ".join(tokens)


def _segment_chinese(text: str) -> str:
    """
    Chinese word segmentation via jieba.

    - Segments into words
    - Removes single-character tokens (mostly function words)
    - Returns space-separated tokens
    """
    if not _check_jieba():
        return text

    import jieba

    tokens = []
    for word in jieba.cut(text):
        word = word.strip()
        if len(word) >= 2:  # Skip single chars (function words, particles)
            tokens.append(word)

    return " ".join(tokens)


@lru_cache(maxsize=32768)
def _lemmatize_cached(text: str) -> str:
    """Cache immutable NLP preprocessing across concurrent rollouts.

    Candidate contents recur across facts and rollout-isolated users. spaCy and
    jieba are CPU-heavy enough that reprocessing the same text dominates local
    Qdrant candidate fusion under load.
    """
    has_cjk = bool(_CJK_PATTERN.search(text))
    has_en = bool(_EN_PATTERN.search(text))

    if has_cjk and has_en:
        en_text, cn_text = _split_mixed_text(text)
        parts = []
        if en_text.strip():
            parts.append(_lemmatize_english(en_text))
        if cn_text.strip():
            parts.append(_segment_chinese(cn_text))
        return " ".join(parts)
    if has_cjk:
        return _segment_chinese(text)
    return _lemmatize_english(text)


def lemmatize_for_bm25(text: str) -> str:
    """
    Main entry: lemmatize/segment text for BM25 keyword search.

    Handles mixed Chinese-English text:
    - English parts: spaCy lemmatization
    - Chinese parts: jieba segmentation
    - Falls back to original text if no NLP library available

    Args:
        text: Raw query or document text

    Returns:
        Preprocessed text suitable for keyword matching
    """
    if not text or not text.strip():
        return ""

    return _lemmatize_cached(text.strip())


# ========================================================================
# BM25 Score Normalization Parameters
# ========================================================================

def get_bm25_params(query: str, lemmatized: str) -> Tuple[float, float]:
    """
    Get sigmoid normalization parameters based on query characteristics.

    Returns (midpoint, steepness) for the sigmoid function:
        normalized = 1 / (1 + exp(-steepness * (raw_score - midpoint)))

    Longer queries tend to produce higher raw BM25 scores, so we adjust
    the midpoint upward.

    Args:
        query: Original query text
        lemmatized: Lemmatized query text

    Returns:
        (midpoint, steepness) tuple
    """
    # Count effective terms (proxy for query complexity)
    term_count = len(lemmatized.split()) if lemmatized else len(query.split())

    if term_count <= 2:
        # Short query: lower midpoint, steeper curve
        return (5.0, 0.8)
    elif term_count <= 5:
        # Medium query
        return (8.0, 0.5)
    else:
        # Long query: higher midpoint, gentler curve
        return (12.0, 0.3)
