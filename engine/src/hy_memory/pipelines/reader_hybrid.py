"""Hybrid reader: vector + BM25 recall with shared post-processing."""

from .reader_base import BaseReadPipeline


class HybridReadPipeline(BaseReadPipeline):
    """Add BM25 candidates to the same pipeline used by the legacy reader."""

    VERSION = "hybrid"
    ENABLE_KEYWORD_RECALL = True
