"""
Read-side pipeline trace logger.

把一次 search 调用的各个阶段（embed / recall / bm25 / tag-match / rrf / evolution /
summary）写入通用 `pipeline_logs` 表，step 字符串统一以 `READ_` 为前缀，与 writer
侧（EXTRACT / RECONCILE / SUMMARY / WRITE_SUMMARY）平行。

对外契约：
  - 所有埋点调用都是 best-effort：cache 为空或写入失败时静默忽略，不影响主流程
  - step 名是常量，inspector 可按步骤前缀检索（如 `step="READ_RECALL_VEC"`）
  - 每条 log 的 parsed 字段存 JSON 化的结构化元数据（便于 inspector 解析 UI）

设计取舍：
  - 不引入新表，沿用现有 `store_pipeline_log`
  - logger 是无状态工具类，按 request/user/agent 绑定后批量复用
  - 内部 best-effort try/except 包死，上层调用方不用 try/except
"""

from __future__ import annotations

import functools
import json
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


def _best_effort_log(method):
    """包装 log_* 协程方法：任何异常（含参数签名错误）都静默吞掉。

    契约保证「埋点绝不影响主流程」。之前若调用方传错 kwarg，会在参数绑定阶段
    抛 TypeError（早于内部 try/except），把整个 search 带崩 → total_found=0。
    这里在最外层兜住所有异常，彻底落实 best-effort。
    """
    @functools.wraps(method)
    async def _wrapper(*args, **kwargs):
        try:
            return await method(*args, **kwargs)
        except Exception as e:  # noqa: BLE001 — trace 绝不能影响主流程
            logger.debug(f"[read-trace] {getattr(method, '__name__', '?')} swallowed: {e}")
            return None
    return _wrapper


# ================================================================
# Step 常量
# ================================================================

# Reader 共通
STEP_READ_SCENE_JUDGE   = "READ_SCENE_JUDGE"      # 生产力(coding)/普通场景判定（search 第一步，client 落库）
STEP_READ_REQUEST       = "READ_REQUEST"          # 入参快照
STEP_READ_EMBED_QUERY   = "READ_EMBED_QUERY"      # query embedding
STEP_READ_INTENT        = "READ_INTENT"           # 意图分类结果（hybrid/*_tag）

# 召回通道
STEP_READ_RECALL_VEC        = "READ_RECALL_VEC"        # 路 A：主向量召回
STEP_READ_HIDDEN_L0_CONTEXT = "READ_HIDDEN_L0_CONTEXT" # L0 used internally, not returned by Search
STEP_READ_KEYWORD_EMBED     = "READ_KEYWORD_EMBED"     # 路 B：keyword batch embed
STEP_READ_TAG_MATCH         = "READ_TAG_MATCH"         # 路 B：tag_index 相似度匹配
STEP_READ_RECALL_TAG        = "READ_RECALL_TAG"        # 路 B：tag filter 向量召回

# 融合 / 排序 / 合成
STEP_READ_BM25          = "READ_BM25"             # 路 C：BM25 重排
STEP_READ_RRF           = "READ_RRF"              # RRF 融合
STEP_READ_MERGE_SCHEMA  = "READ_MERGE_SCHEMA"     # schema 并入 + 截断
STEP_READ_EVOLUTION     = "READ_EVOLUTION"        # 演化链回溯合成
STEP_READ_INTENTION     = "READ_INTENTION"        # L7 意图召回（Proactive 路，含过期转换/补向量/判重）

# 总览
STEP_READ_GRAPH_RERANK  = "READ_GRAPH_RERANK"    # 图重排/扩展（用法 A/B/C + episode 框选）
STEP_READ_SUMMARY       = "READ_SUMMARY"          # 聚合总览（对齐 write 侧 WRITE_SUMMARY）

# Coding（productivity）召回路径
STEP_READ_CODING_EMBED  = "READ_CODING_EMBED"     # coding query embedding
STEP_READ_CODING_VDB    = "READ_CODING_VDB"       # coding store 向量召回（min_score 过滤前后）
STEP_READ_CODING_RESULT = "READ_CODING_RESULT"    # coding 召回最终结果总览


def _safe_json(obj: Any) -> str:
    try:
        return json.dumps(obj, ensure_ascii=False, default=str)
    except Exception:
        return "{}"


def _preview_node(item: Dict[str, Any], *, content_limit: int = 120) -> Dict[str, Any]:
    """把一条 hit 压缩成可读性好、体积小的预览结构。"""
    node = item.get("node")
    content = ""
    layer = ""
    tags: List[str] = []
    if node is not None:
        content = (getattr(node, "content", "") or "")[:content_limit]
        try:
            layer = node.layer.value if node.layer else ""
        except Exception:
            layer = ""
        try:
            tags = list(getattr(node, "tags", None) or [])
        except Exception:
            tags = []
    out = {
        "node_id": item.get("node_id", ""),
        "score": round(float(item.get("score", 0.0)), 6),
        "layer": layer,
        "content": content,
        "tags": tags,
    }
    if "_semantic" in item:
        out["_semantic"] = round(float(item["_semantic"]), 6)
    if "_bm25" in item:
        out["_bm25"] = round(float(item["_bm25"]), 6)
    if item.get("source"):
        out["source"] = item["source"]
    return out


def _preview_hits(items: List[Dict[str, Any]], *, top: int = 10) -> List[Dict[str, Any]]:
    return [_preview_node(it) for it in (items or [])[:top]]


# ================================================================
# Logger
# ================================================================

def _wrap_log_methods(cls):
    """给所有 log_* 协程方法套上 best-effort 包装（含参数签名错误也吞掉）。"""
    import inspect
    for name, attr in list(vars(cls).items()):
        if name.startswith("log_") and inspect.iscoroutinefunction(attr):
            setattr(cls, name, _best_effort_log(attr))
    return cls


@_wrap_log_methods
class ReadTraceLogger:
    """
    Read pipeline 的轻量 trace 写入器。

    使用方式：
        tracer_log = ReadTraceLogger(cache, request_id, user_id, agent_id)
        await tracer_log.log_embed_query(query, dims=384, cache_hit=False, elapsed_ms=12.3)
        ...

    所有 log_* 方法都 best-effort（cache 为 None / 写入异常 / 参数错误 → 静默跳过，
    绝不影响主 search 流程）。
    """


    def __init__(
        self,
        cache: Any,
        request_id: str,
        user_id: str,
        agent_id: str,
        reader_version: str = "",
        session_id: str = "",
    ):
        self._cache = cache
        self._request_id = request_id or ""
        self._user_id = user_id or ""
        self._agent_id = agent_id or "default_agent"
        self._reader_version = reader_version or ""
        self._session_id = session_id or ""

    @property
    def enabled(self) -> bool:
        return self._cache is not None and bool(self._request_id)

    async def _write(
        self,
        step: str,
        *,
        prompt: str = "",
        response: str = "",
        parsed: Optional[Dict[str, Any]] = None,
        memory_ids: Optional[List[str]] = None,
        elapsed_ms: float = 0.0,
    ) -> None:
        if not self.enabled:
            return
        try:
            # parsed 统一带上 reader 标签，便于 inspector 区分哪一版 reader
            p_dict = dict(parsed or {})
            if self._reader_version and "_reader" not in p_dict:
                p_dict["_reader"] = self._reader_version
            await self._cache.store_pipeline_log(
                request_id=self._request_id,
                user_id=self._user_id,
                agent_id=self._agent_id,
                session_id=self._session_id,
                step=step,
                prompt=prompt,
                response=response,
                parsed=_safe_json(p_dict),
                memory_ids=memory_ids or None,
                elapsed_ms=float(elapsed_ms or 0.0),
                prompt_tokens=0,
                completion_tokens=0,
                total_tokens=0,
            )
        except Exception as e:
            logger.debug(f"[read-trace] store_pipeline_log step={step} failed: {e}")

    # ------------------------------------------------------------------
    # 具体步骤埋点
    # ------------------------------------------------------------------

    async def log_scene_judge(
        self,
        *,
        query: str,
        scene: str,
        mode: str,
        is_coding: bool,
        rewrite_query: Optional[str] = None,
        rewrite_used: bool = False,
        created_after: Optional[str] = None,
        elapsed_ms: float = 0.0,
        llm_ms: Optional[float] = None,
        gc_delta: Optional[int] = None,
        throttle_ms: Optional[float] = None,
    ) -> None:
        """生产力(coding)/普通场景判定。search 的第一步，由 client 在调 reader 前落库。

        mode: "explicit"（显式 scene 指定，未调 LLM）/ "llm"（多 query LLM 判类+改写）
              / "default"（单 query 或链路关闭，默认 normal）
        created_after: query rewrite 抽出的时间下界，已转成可读日期字符串（如 "2026-06-24"），
                       无则 None。

        耗时字段语义（务必区分，历史上曾混淆过）：
        - elapsed_ms → 落库为 `parsed.step_ms`：**本环节整体墙钟耗时**（t0 → 本次调用），
          与是否调 LLM 无关。mode=default/explicit 时它就是一段纯同步代码的耗时。
        - llm_ms: **仅 mode="llm" 时有值**，是那次 judge/rewrite LLM 调用的净耗时。
          mode=default/explicit 不调 LLM → 不传 → parsed 里没有这个字段。

        运行时停顿归因字段（None 时不落库，保持 parsed 精简）：
        - gc_delta: 本段（t0 → 本次调用）内 GC 累计次数增量。>=1 说明期间发生过 GC。
        - throttle_ms: 本段内 cgroup CPU 被限流的时长（毫秒）。≈step_ms 说明是容器
          CPU throttling 导致的停顿。
        三者与 elapsed_ms 同为业务侧同步求值，可信度一致；用于区分
        GIL 争抢 / GC 长停顿 / cgroup throttling 三类进程级停顿。
        """
        _parsed = {
            "scene": scene,
            "mode": mode,
            "is_coding": is_coding,
            "rewrite_query": rewrite_query,
            "rewrite_used": rewrite_used,
            "created_after": created_after,
        }
        if llm_ms is not None:
            _parsed["llm_ms"] = round(float(llm_ms), 2)
        if gc_delta is not None:
            _parsed["gc_delta"] = int(gc_delta)
        if throttle_ms is not None:
            _parsed["throttle_ms"] = round(float(throttle_ms), 2)
        await self._write(
            STEP_READ_SCENE_JUDGE,
            prompt=query or "",
            response=_safe_json({
                "scene": scene,
                "mode": mode,
                "is_coding": is_coding,
                "rewrite_used": rewrite_used,
                "created_after": created_after,
            }),
            parsed=_parsed,
            elapsed_ms=elapsed_ms,
        )

    async def log_coding_embed(
        self,
        *,
        query: str,
        dims: int = 0,
        elapsed_ms: float = 0.0,
        provider_meta: Optional[Dict[str, Any]] = None,
    ) -> None:
        """coding 路径：query embedding。"""
        parsed: Dict[str, Any] = {"dims": dims}
        if provider_meta:
            parsed["provider_meta"] = provider_meta
        await self._write(
            STEP_READ_CODING_EMBED,
            prompt=query or "",
            response=_safe_json({"dims": dims}),
            parsed=parsed,
            elapsed_ms=elapsed_ms,
        )

    async def log_coding_vdb(
        self,
        *,
        query: str,
        raw_hits: int,
        kept_hits: int,
        min_score: float,
        top_scores: Optional[List[float]] = None,
        workspace_id: Optional[str] = None,
        branch: Optional[str] = None,
        elapsed_ms: float = 0.0,
    ) -> None:
        """coding 路径：coding store 向量召回 + min_score 过滤。

        raw_hits: 过采样召回条数；kept_hits: min_score 过滤后条数。
        top_scores: 过滤前 top 分数，便于诊断"是分数不够还是库为空"。
        """
        await self._write(
            STEP_READ_CODING_VDB,
            prompt=query or "",
            response=_safe_json({
                "raw_hits": raw_hits,
                "kept_hits": kept_hits,
                "min_score": min_score,
            }),
            parsed={
                "raw_hits": raw_hits,
                "kept_hits": kept_hits,
                "min_score": min_score,
                "top_scores": [round(float(s), 4) for s in (top_scores or [])[:10]],
                "workspace_id": workspace_id,
                "branch": branch,
            },
            elapsed_ms=elapsed_ms,
        )

    async def log_coding_result(
        self,
        *,
        query: str,
        returned: int,
        memory_ids: Optional[List[str]] = None,
        previews: Optional[List[Dict[str, Any]]] = None,
        elapsed_ms: float = 0.0,
    ) -> None:
        """coding 路径：最终返回结果总览（search 收尾）。"""
        await self._write(
            STEP_READ_CODING_RESULT,
            prompt=query or "",
            response=_safe_json({"returned": returned}),
            parsed={"returned": returned, "hits": previews or [],
                    "elapsed_ms": round(float(elapsed_ms or 0.0), 2)},
            memory_ids=memory_ids or None,
            # 收尾总览：elapsed_ms 是整条 coding search 的总耗时（汇总值，非单环节），
            # 落库 elapsed_ms 字段置 0，总耗时保留在 parsed.elapsed_ms。
            elapsed_ms=0,
        )

    async def log_request(
        self,
        *,
        query: str,
        limit: int,
        layers: Optional[List[str]],
        min_score: float = 0.0,
        schema_min_score: Optional[float] = None,
        schema_limit: Optional[int] = None,
        user_ids: List[str],
        agent_ids: List[str],
        session_ids: List[str],
        intention_limit: Optional[int] = None,
    ) -> None:
        # intention_limit：调用方传入的 L7 意图召回上限。0 或 None 都会导致
        # reader 跳过 intention 通道；把它明确落进 READ_REQUEST.parsed，才能
        # 从日志区分「上游没传」和「reader 内部跳过」这两种截然不同的失败模式
        # （0805 事故追查耗时的直接原因）。
        parsed = {
            "query": query,
            "limit": limit,
            "layers": layers,
            "min_score": min_score,
            "schema_min_score": schema_min_score,
            "schema_limit": schema_limit,
            "intention_limit": intention_limit,
            "user_ids": user_ids,
            "agent_ids": agent_ids,
            "session_ids": session_ids,
        }
        await self._write(
            STEP_READ_REQUEST,
            prompt=query or "",
            response=_safe_json({
                "limit": limit,
                "min_score": min_score,
                "user_ids": user_ids,
                "agent_ids": agent_ids,
                "session_ids": session_ids,
            }),
            parsed=parsed,
        )

    async def log_embed_query(
        self,
        *,
        query: str,
        dims: int,
        cache_hit: bool,
        elapsed_ms: float = 0.0,
        provider_meta: Optional[Dict[str, Any]] = None,
    ) -> None:
        parsed: Dict[str, Any] = {"dims": dims, "cache_hit": cache_hit}
        if provider_meta:
            parsed["provider_meta"] = provider_meta
        await self._write(
            STEP_READ_EMBED_QUERY,
            prompt=query or "",
            response=_safe_json({"dims": dims, "cache_hit": cache_hit}),
            parsed=parsed,
            elapsed_ms=elapsed_ms,
        )

    async def log_intent(self, *, query: str, intent: str, keywords: List[str]) -> None:
        await self._write(
            STEP_READ_INTENT,
            prompt=query or "",
            response=intent,
            parsed={"intent": intent, "keywords": keywords},
        )

    async def log_recall_vec(
        self,
        *,
        pool_size: int,
        hits: List[Dict[str, Any]],
        elapsed_ms: float = 0.0,
        sparse_query: Optional[Dict[str, Any]] = None,
    ) -> None:
        preview = _preview_hits(hits)
        parsed = {
            "pool_size": pool_size,
            "returned": len(hits),
            "hits": preview,
        }
        if sparse_query is not None:
            parsed["sparse_query"] = sparse_query
        await self._write(
            STEP_READ_RECALL_VEC,
            prompt=f"limit={pool_size}",
            response=_safe_json({"count": len(hits), "top": preview[:5]}),
            parsed=parsed,
            memory_ids=[h.get("node_id", "") for h in hits if h.get("node_id")],
            elapsed_ms=elapsed_ms,
        )

    async def log_hidden_l0_context(
        self,
        *,
        hits: List[Dict[str, Any]],
        elapsed_ms: float = 0.0,
    ) -> None:
        preview = _preview_hits(hits)
        parsed = {
            "returned": len(hits),
            "hits": preview,
        }
        await self._write(
            STEP_READ_HIDDEN_L0_CONTEXT,
            prompt="",
            response=_safe_json({"count": len(hits), "top": preview[:5]}),
            parsed=parsed,
            memory_ids=[h.get("node_id", "") for h in hits if h.get("node_id")],
            elapsed_ms=elapsed_ms,
        )

    async def log_keyword_embed(
        self,
        *,
        keywords: List[str],
        vec_count: int,
        elapsed_ms: float = 0.0,
        provider_metas: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        parsed: Dict[str, Any] = {"keywords": keywords, "vec_count": vec_count}
        if provider_metas is not None:
            parsed["provider_metas"] = provider_metas
        await self._write(
            STEP_READ_KEYWORD_EMBED,
            prompt=_safe_json(keywords),
            response=_safe_json({"vec_count": vec_count}),
            parsed=parsed,
            elapsed_ms=elapsed_ms,
        )

    async def log_tag_match(
        self,
        *,
        keywords: List[str],
        hit_tags: List[str],
        topk: int,
        min_score: float,
        elapsed_ms: float = 0.0,
    ) -> None:
        parsed = {
            "keywords": keywords,
            "hit_tags": hit_tags,
            "topk": topk,
            "min_score": min_score,
        }
        await self._write(
            STEP_READ_TAG_MATCH,
            prompt=_safe_json(keywords),
            response=_safe_json(hit_tags),
            parsed=parsed,
            elapsed_ms=elapsed_ms,
        )

    async def log_recall_tag(
        self,
        *,
        hit_tags: List[str],
        pool_size: int,
        hits: List[Dict[str, Any]],
        elapsed_ms: float = 0.0,
    ) -> None:
        preview = _preview_hits(hits)
        parsed = {
            "hit_tags": hit_tags,
            "pool_size": pool_size,
            "returned": len(hits),
            "hits": preview,
        }
        await self._write(
            STEP_READ_RECALL_TAG,
            prompt=_safe_json(hit_tags),
            response=_safe_json({"count": len(hits), "top": preview[:5]}),
            parsed=parsed,
            memory_ids=[h.get("node_id", "") for h in hits if h.get("node_id")],
            elapsed_ms=elapsed_ms,
        )

    async def log_bm25(
        self,
        *,
        pool_size: int,
        query_terms: List[str],
        hits: List[Dict[str, Any]],
        raw_hits: Optional[List[Dict[str, Any]]] = None,
        bm25_scores: Optional[Dict[str, float]] = None,
        normalize_method: Optional[str] = None,
        sigmoid_midpoint: Optional[float] = None,
        sigmoid_steepness: Optional[float] = None,
        has_bm25: Optional[bool] = None,
        elapsed_ms: float = 0.0,
        sparse_query: Optional[Dict[str, Any]] = None,
    ) -> None:
        """BM25/keyword 路埋点。

        除融合后的 `hits` 外，尽量暴露 BM25 的「具体情况」：
          - keyword_count / has_bm25：本 query 后端关键词召回是否命中（决定是否触发加权）；
          - normalize_method：`passthrough`（后端分已在 [0,1]）/
            `sigmoid`（经典 BM25 原始分 → sigmoid 归一化）；
          - sigmoid_midpoint / sigmoid_steepness：sigmoid 归一化参数（随 query 词数自适应）；
          - bm25_detail：每条关键词命中的 raw → normalized 变换（看清单条 BM25 如何参与打分）；
          - sparse_query：BM25Encoder.encode_queries 产出的 sparse（nnz + 完整 [[token_id, weight], ...]）。
        """
        preview = _preview_hits(hits)
        # 关键词命中的 raw→normalized 明细（按 raw 分降序，便于排查）
        bm25_detail: List[Dict[str, Any]] = []
        _scores = bm25_scores or {}
        _raw = raw_hits if raw_hits is not None else []
        for r in sorted(_raw, key=lambda x: x.get("score", 0.0), reverse=True)[:20]:
            nid = r.get("node_id", "")
            bm25_detail.append({
                "node_id": nid,
                "raw": round(float(r.get("score", 0.0)), 6),
                "norm": round(float(_scores.get(nid, 0.0)), 6),
            })
        keyword_count = len(_raw)
        _has = has_bm25 if has_bm25 is not None else bool(_scores or _raw)
        parsed = {
            "pool_size": pool_size,
            "query_terms": query_terms,
            "keyword_count": keyword_count,
            "has_bm25": _has,
            "normalize_method": normalize_method,
            "sigmoid_midpoint": round(float(sigmoid_midpoint), 6) if sigmoid_midpoint is not None else None,
            "sigmoid_steepness": round(float(sigmoid_steepness), 6) if sigmoid_steepness is not None else None,
            "bm25_detail": bm25_detail,
            "returned": len(hits),
            "hits": preview,
        }
        if sparse_query is not None:
            parsed["sparse_query"] = sparse_query
        await self._write(
            STEP_READ_BM25,
            prompt=_safe_json(query_terms),
            response=_safe_json({
                "keyword_count": keyword_count,
                "has_bm25": _has,
                "normalize_method": normalize_method,
                "top_bm25": bm25_detail[:5],
                "sparse_nnz": (sparse_query or {}).get("nnz") if sparse_query else None,
            }),
            parsed=parsed,
            memory_ids=[h.get("node_id", "") for h in hits if h.get("node_id")],
            elapsed_ms=elapsed_ms,
        )

    async def log_rrf(
        self,
        *,
        channels: Dict[str, int],          # {"vec": 30, "tag": 18, "bm25": 12}
        weights: Dict[str, float],
        fused: List[Dict[str, Any]],
        confidence: float,
        is_low_confidence: bool,
        top_n: int = 10,
    ) -> None:
        preview: List[Dict[str, Any]] = []
        for item in (fused or [])[:top_n]:
            preview.append({
                "node_id": item.get("node_id", ""),
                "rrf_score": round(float(item.get("rrf_score", 0.0)), 6),
                "rank_by_channel": item.get("rrf_rank_by_channel", {}),
                "per_channel_score": {
                    k: round(float(v), 6)
                    for k, v in (item.get("per_channel_score") or {}).items()
                },
            })
        parsed = {
            "channels": channels,
            "weights": weights,
            "confidence": round(float(confidence), 4),
            "is_low_confidence": bool(is_low_confidence),
            "top": preview,
        }
        await self._write(
            STEP_READ_RRF,
            prompt=_safe_json(weights),
            response=_safe_json({
                "confidence": round(float(confidence), 4),
                "is_low_confidence": bool(is_low_confidence),
                "top": preview[:5],
            }),
            parsed=parsed,
            memory_ids=[p["node_id"] for p in preview if p.get("node_id")],
        )

    async def log_merge_schema(
        self,
        *,
        fused_size: int,
        schema_size: int,
        merged_size: int,
        final_limit: int,
    ) -> None:
        await self._write(
            STEP_READ_MERGE_SCHEMA,
            prompt="",
            response=_safe_json({
                "fused_size": fused_size,
                "schema_size": schema_size,
                "merged_size": merged_size,
                "final_limit": final_limit,
            }),
            parsed={
                "fused_size": fused_size,
                "schema_size": schema_size,
                "merged_size": merged_size,
                "final_limit": final_limit,
            },
        )

    async def log_graph_rerank(
        self,
        *,
        stats: Optional[Dict[str, Any]] = None,
        pool_size: int = 0,
        admitted_ids: Optional[List[str]] = None,
        elapsed_ms: float = 0.0,
    ) -> None:
        """图重排 / 扩展（用法 A/B/C + episode 框选）。

        这一步的效果**必须能和"池子变大"区分开**，所以 stats 要同时带上漏斗各级的存量：
        edges / propagated / reachable / episode_candidates / prefiltered / admitted / paths。
        少了它线上只能看到"结果变了"，无法归因到是哪一级放进来的。
        """
        st = dict(stats or {})
        st["pool_size"] = pool_size
        if admitted_ids:
            st["admitted_ids"] = list(admitted_ids)[:50]
        await self._write(
            STEP_READ_GRAPH_RERANK,
            prompt="",
            response=_safe_json(st),
            parsed=st,
            memory_ids=list(admitted_ids or [])[:50] or None,
            elapsed_ms=elapsed_ms,
        )

    async def log_evolution(
        self,
        *,
        input_size: int,
        evolved_count: int,
        elapsed_ms: float = 0.0,
    ) -> None:
        await self._write(
            STEP_READ_EVOLUTION,
            prompt="",
            response=_safe_json({
                "input_size": input_size,
                "evolved_count": evolved_count,
            }),
            parsed={
                "input_size": input_size,
                "evolved_count": evolved_count,
            },
            elapsed_ms=elapsed_ms,
        )

    async def log_intention(
        self,
        *,
        stats: Optional[Dict[str, Any]] = None,
        elapsed_ms: float = 0.0,
    ) -> None:
        """L7 意图召回（Proactive 路）分段耗时与数量。

        这一步此前**完全没有埋点**，导致 READ_EVOLUTION → READ_SUMMARY 之间
        出现无法解释的空白（线上见过 426ms）。stats 由
        `_retrieval.intention.recall_intentions()` 通过 stats_out 回填，
        分段拆开各子环节，便于直接定位是哪一段慢：

        - `vdb_search_ms`      VDB 向量检索（超采样捞 L7，fetch_limit=limit×6）
        - `expire_ms`          惰性过期转换（逐条 update_payload 转 L2_FACT）
        - `backfill_embed_ms`  判重前补拉缺失 embedding（get_embeddings）
        - `dedup_ms`           判重（cosine 两两比较，纯 CPU）
        - `total_ms`           recall_intentions 端到端
        数量类：`fetched` / `expired` / `survivors` / `dedup_dropped` / `returned`

        `stats.total_ms` 表示函数自身端到端耗时，适合跨调用路径比较。
        """
        await self._write(
            STEP_READ_INTENTION,
            parsed=dict(stats or {}),
            elapsed_ms=elapsed_ms,
        )

    async def log_summary(
        self,
        *,
        query: str,
        intent: Optional[str],
        confidence: Optional[float],
        is_low_confidence: Optional[bool],
        channels: Dict[str, int],
        total_found: int,
        elapsed_ms: float,
        returned_memories: List[Dict[str, Any]],
    ) -> None:
        """一次 search 的总览日志，对齐 writer 侧的 WRITE_SUMMARY 作用。"""
        parsed = {
            "query": query,
            "reader": self._reader_version,
            "intent": intent,
            "confidence": round(float(confidence), 4) if confidence is not None else None,
            "is_low_confidence": is_low_confidence,
            "channels": channels,
            "total_found": total_found,
            "elapsed_ms": round(float(elapsed_ms or 0.0), 2),
            "returned": [
                {
                    "memory_id": m.get("memory_id", ""),
                    "layer": m.get("layer", ""),
                    "score": round(float(m.get("score", 0.0)), 6),
                    "content": (m.get("content", "") or "")[:160],
                    "tags": m.get("tags") or [],
                }
                for m in (returned_memories or [])[:20]
            ],
        }
        await self._write(
            STEP_READ_SUMMARY,
            prompt=query or "",
            response=_safe_json({
                "reader": self._reader_version,
                "intent": intent,
                "confidence": parsed["confidence"],
                "total_found": total_found,
                "elapsed_ms": parsed["elapsed_ms"],
            }),
            parsed=parsed,
            memory_ids=[m.get("memory_id") for m in (returned_memories or []) if m.get("memory_id")],
            # 一次 search 的总览：elapsed_ms 是整条 search 的总耗时（汇总值，非单环节），
            # 落库 elapsed_ms 字段置 0，总耗时保留在 parsed.elapsed_ms / response。
            elapsed_ms=0,
        )
