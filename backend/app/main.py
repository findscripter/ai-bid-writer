"""FastAPI应用主入口"""

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .config import settings
from .utils.logging_setup import setup_logging

setup_logging(settings.enable_file_logging)

from .core.jobs import job_manager
from .core.origin_guard import OriginGuardMiddleware
from .core.upload_limit import UploadSizeLimitMiddleware
from .routers import config, document, outline, content, expand, projects

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    job_manager.closing = False
    # 上次运行时没跑完的任务，标成“中断”，页面上可以接着“继续生成”
    try:
        recovered = job_manager.recover_interrupted()
        if recovered:
            logger.info("发现 %s 个上次未完成的任务，已标记为中断", recovered)
    except Exception:  # noqa: BLE001 - 恢复失败不应该让服务起不来
        logger.warning("恢复未完成任务的状态失败", exc_info=True)
    yield
    await job_manager.shutdown()


# 创建FastAPI应用实例
app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    description="基于FastAPI的AI写标书助手后端API",
    lifespan=lifespan,
)

# 只接受发给本机地址的请求：挡住 DNS 重绑定（恶意网页把自己的域名解析到 127.0.0.1
# 之后，就能以“同源”身份读取本机接口，包括已保存的配置）
app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts)

# 拒绝其他网站发来的、会改变状态的请求（跨站请求伪造）。CORS 只拦得住“读响应”，拦不住“发请求”
app.add_middleware(OriginGuardMiddleware)

# 超过上限的上传在接收请求体之前就拒绝（放在 CORS 里面，开发模式下前端才能读到错误说明）
app.add_middleware(UploadSizeLimitMiddleware)

# 添加CORS中间件
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition", "X-Diagram-Count", "X-Diagram-Error", "X-Missing-Chapters", "X-Error-Code"],
)

# 注册路由
app.include_router(config.router)
app.include_router(document.router)
app.include_router(outline.router)
app.include_router(content.router)
app.include_router(expand.router)
app.include_router(projects.router)


# 健康检查端点
@app.get("/health")
async def health_check():
    """健康检查"""
    return {
        "status": "healthy",
        "app_name": settings.app_name,
        "version": settings.app_version,
    }


# 静态文件服务（用于服务前端构建文件）
# 默认是 backend/static；开发调试时可以用环境变量 AI_BID_STATIC_DIR 指到别的构建目录
STATIC_DIR = Path(
    os.environ.get("AI_BID_STATIC_DIR", "").strip() or (Path(__file__).resolve().parents[1] / "static")
).resolve()

if (STATIC_DIR / "index.html").exists():
    # 挂载静态资源文件夹
    if (STATIC_DIR / "static").is_dir():
        app.mount("/static", StaticFiles(directory=str(STATIC_DIR / "static")), name="static")

    INDEX_FILE = STATIC_DIR / "index.html"
    # index.html 不缓存：重新构建前端后，浏览器要能立刻拿到新的资源文件名
    _NO_CACHE = {"Cache-Control": "no-cache"}

    # 处理React应用的路由（SPA路由支持）
    @app.get("/")
    async def read_index():
        """根路径，返回前端首页"""
        return FileResponse(INDEX_FILE, headers=_NO_CACHE)

    @app.get("/{full_path:path}")
    async def serve_react_app(full_path: str):
        """处理React路由，所有非API路径都返回index.html"""
        # 排除API路径
        if (
            full_path.startswith("api/")
            or full_path.startswith("docs")
            or full_path.startswith("health")
        ):
            # 这些路径应该由FastAPI处理，如果到这里说明404
            raise HTTPException(status_code=404, detail="接口不存在")

        # 只允许返回 static 目录里面的文件：解析成绝对路径后必须仍在该目录下，
        # 否则 "../requirements.txt"、"C:\\Windows\\win.ini" 这类路径会读到目录外的文件
        try:
            candidate = (STATIC_DIR / full_path).resolve()
        except (OSError, ValueError):
            candidate = None
        if candidate is not None and STATIC_DIR in candidate.parents and candidate.is_file():
            return FileResponse(candidate)

        # 对于其他所有路径，返回React应用的index.html（SPA路由）
        return FileResponse(INDEX_FILE, headers=_NO_CACHE)
else:
    # 如果没有静态文件，返回API信息
    @app.get("/")
    async def read_root():
        """根路径，返回API信息"""
        return {
            "message": f"欢迎使用 {settings.app_name} API",
            "version": settings.app_version,
            "docs": "/docs",
            "health": "/health",
        }
