"""Optional local cross-encoder reranker for the shared reader candidate pool."""

from __future__ import annotations

import logging
import threading
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "nreimers/mmarco-mMiniLMv2-L6-H384-v1"


class LocalCrossEncoderReranker:
    """Explicitly initialized transformers cross-encoder."""

    def __init__(
        self,
        model_name: str = DEFAULT_MODEL,
        *,
        device: str = "auto",
        max_length: int = 512,
        batch_size: int = 16,
    ) -> None:
        self.model_name = model_name or DEFAULT_MODEL
        self.device = device or "auto"
        self.max_length = max(32, int(max_length))
        self.batch_size = max(1, int(batch_size))
        self._tokenizer = None
        self._model = None
        self._torch = None
        self._load_error = ""
        self._lock = threading.Lock()

    @property
    def load_error(self) -> str:
        return self._load_error

    @property
    def initialized(self) -> bool:
        return self._model is not None

    def initialize(self) -> Dict[str, Any]:
        """Load the model and run one forward pass before Search serves traffic."""
        if self._model is not None:
            return {
                "model": self.model_name,
                "device": self.device,
                "already_initialized": True,
            }
        if self._load_error:
            raise RuntimeError(self._load_error)
        with self._lock:
            if self._model is not None:
                return {
                    "model": self.model_name,
                    "device": self.device,
                    "already_initialized": True,
                }
            if self._load_error:
                raise RuntimeError(self._load_error)
            try:
                import time

                import torch
                from transformers import AutoModelForSequenceClassification, AutoTokenizer

                started = time.perf_counter()
                device = self.device
                if device == "auto":
                    device = "cuda" if torch.cuda.is_available() else "cpu"
                tokenizer = AutoTokenizer.from_pretrained(self.model_name)
                model = AutoModelForSequenceClassification.from_pretrained(self.model_name)
                model.eval()
                model.to(device)
                self.device = device
                self._torch = torch
                self._tokenizer = tokenizer
                self._model = model
                loaded_ms = round((time.perf_counter() - started) * 1000, 2)

                warmup_started = time.perf_counter()
                scores = self._score_loaded(
                    "memory search warmup",
                    ["reranker initialization check"],
                )
                if len(scores) != 1:
                    raise RuntimeError(
                        f"warmup returned {len(scores)} scores, expected 1"
                    )
                warmup_ms = round((time.perf_counter() - warmup_started) * 1000, 2)
                logger.info(
                    "[local-rerank] initialized model=%s device=%s "
                    "load_ms=%.2f warmup_ms=%.2f",
                    self.model_name, self.device, loaded_ms, warmup_ms,
                )
                return {
                    "model": self.model_name,
                    "device": self.device,
                    "load_ms": loaded_ms,
                    "warmup_ms": warmup_ms,
                    "already_initialized": False,
                }
            except Exception as exc:
                self._load_error = f"{type(exc).__name__}: {exc}"
                # Do not leave a partially initialized model reachable by Search.
                self._tokenizer = None
                self._model = None
                self._torch = None
                logger.error(
                    "[local-rerank] initialization failed: %s",
                    self._load_error,
                )
                raise RuntimeError(self._load_error) from exc

    def score(self, query: str, documents: List[str]) -> Optional[List[float]]:
        if not documents:
            return []
        if not self.initialized:
            logger.error(
                "[local-rerank] score called before initialization; "
                "keep original ranking"
            )
            return None
        return self._score_loaded(query, documents)

    def _score_loaded(self, query: str, documents: List[str]) -> List[float]:
        """Score with an already loaded model; never performs model loading."""
        torch = self._torch
        scores: List[float] = []
        # Search concurrency is owned by the caller/deployment. The SDK does not
        # impose a rerank concurrency limit or serialize model forward passes.
        for start in range(0, len(documents), self.batch_size):
            docs = documents[start:start + self.batch_size]
            encoded = self._tokenizer(
                [query or ""] * len(docs),
                docs,
                padding=True,
                truncation=True,
                max_length=self.max_length,
                return_tensors="pt",
            )
            encoded = {key: value.to(self.device) for key, value in encoded.items()}
            with torch.no_grad():
                logits = self._model(**encoded).logits.reshape(-1)
            scores.extend(float(value) for value in logits.detach().cpu().tolist())
        return scores


_INSTANCES: Dict[tuple, LocalCrossEncoderReranker] = {}
_INSTANCES_LOCK = threading.Lock()


def get_local_reranker(
    model_name: str = DEFAULT_MODEL,
    *,
    device: str = "auto",
    max_length: int = 512,
    batch_size: int = 16,
) -> LocalCrossEncoderReranker:
    key = (model_name, device, int(max_length), int(batch_size))
    with _INSTANCES_LOCK:
        reranker = _INSTANCES.get(key)
        if reranker is None:
            reranker = LocalCrossEncoderReranker(
                model_name, device=device, max_length=max_length,
                batch_size=batch_size,
            )
            _INSTANCES[key] = reranker
    return reranker


def rerank_items_with_scores(
    query: str,
    items: List[Dict[str, Any]],
    *,
    limit: int,
    text_fn: Callable[[Dict[str, Any]], str],
    scorer: Callable[[str, List[str]], Optional[List[float]]],
) -> tuple[
    List[Dict[str, Any]], Dict[str, Any], List[Dict[str, Any]], Dict[str, float]
]:
    """Stable score-sort while retaining the one-pass pool and score map."""
    pool = list(items or [])
    if not pool or limit <= 0:
        return (
            pool[:max(0, limit)],
            {"applied": False, "pool_size": len(pool)},
            pool,
            {},
        )
    documents = [text_fn(item) for item in pool]
    try:
        scores = scorer(query or "", documents)
    except Exception as exc:
        logger.warning(
            "[local-rerank] inference failed; keep original ranking: %s",
            exc,
        )
        return (
            pool[:limit],
            {
                "applied": False,
                "pool_size": len(pool),
                "reason": "scorer_failed",
                "error_type": type(exc).__name__,
            },
            pool,
            {},
        )
    if scores is None or len(scores) != len(pool):
        return (
            pool[:limit],
            {
                "applied": False,
                "pool_size": len(pool),
                "reason": "scorer_unavailable_or_invalid",
            },
            pool,
            {},
        )
    scores_by_id = {
        str(item.get("node_id") or ""): float(score)
        for item, score in zip(pool, scores)
    }
    ranked = sorted(
        enumerate(pool),
        key=lambda row: (-float(scores[row[0]]), row[0]),
    )
    out = []
    for index, item in ranked[:limit]:
        out.append({**item, "_local_rerank_score": float(scores[index])})
    return (
        out,
        {
            "applied": True,
            "pool_size": len(pool),
            "returned": len(out),
            "top_scores": [
                round(float(scores[index]), 6) for index, _ in ranked[:limit]
            ],
        },
        pool,
        scores_by_id,
    )


def rerank_items(
    query: str,
    items: List[Dict[str, Any]],
    *,
    limit: int,
    text_fn: Callable[[Dict[str, Any]], str],
    scorer: Callable[[str, List[str]], Optional[List[float]]],
) -> tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Stable score-sort. None/wrong-size scores preserve the original order."""
    selected, info, _, _ = rerank_items_with_scores(
        query, items, limit=limit, text_fn=text_fn, scorer=scorer,
    )
    return selected, info
