"""上传体积的前置拦截。

multipart 请求体在进入路由之前就会被框架整个接收下来（大的会先写进临时文件），
路由里再判断大小已经晚了。这里按请求头里的 Content-Length 提前拒绝，
浏览器上传文件时总会带这个头。
"""
from __future__ import annotations

import json
from typing import Any, Awaitable, Callable, Dict

from ..config import settings

Scope = Dict[str, Any]
Receive = Callable[[], Awaitable[Dict[str, Any]]]
Send = Callable[[Dict[str, Any]], Awaitable[None]]

MULTIPART_OVERHEAD = 1024 * 1024
"""multipart 的分隔符、表单字段等额外开销的余量。"""

MAX_DRAIN_BYTES = 512 * 1024 * 1024
"""拒绝之前最多读掉（丢弃）多少请求体。浏览器在发完请求体之前收到响应并断开连接，
只会报“连接被重置”，读不到我们的说明；本机传输很快，读完再答是值得的。"""


class UploadSizeLimitMiddleware:
    """multipart 请求的 Content-Length 超过上传上限时直接返回 413。"""

    def __init__(self, app: Any):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") == "http" and scope.get("method") in ("POST", "PUT", "PATCH"):
            headers = dict(scope.get("headers") or [])
            content_type = headers.get(b"content-type", b"").decode("latin-1").lower()
            if content_type.startswith("multipart/form-data"):
                try:
                    length = int(headers.get(b"content-length", b"0"))
                except ValueError:
                    length = 0
                limit = settings.max_file_size
                if length > limit + MULTIPART_OVERHEAD:
                    drained = await self._drain(receive) if length <= MAX_DRAIN_BYTES else False
                    await self._reject(send, limit, close=not drained)
                    return
        await self.app(scope, receive, send)

    @staticmethod
    async def _drain(receive: Receive) -> bool:
        """读掉并丢弃请求体；客户端中途断开返回 False。"""
        while True:
            message = await receive()
            if message.get("type") == "http.disconnect":
                return False
            if not message.get("more_body", False):
                return True

    @staticmethod
    async def _reject(send: Send, limit: int, close: bool) -> None:
        megabytes = limit / 1024 / 1024
        size = f"{megabytes:.0f}" if megabytes == int(megabytes) else f"{megabytes:.1f}"
        body = json.dumps(
            {"detail": f"文件太大了：上传上限是 {size} MB。请压缩或拆分后再上传。"},
            ensure_ascii=False,
        ).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/json; charset=utf-8"),
                    (b"content-length", str(len(body)).encode("ascii")),
                ]
                + ([(b"connection", b"close")] if close else []),
            }
        )
        await send({"type": "http.response.body", "body": body})
