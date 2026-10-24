"""
System 2 Agent Tools

10 个工具供 System 2 Agent (LLM) 操作 VDB + Graph 双层存储。

Read (4):
  1. search_vdb     — 向量语义检索 VDB (L0-L4)
  2. search_graph   — 按内容/标签/层级查 Graph (L5-L7)
  3. get_node       — 统一获取节点详情 (VDB or Graph)，渐进式披露
  4. expand_node    — 图遍历，查看某节点的关联节点

Write (6): — Graph 专用
  5. create_graph_node   — 创建 L6 SCHEMA / L7 INTENTION 节点
  6. update_graph_node   — 更新已有 Graph 节点
  7. add_edge            — 建立关系 (RELATED_TO)
  8. delete_graph_node   — 删除节点
  9. revise_schema       — 版本化修订 Schema，旧版本退出 active 检索
  10. retire_schema      — 用户明确遗忘时归档 Schema
"""

import json
import uuid
import logging
import os
import math
from typing import Any, Dict, List, Optional
from datetime import datetime

from ..models.memory import MemoryLayer, MemoryNode, MemoryStatus, SourceType
from ..data.vector_store_base import VectorStoreBase
from ..data.graph_store_base import GraphStoreBase
from ..core.embed_service import EmbedService

import time
logger = logging.getLogger(__name__)

_S2_SCHEMA_DEDUP_MIN_SCORE = float(os.getenv(
    "MEMORY_EVOLING_SCHEMA_DEDUP_MIN_SCORE", "0.68",
))
_S2_SCHEMA_DEDUP_ENABLED = os.getenv(
    "MEMORY_EVOLING_SCHEMA_DEDUP_ENABLED", "false",
).lower() in ("1", "true", "yes", "on")
_S2_SCHEMA_COMPACTION_ENABLED = os.getenv(
    "MEMORY_EVOLING_SCHEMA_COMPACTION_ENABLED", "false",
).lower() in ("1", "true", "yes", "on")
_S2_SCHEMA_COMPACTION_MAX_NODES = int(os.getenv(
    "MEMORY_EVOLING_SCHEMA_COMPACTION_MAX_NODES", "200",
))

# Evidence tree truncation length for content preview
_TRUNCATE_LEN = 80


def _truncate(text: str, max_len: int = _TRUNCATE_LEN) -> str:
    if not text:
        return ""
    return text[:max_len] + ("..." if len(text) > max_len else "")


def _evidence_raw_source_ids(node: Any) -> List[str]:
    """Return stable raw provenance represented by one VDB evidence node."""
    if node is None:
        return []
    custom = getattr(node, "custom", None) or {}
    source_ids = [
        str(value) for value in custom.get("source_raw_memory_ids") or [] if str(value)
    ]
    legacy_source = str(getattr(node, "source_raw_memory_id", "") or "")
    if legacy_source and legacy_source not in source_ids:
        source_ids.append(legacy_source)
    return source_ids


def _cosine(left: List[float], right: List[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    dot = sum(float(a) * float(b) for a, b in zip(left, right))
    ln = math.sqrt(sum(float(a) * float(a) for a in left))
    rn = math.sqrt(sum(float(b) * float(b) for b in right))
    return dot / (ln * rn) if ln and rn else 0.0


async def run_existing_schema_compaction(
    *,
    graph_store: GraphStoreBase,
    tool_executor: "System2ToolExecutor",
    embed_service: EmbedService,
    isolation_key: str,
) -> Dict[str, Any]:
    """Archive pre-existing near-duplicate L6 nodes without losing evidence."""
    if not _S2_SCHEMA_COMPACTION_ENABLED:
        return {"success": True, "enabled": False, "scanned": 0, "merged": 0, "merges": []}
    nodes = list(await graph_store.get_all_nodes(
        isolation_key=isolation_key,
        layer=MemoryLayer.L6_SCHEMA,
        status=MemoryStatus.ACTIVE,
        limit=max(1, _S2_SCHEMA_COMPACTION_MAX_NODES),
    ))
    nodes = [
        node for node in nodes
        if str((node.custom or {}).get("schema_kind") or "")
        != "balanced_persona_catalog"
    ]
    if len(nodes) < 2:
        return {"success": True, "enabled": True, "scanned": len(nodes), "merged": 0, "merges": []}

    evidence: Dict[str, set[str]] = {}
    raw_sources: Dict[str, set[str]] = {}
    texts: List[str] = []
    for node in nodes:
        evidence[node.node_id] = {
            str(item.get("node_id") or "")
            for item in await graph_store.get_evidence_vdbrefs(node.node_id)
            if item.get("node_id")
        }
        raw_sources[node.node_id] = {
            str(value) for value in (node.custom or {}).get("evidence_raw_source_ids") or []
            if str(value)
        }
        texts.append(str((node.custom or {}).get("retrieval_text") or node.content or ""))
    vectors: List[List[float]] = [list(getattr(node, "embedding", None) or []) for node in nodes]
    missing = [index for index, value in enumerate(vectors) if not value]
    if missing:
        missing_texts = [texts[index] for index in missing]
        if hasattr(embed_service, "embed_batch"):
            generated = await embed_service.embed_batch(missing_texts)
        else:
            generated = [await embed_service.embed_queued(text) for text in missing_texts]
        for index, value in zip(missing, generated):
            vectors[index] = value

    def event_time(node: MemoryNode) -> float:
        value = node.memory_at or node.gmt_created
        return value.timestamp() if hasattr(value, "timestamp") else 0.0

    order = sorted(
        range(len(nodes)),
        key=lambda index: (
            -len(raw_sources[nodes[index].node_id]),
            -len(evidence[nodes[index].node_id]),
            event_time(nodes[index]),
            nodes[index].node_id,
        ),
    )
    removed: set[str] = set()
    merges: List[Dict[str, Any]] = []
    failures: List[Dict[str, Any]] = []
    for keeper_index in order:
        keeper = nodes[keeper_index]
        if keeper.node_id in removed:
            continue
        for duplicate_index in order:
            duplicate = nodes[duplicate_index]
            if duplicate.node_id == keeper.node_id or duplicate.node_id in removed:
                continue
            shared_evidence = sorted(evidence[keeper.node_id] & evidence[duplicate.node_id])
            shared_raw = sorted(raw_sources[keeper.node_id] & raw_sources[duplicate.node_id])
            if not shared_evidence or not shared_raw:
                continue
            similarity = _cosine(vectors[keeper_index], vectors[duplicate_index])
            if similarity < _S2_SCHEMA_DEDUP_MIN_SCORE:
                continue
            add_result = await tool_executor._tool_add_evidence({
                "node_id": keeper.node_id,
                "evidence_list": sorted(evidence[duplicate.node_id]),
            })
            if add_result.get("error"):
                failures.append({"duplicate_id": duplicate.node_id, "error": add_result["error"]})
                continue
            custom = dict(duplicate.custom or {})
            custom.update({
                "dedup_kept_id": keeper.node_id,
                "dedup_reason": "semantic_and_provenance_overlap",
                "dedup_similarity": round(similarity, 6),
                "dedup_shared_evidence_ids": shared_evidence,
                "dedup_shared_raw_source_ids": shared_raw,
            })
            updated = await graph_store.update_node(duplicate.node_id, {
                "status": MemoryStatus.SUPERSEDED.value,
                "superseded_by_id": keeper.node_id,
                "valid_until": datetime.now(),
                "custom_json": json.dumps(custom, ensure_ascii=False),
            })
            if not updated:
                failures.append({"duplicate_id": duplicate.node_id, "error": "archive_failed"})
                continue
            evidence[keeper.node_id].update(evidence[duplicate.node_id])
            raw_sources[keeper.node_id].update(raw_sources[duplicate.node_id])
            removed.add(duplicate.node_id)
            merges.append({
                "kept_id": keeper.node_id,
                "duplicate_id": duplicate.node_id,
                "similarity": round(similarity, 6),
                "shared_evidence_ids": shared_evidence,
                "shared_raw_source_ids": shared_raw,
                "evidence_added": int(add_result.get("evidence_added") or 0),
            })
    return {
        "success": not failures,
        "enabled": True,
        "scanned": len(nodes),
        "merged": len(merges),
        "merges": merges,
        "failures": failures,
    }


# ====================================================================
# Tool definitions (OpenAI function-calling format)
# ====================================================================

SYSTEM2_TOOL_DEFINITIONS = [
    # --- Read tools ---
    {
        "type": "function",
        "function": {
            "name": "search_vdb",
            "description": "Semantic search in VDB. Returns list: content, score, layer. Only searches L2_FACT and L4_IDENTITY layers.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                    "layers": {
                        "type": "array",
                        "items": {"type": "string", "enum": ["l2_fact", "l4_identity"]},
                        "description": "Layer filter. Options: 'l2_fact', 'l4_identity'. Omit to search both."
                    },
                    "limit": {"type": "integer", "description": "Max results, default 10"}
                },
                "required": ["query"]
            },
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search_graph",
            "description": "Search Graph nodes. Filter by content keyword, tags, or layer. Only L6_SCHEMA and L7_INTENTION exist in Graph.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Content keyword (fuzzy match)"},
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Filter by tags"
                    },
                    "layer": {"type": "string", "enum": ["l6_schema", "l7_intention"], "description": "Layer filter. Options: 'l6_schema', 'l7_intention'"},
                },
                "required": [],
            },
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_node",
            "description": "Get node details: content, layer, confidence, tags. Works for both VDB and Graph nodes.",
            "parameters": {
                "type": "object",
                "properties": {
                    "node_id": {"type": "string", "description": "Node ID"},
                },
                "required": ["node_id"]
            },
        }
    },
    {
        "type": "function",
        "function": {
            "name": "expand_node",
            "description": "Graph traversal: see related nodes (RELATED_TO edges) from a given node.",
            "parameters": {
                "type": "object",
                "properties": {
                    "node_id": {"type": "string", "description": "Start node ID"},
                    "hops": {"type": "integer", "description": "Hops, default 1"},
                },
                "required": ["node_id"]
            },
        }
    },
    # --- Write tools ---
    {
        "type": "function",
        "function": {
            "name": "create_graph_node",
            "description": "Create an L6_SCHEMA or L7_INTENTION node. Content must be a single sentence for Schema (circumstance + pattern + insight). Automatically creates VdbRef + DERIVED_FROM + Tag edges.",
            "parameters": {
                "type": "object",
                "properties": {
                    "layer": {
                        "type": "string",
                        "enum": ["l6_schema", "l7_intention"],
                        "description": "Node layer"
                    },
                    "content": {"type": "string", "description": "Node content (single sentence for Schema)"},
                    "evidence_list": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "VDB node_id list as evidence"
                    },
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Tag list (prefer reusing existing tags)"
                    },
                    "confidence": {"type": "number", "description": "Confidence 0-1, default 0.8"},
                },
                "required": ["layer", "content", "evidence_list"]
            },
        }
    },
    {
        "type": "function",
        "function": {
            "name": "add_evidence",
            "description": "Add evidence to an EXISTING Schema or Intention. Links new VDB facts to the node via DERIVED_FROM edges. Does NOT change the node content.",
            "parameters": {
                "type": "object",
                "properties": {
                    "node_id": {"type": "string", "description": "Existing Graph node ID to add evidence to"},
                    "evidence_list": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "VDB node_id list to add as new evidence"
                    },
                },
                "required": ["node_id", "evidence_list"]
            },
        }
    },
    {
        "type": "function",
        "function": {
            "name": "revise_schema",
            "description": "Create a new immutable version of an existing active L6 Schema when new evidence materially changes or corrects its current state. The old version is retained for audit and removed from active retrieval.",
            "parameters": {
                "type": "object",
                "properties": {
                    "node_id": {"type": "string", "description": "Existing active L6 Schema ID"},
                    "content": {"type": "string", "description": "Complete content for the new current Schema version"},
                    "retrieval_text": {"type": "string", "description": "Search-oriented text for the revised state"},
                    "evidence_list": {
                        "type": "array", "items": {"type": "string"},
                        "description": "New VDB evidence IDs; old evidence is inherited automatically"
                    },
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "confidence": {"type": "number"},
                    "schema_kind": {"type": "string", "enum": ["behavior_pattern", "explicit_state"]},
                    "reason": {"type": "string", "description": "Why the old wording would mislead"}
                },
                "required": ["node_id", "content", "evidence_list", "reason"]
            },
        }
    },
    {
        "type": "function",
        "function": {
            "name": "retire_schema",
            "description": "Archive an active L6 Schema when an explicit user forgetting directive targets the same stored user fact or preference.",
            "parameters": {
                "type": "object",
                "properties": {
                    "node_id": {"type": "string"},
                    "forget_fact_id": {"type": "string"},
                    "reason": {"type": "string"}
                },
                "required": ["node_id", "forget_fact_id", "reason"]
            },
        }
    },
    {
        "type": "function",
        "function": {
            "name": "add_edge",
            "description": "Create a RELATED_TO relationship between two Graph nodes.",
            "parameters": {
                "type": "object",
                "properties": {
                    "source_id": {"type": "string"},
                    "target_id": {"type": "string"},
                    "reason": {"type": "string", "description": "Reason for the relationship"},
                },
                "required": ["source_id", "target_id"]
            },
        }
    },
]


# ====================================================================
# Tool executor
# ====================================================================

class System2ToolExecutor:
    """
    执行 System 2 Agent 的 tool calls。

    持有 VDB + Graph store 引用，所有操作自动记 pipeline log。
    """

    def __init__(
        self,
        vector_store: VectorStoreBase,
        graph_store: GraphStoreBase,
        embed_service: EmbedService,
        user_id: str,
        agent_id: str,
    ):
        self.vector_store = vector_store
        self.graph_store = graph_store
        self.embed_service = embed_service
        self.user_id = user_id
        self.agent_id = agent_id
        self._isolation_key = MemoryNode.build_isolation_key(user_id, agent_id)
        self.tool_call_log: List[Dict[str, Any]] = []

    async def execute(self, tool_name: str, args: Dict[str, Any]) -> str:
        """执行一个 tool call，返回 JSON string 结果"""
        start_time = time.perf_counter()
        
        handler = getattr(self, f"_tool_{tool_name}", None)
        if handler is None:
            result = {"error": f"Unknown tool: {tool_name}"}
        else:
            try:
                result = await handler(args)
            except Exception as e:
                logger.error(f"[S2-tool] {tool_name} failed: {e}", exc_info=True)
                result = {"error": f"{type(e).__name__}: {str(e)}"}

        elapsed_ms = (time.perf_counter() - start_time) * 1000

        # Log
        result_json = json.dumps(result, ensure_ascii=False, default=str)
        self.tool_call_log.append({
            "tool": tool_name,
            "args": args,
            "result": result_json,  # 完整结果
            "result_preview": _truncate(result_json, 200),
            "elapsed_ms": round(elapsed_ms, 2),
        })

        # Metrics: Graph ops（write tools 记录到 graph_ops）
        _GRAPH_WRITE_TOOLS = {
            "create_graph_node", "add_evidence", "revise_schema", "retire_schema", "add_edge",
        }
        if tool_name in _GRAPH_WRITE_TOOLS:
            try:
                from ..metrics import MetricsCollector
                MetricsCollector.get().record_graph_op(elapsed_ms)
            except Exception:
                pass

        return result_json

    # ================================================================
    # Read tools
    # ================================================================

    async def _tool_search_vdb(self, args: Dict) -> Any:
        query = args["query"]
        layers_str = args.get("layers")
        limit = args.get("limit", 10)

        layers = None
        if layers_str:
            layers = [MemoryLayer.from_string(layer) for layer in layers_str]

        query_embedding = await self.embed_service.embed_queued(query)
        results = await self.vector_store.search(
            query_embedding=query_embedding,
            user_id=self.user_id,
            agent_ids=[self.agent_id] if self.agent_id else None,
            layers=layers,
            limit=limit,
            status_filter=[MemoryStatus.ACTIVE],
        )

        return [
            {
                "node_id": r["node_id"],
                "content": r["node"].content,
                "score": round(r["score"], 4),
                "layer": r["node"].layer.value,
                "evidence_count": len(r["node"].evidence_chain) if r["node"].evidence_chain else 0,
            }
            for r in results
        ]

    async def _tool_search_graph(self, args: Dict) -> Any:
        query = args.get("query")
        tags = args.get("tags")
        layer = args.get("layer")

        # Search by content (list all active nodes with layer filter)
        layer_filter = MemoryLayer.from_string(layer) if layer else None
        all_nodes = await self.graph_store.get_all_nodes(
            isolation_key=self._isolation_key,
            layer=layer_filter,
            status=MemoryStatus.ACTIVE,
            limit=50,
        )

        # Filter by query keyword
        if query:
            query_lower = query.lower()
            all_nodes = [n for n in all_nodes if query_lower in n.content.lower()]

        # Filter by tags
        if tags and all_nodes:
            tag_set = {t.lower() for t in tags}
            all_nodes = [
                n for n in all_nodes
                if any(t.lower() in tag_set for t in (n.tags or []))
            ] or all_nodes  # fallback to unfiltered if no tag match

        results = []
        for n in all_nodes:
            evidence_refs = await self.graph_store.get_evidence_vdbrefs(n.node_id)
            results.append({
                "node_id": n.node_id,
                "content": n.content,
                "layer": n.layer.value,
                "confidence": n.confidence,
                "evidence_count": len(evidence_refs),
            })
        return results

    async def _tool_get_node(self, args: Dict) -> Any:
        node_id = args["node_id"]

        # Try VDB first
        vdb_node = await self.vector_store.get_by_id(node_id)
        if vdb_node:
            result = {
                "node_id": vdb_node.node_id,
                "layer": vdb_node.layer.value,
                "content": vdb_node.content,
                "status": vdb_node.status.value if hasattr(vdb_node.status, 'value') else str(vdb_node.status),
                "tags": vdb_node.tags or [],
                "gmt_created": str(vdb_node.gmt_created) if vdb_node.gmt_created else None,
            }
            # Add source_raw_memory_id if present (L3/L4)
            if vdb_node.source_raw_memory_id:
                result["source_raw_memory_id"] = vdb_node.source_raw_memory_id
            # Add supersedes info
            if vdb_node.supersedes:
                result["supersedes"] = vdb_node.supersedes
            if not vdb_node.is_latest:
                result["is_latest"] = False
            return result

        # Try Graph
        graph_node = await self.graph_store.get_node(node_id)
        if graph_node:
            evidence_refs = await self.graph_store.get_evidence_vdbrefs(node_id)
            return {
                "node_id": graph_node.node_id,
                "layer": graph_node.layer.value,
                "content": graph_node.content,
                "confidence": graph_node.confidence,
                "status": graph_node.status.value if hasattr(graph_node.status, 'value') else str(graph_node.status),
                "tags": graph_node.tags or [],
                "evidence_count": len(evidence_refs),
            }

        return {"error": f"Node {node_id} not found in VDB or Graph"}

    async def _tool_expand_node(self, args: Dict) -> Any:
        node_id = args["node_id"]
        hops = args.get("hops", 1)

        expanded = await self.graph_store.expand_from_anchors(
            anchor_ids=[node_id],
            hop=hops,
            max_nodes=30,
        )

        return [
            {
                "node_id": item["node_id"],
                "content": item.get("content", ""),
                "layer": item.get("layer", ""),
                "edge_type": item.get("edge_type", ""),
                "confidence": item.get("confidence"),
            }
            for item in expanded
        ]

    # ================================================================
    # Write tools
    # ================================================================

    async def _tool_create_graph_node(self, args: Dict) -> Any:
        return await self._create_graph_node(args)

    async def _create_graph_node(
        self,
        args: Dict,
        *,
        increment_evidence: bool = True,
        custom_extra: Optional[Dict[str, Any]] = None,
        require_evidence_links: bool = False,
    ) -> Any:
        layer_str = args["layer"]
        content = args["content"]
        evidence_list = args["evidence_list"]
        tags = args.get("tags", [])
        confidence = args.get("confidence", 0.8)
        schema_kind = str(args.get("schema_kind") or "behavior_pattern")
        retrieval_text = str(args.get("retrieval_text") or "").strip()

        layer = MemoryLayer.from_string(layer_str)
        node_id = str(uuid.uuid4())

        # Embed content → V_con（Graph 向量检索用）
        try:
            content_embedding = await self.embed_service.embed_queued(content)
        except Exception as e:
            logger.warning(f"create_graph_node: embed failed, node will have no embedding: {e}")
            content_embedding = None
        if layer == MemoryLayer.L6_SCHEMA and retrieval_text:
            try:
                content_embedding = await self.embed_service.embed_queued(retrieval_text)
            except Exception as e:
                logger.warning(f"create_graph_node: retrieval_text embed failed, use content: {e}")

        evidence_nodes: Dict[str, Any] = {}
        evidence_raw_source_ids: List[str] = []
        for eid in evidence_list:
            vdb_node = await self.vector_store.get_by_id(eid)
            evidence_nodes[eid] = vdb_node
            for raw_id in _evidence_raw_source_ids(vdb_node):
                if raw_id not in evidence_raw_source_ids:
                    evidence_raw_source_ids.append(raw_id)
        from ..utils.source_filter import merge_sources
        derived_source = merge_sources(
            getattr(evidence_node, "source", None)
            for evidence_node in evidence_nodes.values()
        )

        # Continuation cycles can ask to create a paraphrase of an active Schema
        # from the same underlying raw evidence.  Reuse that node instead of
        # accumulating near-identical L6 records.  The raw-overlap requirement is
        # intentional: semantically similar patterns backed by different events
        # remain distinct.
        if (
            layer == MemoryLayer.L6_SCHEMA
            and _S2_SCHEMA_DEDUP_ENABLED
            and content_embedding
            and evidence_raw_source_ids
            and hasattr(self.graph_store, "vector_search")
        ):
            try:
                similar = await self.graph_store.vector_search(
                    query_embedding=content_embedding,
                    isolation_key=self._isolation_key,
                    layers=[MemoryLayer.L6_SCHEMA.value],
                    limit=5,
                    score_threshold=_S2_SCHEMA_DEDUP_MIN_SCORE,
                    include_sources=[derived_source],
                )
                candidate_raw = set(evidence_raw_source_ids)
                candidate_evidence = {str(value) for value in evidence_list if str(value)}
                for hit in similar:
                    existing_id = str(hit.get("node_id") or "")
                    if not existing_id:
                        continue
                    custom_json = hit.get("custom_json")
                    if isinstance(custom_json, str):
                        try:
                            existing_custom = json.loads(custom_json or "{}")
                        except json.JSONDecodeError:
                            existing_custom = {}
                    elif isinstance(custom_json, dict):
                        existing_custom = custom_json
                    else:
                        existing = await self.graph_store.get_node(existing_id)
                        existing_custom = dict(getattr(existing, "custom", None) or {})
                    existing_raw = {
                        str(value) for value in
                        existing_custom.get("evidence_raw_source_ids") or [] if str(value)
                    }
                    shared_raw = sorted(candidate_raw & existing_raw)
                    existing_refs = {
                        str(item.get("node_id") or "")
                        for item in await self.graph_store.get_evidence_vdbrefs(existing_id)
                        if item.get("node_id")
                    }
                    shared_evidence = sorted(candidate_evidence & existing_refs)
                    if not shared_raw or not shared_evidence:
                        continue
                    added = await self._tool_add_evidence({
                        "node_id": existing_id,
                        "evidence_list": evidence_list,
                    })
                    return {
                        "node_id": existing_id,
                        "created": False,
                        "deduplicated": True,
                        "similarity": round(float(hit.get("score") or 0.0), 6),
                        "shared_raw_source_ids": shared_raw,
                        "shared_evidence_ids": shared_evidence,
                        **added,
                    }
            except Exception as exc:
                logger.warning("create_graph_node: schema dedup probe failed: %s", exc)

        # Create the Graph Memory node
        now = datetime.now()
        custom = {
            "schema_type": "basic",
            "schema_kind": schema_kind,
            "retrieval_text": retrieval_text,
            "evidence_raw_source_ids": evidence_raw_source_ids,
        } if layer == MemoryLayer.L6_SCHEMA else {}
        if custom_extra:
            custom.update(custom_extra)
        node = MemoryNode(
            node_id=node_id,
            user_id=self.user_id,
            agent_id=self.agent_id,
            source=derived_source,
            layer=layer,
            content=content,
            confidence=confidence,
            status=MemoryStatus.ACTIVE,
            source_type=SourceType.INFERRED,
            tags=tags,
            memory_at=now,
            custom=custom,
        )
        if content_embedding:
            node._graph_embedding = content_embedding
        # embedding 必须在 upsert CREATE 时写入（Kuzu 索引列不可 SET）。
        # Neo4j 可在 upsert 后 SET，但 _graph_embedding 已在 upsert 中处理，无需再调 update_embedding。
        await self.graph_store.upsert_memory_node(node)
        try:
            # Create VdbRef + DERIVED_FROM edges for each evidence
            for eid in evidence_list:
                vdb_node = evidence_nodes.get(eid)
                ev_layer = vdb_node.layer.value if vdb_node else "unknown"
                await self.graph_store.ensure_vdbref(eid, ev_layer)
                linked = await self.graph_store.add_derived_from(node_id, eid)
                if require_evidence_links and linked is False:
                    raise RuntimeError(f"failed to link evidence {eid}")
                # 递增 VDB fact 的 s2_evidence_count（用于 preprocess 过滤已消化 facts）
                if increment_evidence:
                    await self._increment_evidence_count(eid, vdb_node)

            # Create Tag + TAGGED_WITH edges (with embedding normalization)
            for tag in tags:
                await self.graph_store.add_topic_tag(
                    node_id, tag, self._isolation_key, embed_service=self.embed_service,
                )
        except Exception:
            # Revision requires an all-or-nothing new version. Preserve legacy
            # create behavior unless this stricter contract was requested.
            if require_evidence_links:
                await self.graph_store.delete_node(node_id)
            raise

        return {"node_id": node_id, "created": True, "evidence_count": len(evidence_list)}

    async def _tool_revise_schema(self, args: Dict) -> Any:
        """Create a new Schema version and retire the old active version.

        Revision is intentionally immutable: the old node remains in Graph for
        audit/history but leaves normal retrieval because its status becomes
        ``superseded``.  Existing evidence is inherited by the new node.  The
        old node is retired only after the new node and all evidence links have
        been created, so failures cannot remove the current profile state.
        """
        old_id = str(args.get("node_id") or "").strip()
        if not old_id:
            return {"error": "node_id is required"}
        old = await self.graph_store.get_node(old_id)
        if old is None:
            return {"error": f"Schema {old_id} not found"}
        if old.layer != MemoryLayer.L6_SCHEMA:
            return {"error": f"Node {old_id} is not an L6 Schema"}
        if old.status != MemoryStatus.ACTIVE:
            return {"error": f"Schema {old_id} is not active"}
        if old.user_id != self.user_id or old.agent_id != self.agent_id:
            return {"error": f"Schema {old_id} is outside the current user scope"}

        content = str(args.get("content") or "").strip()
        if not content:
            return {"error": "content is required"}
        old_custom = dict(old.custom or {})
        schema_kind = str(
            args.get("schema_kind") or old_custom.get("schema_kind") or "behavior_pattern"
        )
        retrieval_text = str(
            args.get("retrieval_text") or old_custom.get("retrieval_text") or ""
        ).strip()
        tags = list(dict.fromkeys(list(old.tags or []) + list(args.get("tags") or [])))
        new_evidence = [str(value) for value in args.get("evidence_list") or [] if str(value)]
        new_evidence_nodes = {}
        for evidence_id in new_evidence:
            evidence_node = await self.vector_store.get_by_id(evidence_id)
            if evidence_node is None:
                return {"error": f"Evidence {evidence_id} not found"}
            if (
                evidence_node.user_id != self.user_id
                or evidence_node.agent_id != self.agent_id
            ):
                return {"error": f"Evidence {evidence_id} is outside the current user scope"}
            new_evidence_nodes[evidence_id] = evidence_node
        old_refs = await self.graph_store.get_evidence_vdbrefs(old_id)
        old_evidence = [str(ref.get("node_id") or "") for ref in old_refs if ref.get("node_id")]
        all_evidence = list(dict.fromkeys(old_evidence + new_evidence))
        reason = str(args.get("reason") or "").strip()

        try:
            created = await self._create_graph_node(
                {
                    "layer": "l6_schema",
                    "content": content,
                    "retrieval_text": retrieval_text,
                    "evidence_list": all_evidence,
                    "tags": tags,
                    "confidence": args.get("confidence", old.confidence),
                    "schema_kind": schema_kind,
                },
                increment_evidence=False,
                require_evidence_links=True,
                custom_extra={
                    "supersedes_schema_id": old_id,
                    "revision_reason": reason,
                },
            )
        except Exception as exc:
            return {"error": f"Failed to create revised Schema: {exc}"}
        new_id = str(created.get("node_id") or "")
        if not created.get("created") or not new_id:
            return {"error": "Failed to create revised Schema"}

        retired = await self.graph_store.update_node(old_id, {
            "status": MemoryStatus.SUPERSEDED.value,
            "superseded_by_id": new_id,
            "valid_until": datetime.now(),
        })
        if not retired:
            await self.graph_store.delete_node(new_id)
            return {
                "error": f"Failed to retire Schema {old_id}; revised node rolled back",
                "rolled_back": True,
            }

        # RELATED_TO is bidirectional in current backends. Direction is carried
        # by supersedes_schema_id / superseded_by_id; the edge is for audit UI.
        await self.graph_store.add_edge(
            old_id,
            new_id,
            "RELATED_TO",
            {"relation_type": "schema_revision", "weight": 1.0},
        )
        for evidence_id in new_evidence:
            await self._increment_evidence_count(
                evidence_id, new_evidence_nodes[evidence_id],
            )

        return {
            "node_id": new_id,
            "revised": True,
            "supersedes_schema_id": old_id,
            "inherited_evidence_count": len(old_evidence),
            "new_evidence_count": len(new_evidence),
        }

    async def _tool_retire_schema(self, args: Dict) -> Any:
        """Archive one active L6 Schema for an explicit user forgetting directive."""
        node_id = str(args.get("node_id") or "").strip()
        forget_fact_id = str(args.get("forget_fact_id") or "").strip()
        reason = str(args.get("reason") or "").strip()
        if not node_id or not forget_fact_id or not reason:
            return {"error": "node_id, forget_fact_id, and reason are required"}
        schema = await self.graph_store.get_node(node_id)
        if schema is None:
            return {"error": f"Schema {node_id} not found"}
        if schema.layer != MemoryLayer.L6_SCHEMA or schema.status != MemoryStatus.ACTIVE:
            return {"error": f"Schema {node_id} is not an active L6 Schema"}
        if schema.user_id != self.user_id or schema.agent_id != self.agent_id:
            return {"error": f"Schema {node_id} is outside the current user scope"}
        marker = await self.vector_store.get_by_id(forget_fact_id)
        if marker is None:
            return {"error": f"Forget marker {forget_fact_id} not found"}
        if marker.user_id != self.user_id or marker.agent_id != self.agent_id:
            return {"error": f"Forget marker {forget_fact_id} is outside the current user scope"}
        marker_text = str(marker.content or "").lower()
        if "forget" not in marker_text and "忘记" not in marker_text:
            return {"error": f"Fact {forget_fact_id} is not an explicit forgetting directive"}
        custom = dict(schema.custom or {})
        custom.update({
            "retired_by_forget_fact_id": forget_fact_id,
            "retirement_reason": reason,
        })
        updated = await self.graph_store.update_node(node_id, {
            "status": MemoryStatus.ARCHIVED.value,
            "valid_until": datetime.now(),
            "custom_json": json.dumps(custom, ensure_ascii=False),
        })
        if not updated:
            return {"error": f"Failed to retire Schema {node_id}"}
        return {
            "node_id": node_id,
            "retired": True,
            "status": MemoryStatus.ARCHIVED.value,
            "forget_fact_id": forget_fact_id,
        }

    async def _tool_add_evidence(self, args: Dict) -> Any:
        """Add evidence to an existing Schema/Intention (content stays immutable)"""
        node_id = args["node_id"]
        evidence_list = list(dict.fromkeys(
            str(value) for value in args["evidence_list"] if str(value)
        ))
        schema = await self.graph_store.get_node(node_id)
        if schema is None:
            return {"error": f"Schema {node_id} not found"}
        if schema.user_id != self.user_id or schema.agent_id != self.agent_id:
            return {"error": f"Schema {node_id} is outside the current user scope"}
        existing_refs = {
            str(item.get("node_id") or "")
            for item in await self.graph_store.get_evidence_vdbrefs(node_id)
            if item.get("node_id")
        }
        schema_custom = dict(schema.custom or {})
        covered_raw_ids = list(schema_custom.get("evidence_raw_source_ids") or [])
        covered_raw_set = set(covered_raw_ids)
        linked_nodes_added = 0
        raw_sources_added = 0
        evidence_sources = [getattr(schema, "source", None)]
        for eid in evidence_list:
            vdb_node = await self.vector_store.get_by_id(eid)
            if vdb_node is None:
                continue
            if vdb_node.user_id != self.user_id or vdb_node.agent_id != self.agent_id:
                continue
            evidence_sources.append(getattr(vdb_node, "source", None))
            new_raw_ids = [
                raw_id for raw_id in _evidence_raw_source_ids(vdb_node)
                if raw_id not in covered_raw_set
            ]
            if eid not in existing_refs:
                await self.graph_store.ensure_vdbref(eid, vdb_node.layer.value)
                linked = await self.graph_store.add_derived_from(node_id, eid)
                if linked:
                    existing_refs.add(eid)
                    linked_nodes_added += 1
                    await self._increment_evidence_count(eid, vdb_node)
            for raw_id in new_raw_ids:
                covered_raw_set.add(raw_id)
                covered_raw_ids.append(raw_id)
                raw_sources_added += 1

        from ..utils.source_filter import merge_sources
        merged_source = merge_sources(evidence_sources)
        if raw_sources_added or merged_source != schema.source:
            schema_custom["evidence_raw_source_ids"] = covered_raw_ids
            await self.graph_store.update_node(node_id, {
                "custom_json": json.dumps(schema_custom, ensure_ascii=False),
                "source": merged_source,
            })

        return {
            "node_id": node_id,
            "evidence_added": linked_nodes_added + raw_sources_added,
            "linked_nodes_added": linked_nodes_added,
            "raw_sources_added": raw_sources_added,
        }

    async def _increment_evidence_count(self, vdb_id: str, vdb_node=None) -> None:
        """递增 VDB fact 的 s2_evidence_count（存在 custom 子字典中，best-effort）"""
        try:
            # 读出当前 custom dict
            custom = {}
            if vdb_node and hasattr(vdb_node, "custom") and isinstance(vdb_node.custom, dict):
                custom = dict(vdb_node.custom)
            current = custom.get("s2_evidence_count", 0)
            custom["s2_evidence_count"] = current + 1
            # 写回 custom 子字典（_payload_to_node 通过 MemoryNode.from_dict 读 custom）
            await self.vector_store.update_payload(vdb_id, {"custom": custom})
        except Exception as e:
            logger.debug(f"[S2-tools] increment s2_evidence_count for {vdb_id} failed: {e}")

    async def _tool_add_edge(self, args: Dict) -> Any:
        source_id = args["source_id"]
        target_id = args["target_id"]
        reason = args.get("reason", "")

        props = {"relation_type": reason or "related"}

        success = await self.graph_store.add_edge(source_id, target_id, "RELATED_TO", props)
        return {"success": success, "edge": f"({source_id})-[RELATED_TO]->({target_id})"}
