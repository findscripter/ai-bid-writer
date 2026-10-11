"""本地数据目录定位。

应用的全部本机数据（用户配置、项目工作区）都放在同一个根目录下，
默认是用户主目录里的 .ai_write_helper，可用环境变量 AI_BID_HOME 覆盖
（测试、便携部署时使用）。目录一律按需创建，导入模块时不产生副作用。
"""
from __future__ import annotations

import os
from pathlib import Path

ENV_HOME = "AI_BID_HOME"


def data_home() -> Path:
    """返回应用数据根目录（不保证已存在）。"""
    override = os.environ.get(ENV_HOME, "").strip()
    if override:
        return Path(override)
    return Path(os.path.expanduser("~")) / ".ai_write_helper"


def projects_root() -> Path:
    """返回项目工作区根目录（不保证已存在）。"""
    return data_home() / "projects"
