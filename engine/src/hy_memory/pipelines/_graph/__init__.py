"""记忆关系图（pro 模式）。

- `projector`：写侧 —— 把 L2_FACT 投影进图，并建 RELATED_TO / TAGGED_WITH 边
- `rerank`：读侧 —— 用法 A（池内支持度传播）/ B（k 跳阈值松弛）/ C（关系路径）
- `topic_summary`：写侧 —— 按主题切摘要（要 LLM，写侧允许）

设计文档：`docs/pro_graph_design.md`
"""

from .projector import (
    RELATION_CO_OCCURS,
    RELATION_SEMANTIC_NEIGHBOR,
    RELATION_TEMPORAL_NEXT,
    LLM_RELATION_TYPES,
    project_memories_to_graph,
    sync_graph_on_supersede,
    sync_graph_on_shadow,
)
from .rerank import (
    TYPE_PRIOR,
    build_adjacency,
    collect_directed_edges,
    propagate_support,
    apply_temporal_affinity,
    apply_type_quota,
    blend_support,
    edge_group,
    episode_support,
    normalize_by_degree,
    reachable_within,
    relax_admission,
    find_relation_paths,
)

__all__ = [
    "RELATION_CO_OCCURS",
    "RELATION_SEMANTIC_NEIGHBOR",
    "RELATION_TEMPORAL_NEXT",
    "LLM_RELATION_TYPES",
    "project_memories_to_graph",
    "sync_graph_on_supersede",
    "sync_graph_on_shadow",
    "TYPE_PRIOR",
    "build_adjacency",
    "collect_directed_edges",
    "propagate_support",
    "apply_temporal_affinity",
    "apply_type_quota",
    "blend_support",
    "edge_group",
    "episode_support",
    "normalize_by_degree",
    "reachable_within",
    "relax_admission",
    "find_relation_paths",
]
