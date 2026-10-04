"""应用配置管理"""

try:
    from pydantic_settings import BaseSettings
except ImportError:
    from pydantic import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    """应用设置"""

    app_name: str = "AI写标书助手"
    app_version: str = "2.0.0"
    debug: bool = False
    enable_file_logging: bool = False

    # CORS设置
    cors_origins: list = [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
        "http://localhost:3002",
        "http://127.0.0.1:3002",
        "http://localhost:3003",
        "http://127.0.0.1:3003",
        "http://localhost:3004",
        "http://127.0.0.1:3004",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ]

    # 允许的 Host 头。本工具只在本机使用；确实要通过其他地址访问时在 .env 里设置
    # ALLOWED_HOSTS（JSON 数组，例如 ["localhost","127.0.0.1","192.168.1.10"]）
    allowed_hosts: list = ["localhost", "127.0.0.1"]

    # 文件上传设置
    max_file_size: int = 10 * 1024 * 1024  # 10MB

    # OpenAI默认设置
    default_model: str = "gpt-3.5-turbo"

    # 模型调用
    # 流式响应里两次数据之间的最长等待。推理模型思考时也会持续推送数据，120 秒足够宽松
    llm_timeout_seconds: float = 120.0
    llm_connect_timeout_seconds: float = 20.0
    # SDK 层对限流/超时/5xx 的自动重试次数。写作器自己还会重试，两层相乘，这里不宜大
    llm_max_retries: int = 1

    # 招标文件超过这个字数时，解析改为分段提取再合并（避免超出模型上下文）
    analysis_max_chars: int = 90000
    analysis_segment_chars: int = 30000

    class Config:
        env_file = ".env"


# 全局设置实例
settings = Settings()
