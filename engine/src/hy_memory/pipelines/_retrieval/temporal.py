"""读侧时间过滤（created_after）的统一口径。

`created_after` 的语义是「记忆描述的事件发生在该时间之后」，因此按**事件时间**
`memory_at` 过滤，`memory_at` 为空才回退落库时间 `gmt_created`。
按 gmt_created 过滤在批量灌入场景下等于失效（一次导入的记忆 gmt_created 几乎同一时刻），
详见 `data/vector_store_base.node_effective_time`。

分工：
- **能下推的下推**：`vector_store.search()` 接 `created_after`，让 VDB 侧先过滤，省召回量。
- **末端统一兜底**：`keyword_search()`（BM25）、graph 通道等并不都支持该参数，
  所以每个 reader 在产出最终结果前再统一过一遍本模块的 gate，保证没有通道能绕过过滤。
"""

from typing import Any, Dict, List, Optional


def hit_effective_ts(hit: Dict[str, Any]) -> Optional[float]:
    """取一条召回结果的有效时间戳（unix 秒）。

    优先 `node.memory_at`，回退 `node.gmt_created`；node 为 None（graph 通道结果）
    时退回 hit dict 上的同名字段。都取不到返回 None。
    """
    node = hit.get("node")

    for attr in ("memory_at", "gmt_created"):
        v = getattr(node, attr, None) if node is not None else hit.get(attr)
        if v is None or v == "":
            continue
        ts = getattr(v, "timestamp", None)
        if callable(ts):
            try:
                return float(ts())
            except (TypeError, ValueError, OSError):
                continue
        try:
            return float(v)
        except (TypeError, ValueError):
            continue
    return None


def filter_hits_by_created_after(
    hits: List[Dict[str, Any]],
    created_after: Optional[float],
) -> List[Dict[str, Any]]:
    """按 created_after 过滤召回结果。

    时间字段完全取不到的结果**保留** —— 宁可多召回，也不因为缺字段静默丢数据
    （graph 通道结果、历史数据都可能没有时间字段）。
    """
    if not created_after or not hits:
        return hits
    threshold = float(created_after)
    return [
        h for h in hits
        if (ts := hit_effective_ts(h)) is None or ts >= threshold
    ]
