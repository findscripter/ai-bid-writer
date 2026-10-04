"""招标文件解析（项目概述 / 技术评分要求）。

招标文件动辄十几万字，整篇塞给模型可能超出上下文。这里的策略：
- 不超过阈值：整篇一次解析（与原有做法相同，结果最连贯）；
- 超过阈值，或一次解析时服务商报“超出上下文长度”：分段提取，再合并成一份。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, AsyncGenerator, Dict, List, Optional, Tuple

from ..config import settings
from ..utils.errors import LLMError
from ..utils.openai_util import StreamInfo
from ..utils.prompts.analysis_prompts import build_analysis_messages
from .planner import gather_cancellable

logger = logging.getLogger(__name__)

Message = Dict[str, str]
AnalysisEvent = Tuple[str, str]
"""("progress", 进度提示)、("warning", 结果可能不完整之类要让使用者看到的提示) 或 ("chunk", 增量文本)。"""

SEGMENT_CONCURRENCY = 2
NO_CONTENT = "本段无相关内容"
MAX_CONTINUE_ROUNDS = 3
TRUNCATED_NOTICE = "解析结果太长，超出了模型单次输出的上限，已经接着续写；如果结尾仍不完整，请检查后手动补充。"
CONTINUE_PROMPT = (
    "上文因为单次输出的长度限制在中途断开了。请从断开的地方接着往下写，不要重复已经输出的内容，"
    "不要重新开头，保持同样的格式，把剩下的条目写完整。直接输出后续内容。"
)


async def _stream_with_continuation(
    llm: Any, messages: List[Message], temperature: float
) -> AsyncGenerator[AnalysisEvent, None]:
    """流式输出；被长度上限截断时接着续写，避免残缺的结果被当成完整结果保存。"""
    produced: List[str] = []
    current = messages
    for round_index in range(MAX_CONTINUE_ROUNDS + 1):
        info = StreamInfo()
        async for chunk in llm.stream_chat_completion(current, temperature=temperature, info=info):
            produced.append(chunk)
            yield "chunk", chunk
        if info.finish_reason != "length":
            return
        if round_index == MAX_CONTINUE_ROUNDS:
            yield "warning", "解析结果太长，续写之后仍然没有写完，结尾可能不完整，请检查后手动补充。"
            return
        if round_index == 0:
            yield "warning", TRUNCATED_NOTICE
        current = messages + [
            {"role": "assistant", "content": "".join(produced)},
            {"role": "user", "content": CONTINUE_PROMPT},
        ]


async def _collect_with_continuation(llm: Any, messages: List[Message], temperature: float) -> Tuple[str, bool]:
    """一次性收集输出；被长度上限截断时接着续写。返回 (文本, 续写之后是否仍被截断)。"""
    produced: List[str] = []
    current = messages
    for round_index in range(MAX_CONTINUE_ROUNDS + 1):
        info = StreamInfo()
        produced.append(await llm.collect_chat_completion(current, temperature=temperature, info=info))
        if info.finish_reason != "length":
            return "".join(produced), False
        if round_index == MAX_CONTINUE_ROUNDS:
            break
        current = messages + [
            {"role": "assistant", "content": "".join(produced)},
            {"role": "user", "content": CONTINUE_PROMPT},
        ]
    return "".join(produced), True


def split_segments(text: str, segment_chars: int) -> List[str]:
    """按行把长文本切成若干段，每段不超过 segment_chars（单行超长时硬切）。"""
    segment_chars = max(int(segment_chars), 1000)
    segments: List[str] = []
    buffer: List[str] = []
    size = 0
    for line in text.splitlines():
        while len(line) > segment_chars:
            if buffer:
                segments.append("\n".join(buffer))
                buffer, size = [], 0
            segments.append(line[:segment_chars])
            line = line[segment_chars:]
        if size + len(line) + 1 > segment_chars and buffer:
            segments.append("\n".join(buffer))
            buffer, size = [], 0
        buffer.append(line)
        size += len(line) + 1
    if buffer:
        segments.append("\n".join(buffer))
    return [segment for segment in segments if segment.strip()]


def _system_and_task(analysis_type: str) -> tuple:
    messages = build_analysis_messages("", analysis_type)
    return messages[0], messages[-1]["content"]


def build_segment_messages(segment: str, index: int, total: int, analysis_type: str) -> List[Message]:
    system, task = _system_and_task(analysis_type)
    return [
        system,
        {
            "role": "user",
            "content": f"招标文件较长，现在分段阅读。以下是第 {index}/{total} 部分的原文：\n\n{segment}",
        },
        {
            "role": "user",
            "content": (
                f"{task}\n\n"
                "注意：你看到的只是招标文件的一部分。只提取这一部分里出现的相关信息，不要推测其他部分的内容；"
                f"如果这一部分没有相关内容，只回答“{NO_CONTENT}”。条目编号可以先随意，稍后会统一整理。"
            ),
        },
    ]


def build_merge_messages(notes: List[str], analysis_type: str) -> List[Message]:
    system, task = _system_and_task(analysis_type)
    joined = "\n\n".join(f"### 第 {i} 部分的提取结果\n{note}" for i, note in enumerate(notes, start=1))
    return [
        system,
        {"role": "user", "content": f"招标文件较长，已经分段阅读并分别做了提取。各部分的提取结果如下：\n\n{joined}"},
        {
            "role": "user",
            "content": (
                f"{task}\n\n"
                "请把以上各部分的提取结果合并成一份完整的结果：去掉重复，按原文顺序整理，"
                "条目重新连续编号，严格按要求的结构输出；不要添加各部分结果里没有的信息。"
            ),
        },
    ]


async def stream_tender_analysis_events(
    llm: Any,
    text: str,
    analysis_type: str,
    max_chars: Optional[int] = None,
    segment_chars: Optional[int] = None,
) -> AsyncGenerator[AnalysisEvent, None]:
    """流式产出解析过程：进度提示与结果文本的增量。"""
    max_chars = max_chars or settings.analysis_max_chars
    segment_chars = segment_chars or settings.analysis_segment_chars

    if len(text) <= max_chars:
        emitted = False
        try:
            async for kind, value in _stream_with_continuation(
                llm, build_analysis_messages(text, analysis_type), temperature=0.3
            ):
                emitted = emitted or kind == "chunk"
                yield kind, value
            return
        except LLMError as exc:
            if emitted or exc.kind != "context_length":
                raise
            yield "progress", "招标文件超出了模型的上下文长度，改为分段解析。"
            # 模型上下文比预想的小：段也切小一些
            segment_chars = min(segment_chars, max(len(text) // 4, 4000))

    segments = split_segments(text, segment_chars)
    total = len(segments)
    yield "progress", f"招标文件共 {len(text)} 字，分 {total} 段解析。"
    semaphore = asyncio.Semaphore(SEGMENT_CONCURRENCY)
    # 各段并行提取；每完成一段就把进度从队列里送出来，而不是等全部结束
    progress: "asyncio.Queue[Optional[str]]" = asyncio.Queue()
    finished = 0
    incomplete: List[int] = []

    async def _extract(index: int, segment: str) -> str:
        nonlocal finished
        async with semaphore:
            # 单段的提取结果也可能被输出上限截断：接着续写，否则这一段末尾的条目会悄悄丢掉
            note, cut = await _collect_with_continuation(
                llm, build_segment_messages(segment, index, total, analysis_type), temperature=0.2
            )
        if cut:
            incomplete.append(index)
        finished += 1
        progress.put_nowait(f"已完成 {finished}/{total} 段。")
        return note.strip()

    async def _extract_all() -> List[str]:
        try:
            return await gather_cancellable([_extract(i, s) for i, s in enumerate(segments, start=1)])
        finally:
            progress.put_nowait(None)

    task = asyncio.ensure_future(_extract_all())
    try:
        while True:
            message = await progress.get()
            if message is None:
                break
            yield "progress", message
        notes = await task
    except BaseException:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        raise

    if incomplete:
        numbers = "、".join(str(index) for index in sorted(incomplete))
        yield "warning", f"第 {numbers} 段的提取结果太长，续写之后仍不完整，这几段末尾的内容可能缺失，请检查后手动补充。"

    useful = [note for note in notes if note and NO_CONTENT not in note[:20]]
    if not useful:
        useful = [note for note in notes if note]
    if len(useful) == 1:
        yield "chunk", useful[0]
        return

    yield "progress", "正在合并各段的解析结果。"
    async for kind, value in _stream_with_continuation(
        llm, build_merge_messages(useful, analysis_type), temperature=0.2
    ):
        yield kind, value


async def stream_tender_analysis(
    llm: Any,
    text: str,
    analysis_type: str,
    on_progress: Any = None,
    max_chars: Optional[int] = None,
    segment_chars: Optional[int] = None,
) -> AsyncGenerator[str, None]:
    """只产出结果文本；进度提示交给 on_progress 回调。"""
    async for kind, value in stream_tender_analysis_events(llm, text, analysis_type, max_chars, segment_chars):
        if kind in ("progress", "warning"):
            if on_progress is not None:
                on_progress(value)
        else:
            yield value
