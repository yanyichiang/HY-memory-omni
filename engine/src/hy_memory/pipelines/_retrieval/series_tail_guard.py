"""Opt-in same-scale series tail competition; never changes stored evidence."""
import math


def guarded_series_pool(base_items, member_items, similarities, *, pool_limit):
    if pool_limit <= 0:
        return [], {"admitted": [], "rejected": []}
    base = list(base_items[:pool_limit])
    seen = {item["node_id"] for item in base}
    additions = []
    for item in member_items:
        nid = item.get("node_id")
        if not nid or nid in seen:
            continue
        seen.add(nid)
        additions.append(item)
    additions = additions[:pool_limit]
    if not additions:
        return base, {"admitted": [], "rejected": []}
    prefix_size = min(len(base), max(0, pool_limit - len(additions)))
    tail = base[prefix_size:]
    competitors = tail + additions
    if any(type(similarities.get(i["node_id"])) not in (int, float) or
           not math.isfinite(similarities[i["node_id"]]) for i in competitors):
        return base, {"admitted": [], "rejected": [i["node_id"] for i in additions], "missing_vector": True}
    slots = pool_limit - prefix_size
    ranked = sorted(competitors, key=lambda i: -similarities[i["node_id"]])
    chosen = {i["node_id"] for i in ranked[:slots]}
    kept = base[:prefix_size] + [i for i in tail if i["node_id"] in chosen]
    admitted = [i for i in additions if i["node_id"] in chosen]
    return kept + admitted, {"admitted": [i["node_id"] for i in admitted],
                            "rejected": [i["node_id"] for i in additions if i["node_id"] not in chosen],
                            "displaced": [i["node_id"] for i in tail if i["node_id"] not in chosen],
                            "protected_prefix": prefix_size}
