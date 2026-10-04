"""跨站请求防护。

浏览器里任何网页都可以向 http://127.0.0.1:8000 发 POST——跨域规则只拦“读响应”，不拦“发请求”。
更麻烦的是，不带 Content-Type 的请求体（例如一个没有类型的 Blob）在浏览器看来是“简单请求”，
不会先发预检；而 FastAPI 遇到没有 Content-Type 的请求体会照样按 JSON 解析。于是恶意网页
可以让本机服务执行任意接口，例如让后端带着已保存的 API Key 去请求攻击者指定的地址。

浏览器发出的跨站非 GET 请求一定带 Origin 头，所以这里对会改变状态的请求核对来源：
来自本应用自己的页面（同源）或开发服务器（CORS 白名单里的地址）才放行。不带 Origin 的
请求（命令行工具、脚本、测试客户端）不是浏览器发的，也放行——它们本来就能直接访问本机端口。
"""
from __future__ import annotations

import json
from typing import Any, Awaitable, Callable, Dict, Iterable, Set

from ..config import settings

Scope = Dict[str, Any]
Receive = Callable[[], Awaitable[Dict[str, Any]]]
Send = Callable[[Dict[str, Any]], Awaitable[None]]

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def _normalize(origin: str) -> str:
    return origin.strip().rstrip("/").lower()


class OriginGuardMiddleware:
    """拒绝来自其他网站的、会改变状态的请求。"""

    def __init__(self, app: Any, extra_origins: Iterable[str] = ()):
        self.app = app
        self._extra = {_normalize(o) for o in extra_origins}

    def _allowed(self) -> Set[str]:
        return {_normalize(o) for o in settings.cors_origins} | self._extra

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") == "http" and scope.get("method", "GET").upper() not in SAFE_METHODS:
            headers = dict(scope.get("headers") or [])
            raw_origin = headers.get(b"origin")
            if raw_origin is not None:
                origin = _normalize(raw_origin.decode("latin-1"))
                host = headers.get(b"host", b"").decode("latin-1").strip().lower()
                same_origin = bool(host) and origin in (f"http://{host}", f"https://{host}")
                if not same_origin and origin not in self._allowed():
                    await self._reject(send)
                    return
        await self.app(scope, receive, send)

    @staticmethod
    async def _reject(send: Send) -> None:
        body = json.dumps(
            {"detail": "拒绝了来自其他网站的请求。请直接在本应用的页面里操作。"},
            ensure_ascii=False,
        ).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": 403,
                "headers": [
                    (b"content-type", b"application/json; charset=utf-8"),
                    (b"content-length", str(len(body)).encode("ascii")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
