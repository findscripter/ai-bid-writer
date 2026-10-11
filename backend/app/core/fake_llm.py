"""可编排的假模型：不联网、不要 API Key。

用途：
- 自动化测试：用 responder 精确控制每次调用返回什么（文本、截断、报错、延迟）；
- 演示模式：配合 demo_llm 里的应答器，没有 Key 也能把整个流程走一遍。

它继承 OpenAIUtil，只替换“发请求”这一层，因此 JSON 提取、校验、修复、重试
走的是与真实环境完全相同的代码。
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator, Callable, Dict, List, Optional, Union

from ..utils.openai_util import OpenAIUtil, StreamInfo


@dataclass
class FakeCall:
    """一次调用的记录。"""

    index: int
    messages: List[Dict[str, str]]
    temperature: float = 0.7
    response_format: Optional[dict] = None
    max_tokens: Optional[int] = None

    @property
    def system(self) -> str:
        return "\n".join(m.get("content", "") for m in self.messages if m.get("role") == "system")

    @property
    def last_user(self) -> str:
        for message in reversed(self.messages):
            if message.get("role") == "user":
                return message.get("content", "")
        return ""

    @property
    def text(self) -> str:
        """全部消息内容拼在一起，便于按关键字判断是哪一类请求。"""
        return "\n".join(m.get("content", "") for m in self.messages)


@dataclass
class FakeReply:
    """假模型的一次应答。"""

    text: str = ""
    finish_reason: str = "stop"
    error: Optional[BaseException] = None
    """不为空时：输出完 text 之后抛出（text 为空即一开始就失败）。"""
    chunk_size: int = 0
    """每个流式分片的字符数；0 表示用 FakeLLM 的默认值。"""
    delay: float = -1.0
    """每个分片之间的等待秒数；负数表示用 FakeLLM 的默认值。"""


Responder = Callable[[FakeCall], Union[str, FakeReply, BaseException]]


class FakeLLM(OpenAIUtil):
    """假模型客户端。"""

    def __init__(
        self,
        responder: Optional[Responder] = None,
        model_name: str = "fake-model",
        chunk_size: int = 16,
        delay: float = 0.0,
    ):
        # 故意不调用父类 __init__：不读配置文件、不创建网络客户端
        self.api_key = "fake"
        self.base_url = ""
        self.model_name = model_name
        self.client = None  # type: ignore[assignment]
        self.responder: Responder = responder or (lambda call: "")
        self.chunk_size = max(int(chunk_size), 1)
        self.delay = delay
        self.calls: List[FakeCall] = []
        self.active = 0
        self.max_active = 0

    async def get_available_models(self) -> List[str]:
        return [self.model_name]

    async def stream_chat_completion(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.7,
        response_format: dict | None = None,
        max_tokens: int | None = None,
        info: StreamInfo | None = None,
    ) -> AsyncGenerator[str, None]:
        call = FakeCall(
            index=len(self.calls),
            messages=[dict(m) for m in messages],
            temperature=temperature,
            response_format=response_format,
            max_tokens=max_tokens,
        )
        self.calls.append(call)

        result: Any = self.responder(call)
        if isinstance(result, BaseException):
            reply = FakeReply(error=result)
        elif isinstance(result, FakeReply):
            reply = result
        else:
            reply = FakeReply(text=str(result or ""))

        size = reply.chunk_size or self.chunk_size
        delay = self.delay if reply.delay < 0 else reply.delay

        self.active += 1
        self.max_active = max(self.max_active, self.active)
        emitted = 0
        try:
            # 让出一次控制权，模拟网络往返，也让并发度统计有意义
            await asyncio.sleep(delay)
            for start in range(0, len(reply.text), size):
                piece = reply.text[start:start + size]
                emitted += len(piece)
                yield piece
                await asyncio.sleep(delay)
            if reply.error is not None:
                # 与真实客户端一致：已经输出过内容之后才出的错，标记为“中途中断”
                if emitted and hasattr(reply.error, "partial"):
                    reply.error.partial = True
                raise reply.error
        finally:
            self.active -= 1

        if info is not None:
            info.finish_reason = reply.finish_reason
            info.chars = emitted
            info.completion_tokens = emitted
            info.prompt_tokens = sum(len(m.get("content", "")) for m in messages)


@dataclass
class ScriptedResponder:
    """按“关键字 → 应答”的规则表作答的应答器，测试里最常用。

    rules 的每一项是 (关键字, 应答)。关键字出现在本次调用的全部消息文本里即命中；
    应答可以是字符串、FakeReply、异常，或者接收 FakeCall 的函数。
    同一关键字可以配置多次：按顺序各用一次，最后一个可重复使用。
    """

    rules: List[tuple] = field(default_factory=list)
    default: Any = ""
    _used: Dict[int, bool] = field(default_factory=dict)

    def __call__(self, call: FakeCall) -> Any:
        text = call.text
        matched = [i for i, (keyword, _) in enumerate(self.rules) if keyword in text]
        if not matched:
            answer = self.default
        else:
            first_keyword = self.rules[matched[0]][0]
            same = [i for i in matched if self.rules[i][0] == first_keyword]
            unused = [i for i in same if not self._used.get(i)]
            pick = unused[0] if unused else same[-1]
            self._used[pick] = True
            answer = self.rules[pick][1]
        return answer(call) if callable(answer) else answer
