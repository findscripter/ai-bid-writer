"""应用级异常定义。"""
from __future__ import annotations

from typing import Optional


class AppError(Exception):
    """用于在 service 层传递可预期的业务错误。"""

    def __init__(self, message: str, status_code: int = 500, code: Optional[str] = None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        # 固定的错误码，经响应头 X-Error-Code 交给前端区分同一状态码下的不同原因（不依赖提示文案）
        self.code = code


class LLMError(AppError):
    """模型调用失败。

    kind 取值：auth / balance / rate_limit / context_length / bad_request /
    timeout / connection / server / empty / unknown。
    retryable 表示过一会儿重试有可能成功（限流、超时、网络、服务端错误）。
    hint 是给使用者看的处理建议；message 保留服务商返回的原始信息。
    """

    def __init__(
        self,
        message: str,
        kind: str = "unknown",
        retryable: bool = False,
        hint: str = "",
        status_code: int = 502,
        partial: bool = False,
    ):
        super().__init__(message, status_code=status_code)
        self.kind = kind
        self.retryable = retryable
        self.hint = hint
        self.partial = partial

    @property
    def friendly(self) -> str:
        """适合直接展示的简短说明。"""
        detail = self.message
        if len(detail) > 200:
            detail = detail[:200] + "…"
        return f"{self.hint}（{detail}）" if self.hint else detail


_HINTS = {
    "auth": "API Key 无效、已过期或没有权限，请在设置里检查",
    "balance": "模型服务账户余额不足或额度用尽",
    "rate_limit": "模型服务限流，稍后会自动重试；也可以调低并发数",
    "context_length": "输入内容超过了模型的上下文长度",
    "bad_request": "模型服务拒绝了请求，请检查模型名称与接口地址",
    "timeout": "模型服务响应超时",
    "connection": "连接模型服务失败，请检查网络与接口地址",
    "server": "模型服务暂时不可用",
    "empty": "模型没有返回内容",
    "content_filter": "模型服务的内容审核中止了这次输出",
}

# 只认明确表示“没钱了”的说法。限流的报错里常带 quota、billing 的帮助链接，不能据此判成余额不足
_BALANCE_MARKERS = (
    "insufficient_quota",
    "insufficient quota",
    "insufficient balance",
    "insufficient_balance",
    "exceeded your current quota",
    "billing_hard_limit",
    "余额不足",
    "账户余额",
    "欠费",
    "arrears",
)
_CONTEXT_MARKERS = (
    "context length",
    "context_length",
    "maximum context",
    "context window",
    "too many tokens",
    "reduce the length",
    "input length",
    "上下文长度",
    "输入过长",
)


def classify_llm_error(exc: BaseException, partial: bool = False) -> LLMError:
    """把 SDK / 网络层抛出的异常归类成 LLMError。

    partial 为 True 表示已经收到一部分输出之后才出错。
    """
    if isinstance(exc, LLMError):
        return exc

    text = str(exc)
    lowered = text.lower()
    status: Optional[int] = getattr(exc, "status_code", None)
    kind = "unknown"
    retryable = False

    try:
        import httpx
        import openai
    except Exception:  # pragma: no cover - 依赖缺失时退化为按文本判断
        httpx = None  # type: ignore[assignment]
        openai = None  # type: ignore[assignment]

    if openai is not None and isinstance(exc, openai.APITimeoutError):
        kind, retryable = "timeout", True
    elif openai is not None and isinstance(exc, openai.APIConnectionError):
        kind, retryable = "connection", True
    elif status in (401, 403):
        kind = "auth"
    elif status == 402:
        kind = "balance"
    elif status == 429:
        if any(marker in lowered for marker in _BALANCE_MARKERS):
            kind = "balance"
        else:
            kind, retryable = "rate_limit", True
    elif status in (408, 409):
        kind, retryable = "timeout", True
    elif status is not None and status >= 500:
        kind, retryable = "server", True
    elif status in (400, 404, 413, 422):
        kind = "context_length" if any(m in lowered for m in _CONTEXT_MARKERS) else "bad_request"
    elif httpx is not None and isinstance(exc, (httpx.TimeoutException,)):
        kind, retryable = "timeout", True
    elif httpx is not None and isinstance(exc, httpx.HTTPError):
        kind, retryable = "connection", True
    elif isinstance(exc, (ConnectionError, TimeoutError)):
        kind, retryable = "connection", True
    elif any(marker in lowered for marker in ("rate limit", "too many requests", "concurrency")):
        kind, retryable = "rate_limit", True
    elif "timeout" in lowered or "timed out" in lowered:
        kind, retryable = "timeout", True

    return LLMError(
        f"模型调用失败: {text}",
        kind=kind,
        retryable=retryable,
        hint=_HINTS.get(kind, ""),
        partial=partial,
    )
