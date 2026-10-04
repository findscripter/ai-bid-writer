"""用 uvicorn 运行本应用时使用的 Server。

页面开着任务事件流（长连接）时，uvicorn 退出会先等这些连接自己结束（最多
timeout_graceful_shutdown 秒），等不到就强行取消，还会打印一大段报错。
这里在等待之前先取消后台任务：任务结束时事件流会推送“已取消”并正常关闭，
按 Ctrl+C 或关闭窗口后很快就能退出，任务记录也来得及标成“已取消”。
"""
from __future__ import annotations

import socket
from typing import List, Optional

import uvicorn

from .core.jobs import job_manager


class AppServer(uvicorn.Server):
    async def shutdown(self, sockets: Optional[List[socket.socket]] = None) -> None:
        await job_manager.shutdown()
        await super().shutdown(sockets=sockets)
