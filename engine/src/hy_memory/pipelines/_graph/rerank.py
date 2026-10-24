"""读侧：记忆关系图怎么参与打分。

三种用法需要三套不同的数学，最常见的错误是拿一套加权去干这三件事：

| 用法 | 做什么 | 解决什么失败 | 引入新候选 |
|---|---|---|---|
| **A** `propagate_support` | 在**截断前的扩池结果内部**重排 | 分数接近时排序是噪声 | **不会** |
| **B** `relax_admission` | 让被强命中支持的候选**降低准入门槛** | 相关但相似度低，被阈值挡掉 | 会（有界） |
| **C** `find_relation_paths` | 输出连接两个命中的**路径** | 关系语义在平铺列表里丢了 | 少量 |

关键取舍（详见 `docs/pro_graph_design.md` §3）：

1. **A 必须作用在截断前的扩池结果上**。只把已选出的 top-10 换个顺序收益很小；
   有价值的是从几十条候选里重新决定哪 10 条进最终结果。
2. **B 绝不给扩展候选"发明"图分数**。图分和语义分不同量纲，硬融合就是靠拍系数把不可比的
   东西凑一起。正确做法是图只动态放宽准入阈值，最终分仍是候选自己与 query 的相似度 ——
   图修正的是**召回漏检**，不是相关性判断，所以永远不可能把真正不相关的东西捧上来。
3. **tag 共属不作为遍历边**（τ=0）。它是分类关系而非关联关系：一个 `work` 标签下 200 条
   记忆彼此"相关度相同"，既弱又均匀，且高频 tag 形成 hub。tag 的正确用法是读侧
   **打分通道**（query BM25 terms ∩ mem.tags，权重高于 co_occur）以及 filter/boost。
4. **用法 B 硬闸**：`sim(cand) ≥ seed_sim − δ`（默认 δ=0.2），替代旧的
   `min_score·(1−γ·support)` 松弛门槛。扩展通过闸后按时间并进 seed（`\\n\\n`），
   不单独占 top-k 坑。
"""

import logging
import math
import re
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)


# 边类型先验 τ。判据是**这条边能否提供向量检索本身拿不到的信息**。
TYPE_PRIOR: Dict[str, float] = {
    # LLM 标注：两端余弦往往很低，向量检索永远发现不了 → 信息量最高
    "causes": 0.9,
    "contrasts": 0.7,
    "elaborates": 0.9,
    # Independent dated occurrences of the same concrete activity/event type.
    "same_series": 0.85,
    # 时序脊：同 Topic 内的递进关系，有向。回答"X 之后/之前"靠它
    "temporal_next": 0.7,
    # 共同写入：仍参与邻域扩展，但先验低于 typed 边；最终分里 co_occur 通道权重也更低
    # （相对 tag∩keyword）。噪声靠度数归一化 + seed_sim 硬闸控制。
    "co_occurs": 0.55,
    # 确定性：记录的就是"语义相近"，而这正是向量索引本来就知道的事 → 高度冗余
    "semantic_neighbor": 0.35,
    # Episode 共属：同一次讨论（跨 write 批次）。不走边，由 episode_id 字段框出，
    # 本质是"跨批次延长的 co_occurs"，先验与之对齐
    "episode": 0.55,
    # 兜底（老数据里 System 2 写的无类型 RELATED_TO）
    "related": 0.5,
}
_DEFAULT_PRIOR = 0.5

# 读侧一律过滤的图节点状态：被判重逻辑删除的记忆不能从图里绕回来
_EXCLUDED_STATUS = {"shadow"}


def edge_prior(relation_type: Optional[str]) -> float:
    return TYPE_PRIOR.get((relation_type or "").lower(), _DEFAULT_PRIOR)


def filter_relation_edges(
    edges: Iterable[Dict[str, Any]], *, include_same_series: bool,
) -> List[Dict[str, Any]]:
    """Apply feature gates before graph edges affect ranking or admission."""
    return [
        edge for edge in (edges or [])
        if include_same_series
        or str(edge.get("relation_type") or "").lower() != "same_series"
    ]


def build_adjacency(
    edges: Iterable[Dict[str, Any]],
    *,
    exclude_status: Optional[Set[str]] = None,
) -> Dict[str, List[Tuple[str, str, float]]]:
    """把 `graph_store.get_related_edges()` 的结果建成无向邻接表。

    同一对节点之间可能有多种关系（既 `co_occurs` 又 `causes`）。这里**折叠成一条、
    取有效权重最大的那种**：度数应该数"有多少个不同的邻居"，而不是"有多少条平行边"，
    否则 hub 降权（`sqrt(deg)`）会被平行边稀释，支持度也会重复计。

    Returns:
        {node_id: [(neighbor_id, relation_type, effective_weight), ...]}
        `effective_weight` = 边权 × 类型先验 τ，后续公式直接用它。
    """
    excluded = exclude_status if exclude_status is not None else _EXCLUDED_STATUS
    # (node, neighbor) -> (relation_type, effective_weight)，只保留最强的
    best: Dict[Tuple[str, str], Tuple[str, float]] = {}

    for e in edges or []:
        src, tgt = e.get("source_id"), e.get("target_id")
        if not src or not tgt or src == tgt:
            continue
        if (e.get("target_status") or "").lower() in excluded:
            continue
        # 有向边（TEMPORAL_NEXT）从两端都可能命中，source 侧也要过滤 shadow
        if (e.get("source_status") or "").lower() in excluded:
            continue
        rtype = e.get("relation_type") or "related"
        try:
            w = float(e.get("weight", 1.0))
        except (TypeError, ValueError):
            w = 1.0
        eff = max(0.0, min(w, 1.0)) * edge_prior(rtype)
        # 邻接表本身是无向的（A/B 只关心"挨着"）；方向信息由 forward_dirs 单独保留
        for a, b in ((src, tgt), (tgt, src)):
            prev = best.get((a, b))
            if prev is None or eff > prev[1]:
                best[(a, b)] = (rtype, eff)

    adj: Dict[str, List[Tuple[str, str, float]]] = {}
    for (a, b), (rtype, eff) in best.items():
        adj.setdefault(a, []).append((b, rtype, eff))
    return adj


def collect_directed_edges(edges: Iterable[Dict[str, Any]]) -> Set[Tuple[str, str]]:
    """收集有向边的正向 (source, target) 集合（目前只有 `temporal_next`）。

    邻接表刻意做成无向的 —— 用法 A/B 只关心"挨着"。但用法 C 输出路径时要能说清
    方向，否则"X 之后发生了什么"和"X 之前"分不开。
    """
    out: Set[Tuple[str, str]] = set()
    for e in edges or []:
        if not e.get("directed"):
            continue
        src, tgt = e.get("source_id"), e.get("target_id")
        if src and tgt and src != tgt:
            out.add((src, tgt))
    return out


# ================================================================
# 用法 A：池内支持度传播
# ================================================================

def propagate_support(
    scores: Dict[str, float],
    adjacency: Dict[str, List[Tuple[str, str, float]]],
    *,
    beta: float = 0.15,
    iterations: int = 1,
    support_cap: float = 1.0,
) -> Tuple[Dict[str, float], Dict[str, float]]:
    """在**已召回池内部**做图正则化重排。

        support(v) = Σ_{u ∈ N(v) ∩ P, u≠v}  eff_w(u,v) · s(u)  /  sqrt(deg_pool(v))
        s'(v)      = s0(v) + beta · min(support(v), support_cap)

    三个护栏都在公式里：
      - `∩ P`（只在池内传播）→ 不引入新候选，不会 hub fan-out；
      - `sqrt(deg_pool(v))` 度数归一化 → 这是 tag hub 问题的直接解药（图上的 IDF 类比）；
      - `beta` 小 + `support_cap` → 这是**微调**而非重写排序。beta 大到能让排序翻天覆地，
        就说明在用图代替检索，一定掉精度。

    Args:
        scores: {node_id: s0}，直接召回分（**截断前的扩池结果**）
        adjacency: build_adjacency() 的产物
        iterations: 传播轮数，1~2 足够；更多轮收益递减且开始糊化

    Returns:
        (新分数 dict, support dict)。support 单独返回，供观测和用法 B 复用。
    """
    if not scores or not adjacency or beta <= 0:
        return dict(scores), {}

    pool = set(scores)
    # 池内度数（只算两端都在池里的边）
    deg: Dict[str, int] = {}
    for v in pool:
        deg[v] = sum(1 for (nb, _t, _w) in adjacency.get(v, []) if nb in pool)

    s0 = dict(scores)
    cur = dict(scores)
    support: Dict[str, float] = {}

    for _ in range(max(1, iterations)):
        nxt: Dict[str, float] = {}
        for v in pool:
            raw = 0.0
            for nb, _rtype, eff_w in adjacency.get(v, []):
                if nb == v or nb not in pool:
                    continue
                raw += eff_w * cur.get(nb, 0.0)
            d = deg.get(v, 0)
            sup = raw / (d ** 0.5) if d > 0 else 0.0
            support[v] = sup
            nxt[v] = s0[v] + beta * min(sup, support_cap)
        cur = nxt

    return cur, support


# ================================================================
# 用法 B：阈值松弛（图只降低门槛，绝不发明相关性）
# ================================================================

# 边类型分组，用于扩展时按类型分配配额。
#
# 时间边数量天然最多、信息量最低（同一天写的东西不一定有关系）；关系边最少但信息量最高
# （`causes` 两端的向量相似度可能很低，是向量检索永远找不到的）。不分配额的话，
# 时间边会把关系边从 top-N 里挤出去 —— 这和 tag hub 淹没结果是同一类问题。
_RELATIONAL_TYPES = {"causes", "elaborates", "contrasts", "same_series",
                     "co_occurs", "related",
                     "episode"}
_TEMPORAL_TYPES = {"temporal_next"}


def edge_group(relation_type: Optional[str]) -> str:
    rt = (relation_type or "").lower()
    if rt in _TEMPORAL_TYPES:
        return "temporal"
    if rt == "semantic_neighbor":
        return "semantic"
    return "relational"


def normalize_by_degree(
    adjacency: Dict[str, List[Tuple[str, str, float]]],
) -> Dict[str, List[Tuple[str, str, float]]]:
    """按度数给边权贬值：`eff_w /= sqrt(deg(neighbor))`。

    高连接节点（同一天写了很多条、或话题 hub）的每一条边都更不具区分度。
    这是图上的 IDF 类比，也是时间边能不能安全参与扩展的前提 ——
    否则一个高产的日子会把当天所有记忆等权拉进来。
    """
    deg = {n: len(nbs) for n, nbs in (adjacency or {}).items()}
    out: Dict[str, List[Tuple[str, str, float]]] = {}
    for node, nbs in (adjacency or {}).items():
        scaled = []
        for nb, rtype, eff in nbs:
            d = deg.get(nb, 1) or 1
            scaled.append((nb, rtype, eff / (d ** 0.5)))
        out[node] = scaled
    return out


def reachable_within(
    seed_scores: Dict[str, float],
    adjacency: Dict[str, List[Tuple[str, str, float]]],
    *,
    hops: int = 2,
    seed_floor: float = 0.6,
    hop_decay: float = 0.5,
    max_nodes: int = 200,
    multi_seed_bonus: float = 0.5,
) -> Dict[str, Tuple[float, str, str, int]]:
    """从高分 seed 出发做 BFS，返回池外可达节点的结构支持度。

    这是**关系型结构多跳**的实现：`causes` / `co_occurs` / `temporal_next` 这些边
    可以串起来走，"朋友推荐的餐厅"这类问题的两端往往隔着一个中间节点。

    支持度沿路衰减：`support = Π(eff_w) · hop_decay^(hop-1) · s0(seed)`。
    衰减 + 节点预算是必须的 —— 2 跳不加约束就等于把整个连通分量拉进来。

    **多 seed 佐证**：单个 seed 指向一个候选可能是巧合，**两个不同 seed 同时指向它**
    才是真正的佐证（同一个"互相佐证"逻辑，用法 A 用在池内、这里用在扩展）。
    所以 support 不是简单取 max，而是"最强路径 + 其余 seed 的贡献 × multi_seed_bonus"。
    例：query 同时命中「吃饭」和「骑车」，两者都指向「公园」→ 公园显著上浮。

    Returns:
        {node_id: (support, via_seed, relation_type_of_first_edge, hop)}
    """
    if hops < 1 or not seed_scores or not adjacency:
        return {}

    in_pool = set(seed_scores)
    seeds = sorted(
        [(nid, s) for nid, s in seed_scores.items() if s >= seed_floor],
        key=lambda x: x[1], reverse=True,
    )
    if not seeds:
        return {}

    # cand -> {seed: (best_support_from_that_seed, first_rel, hop)}
    per_seed: Dict[str, Dict[str, Tuple[float, str, int]]] = {}
    # frontier: (node, 累计权重, via_seed, 首跳关系, hop)
    frontier: List[Tuple[str, float, str, str, int]] = [
        (nid, s, nid, "", 0) for nid, s in seeds
    ]
    visited = set(in_pool)

    for hop in range(1, hops + 1):
        nxt: List[Tuple[str, float, str, str, int]] = []
        for cur, acc, via, first_rel, _h in frontier:
            for nb, rtype, eff_w in adjacency.get(cur, []):
                if nb == cur:
                    continue
                # 跳数衰减：第 1 跳不衰减，之后每跳乘 hop_decay
                sup = acc * eff_w * (hop_decay ** (hop - 1))
                rel = first_rel or rtype
                if nb not in in_pool:
                    slot = per_seed.setdefault(nb, {})
                    prev = slot.get(via)
                    if prev is None or sup > prev[0]:
                        slot[via] = (sup, rel, hop)
                if nb not in visited and hop < hops:
                    visited.add(nb)
                    nxt.append((nb, acc * eff_w, via, rel, hop))
            if len(per_seed) >= max_nodes:
                break
        if len(per_seed) >= max_nodes:
            break
        frontier = nxt
        if not frontier:
            break

    # 合成：最强路径全额 + 其余 seed 的贡献打折累加（有界，避免多 seed 无限叠）
    best: Dict[str, Tuple[float, str, str, int]] = {}
    for cand, slots in per_seed.items():
        ranked = sorted(slots.items(), key=lambda kv: kv[1][0], reverse=True)
        top_seed, (top_sup, top_rel, top_hop) = ranked[0]
        extra = sum(s[0] for _sid, s in ranked[1:])
        best[cand] = (
            top_sup + multi_seed_bonus * extra, top_seed, top_rel, top_hop,
        )
    return best


def apply_type_quota(
    reach: Dict[str, Tuple[float, str, str, int]],
    *,
    top_n: int,
    quotas: Optional[Dict[str, float]] = None,
) -> Dict[str, Tuple[float, str, str, int]]:
    """按边类型分配 top-N 配额，再按 support 截断。

    为什么必须分组：时间边数量天然最多、信息量最低；关系边最少但信息量最高
    （`causes` 两端余弦可能很低，向量检索永远找不到）。不分配额的话时间边会把关系边
    从 top-N 里挤出去。

    这一步是**免费的**（纯本地排序），必须放在"批量取向量算相似度"之前 ——
    算相似度是整条链路上唯一有 I/O 成本的一步。
    """
    if top_n <= 0 or not reach:
        return {}
    q = quotas or {"relational": 0.5, "temporal": 0.3, "semantic": 0.2}

    grouped: Dict[str, List[Tuple[str, Tuple[float, str, str, int]]]] = {}
    for cand, val in reach.items():
        grouped.setdefault(edge_group(val[2]), []).append((cand, val))

    out: Dict[str, Tuple[float, str, str, int]] = {}
    for group, items in grouped.items():
        items.sort(key=lambda kv: kv[1][0], reverse=True)
        budget = max(1, int(round(top_n * q.get(group, 0.0))))
        for cand, val in items[:budget]:
            out[cand] = val

    # 配额没用满时，用全局最强的候选补齐
    if len(out) < top_n:
        rest = sorted(
            ((c, v) for c, v in reach.items() if c not in out),
            key=lambda kv: kv[1][0], reverse=True,
        )
        for cand, val in rest[: top_n - len(out)]:
            out[cand] = val
    return out


def episode_support(
    hits: List[Dict[str, Any]],
    episode_members: Dict[str, List[str]],
    *,
    seed_floor: float = 0.6,
    weight: float = 0.7,
    multi_seed_bonus: float = 0.5,
) -> Dict[str, Tuple[float, str, str, int]]:
    """把 episode 共属折算成结构支持度，形状与 `reachable_within` 一致，可直接进同一漏斗。

    Episode 是"一次讨论"（跨 write 批次，SDK 内部按时间间隔切）。同一 episode 的记忆
    彼此有真实关联，但向量可能互不相似 —— 这正是向量检索找不到的那部分。

    为什么用字段而不是边：一个 episode 10-30 条记忆，两两连边是 45-435 条；
    一个 `episode_id` + 一次过滤查询就够，而且**不依赖图**（graph 关掉也能用）。

    与 tag 桥接（τ=0，已否决）的区别：`work` 标签下可能有跨年的 200 条，是**分类关系**；
    episode 是同一次讨论的 10-30 条，是**情节关系** —— 本质上是"跨批次延长的 co_occurs"。

        support(c) = weight / sqrt(episode_size) · s0(seed)

    `sqrt(episode_size)` 归一化：episode 越大，单条共属越不具区分度（同 tag hub 的道理）。
    多 seed 佐证同样适用：两个高分命中同属一个 episode 时，该 episode 的成员更可信。

    Args:
        hits: 直接命中（用来挑 seed，也用来排除已在池内的）
        episode_members: {episode_id: [member_node_id, ...]}，调用方从 VDB 框出来

    Returns:
        {node_id: (support, via_seed, "episode", 1)}
    """
    if not hits or not episode_members:
        return {}

    in_pool = {h.get("node_id") for h in hits if h.get("node_id")}
    # episode_id → 该 episode 下分数最高的几个 seed
    seeds_by_ep: Dict[str, List[Tuple[str, float]]] = {}
    for h in hits:
        score = float(h.get("score", 0.0))
        if score < seed_floor:
            continue
        node = h.get("node")
        ep = (getattr(node, "episode_id", "") or "") if node is not None else ""
        if not ep or ep not in episode_members:
            continue
        seeds_by_ep.setdefault(ep, []).append((h.get("node_id") or "", score))

    out: Dict[str, Tuple[float, str, str, int]] = {}
    for ep, seeds in seeds_by_ep.items():
        members = [m for m in episode_members.get(ep, []) if m and m not in in_pool]
        if not members:
            continue
        size = max(2, len(episode_members.get(ep, [])))
        base = weight / (size ** 0.5)
        seeds.sort(key=lambda x: x[1], reverse=True)
        top_seed, top_score = seeds[0]
        extra = sum(s for _sid, s in seeds[1:])
        sup = base * (top_score + multi_seed_bonus * extra)
        for m in members:
            prev = out.get(m)
            if prev is None or sup > prev[0]:
                out[m] = (sup, top_seed, "episode", 1)
    return out


def blend_support(
    graph_reach: Dict[str, Tuple[float, str, str, int]],
    episode_reach: Dict[str, Tuple[float, str, str, int]],
    *,
    lam: float = 0.3,
    support_cap: float = 1.0,
) -> Dict[str, Tuple[float, str, str, int]]:
    """把「图边可达」与「episode 共属」两条来源的支持度**有界叠加**，而不是取 max。

    为什么不能取 max：这是**两个独立观察**。`co_occurs` 说"这两条是同一段话里抽出来的"，
    episode 共属说"这两条属于同一件事，哪怕隔了几次写入"。两者同时成立时，该候选比
    只成立一个更可信；取 max 等于宣布"多一个独立证据不加分"。

    而且取 max 会**系统性偏向粗粒度信号**：episode 的支持度被 `sqrt(episode_size)`
    归一化压着，天然小于 `co_occurs`，所以 max 几乎总是选中图边 —— episode 通道在
    "有共现边的候选"上等于完全不起作用，只在跨批次、无共现边的候选上才有效。

        support = min(support_cap, s_graph + lam · s_episode)

    用折扣系数而不是直接相加，是为了避免两个弱证据叠出一个强结论；`support_cap`
    封顶保证准入门槛最多降到 `(1 - gamma) · min_score`，护栏不变。
    这与 `reachable_within` 里对多 seed 佐证的处理是同一套逻辑（最强的全额 + 其余打折）。

    归属信息（via_seed / relation_type / hop）取**支持度更强**的那一侧，便于观测。
    """
    if not episode_reach:
        return dict(graph_reach or {})
    out: Dict[str, Tuple[float, str, str, int]] = dict(graph_reach or {})
    for cand, (ep_sup, ep_seed, ep_type, ep_hop) in episode_reach.items():
        prev = out.get(cand)
        if prev is None:
            out[cand] = (min(ep_sup, support_cap), ep_seed, ep_type, ep_hop)
            continue
        g_sup, g_seed, g_type, g_hop = prev
        merged = min(g_sup + lam * ep_sup, support_cap)
        if ep_sup > g_sup:
            out[cand] = (merged, ep_seed, ep_type, ep_hop)
        else:
            out[cand] = (merged, g_seed, g_type, g_hop)
    return out


def apply_temporal_affinity(
    reach: Dict[str, Tuple[float, str, str, int]],
    *,
    times: Dict[str, float],
    tau_days: float = 7.0,
    floor: float = 0.3,
) -> Dict[str, Tuple[float, str, str, int]]:
    """给结构支持度乘一个**时间亲和**因子：与锚点写得越近，联系越可能真实。

    这是打分的第二个维度（第一个是内容：边权 × 候选自身与 query 的相似度）。

    动机来自这样一次写入："我今天去公园玩了，是骑车去的，今天还去吃了东西" ——
    公园 / 骑车 / 吃饭是**一起**被记下来的。之后问"上周吃饭的地方在哪"，
    向量检索可能只捞到「吃饭」而捞不到「公园」，但它们同一时间点写入这件事本身
    就是强信号。同批次的 `co_occurs` 边天然满足 Δt≈0 → 因子=1。

        factor = clamp(exp(-Δdays / tau_days), floor, 1.0)

    `floor` 不设 0：时间远但关系强（如 LLM 标的 `causes`）的边不该被时间抹平。
    取不到时间的节点按 1.0 处理 —— 不因缺字段惩罚。
    """
    if not reach or not times:
        return reach
    out: Dict[str, Tuple[float, str, str, int]] = {}
    tau_sec = max(1.0, tau_days * 86400.0)
    for cand, (sup, via, rel, hop) in reach.items():
        t_c, t_s = times.get(cand), times.get(via)
        if t_c is None or t_s is None:
            out[cand] = (sup, via, rel, hop)
            continue
        factor = math.exp(-abs(t_c - t_s) / tau_sec)
        factor = max(floor, min(1.0, factor))
        out[cand] = (sup * factor, via, rel, hop)
    return out


def temporal_affinity_factor(
    t_cand: Optional[float],
    t_seed: Optional[float],
    *,
    tau_days: float = 7.0,
    floor: float = 0.3,
) -> float:
    """单对 (cand, seed) 的时间亲和 ∈ [floor, 1]；缺时间按 1.0。"""
    if t_cand is None or t_seed is None:
        return 1.0
    tau_sec = max(1.0, tau_days * 86400.0)
    factor = math.exp(-abs(t_cand - t_seed) / tau_sec)
    return max(floor, min(1.0, factor))


_TERM_RE = re.compile(r"[a-z0-9\u4e00-\u9fff]+", re.I)


def tokenize_query_terms(query: str) -> List[str]:
    """轻量分词：用于 BM25/tag 通道（不引入 LLM；评测单 query 路径可用）。"""
    if not query:
        return []
    return [t.lower() for t in _TERM_RE.findall(query) if len(t) > 1]


def keyword_content_overlap(terms: List[str], content: str) -> float:
    """query terms 命中 content 的比例 ∈ [0, 1]。"""
    if not terms or not content:
        return 0.0
    blob = content.lower()
    hit = sum(1 for t in terms if t in blob)
    return hit / len(terms)


def tag_keyword_overlap(terms: List[str], tags: Optional[Iterable[str]]) -> float:
    """query BM25 terms ∩ mem.tags（大小写不敏感）的覆盖率 ∈ [0, 1]。

    tag 通道权重要高于 co_occur：专名/主题词对齐比弱共现边更可信。
    """
    if not terms or not tags:
        return 0.0
    tag_set = {str(t).lower().strip() for t in tags if t}
    if not tag_set:
        return 0.0
    # 精确交集 + tag 被 term 包含 / term 被 tag 包含（travel ↔ traveling）
    hit = 0
    for t in terms:
        if t in tag_set:
            hit += 1
            continue
        if any(t in tag or tag in t for tag in tag_set if len(tag) > 2):
            hit += 1
    return hit / len(terms)


def score_expanded_candidate(
    *,
    sim: float,
    bm25: float = 0.0,
    tag_overlap: float = 0.0,
    temporal: float = 1.0,
    support: float = 0.0,
    relation_type: Optional[str] = None,
    w_sem: float = 1.0,
    w_bm25: float = 0.3,
    w_tag: float = 0.5,
    w_temporal: float = 0.2,
    w_co_occur: float = 0.15,
    w_struct: float = 0.25,
) -> float:
    """扩展候选多通道融合分（无 LLM）。

        score = w_sem·sim + w_bm25·bm25 + w_tag·tag
              + w_temporal·temporal + w_edge·min(support,1)

    `co_occurs` / `episode` 走较低的 `w_co_occur`；typed 边走 `w_struct`。
    """
    rtype = (relation_type or "").lower()
    if rtype in ("co_occurs", "episode"):
        struct = w_co_occur * min(max(support, 0.0), 1.0)
    else:
        struct = w_struct * min(max(support, 0.0), 1.0)
    return (
        w_sem * float(sim)
        + w_bm25 * float(bm25)
        + w_tag * float(tag_overlap)
        + w_temporal * float(temporal)
        + struct
    )


def relax_admission(
    *,
    seed_scores: Dict[str, float],
    adjacency: Dict[str, List[Tuple[str, str, float]]],
    candidate_sims: Dict[str, float],
    min_score: float = 0.0,
    gamma: float = 0.3,
    seed_floor: float = 0.6,
    max_admit: int = 20,
    hops: int = 1,
    hop_decay: float = 0.5,
    boost_beta: float = 0.0,
    boost_cap: float = 1.0,
    reach: Optional[Dict[str, Tuple[float, str, str, int]]] = None,
    seed_sim_delta: float = 0.2,
    candidate_bm25: Optional[Dict[str, float]] = None,
    candidate_tag: Optional[Dict[str, float]] = None,
    candidate_temporal: Optional[Dict[str, float]] = None,
    channel_weights: Optional[Dict[str, float]] = None,
) -> List[Dict[str, Any]]:
    """从高分 seed 的 k 跳邻域里捞回被漏检的候选，并**重新打分**。

    **硬闸（用法 B 准入）**：

        admit(c) iff sim(c) ≥ seed_sim(via) − δ     （默认 δ=0.2）

    `seed_sim` 是把 c 拉进来的 via_seed 相对 query 的分数。比旧的
    `min_score·(1−γ·support)` 更直观：扩展不能比自己的种子低太多。

    `gamma ≤ 0` 仍表示**关闭**用法 B（兼容 `MEMORY_GRAPH_RELAX_GAMMA=0`）。

    **多通道打分**（可选特征字典齐全时启用；否则退回 `sim + boost_beta·support`）：

        语义 + BM25(content) + tag∩keyword（高）+ 时序 + co_occur/结构（低）

    Args:
        candidate_sims: {candidate_id: sim(query, candidate)}
        seed_sim_delta: 硬闸 δ，env `MEMORY_GRAPH_SEED_SIM_DELTA`
        candidate_bm25 / candidate_tag / candidate_temporal: 可选通道特征 ∈ [0,1]
        channel_weights: {sem,bm25,tag,temporal,co_occur,struct} 覆盖默认权重
        reach: 可选，预先算好（并已乘过时间亲和）的可达集

    Returns:
        [{"node_id", "score", "sim", "support", "threshold", "via_seed",
          "relation_type", "hop", ...}]，按 score 降序，最多 max_admit 条。
    """
    if gamma <= 0 or not seed_scores or not candidate_sims:
        return []
    # 无邻接且无预计算 reach（例如只靠 episode）时也允许
    if reach is None and not adjacency:
        return []

    if reach is None:
        reach = reachable_within(
            seed_scores, adjacency,
            hops=max(1, hops), seed_floor=seed_floor, hop_decay=hop_decay,
        )

    delta = max(0.0, float(seed_sim_delta))
    use_channels = bool(
        candidate_bm25 is not None
        or candidate_tag is not None
        or candidate_temporal is not None
        or channel_weights
    )
    cw = channel_weights or {}

    admitted: List[Dict[str, Any]] = []
    for cand_id, (sup, seed_id, rtype, hop) in reach.items():
        if cand_id not in candidate_sims:
            continue
        sim = float(candidate_sims.get(cand_id, 0.0))
        seed_sim = float(seed_scores.get(seed_id, 0.0))
        threshold = seed_sim - delta
        if sim < threshold:
            continue

        bm25 = float((candidate_bm25 or {}).get(cand_id, 0.0))
        tag_ov = float((candidate_tag or {}).get(cand_id, 0.0))
        temporal = float((candidate_temporal or {}).get(cand_id, 1.0))

        if use_channels:
            score = score_expanded_candidate(
                sim=sim, bm25=bm25, tag_overlap=tag_ov, temporal=temporal,
                support=sup, relation_type=rtype,
                w_sem=float(cw.get("sem", 1.0)),
                w_bm25=float(cw.get("bm25", 0.3)),
                w_tag=float(cw.get("tag", 0.5)),
                w_temporal=float(cw.get("temporal", 0.2)),
                w_co_occur=float(cw.get("co_occur", 0.15)),
                w_struct=float(cw.get("struct", 0.25)),
            )
        else:
            score = sim + boost_beta * min(sup, boost_cap)

        admitted.append({
            "node_id": cand_id,
            "score": score,
            "sim": sim,
            "support": sup,
            "threshold": threshold,
            "seed_sim": seed_sim,
            "via_seed": seed_id,
            "relation_type": rtype,
            "hop": hop,
            "bm25": bm25,
            "tag_overlap": tag_ov,
            "temporal": temporal,
        })

    admitted.sort(key=lambda x: x["score"], reverse=True)
    return admitted[:max_admit]


def _item_time_seconds(item: Dict[str, Any]) -> float:
    node = item.get("node")
    if node is None:
        return 0.0
    value = getattr(node, "memory_at", None) or getattr(node, "gmt_created", None)
    if value is None:
        return 0.0
    try:
        return float(value.timestamp())
    except Exception:
        return 0.0


def _canonical_content(item: Dict[str, Any]) -> str:
    node = item.get("node")
    if node is not None and getattr(node, "content", None):
        return str(node.content)
    return str(item.get("content") or "")


def merge_expansions_into_seeds(
    hits: List[Dict[str, Any]],
    admitted_hits: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """把通过硬闸的扩展 mem **按时间并进**对应 seed，用 ``\\n\\n`` 分隔。

    - 合成后仍占 **1** 个 top-k 坑（保留 seed 原 score / 排序位置）
    - 同一 cand 只并进 via 最强的那条 seed（admitted 已是单 via）
    - 块顺序：seed + expansions 全部按 `memory_at`（缺则 `gmt_created`）升序
    - 不写回 VDB；只改读侧返回的 content
    """
    if not admitted_hits:
        return hits

    by_seed: Dict[str, List[Dict[str, Any]]] = {}
    for a in admitted_hits:
        via = a.get("graph_via") or a.get("via_seed")
        if not via:
            continue
        by_seed.setdefault(via, []).append(a)

    if not by_seed:
        return hits

    hit_by_id = {h.get("node_id"): h for h in hits if h.get("node_id")}

    for seed_id, exps in by_seed.items():
        seed_hit = hit_by_id.get(seed_id)
        if seed_hit is None:
            continue
        existing = list(seed_hit.get("_graph_merged_items") or [])
        if not existing:
            existing = [seed_hit]
        elif not any(piece.get("node_id") == seed_id for piece in existing):
            existing.insert(0, seed_hit)
        pieces = existing + list(exps)
        deduped = []
        seen_ids: Set[str] = set()
        seen_contents: Set[str] = set()
        for piece in pieces:
            piece_id = str(piece.get("node_id") or "")
            piece_content = " ".join(_canonical_content(piece).split()).casefold()
            if ((piece_id and piece_id in seen_ids)
                    or (piece_content and piece_content in seen_contents)):
                continue
            if piece_id:
                seen_ids.add(piece_id)
            if piece_content:
                seen_contents.add(piece_content)
            deduped.append(piece)
        pieces = deduped
        pieces.sort(key=_item_time_seconds)
        merged_items = [
            {**piece, "content": _canonical_content(piece)}
            for piece in pieces
        ]
        merged = "\n\n".join(
            c for c in (_canonical_content(p) for p in pieces) if c
        )
        if not merged:
            continue
        # 写到 hit 上：下游组 response 时优先用 item["content"] 覆盖 node.content
        seed_hit["content"] = merged
        seed_hit["graph_merged"] = True
        seed_hit["_graph_merged_items"] = merged_items
        seed_hit["graph_merged_ids"] = [
            e.get("node_id") for e in exps if e.get("node_id")
        ]
        # 保留最强扩展的观测字段，便于 trace
        best = max(exps, key=lambda x: float(x.get("score", 0.0)))
        seed_hit["graph_support"] = best.get("graph_support") or best.get("support")
        seed_hit["graph_relation"] = best.get("graph_relation") or best.get("relation_type")
        if all(
            (e.get("graph_relation") or e.get("relation_type")) == "same_series"
            for e in exps
        ):
            seed_hit["_timeline_member_ids"] = [
                piece.get("node_id") for piece in merged_items if piece.get("node_id")
            ]
            seed_hit["_timeline"] = [
                {
                    "memory_id": piece.get("node_id"),
                    "memory_at": _item_time_seconds(piece),
                }
                for piece in merged_items if piece.get("node_id")
            ]

    # 扩展不再作为独立 hit 返回
    return hits


def annotate_same_series_in_pool(
    hits: List[Dict[str, Any]],
    adjacency: Dict[str, List[Tuple[str, str, float]]],
) -> List[Dict[str, Any]]:
    """Mark explicit same-series neighbors that are already query candidates."""
    pool_ids = {item.get("node_id") for item in hits if item.get("node_id")}
    for item in hits:
        node_id = item.get("node_id")
        if not node_id:
            continue
        members = sorted({
            neighbor for neighbor, relation, _weight in adjacency.get(node_id, [])
            if relation == "same_series" and neighbor in pool_ids
        })
        if members:
            item["_same_series_pool_ids"] = members
    return hits


def merge_same_series_in_pool(hits: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Fold connected same-series candidates into one chronological L2 slot."""
    by_id = {item.get("node_id"): item for item in hits if item.get("node_id")}
    adjacency = {
        node_id: {
            member for member in item.get("_same_series_pool_ids") or []
            if member in by_id
        }
        for node_id, item in by_id.items()
    }
    visited: Set[str] = set()
    remove: Set[str] = set()
    for start in list(adjacency):
        if start in visited or not adjacency[start]:
            continue
        component: Set[str] = set()
        stack = [start]
        while stack:
            current = stack.pop()
            if current in visited:
                continue
            visited.add(current)
            component.add(current)
            stack.extend(adjacency.get(current, set()) - visited)
        if len(component) < 2:
            continue
        members = [by_id[node_id] for node_id in component]
        if any(member.get("graph_merged") for member in members):
            continue
        seed = max(
            members,
            key=lambda item: (float(item.get("score", 0.0)), -hits.index(item)),
        )
        pieces = sorted(members, key=_item_time_seconds)
        seed["content"] = "\n\n".join(
            text for text in (_canonical_content(piece) for piece in pieces) if text
        )
        seed["graph_merged"] = True
        seed["graph_relation"] = "same_series"
        seed["_graph_merged_items"] = [
            {**piece, "content": _canonical_content(piece)} for piece in pieces
        ]
        seed["graph_merged_ids"] = [
            piece.get("node_id") for piece in pieces
            if piece.get("node_id") and piece is not seed
        ]
        seed["_timeline_member_ids"] = [
            piece.get("node_id") for piece in pieces if piece.get("node_id")
        ]
        seed["_timeline"] = [
            {
                "memory_id": piece.get("node_id"),
                "memory_at": _item_time_seconds(piece),
            }
            for piece in pieces if piece.get("node_id")
        ]
        remove.update(component - {seed.get("node_id")})
    return [item for item in hits if item.get("node_id") not in remove]


# ================================================================
# 用法 C：关系路径（独立输出通道，不进主排序）
# ================================================================

def find_relation_paths(
    *,
    hit_scores: Dict[str, float],
    adjacency: Dict[str, List[Tuple[str, str, float]]],
    high_floor: float = 0.6,
    max_paths: int = 5,
    typed_only: bool = True,
    forward_dirs: Optional[Set[Tuple[str, str]]] = None,
) -> List[Dict[str, Any]]:
    """找出连接两个高分命中的 ≤2 跳路径。

    关系型问题（"推荐那家餐厅的朋友是谁"）要的不是排好序的列表，而是一条**路径**。
    把路径节点混进平铺的召回列表会丢掉关系语义 —— 答案 LLM 只看到几条互不相干的记忆。
    所以这里作为独立字段返回，**不参与主排序**。

    中间节点（1 跳路径没有；2 跳路径的桥接点）即使自己分数很低也会带上 —— 它是路径的一部分。

    Args:
        hit_scores: 直接命中 {node_id: score}
        high_floor: 只在分数 ≥ 该值的命中之间找路径
        typed_only: 只用信息量高的边（排除 semantic_neighbor —— 它只说明"语义相近"，
            两条语义相近的记忆之间连一条路径对答案没有解释价值）
        forward_dirs: `collect_directed_edges()` 的产物。有向边（`temporal_next`）
            据此标出方向 —— `direction="forward"` 表示 A 在 B **之前**发生。
            不标方向的话"X 之后"和"X 之前"在输出里分不开。

    Returns:
        [{"score", "hops", "nodes": [id...], "relations": [{type, direction}...]}]
        按 score 降序
    """
    fwd = forward_dirs or set()

    def _rel(a: str, b: str, rtype: str) -> Dict[str, str]:
        """描述 a→b 这一步的关系。有向边给出 forward / backward。"""
        item = {"type": rtype}
        if (a, b) in fwd:
            item["direction"] = "forward"    # a 早于 b
        elif (b, a) in fwd:
            item["direction"] = "backward"   # a 晚于 b
        return item
    anchors = sorted(
        [(nid, s) for nid, s in (hit_scores or {}).items() if s >= high_floor],
        key=lambda x: x[1], reverse=True,
    )
    if len(anchors) < 2 or not adjacency:
        return []

    anchor_ids = {nid for nid, _ in anchors}
    anchor_score = dict(anchors)

    def _usable(rtype: str) -> bool:
        if not typed_only:
            return True
        return (rtype or "").lower() != "semantic_neighbor"

    paths: List[Dict[str, Any]] = []
    seen: Set[Tuple[str, ...]] = set()

    def _emit(nodes: List[str], relations: List[Dict[str, str]], score: float) -> None:
        key = tuple(sorted((nodes[0], nodes[-1]))) + tuple(
            sorted(r["type"] for r in relations)
        )
        if key in seen:
            return
        seen.add(key)
        paths.append({
            "score": round(score, 6),
            "hops": len(nodes) - 1,
            "nodes": nodes,
            "relations": relations,
        })

    for a_id, a_s in anchors:
        # 1 跳：两个 anchor 直接相连
        for nb, rtype, eff_w in adjacency.get(a_id, []):
            if not _usable(rtype):
                continue
            if nb in anchor_ids and nb != a_id:
                _emit(
                    [a_id, nb], [_rel(a_id, nb, rtype)],
                    min(a_s, anchor_score[nb]) * eff_w,
                )

        # 2 跳：经一个中间节点连到另一个 anchor
        for mid, r1, w1 in adjacency.get(a_id, []):
            if mid in anchor_ids or not _usable(r1):
                continue
            for nb, r2, w2 in adjacency.get(mid, []):
                if nb == a_id or nb not in anchor_ids or not _usable(r2):
                    continue
                _emit(
                    [a_id, mid, nb],
                    [_rel(a_id, mid, r1), _rel(mid, nb, r2)],
                    min(a_s, anchor_score[nb]) * w1 * w2,
                )

    paths.sort(key=lambda p: p["score"], reverse=True)
    return paths[:max_paths]
