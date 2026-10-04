"""写作管线共用的小工具：计字、时间戳、ID、分句。"""
from __future__ import annotations

import re
import secrets
import threading
from datetime import datetime, timedelta, timezone
from typing import List

_WHITESPACE_RE = re.compile(r"\s+")
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[。！？!?；;])|\n+")


def count_chars(text: str | None) -> int:
    """正文字数：非空白字符数。前后端、预算与审校统一用这个口径。"""
    if not text:
        return 0
    return len(_WHITESPACE_RE.sub("", text))


_last_stamp = datetime.min.replace(tzinfo=timezone.utc)
_stamp_lock = threading.Lock()


def now_iso() -> str:
    """当前时间（UTC，ISO 8601，毫秒级），同一进程内严格递增。

    保存正文时的编辑冲突检测、恢复历史版本时的核对都靠它区分先后：秒级会把
    同一秒内的两次修改当成同一个版本；系统时钟的分辨率也可能粗到十几毫秒，
    所以撞上上一次的值时顺延 1 毫秒，保证每次取到的都不一样。
    """
    global _last_stamp
    with _stamp_lock:
        now = datetime.now(timezone.utc)
        now = now.replace(microsecond=now.microsecond // 1000 * 1000)
        if now <= _last_stamp:
            now = _last_stamp + timedelta(milliseconds=1)
        _last_stamp = now
    return now.isoformat(timespec="milliseconds")


def new_id(nbytes: int = 6) -> str:
    """生成短随机 ID（十六进制）。"""
    return secrets.token_hex(nbytes)


def split_sentences(text: str | None) -> List[str]:
    """按中文句末标点与换行切句，去掉空白句。"""
    if not text:
        return []
    parts = _SENTENCE_SPLIT_RE.split(text)
    return [p.strip() for p in parts if p and p.strip()]


def clip(text: str | None, limit: int, suffix: str = "…") -> str:
    """把文本截到 limit 个字符以内（超出时加省略号）。"""
    value = (text or "").strip()
    if limit <= 0 or len(value) <= limit:
        return value
    return value[: max(limit - len(suffix), 0)].rstrip() + suffix
