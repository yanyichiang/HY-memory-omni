"""
Agent Memory V2 - Cache 工厂

根据配置选择缓存后端:
- sqlite (默认): 零依赖，单机开箱即用
- mysql: 标准 MySQL 持久化，需安装 aiomysql 包

Usage:
    from hy_memory.data.cache import create_cache
    cache = create_cache(config)
    await cache.initialize()
"""

import logging
from .cache_base import CacheBase
from ..config import MemoryConfig

logger = logging.getLogger(__name__)

_SUPPORTED_BACKENDS = ("sqlite", "mysql")


def create_cache(config: MemoryConfig) -> CacheBase:
    """
    根据配置创建缓存后端实例。

    支持的后端:
    - "sqlite": SqliteCache (默认，零依赖本地持久化)
    - "mysql":  MysqlCache (标准 MySQL，需安装 aiomysql 包)

    Args:
        config: MemoryConfig 实例

    Returns:
        CacheBase 子类实例

    Raises:
        ValueError: backend 缺失或不在 sqlite/mysql 之内
    """
    backend_raw = getattr(getattr(config, "cache", None), "backend", None)
    if not backend_raw or not str(backend_raw).strip():
        raise ValueError(
            "config.cache.backend is required (one of: sqlite / mysql)"
        )
    backend = str(backend_raw).lower().strip()

    if backend == "mysql":
        from .cache_mysql import MysqlCache
        logger.info("Cache backend: mysql")
        return MysqlCache(config)
    elif backend == "sqlite":
        from .cache_sqlite import SqliteCache
        return SqliteCache(config)
    else:
        raise ValueError(
            f"Unknown cache backend {backend!r}; must be one of: sqlite / mysql"
        )


__all__ = ["CacheBase", "create_cache"]
