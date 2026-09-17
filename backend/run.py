"""后端服务启动脚本"""
import uvicorn
import os

if __name__ == "__main__":
    # 确保在正确的目录中运行
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=8000,
        reload=False,
        log_level="info",
        # 单机桌面工具：并发的 LLM 调用/SSE 都是 I/O 密集型，单 worker 的 async
        # 事件循环即可充分并发。此前的 cpu_count()*2 会在多核机上拉起几十个进程，
        # 直接吃爆内存（页面文件不足、无法绑定端口）。
        workers=1,
    )