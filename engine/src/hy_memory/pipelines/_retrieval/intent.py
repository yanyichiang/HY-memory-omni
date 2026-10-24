"""
意图分类 + query keyword 提取。

根据 query 的字面锚点与概念性问法，在三类检索意图之间选择权重策略。

三种意图：
- NAVIGATIONAL：query 含精确标识符（CamelCase/snake_case/引号短语/路径/ID/URL
  等），应关掉向量通道、加重 BM25
- CONCEPTUAL：query 问倾向/模式/态度（how/why/explain/tend to/怎么/为什么 等），
  应加重 tag 通道和向量通道
- FACTUAL：其余默认，向量主导 + tag 次之

正则只识别 NAVIGATIONAL 高置信度的字面信号，其余回退 CONCEPTUAL / FACTUAL 的
关键词触发表。FACTUAL 与 CONCEPTUAL 分错的权重差异很小，对结果影响不大；
NAVIGATIONAL 分错的代价较高（应字面匹配却被向量稀释），因此 NAV 检测写得严。
"""

import re
from typing import List

from . import config


# ================================================================
# NAVIGATIONAL 模式（OMEGA 照搬 + 轻度扩展）
# ================================================================

_NAV_PATTERNS = [
    r"`[^`]+`",                          # 反引号包裹
    r'"[^"]{2,}"',                       # 双引号精确短语
    r"'[^']{2,}'",                       # 单引号精确短语
    r"[/\\][\w.\-]+[/\\]",               # 路径（/src/foo/）
    r"\b[a-z][a-z0-9]*_[a-z0-9_]+\b",    # snake_case
    # CamelCase / camelCase / PascalCase：token 内部必须有 "小写→大写" 的切换；
    # 覆盖 "SoundCloud"、"camelCase"、"PascalCase" 等。纯全小写或全大写单词不命中。
    r"\b[A-Za-z][a-z0-9]+[A-Z][A-Za-z0-9]*\b",
    r"\bmem-[a-f0-9]{8,}\b",             # hy_memory 节点 ID
    r"\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b",  # 完整 UUID
    r"\bv?\d+\.\d+(?:\.\d+)?\b",         # 版本号 1.2 / v0.3.45
    r"\b[a-f0-9]{16,}\b",                # 长 hex 串
    r"https?://\S+",                     # URL
]

_NAV_REGEX = re.compile("|".join(_NAV_PATTERNS))


# ================================================================
# CONCEPTUAL 触发词
# ================================================================

_CONCEPTUAL_TRIGGERS = {
    # 英文
    "how", "why", "explain", "approach", "strategy", "tend", "overall",
    "architecture", "design", "philosophy", "pattern", "style",
    "in general", "generally",
    # 中文
    "怎么", "为什么", "如何", "倾向", "风格", "整体", "一般", "通常",
    "总体", "模式",
}


# ================================================================
# Keyword 提取
# ================================================================

# OMEGA 同款停用词，仅英文；中文依赖"连续汉字成 token"的弱分词
_STOPWORDS_EN = {
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "do", "does", "did", "have", "has", "had", "having",
    "my", "mine", "your", "yours", "our", "ours", "their", "theirs",
    "i", "you", "we", "they", "he", "she", "it", "me", "him", "her", "us", "them",
    "this", "that", "these", "those",
    "what", "when", "where", "who", "whom", "how", "why", "which",
    "and", "or", "but", "not", "no", "nor",
    "for", "to", "of", "in", "on", "at", "by", "from", "with", "about",
    "as", "if", "then", "than", "so", "too", "very",
    "can", "could", "would", "should", "may", "might", "will", "shall",
    "am",
}


# ================================================================
# API
# ================================================================

def is_navigational(query: str) -> bool:
    """query 是否含明确的字面标识符信号。"""
    return bool(_NAV_REGEX.search(query or ""))


def is_conceptual(query: str) -> bool:
    """query 是否是概念/倾向类问法。"""
    if not query:
        return False
    q_lower = query.lower()
    for trig in _CONCEPTUAL_TRIGGERS:
        if trig in q_lower:
            return True
    return False


def classify_intent(query: str) -> str:
    """
    返回三种意图之一：NAVIGATIONAL / FACTUAL / CONCEPTUAL。

    优先级：NAV > CONCEPTUAL > FACTUAL（默认兜底）。
    若配置了 `HY_MEMORY_READER_INTENT_OVERRIDE`，直接返回覆盖值（调试用）。
    """
    if config.INTENT_OVERRIDE in ("NAVIGATIONAL", "FACTUAL", "CONCEPTUAL"):
        return config.INTENT_OVERRIDE
    if is_navigational(query):
        return "NAVIGATIONAL"
    if is_conceptual(query):
        return "CONCEPTUAL"
    return "FACTUAL"


# 中英文混合分词：
#   - 连续的英文/数字 token 作为一词
#   - 每个连续汉字段也作为一个 token（粗分词，不做精细切分）
_TOKEN_RE = re.compile(r"[a-zA-Z0-9]+|[\u4e00-\u9fff]+")


def extract_keywords(query: str) -> List[str]:
    """
    从 query 中提取关键词序列（用于 batch embed → tag_index 匹配）。

    规则：
      - 英文/数字 token 必须 ≥ 3 字符且不在停用词表
      - 汉字 token 保留原串（作为 embedding 输入整体打向量）
      - 去重保持顺序，最多 `KEYWORD_MAX_COUNT` 个
    """
    if not query:
        return []
    raw_tokens = _TOKEN_RE.findall(query)
    seen = set()
    result: List[str] = []
    for tok in raw_tokens:
        t = tok.lower() if tok.isascii() else tok
        # 英文/数字的停用词和过短过滤
        if tok.isascii():
            if len(t) < 3 or t in _STOPWORDS_EN:
                continue
        else:
            # 汉字 token：单字意义太弱
            if len(t) < 2:
                continue
        if t in seen:
            continue
        seen.add(t)
        result.append(t)
        if len(result) >= config.KEYWORD_MAX_COUNT:
            break
    return result
