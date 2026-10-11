"""服务退出：页面开着任务事件流时，退出不必干等超时，进行中的任务标成“被中断”。

这里起一个真实的 uvicorn 服务（随机端口），用标准库 http.client 收发请求。
"""
from __future__ import annotations

import http.client
import json
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

import uvicorn

from app.core.jobs import INTERRUPTED_MESSAGE, job_manager, store
from app.main import app
from app.server import AppServer


def _request(port: int, method: str, path: str, payload: Optional[dict] = None) -> Tuple[int, Dict[str, Any]]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Content-Type": "application/json"} if body is not None else {}
        conn.request(method, path, body=body, headers=headers)
        response = conn.getresponse()
        return response.status, json.loads(response.read().decode("utf-8"))
    finally:
        conn.close()


def test_shutdown_interrupts_jobs_and_closes_event_streams(monkeypatch):
    # 演示模型放慢输出，保证退出时任务还在写
    monkeypatch.setenv("AI_BID_DEMO", "1")
    monkeypatch.setenv("AI_BID_DEMO_DELAY", "0.2")

    # 优雅退出的超时故意设得很长：如果事件流没有被主动结束，退出就要等满 20 秒
    config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning", timeout_graceful_shutdown=20)
    server = AppServer(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 15
    while not server.started and time.time() < deadline:
        time.sleep(0.02)
    assert server.started
    port = server.servers[0].sockets[0].getsockname()[1]

    status, created = _request(port, "POST", "/api/projects", {"name": "退出测试"})
    assert status == 200
    project_id = created["project"]["id"]
    outline = [{"title": f"第{i}章", "children": [{"title": f"第{i}节"}]} for i in range(1, 7)]
    status, _ = _request(port, "PUT", f"/api/projects/{project_id}/outline", {"outline": outline})
    assert status == 200
    status, started = _request(port, "POST", f"/api/projects/{project_id}/jobs", {"kind": "write"})
    assert status == 200
    job_id = started["job"]["id"]

    events: List[Dict[str, Any]] = []

    def listen() -> None:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
        try:
            conn.request("GET", f"/api/projects/{project_id}/jobs/{job_id}/events")
            response = conn.getresponse()
            for raw in response:
                line = raw.decode("utf-8").strip()
                if line.startswith("data: "):
                    events.append(json.loads(line[6:]))
        except OSError:
            pass
        finally:
            conn.close()

    listener = threading.Thread(target=listen, daemon=True)
    listener.start()
    deadline = time.time() + 10
    while not any(e.get("type") == "job_stage" for e in events) and time.time() < deadline:
        time.sleep(0.02)
    assert events, "事件流没有连上"

    begin = time.time()
    server.should_exit = True  # 与按下 Ctrl+C 走同一条退出路径
    thread.join(timeout=30)
    elapsed = time.time() - begin
    assert not thread.is_alive()
    assert elapsed < 5, f"退出用了 {elapsed:.1f} 秒，事件流没有被主动结束"

    # 页面收到了“被中断”（不是使用者自己停下的“已取消”），事件流随后正常结束
    listener.join(timeout=5)
    assert not listener.is_alive()
    ends = [e for e in events if e.get("type") == "job_end"]
    assert ends and ends[-1]["job"]["status"] == "interrupted"
    assert ends[-1]["job"]["error"] == INTERRUPTED_MESSAGE

    record = next(r for r in store.load_jobs(project_id, limit=10) if r.id == job_id)
    assert record.status == "interrupted"
    job_manager.closing = False
