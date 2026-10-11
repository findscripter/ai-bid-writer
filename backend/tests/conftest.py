"""测试公共配置。

所有测试都不得触碰真实用户目录，也不得调用真实 LLM：
- 在导入 app 之前把数据目录（配置、项目工作区）指到临时目录（上传文件本来就只在系统临时目录里停留）；
- 需要 LLM 的测试一律使用 app.core.fake_llm.FakeLLM。
"""
from __future__ import annotations

import os
import shutil
import tempfile

_TEST_HOME = tempfile.mkdtemp(prefix="ai_bid_test_home_")
os.environ["AI_BID_HOME"] = _TEST_HOME
# FastAPI 的 TestClient 发出的请求 Host 是 testserver
os.environ["ALLOWED_HOSTS"] = '["localhost", "127.0.0.1", "[::1]", "testserver"]'
os.environ.setdefault("ENABLE_FILE_LOGGING", "false")

import pytest  # noqa: E402


def pytest_sessionfinish(session, exitstatus):  # noqa: D401
    """测试结束后清理临时数据目录。"""
    shutil.rmtree(_TEST_HOME, ignore_errors=True)


@pytest.fixture()
def data_home(tmp_path, monkeypatch):
    """为单个测试提供独立的数据根目录。"""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("AI_BID_HOME", str(home))
    return home
