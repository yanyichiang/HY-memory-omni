"""
BM25-lite：对内存中有限候选池（20~100 条）直接跑 BM25 公式排序。

设计取舍：
  - 不建全库倒排索引。召回池已经由向量通道/tag 通道确定，BM25 只负责在池内
    重新排序，规模 ≤ 100，纯 Python 计算微秒到毫秒级，零外部依赖
  - IDF / avgdl 的统计基数就是"当前候选池"而非全库。这样做会轻微偏置
    （稀有词在全库的 IDF 和在池内的 IDF 不同），但池的 size 足以让相对排序
    保持合理；且 BM25 分数最终只用于 RRF 的 rank，rank 对绝对分数不敏感
  - 支持中英文混合：英文按空白+标点切 token 并 lowercase，汉字段直接作为
    一个整串 token（OMEGA 原本不处理中文，这里做最低限度扩展）

该模块是纯函数实现，无副作用，便于单测。
"""

import math
import re
from collections import Counter
from typing import Dict, List, Tuple

from . import config


# 复用 intent 里的 token 正则
_TOKEN_RE = re.compile(r"[a-zA-Z0-9]+|[\u4e00-\u9fff]+")


def _tokenize(text: str) -> List[str]:
    if not text:
        return []
    return [tok.lower() if tok.isascii() else tok for tok in _TOKEN_RE.findall(text)]


def compute_bm25_scores(
    query_terms: List[str],
    candidate_contents: List[str],
    k1: float = None,
    b: float = None,
) -> List[float]:
    """
    对 candidate_contents 中每条计算 BM25 分数。

    Args:
        query_terms: 已分词的 query token 列表（与 _tokenize 保持一致的形态）
        candidate_contents: 候选 content 字符串列表
        k1, b: BM25 参数，None 时使用配置默认值

    Returns:
        与 candidate_contents 等长的 raw BM25 分数列表。
        若 query_terms 为空或池为空，返回全零。
    """
    if not query_terms or not candidate_contents:
        return [0.0] * len(candidate_contents)

    k1 = k1 if k1 is not None else config.BM25_K1
    b = b if b is not None else config.BM25_B

    N = len(candidate_contents)
    tokenized: List[List[str]] = [_tokenize(c) for c in candidate_contents]
    doc_lens: List[int] = [len(toks) for toks in tokenized]
    avgdl = (sum(doc_lens) / N) if N > 0 else 1.0
    avgdl = avgdl or 1.0  # 避免除零

    # 预计算每个 query term 的 df
    q_terms = list({t for t in query_terms if t})
    df: Dict[str, int] = {}
    for t in q_terms:
        df[t] = sum(1 for toks in tokenized if t in toks)

    # 预计算 term freq per doc（每个 doc 对 q_terms 的 Counter 投影，避免全 Counter）
    tf_per_doc: List[Dict[str, int]] = []
    for toks in tokenized:
        c = Counter(toks)
        tf_per_doc.append({t: c.get(t, 0) for t in q_terms})

    scores: List[float] = []
    for i, toks in enumerate(tokenized):
        dl = doc_lens[i] or 1
        score = 0.0
        tf_map = tf_per_doc[i]
        for t in q_terms:
            tf = tf_map.get(t, 0)
            if tf == 0:
                continue
            # IDF with +1 smoothing（BM25+，避免负 IDF）
            idf = math.log((N - df[t] + 0.5) / (df[t] + 0.5) + 1.0)
            denom = tf + k1 * (1 - b + b * dl / avgdl)
            score += idf * (tf * (k1 + 1)) / denom
        scores.append(score)

    return scores


def score_and_rank(
    query_terms: List[str],
    candidates: List[Tuple[str, str]],
) -> List[Tuple[str, float]]:
    """
    便捷函数：输入 [(id, content), ...]，返回按 BM25 降序排的 [(id, score), ...]。
    分数已除以 max 归一化到 [0, 1]（不影响 rank，便于观测）。
    """
    contents = [c for _, c in candidates]
    raw = compute_bm25_scores(query_terms, contents)
    max_s = max(raw) if raw else 0.0
    if max_s <= 0:
        norm = [0.0] * len(raw)
    else:
        norm = [s / max_s for s in raw]
    ranked = [(cid, norm[i]) for i, (cid, _) in enumerate(candidates)]
    ranked.sort(key=lambda x: x[1], reverse=True)
    return ranked


# 方便 intent 模块复用
tokenize = _tokenize
