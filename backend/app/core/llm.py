"""模型客户端的统一入口。

正常情况下返回真实的 OpenAIUtil；设置环境变量 AI_BID_DEMO=1 时返回演示用的
假模型——不需要 API Key，不联网，用来体验界面和流程（生成的是示意文本）。
"""
from __future__ import annotations

import os
from typing import Any, Optional

from ..utils.openai_util import OpenAIUtil

ENV_DEMO = "AI_BID_DEMO"


def demo_enabled() -> bool:
    return os.environ.get(ENV_DEMO, "").strip().lower() in ("1", "true", "yes", "on")


def create_llm(model_name: Optional[str] = None) -> Any:
    """创建模型客户端；没有配置 API Key 时抛 AppError(400)。"""
    if demo_enabled():
        from .demo_llm import create_demo_llm

        return create_demo_llm(model_name)
    return OpenAIUtil(model_name=model_name)
