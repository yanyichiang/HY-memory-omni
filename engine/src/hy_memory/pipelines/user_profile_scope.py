"""User-only synchronization helpers for L0-derived profile artifacts."""

from __future__ import annotations

import asyncio
import weakref


_LOOP_LOCKS = weakref.WeakKeyDictionary()


def user_profile_lock(user_id: str) -> asyncio.Lock:
    """Return an event-loop-local lock keyed only by user_id."""
    loop = asyncio.get_running_loop()
    locks = _LOOP_LOCKS.get(loop)
    if locks is None:
        locks = weakref.WeakValueDictionary()
        _LOOP_LOCKS[loop] = locks
    key = str(user_id or "").strip()
    lock = locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        locks[key] = lock
    return lock
