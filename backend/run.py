"""后端服务启动脚本"""
import os
import sys

if __name__ == "__main__":
    # 确保在正确的目录中运行
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    # 用错了 Python（没装依赖）是最常见的启动失败：直接说清楚怎么办，不只丢一段回溯
    try:
        import uvicorn

        from app.server import AppServer
    except ModuleNotFoundError as exc:
        print(f"缺少依赖 {exc.name}：这个 Python（{sys.executable}）还没有安装本项目的依赖。")
        print("请运行 pip install -r backend/requirements.txt；")
        print("电脑上有多个 Python 时，用环境变量 AI_BID_PYTHON 指定装了依赖的那个。")
        sys.exit(1)

    # 端口默认 8000，可用环境变量 AI_BID_PORT 调整。单端口方式下页面和接口同源，改了端口不用改别的；
    # 用前端开发服务器时，把 frontend/.env 里的 REACT_APP_API_URL 指向新端口
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
    except SystemExit:
        # 端口绑定失败时 uvicorn 自己以 1 退出（错误已经打印在上面）
        if not server.started:
            print(f"端口 {port} 可能被别的程序占用了：设置环境变量 AI_BID_PORT（例如 8001）后再启动。")
        raise
    if not server.started:
        # 其他原因没能启动（原因见上面的日志）：以非零状态退出
        sys.exit(3)
