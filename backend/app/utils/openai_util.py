"""OpenAI 调用公共工具。"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from dataclasses import dataclass
from typing import Any, AsyncGenerator, Awaitable, Callable, Dict, List, Optional, Tuple

import httpx
import openai
from pydantic import BaseModel, ValidationError

from ..config import settings
from ..utils.config_manager import config_manager
from ..utils.errors import AppError, classify_llm_error
from .prompts.json_repair_prompts import build_json_repair_messages

logger = logging.getLogger(__name__)

ProgressCallback = Callable[[str], Awaitable[None]]
JsonValidator = Callable[[Dict[str, Any]], None]

_THINK_BLOCK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)
_JSON_FENCE_RE = re.compile(r"```(?:json|JSON)?\s*\n(.*?)\n```", re.DOTALL)


@dataclass
class StreamInfo:
    """一次流式调用结束后的信息，由 stream_chat_completion 填写。

    finish_reason 为 "length" 表示输出因长度上限被截断，调用方需要接着续写。
    token 用量只有服务商在流里返回时才有值。
    """

    finish_reason: Optional[str] = None
    chars: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0


# 同一组 (api_key, base_url) 复用一个客户端，避免每次调用都新建连接池。
# 客户端内部的连接绑定事件循环，所以循环变了（测试里常见）就重建。
_CLIENT_CACHE: Dict[Tuple[str, str], Tuple[Any, openai.AsyncOpenAI]] = {}
_CLIENT_CACHE_LIMIT = 8


def _get_client(api_key: str, base_url: str) -> openai.AsyncOpenAI:
    try:
        loop: Any = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    key = (api_key, base_url or "")
    cached = _CLIENT_CACHE.get(key)
    if cached is not None and loop is not None and cached[0] is loop:
        return cached[1]

    client = openai.AsyncOpenAI(
        api_key=api_key,
        base_url=base_url or None,
        # read 是流里两次数据之间的最长等待；SDK 默认 600 秒，卡死的连接要等十分钟才报错
        timeout=httpx.Timeout(
            settings.llm_timeout_seconds,
            connect=settings.llm_connect_timeout_seconds,
        ),
        max_retries=settings.llm_max_retries,
    )
    if loop is not None:
        if len(_CLIENT_CACHE) >= _CLIENT_CACHE_LIMIT:
            _CLIENT_CACHE.clear()
        _CLIENT_CACHE[key] = (loop, client)
    return client


class OpenAIUtil:
    """封装 OpenAI SDK 调用、日志与 JSON 修复能力。"""

    def __init__(self, model_name: str | None = None):
        """model_name 可覆盖全局配置中的模型（用于多份生成时每份用不同模型）。"""
        config = config_manager.load_config()
        self.api_key = config.get("api_key", "")
        self.base_url = config.get("base_url", "")
        self.model_name = (model_name or "").strip() or config.get(
            "model_name", "gpt-3.5-turbo"
        )
        if not self.api_key:
            raise AppError("请先配置OpenAI API密钥", status_code=400)
        self.client = _get_client(self.api_key, self.base_url)

    @classmethod
    def from_values(cls, api_key: str, base_url: str = "", model_name: str = "") -> "OpenAIUtil":
        """用给定的参数创建客户端，不读也不写配置文件（设置页“测试连接”时用）。"""
        if not (api_key or "").strip():
            raise AppError("请先配置OpenAI API密钥", status_code=400)
        instance = cls.__new__(cls)
        instance.api_key = api_key.strip()
        instance.base_url = (base_url or "").strip()
        instance.model_name = (model_name or "").strip() or "gpt-3.5-turbo"
        instance.client = _get_client(instance.api_key, instance.base_url)
        return instance

    async def list_all_models(self) -> List[str]:
        """返回服务商提供的全部模型 ID（不做关键字过滤）。"""
        try:
            models = await self.client.models.list()
        except Exception as exc:
            raise classify_llm_error(exc) from exc
        return sorted({model.id for model in models.data if getattr(model, "id", None)})

    def _chat_endpoint_url(self) -> str:
        """获取聊天完成接口地址。"""
        base_url = (self.base_url or "https://api.openai.com/v1").rstrip("/")
        return f"{base_url}/chat/completions"

    def _log_ai_request(
        self,
        request_id: str,
        messages: list[dict[str, str]],
        temperature: float,
        response_format: dict | None,
    ) -> None:
        """记录 AI 请求日志。"""
        if not settings.enable_file_logging:
            return

        logger.debug(
            "AI_REQUEST %s",
            json.dumps(
                {
                    "request_id": request_id,
                    "url": self._chat_endpoint_url(),
                    "model": self.model_name,
                    "temperature": temperature,
                    "response_format": response_format,
                    "messages": messages,
                },
                ensure_ascii=False,
            ),
        )

    def _log_ai_response(self, request_id: str, content: str) -> None:
        """记录 AI 响应日志。"""
        if not settings.enable_file_logging:
            return

        logger.debug(
            "AI_RESPONSE %s",
            json.dumps(
                {
                    "request_id": request_id,
                    "url": self._chat_endpoint_url(),
                    "model": self.model_name,
                    "content": content,
                },
                ensure_ascii=False,
            ),
        )

    def _log_ai_raw_response(
        self,
        request_id: str,
        raw_chunks: list[dict[str, Any]],
        content: str,
    ) -> None:
        """记录 AI 接口原始响应日志。"""
        if not settings.enable_file_logging:
            return

        logger.debug(
            "AI_RAW_RESPONSE %s",
            json.dumps(
                {
                    "request_id": request_id,
                    "url": self._chat_endpoint_url(),
                    "model": self.model_name,
                    "raw_chunks": raw_chunks,
                    "content": content,
                },
                ensure_ascii=False,
                default=str,
            ),
        )

    def _log_ai_error(
        self,
        request_id: str,
        messages: list[dict[str, str]],
        temperature: float,
        response_format: dict | None,
        partial_content: str,
        raw_chunks: list[dict[str, Any]],
        error: Exception,
    ) -> None:
        """记录 AI 异常日志。"""
        if not settings.enable_file_logging:
            return

        logger.debug(
            "AI_ERROR %s",
            json.dumps(
                {
                    "request_id": request_id,
                    "url": self._chat_endpoint_url(),
                    "model": self.model_name,
                    "temperature": temperature,
                    "response_format": response_format,
                    "messages": messages,
                    "partial_content": partial_content,
                    "raw_chunks": raw_chunks,
                    "error": str(error),
                },
                ensure_ascii=False,
                default=str,
            ),
        )

    @staticmethod
    def _dump_chunk(chunk: Any) -> dict[str, Any]:
        """序列化 OpenAI SDK 返回的 chunk。"""
        if hasattr(chunk, "model_dump"):
            return chunk.model_dump(mode="json")
        return {"raw": str(chunk)}

    @staticmethod
    def _extract_json_content(content: str) -> str:
        """提取模型响应中的 JSON 内容，兼容 Markdown 代码块包裹与推理模型的 <think> 思考过程。"""
        normalized = _THINK_BLOCK_RE.sub("", content or "").strip()
        if not normalized.startswith("```") and not normalized.startswith(("{", "[")):
            # 前后带了说明文字：取其中的 ```json 代码块
            fenced = _JSON_FENCE_RE.search(normalized)
            if fenced:
                return fenced.group(1).strip()
        if not normalized.startswith("```"):
            return normalized

        lines = normalized.splitlines()
        if not lines:
            return normalized

        first_line = lines[0].strip().lower()
        last_line = lines[-1].strip()
        if not last_line.startswith("```"):
            return normalized

        if first_line in {"```", "```json", "```javascript", "```js"}:
            return "\n".join(lines[1:-1]).strip()

        return normalized

    @staticmethod
    def _is_response_format_unsupported_error(message: str) -> bool:
        """判断当前错误是否表示模型不支持 response_format。"""
        normalized = message.lower()
        if "response_format" not in normalized:
            return False

        return any(
            marker in normalized
            for marker in (
                "not supported",
                "does not support",
                "not support",
                "unsupported",
                "unknown parameter",
                "invalid parameter",
            )
        )

    @staticmethod
    async def emit_progress(
        progress_callback: ProgressCallback | None,
        message: str,
    ) -> None:
        """发送进度消息。"""
        if progress_callback is None:
            return

        await progress_callback(message)

    async def get_available_models(self) -> List[str]:
        """获取可用模型列表。"""
        try:
            models = await self.client.models.list()
        except Exception as exc:
            raise AppError(f"获取模型列表失败: {exc}", status_code=502) from exc

        chat_models: list[str] = []
        for model in models.data:
            model_id = model.id.lower()
            if any(
                keyword in model_id
                for keyword in ["gpt", "claude", "chat", "llama", "qwen", "deepseek"]
            ):
                chat_models.append(model.id)
        return sorted(set(chat_models))

    @staticmethod
    def _drop_unsupported_param(params: dict[str, Any], error_text: str) -> bool:
        """服务商报某个可选参数不被支持时，去掉它以便重试；没有可去掉的返回 False。

        response_format 不在这里处理：它由上层的 JSON 模式降级逻辑负责。
        """
        lowered = error_text.lower()
        if "temperature" in params and "temperature" in lowered:
            # 部分模型（如 GPT-5 系）不接受自定义 temperature
            del params["temperature"]
            return True
        if "max_tokens" in params and "max_tokens" in lowered:
            value = params.pop("max_tokens")
            if "max_completion_tokens" in lowered:
                params["max_completion_tokens"] = value
            return True
        if "max_completion_tokens" in params and "max_completion_tokens" in lowered:
            del params["max_completion_tokens"]
            return True
        return False

    async def stream_chat_completion(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.7,
        response_format: dict | None = None,
        max_tokens: int | None = None,
        info: StreamInfo | None = None,
    ) -> AsyncGenerator[str, None]:
        """流式调用聊天完成接口。

        info 不为空时，结束后把 finish_reason 等信息写进去（调用方据此判断是否被截断）。
        失败时抛 LLMError（AppError 的子类），带有错误类别与是否值得重试。
        """
        request_id = uuid.uuid4().hex
        parts: list[str] = []
        raw_chunks: list[dict[str, Any]] = []
        keep_raw = settings.enable_file_logging
        self._log_ai_request(request_id, messages, temperature, response_format)

        params: dict[str, Any] = {"temperature": temperature}
        if response_format is not None:
            params["response_format"] = response_format
        if max_tokens:
            params["max_tokens"] = int(max_tokens)

        stream = None
        while stream is None:
            try:
                stream = await self.client.chat.completions.create(
                    model=self.model_name,
                    messages=messages,
                    stream=True,
                    **params,
                )
            except Exception as exc:
                if self._drop_unsupported_param(params, str(exc)):
                    continue
                self._log_ai_error(
                    request_id,
                    messages,
                    temperature,
                    response_format,
                    "",
                    raw_chunks,
                    exc,
                )
                raise classify_llm_error(exc) from exc

        finish_reason: str | None = None
        try:
            async for chunk in stream:
                if keep_raw:
                    raw_chunks.append(self._dump_chunk(chunk))
                usage = getattr(chunk, "usage", None)
                if usage is not None and info is not None:
                    info.prompt_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
                    info.completion_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
                    details = getattr(usage, "prompt_tokens_details", None)
                    info.cached_tokens = int(
                        getattr(details, "cached_tokens", 0)
                        or getattr(usage, "prompt_cache_hit_tokens", 0)
                        or 0
                    )
                choices = getattr(chunk, "choices", None)
                if not choices:
                    continue
                choice = choices[0]
                if getattr(choice, "finish_reason", None):
                    finish_reason = choice.finish_reason
                delta = getattr(choice, "delta", None)
                content = getattr(delta, "content", None) if delta is not None else None
                if content:
                    parts.append(content)
                    yield content
        except Exception as exc:
            self._log_ai_error(
                request_id,
                messages,
                temperature,
                response_format,
                "".join(parts),
                raw_chunks,
                exc,
            )
            raise classify_llm_error(exc, partial=bool(parts)) from exc
        finally:
            # 调用方提前退出或被取消时，立刻关掉连接，别让服务端继续生成
            try:
                await stream.close()
            except Exception:
                pass

        if info is not None:
            info.finish_reason = finish_reason
            info.chars = sum(len(part) for part in parts)

        self._log_ai_response(request_id, "".join(parts))
        self._log_ai_raw_response(request_id, raw_chunks, "".join(parts))

    async def collect_chat_completion(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.7,
        response_format: dict | None = None,
        max_tokens: int | None = None,
        info: StreamInfo | None = None,
    ) -> str:
        """收集流式输出并拼接为完整文本。"""
        parts: list[str] = []
        async for chunk in self.stream_chat_completion(
            messages,
            temperature=temperature,
            response_format=response_format,
            max_tokens=max_tokens,
            info=info,
        ):
            parts.append(chunk)
        return "".join(parts)

    async def _collect_chat_completion_with_json_mode_fallback(
        self,
        messages: list[dict[str, str]],
        temperature: float,
        use_response_format: bool,
        progress_callback: ProgressCallback | None = None,
    ) -> tuple[str, bool]:
        """优先使用 JSON 模式请求，不支持时自动降级为普通请求。"""
        try:
            content = await self.collect_chat_completion(
                messages,
                temperature=temperature,
                response_format={"type": "json_object"}
                if use_response_format
                else None,
            )
            return content, use_response_format
        except AppError as exc:
            if (
                not use_response_format
                or not self._is_response_format_unsupported_error(exc.message)
            ):
                raise

            await self.emit_progress(
                progress_callback,
                "当前模型不支持结构化 JSON 响应，已降级为普通请求解析。",
            )
            content = await self.collect_chat_completion(
                messages,
                temperature=temperature,
                response_format=None,
            )
            return content, False

    @staticmethod
    def _normalize_json_response(
        content: str,
        schema: type[BaseModel] | None = None,
        validator: JsonValidator | None = None,
    ) -> Dict[str, Any]:
        """解析、校验并标准化 JSON 响应。"""
        json_content = OpenAIUtil._extract_json_content(content)
        parsed = json.loads(json_content)

        if schema is None:
            normalized = parsed
        else:
            validated = schema.model_validate(parsed)
            normalized = validated.model_dump(exclude_none=True)

        if validator is not None:
            validator(normalized)

        return normalized

    @staticmethod
    def _format_json_issues(error: Exception) -> list[str]:
        """格式化 JSON 解析或校验问题。"""
        if isinstance(error, json.JSONDecodeError):
            return [
                f"JSON 语法错误：第 {error.lineno} 行第 {error.colno} 列附近 {error.msg}。"
            ]

        if isinstance(error, ValidationError):
            issues: list[str] = []
            for item in error.errors():
                location = ".".join(str(part) for part in item.get("loc", [])) or "root"
                message = item.get("msg", "字段校验失败")
                issues.append(f"{location}: {message}")
            return issues or [str(error)]

        return [str(error)]

    async def _repair_json_response(
        self,
        invalid_content: str,
        issues: list[str],
        temperature: float,
        use_response_format: bool,
        progress_callback: ProgressCallback | None,
        progress_label: str,
    ) -> tuple[str, bool]:
        """基于当前结果发起一次定向 JSON 修复。"""
        await self.emit_progress(
            progress_callback,
            f"{progress_label}格式校验失败，正在基于当前结果进行修复。",
        )
        repair_messages = build_json_repair_messages(
            invalid_content=invalid_content,
            issues=issues,
            target_description=progress_label,
        )
        return await self._collect_chat_completion_with_json_mode_fallback(
            messages=repair_messages,
            temperature=temperature,
            use_response_format=use_response_format,
            progress_callback=progress_callback,
        )

    async def collect_json_response(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.7,
        schema: type[BaseModel] | None = None,
        validator: JsonValidator | None = None,
        progress_callback: ProgressCallback | None = None,
        progress_label: str = "JSON结果",
        failure_message: str = "模型返回的 JSON 数据格式无效",
    ) -> Dict[str, Any]:
        """收集并校验 JSON 响应。"""
        max_retries = 2
        total_attempts = max_retries + 1
        use_response_format = True

        for attempt in range(total_attempts):
            try:
                (
                    content,
                    use_response_format,
                ) = await self._collect_chat_completion_with_json_mode_fallback(
                    messages=messages,
                    temperature=temperature,
                    use_response_format=use_response_format,
                    progress_callback=progress_callback,
                )
                normalized = self._normalize_json_response(
                    content,
                    schema=schema,
                    validator=validator,
                )
                return normalized
            except (json.JSONDecodeError, ValidationError, ValueError) as exc:
                issues = self._format_json_issues(exc)
                logger.warning(
                    "模型返回非法 JSON，第 %s/%s 次尝试: %s；问题: %s",
                    attempt + 1,
                    total_attempts,
                    content,
                    " | ".join(issues),
                )

                try:
                    (
                        repaired_content,
                        use_response_format,
                    ) = await self._repair_json_response(
                        invalid_content=content,
                        issues=issues,
                        temperature=temperature,
                        use_response_format=use_response_format,
                        progress_callback=progress_callback,
                        progress_label=progress_label,
                    )
                    normalized = self._normalize_json_response(
                        repaired_content,
                        schema=schema,
                        validator=validator,
                    )
                    return normalized
                except AppError as repair_error:
                    logger.warning(
                        "JSON 修复请求失败，第 %s/%s 次尝试: %s",
                        attempt + 1,
                        total_attempts,
                        repair_error.message,
                    )
                    exc = repair_error
                except (
                    json.JSONDecodeError,
                    ValidationError,
                    ValueError,
                ) as repair_error:
                    logger.warning(
                        "JSON 修复后仍校验失败，第 %s/%s 次尝试: %s；问题: %s",
                        attempt + 1,
                        total_attempts,
                        repaired_content,
                        " | ".join(self._format_json_issues(repair_error)),
                    )
                    exc = repair_error

                if attempt == max_retries:
                    await self.emit_progress(
                        progress_callback,
                        f"{progress_label}连续 {total_attempts} 次校验失败。",
                    )
                    raise AppError(failure_message, status_code=502) from exc

                await self.emit_progress(
                    progress_callback,
                    f"{progress_label}第 {attempt + 1}/{total_attempts} 次校验失败，正在重试。",
                )

        raise AppError(failure_message, status_code=502)
