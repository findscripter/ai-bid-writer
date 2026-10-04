"""后端服务启动脚本"""
import uvicorn
import os
import sys

if __name__ == "__main__":
    # 确保在正确的目录中运行
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    from app.server import AppServer

    # 端口默认 8000，可用环境变量 AI_BID_PORT 调整（改了端口要同时在 .env 的 CORS_ORIGINS 里放行）
    try:
        port = int(os.environ.get("AI_BID_PORT", "8000"))
    except ValueError:
        port = 8000

    config = uvicorn.Config(
        "app.main:app",
        # 只监听本机回环地址：这是单机工具，接口没有鉴权，不要暴露到局域网
        host="127.0.0.1",
        port=port,
        reload=False,
        log_level="info",
        # 单机桌面工具：并发的 LLM 调用/SSE 都是 I/O 密集型，单 worker 的 async
        # 事件循环即可充分并发。此前的 cpu_count()*2 会在多核机上拉起几十个进程，
        # 直接吃爆内存（页面文件不足、无法绑定端口）。
        # 另外后台任务的状态在进程内存里，多 worker 会让任务与订阅落在不同进程上。
        workers=1,
        # 退出时还没结束的请求（例如正在流式输出的招标文件解析）最多再等 3 秒
        timeout_graceful_shutdown=3,
    )
    # AppServer 退出时先取消后台任务，让页面上的任务事件流正常结束，不必干等超时
    server = AppServer(config)
    try:
        server.run()
    except KeyboardInterrupt:
        pass
    if not server.started:
        # 与 uvicorn.run 一致：没能启动（例如端口被占用）时以非零状态退出
        sys.exit(3)
