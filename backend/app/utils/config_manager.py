"""配置管理工具"""

import json
import logging
import os
from typing import Dict

from ..core.paths import data_home

logger = logging.getLogger(__name__)


class ConfigManager:
    """用户配置管理器"""

    @property
    def config_dir(self) -> str:
        """配置目录：默认在用户家目录下，可用环境变量 AI_BID_HOME 覆盖。"""
        return str(data_home())

    @property
    def config_file(self) -> str:
        return os.path.join(self.config_dir, "user_config.json")

    def load_config(self) -> Dict:
        """从本地JSON文件加载配置"""
        default_config = {"api_key": "", "base_url": "", "model_name": "gpt-3.5-turbo"}

        config_file = self.config_file
        if os.path.exists(config_file):
            try:
                with open(config_file, "r", encoding="utf-8") as f:
                    loaded_config = json.load(f)
                    if isinstance(loaded_config, dict):
                        default_config.update(loaded_config)
            except Exception as exc:
                logger.warning("读取配置文件失败，使用默认配置: %s", exc)

        return default_config

    def save_config(self, api_key: str, base_url: str, model_name: str) -> bool:
        """保存配置到本地JSON文件（先写临时文件再替换，避免写到一半损坏原文件）"""
        config = {"api_key": api_key, "base_url": base_url, "model_name": model_name}

        config_file = self.config_file
        tmp_file = f"{config_file}.tmp"
        try:
            os.makedirs(self.config_dir, exist_ok=True)
            with open(tmp_file, "w", encoding="utf-8") as f:
                json.dump(config, f, ensure_ascii=False, indent=2)
            os.replace(tmp_file, config_file)
            return True
        except Exception as exc:
            logger.warning("保存配置文件失败: %s", exc)
            try:
                if os.path.exists(tmp_file):
                    os.remove(tmp_file)
            except OSError:
                pass
            return False


# 全局配置管理器实例
config_manager = ConfigManager()
