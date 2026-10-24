"""Process-wide, event-loop-local concurrency budgets for memory workflows.

One top-level write fans out into many LLM, embedding, retrieval, graph, and
episode operations.  These gates bound that fan-out without changing the
synchronous API contract: a write still waits for all work that belongs to it.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import dataclass
import logging
import os
import threading
import time
import weakref


logger = logging.getLogger(__name__)

_workload_kind: ContextVar[str] = ContextVar(
    "hy_memory_workload_kind", default="foreground",
)
_states: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, dict]" = (
    weakref.WeakKeyDictionary()
)
_states_lock = threading.Lock()


@dataclass
class _GateStats:
    active: int = 0
    max_active: int = 0
    wait_count: int = 0
    waited_count: int = 0
    total_wait_ms: float = 0.0
    max_wait_ms: float = 0.0


def _limit(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(default))))
    except (TypeError, ValueError):
        return default


def _gate(limit: int) -> dict:
    return {
        "semaphore": asyncio.Semaphore(limit),
        "limit": limit,
        "stats": _GateStats(),
    }


def _state() -> dict:
    loop = asyncio.get_running_loop()
    with _states_lock:
        state = _states.get(loop)
        if state is None:
            state = {
                "llm": _gate(_limit("MEMORY_LLM_GLOBAL_CONCURRENCY", 32)),
                "derived_llm": _gate(
                    _limit("MEMORY_DERIVED_LLM_CONCURRENCY", 20)
                ),
                "episode": _gate(
                    _limit("MEMORY_DYNAMIC_EPISODE_CONCURRENCY", 20)
                ),
                "graph": _gate(
                    _limit("MEMORY_GRAPH_PROJECTION_CONCURRENCY", 20)
                ),
                # Kuzu has one process-wide executor worker.  A projection-level
                # gate of one prevents dozens of projections from each enqueueing
                # hundreds of tiny Cypher calls ahead of one another.
                "graph_kuzu": _gate(
                    _limit("MEMORY_KUZU_PROJECTION_CONCURRENCY", 1)
                ),
                "embedding": _gate(
                    _limit("MEMORY_EMBEDDING_GLOBAL_CONCURRENCY", 20)
                ),
                # Reconcile can create 2 searches per extracted fact.  Keep local
                # stores especially narrow because every query scans the local
                # collection and competes for CPU/memory bandwidth.
                "reconcile_retrieval": _gate(
                    _limit("MEMORY_RECONCILE_RETRIEVAL_CONCURRENCY", 16)
                ),
                "reconcile_retrieval_local": _gate(
                    _limit("MEMORY_RECONCILE_LOCAL_RETRIEVAL_CONCURRENCY", 2)
                ),
            }
            _states[loop] = state
        return state


@asynccontextmanager
async def _slot(name: str, trace_name: str):
    gate = _state()[name]
    stats = gate["stats"]
    stats.wait_count += 1
    started = time.perf_counter()
    await gate["semaphore"].acquire()
    wait_ms = (time.perf_counter() - started) * 1000
    stats.total_wait_ms += wait_ms
    stats.max_wait_ms = max(stats.max_wait_ms, wait_ms)
    if wait_ms >= 1.0:
        stats.waited_count += 1
    stats.active += 1
    stats.max_active = max(stats.max_active, stats.active)
    warn_ms = _limit("MEMORY_WORKLOAD_GATE_LOG_MS", 1000)
    if wait_ms >= warn_ms:
        logger.info(
            "TRACE_PERF %s wait_ms=%.1f active=%d limit=%d",
            trace_name, wait_ms, stats.active, gate["limit"],
        )
    try:
        yield
    finally:
        stats.active -= 1
        gate["semaphore"].release()


def workload_snapshot() -> dict:
    result = {}
    for name, gate in _state().items():
        stats = gate["stats"]
        result[name] = {
            "limit": gate["limit"],
            "active": stats.active,
            "max_active": stats.max_active,
            "wait_count": stats.wait_count,
            "waited_count": stats.waited_count,
            "total_wait_ms": round(stats.total_wait_ms, 3),
            "max_wait_ms": round(stats.max_wait_ms, 3),
        }
    return result


@asynccontextmanager
async def workload_scope(kind: str):
    token = _workload_kind.set(str(kind or "foreground"))
    try:
        yield
    finally:
        _workload_kind.reset(token)


@asynccontextmanager
async def llm_slot():
    if _workload_kind.get() == "derived":
        async with _slot("derived_llm", "DERIVED_LLM_GATE_WAIT"):
            async with _slot("llm", "LLM_GATE_WAIT"):
                yield
    else:
        async with _slot("llm", "LLM_GATE_WAIT"):
            yield


@asynccontextmanager
async def episode_slot():
    async with _slot("episode", "EPISODE_GATE_WAIT"):
        yield


@asynccontextmanager
async def graph_slot(*, kuzu: bool = False):
    name = "graph_kuzu" if kuzu else "graph"
    trace = "KUZU_GRAPH_GATE_WAIT" if kuzu else "GRAPH_GATE_WAIT"
    async with _slot(name, trace):
        yield


@asynccontextmanager
async def embedding_slot():
    async with _slot("embedding", "EMBED_GATE_WAIT"):
        yield


@asynccontextmanager
async def reconcile_retrieval_slot(*, local: bool = False):
    name = "reconcile_retrieval_local" if local else "reconcile_retrieval"
    trace = (
        "RECONCILE_LOCAL_RETRIEVAL_GATE_WAIT"
        if local else "RECONCILE_RETRIEVAL_GATE_WAIT"
    )
    async with _slot(name, trace):
        yield
