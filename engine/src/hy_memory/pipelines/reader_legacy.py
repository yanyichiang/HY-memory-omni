"""Legacy reader: vector recall with the shared read-side processing pipeline."""

from .reader_base import BaseReadPipeline


class LegacyReadPipeline(BaseReadPipeline):
    """Use vector retrieval only; all post-recall processing is shared."""

    VERSION = "legacy"
    ENABLE_KEYWORD_RECALL = False
