"""
Agent Memory V2 - VectorStore Provider 工厂

根据配置选择向量数据库后端 (Chroma / Qdrant / FAISS)。

用法:
    from .vector_store import create_vector_store, VectorStore

    # 工厂函数 (推荐)
    store = create_vector_store(config)

    # 向后兼容别名（默认创建对应 provider 的实例）
    store = VectorStore(config)
"""

import logging
from typing import TYPE_CHECKING

from ..config import MemoryConfig
from .vector_store_base import VectorStoreBase

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)


def create_vector_store(config: MemoryConfig) -> VectorStoreBase:
    """
    工厂函数: 根据 config.vector_store.provider 创建对应的 VectorStore 实现。

    - "chroma"  → ChromaVectorStore  (嵌入式, 零外部服务依赖)
    - "qdrant"  → QdrantVectorStore  (嵌入式 / 远程)
    - "faiss"   → FaissVectorStore   (嵌入式, CPU)
    未配置或配置未知 provider 直接抛错；不做任何静默 fallback 到 chroma。
    """
    provider = getattr(config.vector_store, 'provider', None)
    if not provider or not str(provider).strip():
        raise ValueError(
            "config.vector_store.provider is required "
            "(one of: chroma / qdrant / faiss)"
        )
    provider = str(provider).lower().strip()

    if provider == "qdrant":
        from .vector_store_qdrant import QdrantVectorStore
        logger.debug("VectorStore provider: qdrant")
        return QdrantVectorStore(config)
    elif provider == "faiss":
        from .vector_store_faiss import FaissVectorStore
        logger.debug("VectorStore provider: faiss")
        return FaissVectorStore(config)
    elif provider == "chroma":
        from .vector_store_chroma import ChromaVectorStore
        logger.debug("VectorStore provider: chroma")
        return ChromaVectorStore(config)
    else:
        raise ValueError(
            f"Unknown vector_store provider {provider!r}; "
            f"must be one of: chroma / qdrant / faiss"
        )


# 向后兼容: `from .vector_store import VectorStore` 仍然可用
# VectorStore 现在是工厂函数的别名，调用 VectorStore(config) 等价于 create_vector_store(config)
def VectorStore(config: MemoryConfig) -> VectorStoreBase:
    """向后兼容别名 - 等价于 create_vector_store(config)"""
    return create_vector_store(config)
