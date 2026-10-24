"""
轻量 NER 工具（spaCy），供 tag 属性标注与检索 entity×entity boost 使用。

spaCy en_core_web_*（OntoNotes）实体类型一览：
  PERSON, NORP, FAC, ORG, GPE, LOC, PRODUCT, EVENT, WORK_OF_ART, LAW, LANGUAGE
  DATE, TIME, PERCENT, MONEY, QUANTITY, ORDINAL, CARDINAL

参与 tag boost 的白名单见 BOOST_ENTITY_LABELS。
默认排除：
  - PERSON：对话里问句几乎都带说话人名字，会把整库同名 tag 记忆 +0.3 冲垮 top-k
  - LAW / LANGUAGE：极稀、噪声
  - DATE/TIME/数量类：不进入标注白名单，避免 May/2023 乱撞
"""

from __future__ import annotations

import logging
import re
import threading
from functools import lru_cache
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

logger = logging.getLogger(__name__)

# 写入 tag_ners 时可标注的类型（含 PERSON，便于排查；不代表会 boost）
ANNOTATE_ENTITY_LABELS: Set[str] = {
    "PERSON",
    "GPE",
    "LOC",
    "FAC",
    "ORG",
    "NORP",
    "PRODUCT",
    "EVENT",
    "WORK_OF_ART",
    "LAW",
    "LANGUAGE",
}

# 检索 entity×entity boost 白名单（不适类型已剔除）
BOOST_ENTITY_LABELS: Set[str] = {
    "GPE",
    "LOC",
    "FAC",
    "ORG",
    "NORP",
    "PRODUCT",
    "EVENT",
    "WORK_OF_ART",
}

# 兼容旧名：历史代码 / 测试里的 ENTITY_LABELS = 标注全集
ENTITY_LABELS: Set[str] = set(ANNOTATE_ENTITY_LABELS)

# 同类才 boost，避免 GPE×ORG 乱加分（PERSON 已不参与 boost，组仍保留供 same_group 工具）
ENTITY_GROUPS: Dict[str, Set[str]] = {
    "GEO": {"GPE", "LOC", "FAC"},
    "PERSON": {"PERSON"},
    "ORG": {"ORG", "NORP"},
    "OTHER": {"PRODUCT", "EVENT", "WORK_OF_ART", "LAW", "LANGUAGE"},
}

_LABEL_TO_GROUP = {
    lab: grp for grp, labs in ENTITY_GROUPS.items() for lab in labs
}

# TitleCase 单 token；启发式不再猜 GPE（Prius 会被误标成地点）
_TITLE_TOKEN = re.compile(r"^[A-Z][\w'-]+$")
_TOPIC_BLACKLIST = {
    "travel", "family", "health", "event", "habits", "gym", "hiking",
    "painting", "home", "music", "values", "adventure", "camping", "work",
    "hobby", "relationship", "friend", "partner", "plan", "activity",
    "lifestyle", "emotion", "feeling", "sport", "food", "art", "nature",
    "outdoor", "trip", "vacation", "exercise", "fitness", "basic_info",
}

# 地理意图：问句无 boostable 实体时，给候选 GPE/LOC/FAC tag 一个 prior（不碰 PERSON）
_GEO_INTENT_RE = re.compile(
    r"(?is)"
    r"(?:\b(?:which|what)\s+country\b)"
    r"|(?:\b(?:which|what)\s+(?:city|place|location|destination)\b)"
    r"|(?:\bwhere\b.{0,48}\b(?:visit|travel|go|went|been)\b)"
    r"|(?:\bvisit(?:ing|ed)?\b)"
    r"|(?:\broad\s*trip\b|\btrip\b)"
    r"|(?:\btravel(?:l?ing|ed)?\b)",
)
_GEO_PRIOR_LABELS: Set[str] = {"GPE", "LOC", "FAC"}
_MONTH_NAME_TO_NUM = {
    "january": 1, "jan": 1,
    "february": 2, "feb": 2,
    "march": 3, "mar": 3,
    "april": 4, "apr": 4,
    "may": 5,
    "june": 6, "jun": 6,
    "july": 7, "jul": 7,
    "august": 8, "aug": 8,
    "september": 9, "sep": 9, "sept": 9,
    "october": 10, "oct": 10,
    "november": 11, "nov": 11,
    "december": 12, "dec": 12,
}
# (year|None, month)
TimeHint = Tuple[Optional[int], int]
# (year, month, day) — day-level soft admit / boost（非 LLM）
DayHint = Tuple[int, int, int]

# The lemmatizer intentionally disables NER. Cache the separate full pipeline:
# loading it once per query/tag was spending seconds on repeated disk reads.
_ner_nlp = None
_ner_load_attempted = False
_ner_load_lock = threading.Lock()


def _get_nlp():
    """懒加载 spaCy；模型缺失时返回 None（降级：不猜类型）。"""
    global _ner_nlp, _ner_load_attempted
    if _ner_load_attempted:
        return _ner_nlp
    with _ner_load_lock:
        if not _ner_load_attempted:
            _ner_nlp = _load_nlp()
            _ner_load_attempted = True
    return _ner_nlp


def _load_nlp():
    """Load once under the initialization lock, including negative results."""
    try:
        from .lemmatize import _get_spacy_nlp
        nlp = _get_spacy_nlp()
        if nlp is not None and "ner" in getattr(nlp, "pipe_names", []):
            return nlp
    except Exception as e:
        logger.debug("[ner] spaCy via lemmatize unavailable: %s", e)
    try:
        import spacy
        for name in ("en_core_web_sm", "en_core_web_md", "en_core_web_lg"):
            try:
                nlp = spacy.load(name)
                if "ner" in nlp.pipe_names:
                    return nlp
            except Exception:
                continue
    except Exception as e:
        logger.debug("[ner] spaCy unavailable: %s", e)
    return None


@lru_cache(maxsize=32768)
def _extract_entities_cached(text: str, for_boost: bool) -> Tuple[Tuple[str, str], ...]:
    nlp = _get_nlp()
    if nlp is None:
        return ()
    allowed = BOOST_ENTITY_LABELS if for_boost else ANNOTATE_ENTITY_LABELS
    doc = nlp(text)
    return tuple(
        (ent.text.strip(), ent.label_)
        for ent in doc.ents
        if ent.label_ in allowed and ent.text.strip()
    )


def extract_entities(
    text: str,
    *,
    for_boost: bool = False,
) -> List[Tuple[str, str]]:
    """从文本抽实体 → [(span_text, label), ...]。

    for_boost=True 时只保留 BOOST_ENTITY_LABELS（检索加分用）。
    """
    if not text or not str(text).strip():
        return []
    return list(_extract_entities_cached(str(text).strip(), bool(for_boost)))


def classify_tag(tag: str) -> str:
    """给单个 tag 打 NER label；非实体返回空串。

    优先 spaCy 整段 NER。不再用 TitleCase→GPE 启发式（会把 Prius 标成地点）。
    全小写专名会再试一次 Title Case 形式供 spaCy 识别。
    """
    if not tag or not str(tag).strip():
        return ""
    t = str(tag).strip()
    # 整段跑 NER（"Weight Watchers" / "Icefields Parkway"）
    ents = extract_entities(t, for_boost=False)
    if not ents and t.islower() and t not in _TOPIC_BLACKLIST and t.isalpha():
        ents = extract_entities(t.title(), for_boost=False)
    if ents:
        best = max(ents, key=lambda x: len(x[0]))
        return best[1]
    # 不猜测：TitleCase 专名若 spaCy 不认，宁可空也不要误标 GPE
    return ""


def annotate_tag_ners(tags: Sequence[str]) -> List[str]:
    """与 tags 等长的 ner label 列表（主题词为空串）。"""
    return [classify_tag(t) for t in tags]


def has_geo_intent(query: str) -> bool:
    """问句是否在问地点/旅行（用于 geo-intent → GEO-tag prior）。"""
    return bool(_GEO_INTENT_RE.search(query or ""))


def query_time_hints(query: str) -> List[TimeHint]:
    """从问句抽 (year?, month) 软约束，如 May 2023 → [(2023, 5)]。"""
    if not query:
        return []
    q = str(query)
    hints: List[TimeHint] = []
    seen: Set[TimeHint] = set()

    def _add(year: Optional[int], month: int) -> None:
        if month < 1 or month > 12:
            return
        key = (year, month)
        if key not in seen:
            seen.add(key)
            hints.append(key)

    # 2023-05 / 2023/05 / 2023.05
    for m in re.finditer(r"\b(20\d{2})[-/.](\d{1,2})\b", q):
        _add(int(m.group(1)), int(m.group(2)))
    # May 2023 / May, 2023
    for m in re.finditer(
        r"\b(" + "|".join(_MONTH_NAME_TO_NUM.keys()) + r")\b\.?,?\s*(20\d{2})\b",
        q,
        flags=re.I,
    ):
        _add(int(m.group(2)), _MONTH_NAME_TO_NUM[m.group(1).lower()])
    # 2023 May
    for m in re.finditer(
        r"\b(20\d{2})\s+(" + "|".join(_MONTH_NAME_TO_NUM.keys()) + r")\b",
        q,
        flags=re.I,
    ):
        _add(int(m.group(1)), _MONTH_NAME_TO_NUM[m.group(2).lower()])
    # bare month name only if a year also appears somewhere
    years = [int(y) for y in re.findall(r"\b(20\d{2})\b", q)]
    if years and not hints:
        for m in re.finditer(
            r"\b(" + "|".join(_MONTH_NAME_TO_NUM.keys()) + r")\b",
            q,
            flags=re.I,
        ):
            for y in years:
                _add(y, _MONTH_NAME_TO_NUM[m.group(1).lower()])
    return hints


def query_day_hints(query: str) -> List[DayHint]:
    """从问句抽具体日 (y,m,d)，如 9th December 2023 / December 9, 2023 / 2023-12-09。

    纯正则，供 light-search 时间窗准入；不调用 LLM。
    """
    if not query:
        return []
    q = str(query)
    hints: List[DayHint] = []
    seen: Set[DayHint] = set()
    months = "|".join(_MONTH_NAME_TO_NUM.keys())

    def _add(year: int, month: int, day: int) -> None:
        if month < 1 or month > 12 or day < 1 or day > 31:
            return
        key = (year, month, day)
        if key not in seen:
            seen.add(key)
            hints.append(key)

    # ISO 2023-12-09
    for m in re.finditer(r"\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b", q):
        _add(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    # 9th December 2023 / 9 December 2023
    for m in re.finditer(
        rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s+({months})\s+(20\d{{2}})\b",
        q,
        flags=re.I,
    ):
        _add(int(m.group(3)), _MONTH_NAME_TO_NUM[m.group(2).lower()], int(m.group(1)))
    # December 9, 2023 / December 9th 2023
    for m in re.finditer(
        rf"\b({months})\s+(\d{{1,2}})(?:st|nd|rd|th)?\,?\s+(20\d{{2}})\b",
        q,
        flags=re.I,
    ):
        _add(int(m.group(3)), _MONTH_NAME_TO_NUM[m.group(1).lower()], int(m.group(2)))
    return hints


def memory_at_day_tuple(memory_at: Any) -> Optional[DayHint]:
    """把 memory_at（unix / datetime / ISO 字符串）解析成 (y,m,d)。"""
    if memory_at is None or memory_at == "":
        return None
    # datetime-like
    if hasattr(memory_at, "year") and hasattr(memory_at, "month") and hasattr(memory_at, "day"):
        try:
            return (int(memory_at.year), int(memory_at.month), int(memory_at.day))
        except (TypeError, ValueError):
            pass
    # unix seconds
    try:
        ts = float(memory_at)
        if ts > 1e11:  # ms
            ts = ts / 1000.0
        from datetime import datetime, timezone
        dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        return (dt.year, dt.month, dt.day)
    except (TypeError, ValueError, OSError, OverflowError):
        pass
    s = str(memory_at).strip()
    m = re.match(r"^(20\d{2})[-/](\d{1,2})[-/](\d{1,2})", s)
    if m:
        return (int(m.group(1)), int(m.group(2)), int(m.group(3)))
    return None


def memory_matches_day_hints(
    memory_at: Any,
    hints: Sequence[DayHint],
) -> bool:
    """无 hints → True；否则 memory_at 落在任一 (y,m,d) 即 True。"""
    if not hints:
        return True
    day = memory_at_day_tuple(memory_at)
    if day is None:
        return False
    return day in set(hints)


def memory_matches_time_hints(
    content: str,
    hints: Sequence[TimeHint],
    *,
    memory_at: Any = None,
) -> bool:
    """无 hints → True；否则 content / memory_at 命中任一月约束即可。"""
    if not hints:
        return True
    text = (content or "").lower()
    at_s = ""
    if memory_at is not None:
        at_s = str(memory_at).lower()

    for year, month in hints:
        mon_names = [k for k, v in _MONTH_NAME_TO_NUM.items() if v == month]
        yyyy_mm = f"{year:04d}-{month:02d}" if year else None
        # ISO month
        if yyyy_mm and (yyyy_mm in text or yyyy_mm in at_s):
            return True
        if yyyy_mm:
            alt = yyyy_mm.replace("-", "/")
            if alt in text or alt in at_s:
                return True
        # "may 2023" / "2023-05-20"
        if year is not None:
            for name in mon_names:
                if f"{name} {year}" in text or f"{year} {name}" in text:
                    return True
            # memory_at like 2023-05-20
            if at_s.startswith(f"{year:04d}-{month:02d}"):
                return True
            if re.search(rf"\b{year:04d}-{month:02d}[-/]\d{{1,2}}\b", text):
                return True
        else:
            for name in mon_names:
                if re.search(rf"\b{name}\b", text) or re.search(rf"\b{name}\b", at_s):
                    return True
    return False


def apply_geo_intent_prior(
    query: str,
    query_ents: Sequence[Tuple[str, str]],
    nodes: Sequence[Any],
    tag_cos_by_id: Optional[Dict[str, float]] = None,
    *,
    prior: float = 0.6,
) -> Dict[str, float]:
    """query 无 boostable 实体且具 geo-intent 时，给 GEO-tag 候选写入 prior。

    nodes: MemoryNode-like（.node_id / .tags / .tag_ners / .content / .memory_at）。
    已有 tag_cos 取 max；prior<=0 时禁用。
    """
    out: Dict[str, float] = dict(tag_cos_by_id or {})
    if prior <= 0:
        return out
    if query_ents:
        return out
    if not has_geo_intent(query or ""):
        return out
    hints = query_time_hints(query or "")
    for n in nodes or []:
        nid = getattr(n, "node_id", None) or (n.get("node_id") if isinstance(n, dict) else None)
        if not nid:
            continue
        if isinstance(n, dict):
            tags = list(n.get("tags") or [])
            ners = list(n.get("tag_ners") or [])
            content = n.get("content") or ""
            memory_at = n.get("memory_at")
        else:
            tags = list(getattr(n, "tags", None) or [])
            ners = list(getattr(n, "tag_ners", None) or [])
            content = getattr(n, "content", None) or ""
            memory_at = getattr(n, "memory_at", None)
        ents = entity_tag_pairs(tags, ners if ners else None)
        if not any((lab or "").upper() in _GEO_PRIOR_LABELS for _, lab in ents):
            continue
        if not memory_matches_time_hints(content, hints, memory_at=memory_at):
            continue
        out[str(nid)] = max(float(out.get(str(nid), 0.0)), float(prior))
    return out


def entity_tag_pairs(
    tags: Sequence[str],
    tag_ners: Optional[Sequence[str]] = None,
    *,
    for_boost: bool = True,
) -> List[Tuple[str, str]]:
    """返回实体 tag → [(tag_text, label), ...]。

    默认 for_boost=True：只保留 BOOST_ENTITY_LABELS（排除 PERSON 等）。
    """
    if not tags:
        return []
    if tag_ners is None or len(tag_ners) != len(tags):
        tag_ners = annotate_tag_ners(tags)
    allowed = BOOST_ENTITY_LABELS if for_boost else ANNOTATE_ENTITY_LABELS
    out: List[Tuple[str, str]] = []
    for t, lab in zip(tags, tag_ners):
        lab = (lab or "").strip().upper()
        if t and lab in allowed:
            out.append((str(t).strip(), lab))
    return out


def same_entity_group(label_a: str, label_b: str) -> bool:
    ga = _LABEL_TO_GROUP.get((label_a or "").upper())
    gb = _LABEL_TO_GROUP.get((label_b or "").upper())
    return bool(ga and gb and ga == gb)


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    s = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        fx = float(x)
        fy = float(y)
        s += fx * fy
        na += fx * fx
        nb += fy * fy
    if na <= 0.0 or nb <= 0.0:
        return 0.0
    return s / ((na ** 0.5) * (nb ** 0.5))


def max_entity_tag_cos(
    query_entities: Sequence[Tuple[str, str]],
    mem_entities: Sequence[Tuple[str, str]],
    embeddings: Dict[str, Sequence[float]],
    *,
    min_cos: float = 0.5,
    require_same_group: bool = True,
) -> Tuple[float, Optional[Tuple[str, str, str, str]]]:
    """query 实体 × memory 实体 tag 的最大余弦。

    embeddings: text → vector（query span 与 tag 名都要有）。
    返回 (cos_or_0, (q_text, q_lab, tag, tag_lab) | None)。
    仅当 max cos >= min_cos 时返回该 cos，否则 0。

    调用方应只传入 BOOST_ENTITY_LABELS 内的实体（本函数再滤一层兜底）。
    """
    best = 0.0
    best_pair: Optional[Tuple[str, str, str, str]] = None
    for q_text, q_lab in query_entities:
        if (q_lab or "").upper() not in BOOST_ENTITY_LABELS:
            continue
        qv = embeddings.get(q_text)
        if not qv:
            continue
        for t_text, t_lab in mem_entities:
            if (t_lab or "").upper() not in BOOST_ENTITY_LABELS:
                continue
            if require_same_group and not same_entity_group(q_lab, t_lab):
                continue
            tv = embeddings.get(t_text)
            if not tv:
                continue
            c = cosine(qv, tv)
            if c > best:
                best = c
                best_pair = (q_text, q_lab, t_text, t_lab)
    if best >= min_cos:
        return best, best_pair
    return 0.0, best_pair
