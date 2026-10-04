"""章节写作：把一个叶子章节写出来。

长文本在这里要处理三件事：
1. 上下文——每章都带上统一口径、全书目录、本章计划、招标原文片段和相邻章节摘记，
   而不是只凭一个标题去写；
2. 篇幅——短章一次写完，不够再补；长章先划分小节再逐节写，
   每节都在模型单次输出的舒适区内，不靠“继续、继续”硬拉；
3. 截断——每次调用都看 finish_reason，被长度上限截断就接着写完。
"""
from __future__ import annotations

import asyncio
import logging
import random
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from pydantic import BaseModel, ConfigDict, field_validator, model_validator

from ..utils.errors import AppError, LLMError
from ..utils.openai_util import StreamInfo
from ..utils.personas import BUILTIN_PERSONAS
from .budget import allocate_budget
from .cleaner import clean_chapter_text, join_continuation, strip_preamble
from .digest import build_digest
from .models import (
    Blueprint,
    ChapterDigest,
    ChapterPlan,
    LeafInfo,
    Material,
    Project,
    RequirementItem,
)
from .outline_tree import collect_leaves, outline_overview
from .planner import FATAL_KINDS, _as_str, _as_str_list
from .prompts import (
    TRUNCATED_TASK,
    build_chapter_context,
    build_shared_messages,
    chapter_task,
    continuation_task,
    revise_task,
    section_plan_task,
    section_task,
    word_range,
)
from .requirements import parse_requirements
from .retrieval import Chunk, TextIndex, tokenize
from .textutil import clip, count_chars

logger = logging.getLogger(__name__)

Message = Dict[str, str]

SECTION_WORDS = 900
"""分节写作时每个小节的理想字数。"""

MAX_TRUNCATION_ROUNDS = 3
"""输出被长度上限截断后，最多接着写几次。"""

MAX_EXPAND_ROUNDS = 3
"""篇幅不足时最多补写几轮。"""

MIN_EXPAND_GAIN = 30
"""一轮补写新增不到这么多字，说明模型已经写不出新东西，停止。"""

MAX_PIECE_ATTEMPTS = 3
"""单次模型调用遇到限流、超时、网络错误时的最多尝试次数。"""

RETRY_DELAYS = (2.0, 6.0, 15.0)
"""各次重试前的等待秒数（限流时加倍）。测试里会把它改成 0。"""


# ---------------------------------------------------------------------------
# 写作上下文
# ---------------------------------------------------------------------------


@dataclass
class WritingContext:
    """一次写作任务里各章共用的东西，开工前准备一次。"""

    project: Project
    blueprint: Optional[Blueprint]
    leaves: List[LeafInfo]
    leaf_by_uid: Dict[str, LeafInfo]
    requirements: List[RequirementItem]
    req_by_id: Dict[str, RequirementItem]
    budget: Dict[str, int]
    budget_note: str
    shared_messages: List[Message]
    tender_index: Optional[TextIndex] = None
    material_index: Optional[TextIndex] = None
    temperature: float = 0.7
    section_threshold: int = 1800

    def plan_for(self, uid: str) -> Optional[ChapterPlan]:
        return self.blueprint.plans.get(uid) if self.blueprint is not None else None


def compute_budget(project: Project, blueprint: Optional[Blueprint]) -> Tuple[Dict[str, int], str]:
    """按项目设置与写作计划里的权重，给每个叶子章节分配目标字数。"""
    leaves = collect_leaves(project.outline)
    weights: Dict[str, float] = {}
    if blueprint is not None:
        weights = {uid: plan.weight for uid, plan in blueprint.plans.items()}
    response_leaves = [leaf for leaf in leaves if leaf.is_response_chapter]
    if response_leaves:
        # 响应表要把条目逐行列全：条目越多，需要的篇幅越大，与“平均每章多少字”无关
        items = parse_requirements(project.requirements)
        scoring = sum(1 for item in items if item.kind == "scoring")
        demands = sum(1 for item in items if item.kind == "requirement")
        for leaf in response_leaves:
            count = _response_item_count(leaf, scoring, demands)
            if count:
                weights[leaf.uid] = min(max(count / 6.0, 1.0), 4.0)
    settings = project.settings
    result = allocate_budget(
        [leaf.uid for leaf in leaves],
        weights,
        settings.target_pages * settings.words_per_page,
    )
    return result.words, result.note


def _response_kind(leaf: LeafInfo) -> str:
    """响应表型章节逐条响应的是哪一类条目：scoring（评审项）/ requirement（采购人要求）/ 空。"""
    if not leaf.is_response_chapter:
        return ""
    if "评审" in leaf.title or "评分" in leaf.title:
        return "scoring"
    if "采购人要求" in leaf.title or "技术需求" in leaf.title or "发包人要求" in leaf.title:
        return "requirement"
    return ""


def _response_item_count(leaf: LeafInfo, scoring: int, demands: int) -> int:
    kind = _response_kind(leaf)
    return scoring if kind == "scoring" else demands if kind == "requirement" else 0


def _persona_text(persona_id: Optional[str]) -> str:
    for persona in BUILTIN_PERSONAS:
        if persona["id"] == persona_id:
            return persona["description"]
    return ""


def build_writing_context(
    project: Project,
    blueprint: Optional[Blueprint],
    tender_text: str = "",
    materials: Sequence[Material] = (),
) -> WritingContext:
    leaves = collect_leaves(project.outline)
    requirements = parse_requirements(project.requirements)
    budget, note = compute_budget(project, blueprint)
    settings = project.settings

    tender_index = None
    if settings.use_tender_excerpts and tender_text.strip():
        tender_index = TextIndex.from_text(tender_text, source="")
    material_index = None
    documents = [(m.name, m.text) for m in materials if m.text.strip()]
    if documents:
        material_index = TextIndex.from_documents(documents)

    shared = build_shared_messages(
        overview=project.overview,
        fact_sheet=blueprint.fact_sheet if blueprint is not None else None,
        outline_text=outline_overview(project.outline),
        company_profile=project.company_profile,
        persona=_persona_text(settings.persona_id),
        style_notes=settings.style_notes,
    )
    return WritingContext(
        project=project,
        blueprint=blueprint,
        leaves=leaves,
        leaf_by_uid={leaf.uid: leaf for leaf in leaves},
        requirements=requirements,
        req_by_id={item.id: item for item in requirements},
        budget=budget,
        budget_note=note,
        shared_messages=shared,
        tender_index=tender_index,
        material_index=material_index,
        temperature=settings.temperature,
        section_threshold=settings.section_threshold,
    )


def chapter_requirements(ctx: WritingContext, leaf: LeafInfo) -> List[RequirementItem]:
    """这一章要正面响应的条目。"""
    if leaf.is_response_chapter:
        # 响应表型章节：评审办法响应表对全部评审项，采购人要求响应表对全部采购人要求
        kind = _response_kind(leaf)
        if kind:
            return [item for item in ctx.requirements if item.kind == kind][:60]
        return []
    plan = ctx.plan_for(leaf.uid)
    if plan is None:
        return []
    return [ctx.req_by_id[rid] for rid in plan.requirement_ids if rid in ctx.req_by_id]


def coverage_map_text(ctx: WritingContext, max_chars: int = 3000) -> str:
    """评审项 → 负责章节 的对照，给响应表型章节填“支撑章节”用。"""
    if ctx.blueprint is None or not ctx.requirements:
        return ""
    owners: Dict[str, List[str]] = {}
    for leaf in ctx.leaves:
        plan = ctx.blueprint.plans.get(leaf.uid)
        if plan is None or leaf.is_response_chapter:
            continue
        for rid in plan.requirement_ids:
            owners.setdefault(rid, []).append(f"{leaf.id} {leaf.title}")
    lines = []
    for item in ctx.requirements:
        chapters = owners.get(item.id)
        lines.append(f"- {item.id} {item.name} → {'、'.join(chapters[:4]) if chapters else '（暂无对应章节）'}")
    return clip("\n".join(lines), max_chars)


def chapter_context_text(
    ctx: WritingContext,
    leaf: LeafInfo,
    siblings: Sequence[Tuple[LeafInfo, ChapterDigest]] = (),
) -> str:
    plan = ctx.plan_for(leaf.uid)
    requirements = chapter_requirements(ctx, leaf)
    query_parts = [leaf.title, leaf.description, " ".join(leaf.path_titles)]
    if plan is not None:
        query_parts.extend(plan.key_points)
    for item in requirements[:12]:
        query_parts.append(item.name)
        query_parts.extend(item.keywords)
    query = " ".join(p for p in query_parts if p)

    tender_chunks: List[Chunk] = []
    if ctx.tender_index is not None:
        if leaf.is_response_chapter:
            tender_chunks = ctx.tender_index.search(query, top_k=8, max_chars=4000, min_ratio=0.25)
        else:
            tender_chunks = ctx.tender_index.search(query, top_k=4, max_chars=1800)
    material_chunks: List[Chunk] = []
    if ctx.material_index is not None:
        material_chunks = ctx.material_index.search(query, top_k=3, max_chars=1500, min_ratio=0.5)

    return build_chapter_context(
        leaf=leaf,
        plan=plan,
        requirements=requirements,
        tender_chunks=tender_chunks,
        material_chunks=material_chunks,
        siblings=siblings,
        coverage_map=coverage_map_text(ctx) if leaf.is_response_chapter else "",
    )


# ---------------------------------------------------------------------------
# 实时文本
# ---------------------------------------------------------------------------


class LiveText:
    """章节的实时文本：攒一小段再往外发，避免每个 token 一条事件。"""

    def __init__(
        self,
        on_delta: Optional[Callable[[str], None]] = None,
        on_reset: Optional[Callable[[str], None]] = None,
        min_chars: int = 48,
        max_interval: float = 0.25,
    ):
        self.text = ""
        self._on_delta = on_delta
        self._on_reset = on_reset
        self._pending: List[str] = []
        self._pending_chars = 0
        self._last_flush = time.monotonic()
        self._min_chars = min_chars
        self._max_interval = max_interval

    def delta(self, piece: str) -> None:
        if not piece:
            return
        self.text += piece
        self._pending.append(piece)
        self._pending_chars += len(piece)
        now = time.monotonic()
        if self._pending_chars >= self._min_chars or now - self._last_flush >= self._max_interval:
            self.flush()

    def flush(self) -> None:
        if self._pending:
            chunk = "".join(self._pending)
            self._pending = []
            self._pending_chars = 0
            if self._on_delta is not None:
                self._on_delta(chunk)
        self._last_flush = time.monotonic()

    def reset(self, text: str) -> None:
        """把实时文本回滚成 text（某次调用中途失败、需要重来时）。"""
        self._pending = []
        self._pending_chars = 0
        self.text = text
        if self._on_reset is not None:
            self._on_reset(text)


@dataclass
class WriteResult:
    content: str
    section_titles: List[str] = field(default_factory=list)
    truncated: bool = False
    calls: int = 0


CallHook = Optional[Callable[[StreamInfo], None]]


# ---------------------------------------------------------------------------
# 单次调用：重试与截断续写
# ---------------------------------------------------------------------------


def _check_finish_reason(info: StreamInfo) -> None:
    """length 由调用方接着续写；其余非正常结束（内容审核拦截、服务资源不足）都不能当成写完了。"""
    reason = (info.finish_reason or "").lower()
    if reason in ("", "stop", "length", "eos", "end_turn", "tool_calls", "function_call"):
        return
    if "filter" in reason or "sensitive" in reason or "safety" in reason:
        raise LLMError(
            f"模型调用失败: 输出被中止（finish_reason={info.finish_reason}）",
            kind="content_filter",
            hint="模型服务的内容审核中止了这次输出，可以调整这一章的写作要求后重试，或换一个模型",
        )
    raise LLMError(
        f"模型调用失败: 输出被中止（finish_reason={info.finish_reason}）",
        kind="server",
        retryable=True,
        hint="模型服务中途停止了输出",
    )


async def _stream_piece(
    llm: Any,
    messages: List[Message],
    temperature: float,
    live: LiveText,
    on_call: CallHook,
) -> Tuple[str, StreamInfo]:
    """流式调用一次；遇到限流、超时这类暂时性错误时退避重试。"""
    base = live.text
    attempt = 0
    while True:
        info = StreamInfo()
        parts: List[str] = []
        try:
            async for chunk in llm.stream_chat_completion(messages, temperature=temperature, info=info):
                parts.append(chunk)
                live.delta(chunk)
            live.flush()
            if on_call is not None:
                on_call(info)
            _check_finish_reason(info)
            return "".join(parts), info
        except LLMError as exc:
            attempt += 1
            if exc.kind == "timeout":
                # 请求还没开始返回就超时的，SDK 层已经重试过；只有输出到一半卡住的才值得再试一次
                limit = 2 if exc.partial else 1
            else:
                limit = MAX_PIECE_ATTEMPTS
            if not exc.retryable or attempt >= limit:
                raise
            logger.info("模型调用失败（%s），第 %s 次重试", exc.kind, attempt)
            if parts:
                live.reset(base)
            delay = RETRY_DELAYS[min(attempt - 1, len(RETRY_DELAYS) - 1)]
            if exc.kind == "rate_limit":
                delay *= 2.5
            if delay > 0:
                await asyncio.sleep(delay + random.uniform(0, delay * 0.25))


async def _stream_complete(
    llm: Any,
    messages: List[Message],
    temperature: float,
    live: LiveText,
    on_call: CallHook,
) -> Tuple[str, bool, int]:
    """调用一次，并在输出被长度上限截断时接着写完。返回 (文本, 是否仍被截断, 调用次数)。"""
    text, info = await _stream_piece(llm, messages, temperature, live, on_call)
    calls = 1
    truncated = info.finish_reason == "length"
    rounds = 0
    while truncated and rounds < MAX_TRUNCATION_ROUNDS:
        rounds += 1
        follow = messages + [
            {"role": "assistant", "content": text},
            {"role": "user", "content": TRUNCATED_TASK},
        ]
        more, info = await _stream_piece(llm, follow, temperature, live, on_call)
        calls += 1
        if not more.strip():
            break
        text = join_continuation(text, strip_preamble(more), truncated=True)
        truncated = info.finish_reason == "length"
    return text, truncated, calls


def _pending_points(points: Sequence[str], text: str) -> List[str]:
    """粗略判断哪些要点还没写到：要点里的词在正文中出现得很少。"""
    if not points:
        return []
    text_tokens = set(tokenize(text))
    pending: List[str] = []
    for point in points:
        tokens = set(tokenize(point))
        if not tokens:
            continue
        hit = len(tokens & text_tokens) / len(tokens)
        if hit < 0.5:
            pending.append(point)
    return pending


async def _expand_until_enough(
    llm: Any,
    messages: List[Message],
    text: str,
    target: int,
    points: Sequence[str],
    temperature: float,
    live: LiveText,
    on_call: CallHook,
    max_rounds: int = MAX_EXPAND_ROUNDS,
    lower_ratio: float = 1.0,
) -> Tuple[str, int]:
    """篇幅不足时补写，直到够了、或模型写不出新内容为止。"""
    lower = int(word_range(target)[0] * lower_ratio)
    calls = 0
    for _ in range(max_rounds):
        current = count_chars(text)
        if current >= lower:
            break
        live.delta("\n\n")
        follow = messages + [
            {"role": "assistant", "content": text},
            {"role": "user", "content": continuation_task(current, target, _pending_points(points, text))},
        ]
        try:
            more, _truncated, used = await _stream_complete(llm, follow, temperature, live, on_call)
        except LLMError as exc:
            if exc.kind in FATAL_KINDS:
                raise
            # 补写只是锦上添花：失败了就用已经写好的部分，不把整章判为失败
            logger.info("补写失败，保留已写出的 %s 字：%s", current, exc.friendly)
            break
        calls += used
        more = clean_chapter_text(more)
        merged = join_continuation(text, more, truncated=False)
        if count_chars(merged) - current < MIN_EXPAND_GAIN:
            break
        text = merged
    return text, calls


# ---------------------------------------------------------------------------
# 小节划分
# ---------------------------------------------------------------------------


class _SectionOut(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title: str = ""
    points: List[str] = []
    words: int = 0

    @field_validator("title", mode="before")
    @classmethod
    def _title(cls, value: Any) -> str:
        return _as_str(value).strip("#* 　")

    @field_validator("points", mode="before")
    @classmethod
    def _points(cls, value: Any) -> List[str]:
        return _as_str_list(value)

    @field_validator("words", mode="before")
    @classmethod
    def _words(cls, value: Any) -> int:
        try:
            return min(max(int(float(value)), 0), 100000)
        except (TypeError, ValueError, OverflowError):
            return 0


class _SectionPlanOut(BaseModel):
    model_config = ConfigDict(extra="ignore")

    sections: List[_SectionOut] = []

    @model_validator(mode="before")
    @classmethod
    def _shape(cls, data: Any) -> Any:
        if isinstance(data, list):
            return {"sections": data}
        if isinstance(data, dict) and "sections" not in data:
            for alias in ("items", "parts", "outline", "data"):
                if isinstance(data.get(alias), list):
                    return {"sections": data[alias]}
        return data


Section = Tuple[str, List[str], int]


def _normalize_sections(raw_sections: Sequence[Dict[str, Any]], target: int) -> List[Section]:
    sections: List[Section] = []
    seen = set()
    for raw in raw_sections:
        title = clip(str(raw.get("title", "")).strip(), 30, suffix="")
        if not title or title in seen:
            continue
        seen.add(title)
        sections.append((title, [clip(p, 100) for p in raw.get("points", [])][:5], int(raw.get("words", 0) or 0)))
    sections = sections[:8]
    if len(sections) < 2:
        return []
    # 各小节字数按比例缩放到总和等于本章目标；没给字数的按平均
    given = [w for _, _, w in sections if w > 0]
    average = (sum(given) / len(given)) if given else target / len(sections)
    raw_words = [w if w > 0 else average for _, _, w in sections]
    scale = target / sum(raw_words) if sum(raw_words) > 0 else 1.0
    return [
        (title, points, max(int(words * scale), 200))
        for (title, points, _), words in zip(sections, raw_words)
    ]


async def _plan_sections(
    llm: Any,
    base_messages: List[Message],
    leaf: LeafInfo,
    target: int,
) -> List[Section]:
    """让模型把长章划分成小节；失败时返回空列表（调用方改用整章写作）。"""
    count = min(max(round(target / SECTION_WORDS), 2), 8)

    def _validator(payload: Dict[str, Any]) -> None:
        titled = [s for s in payload.get("sections", []) if str(s.get("title", "")).strip()]
        if len(titled) < 2:
            raise ValueError("sections 至少需要 2 个带标题的小节")

    try:
        raw = await llm.collect_json_response(
            messages=base_messages + [{"role": "user", "content": section_plan_task(leaf, target, count)}],
            temperature=0.3,
            schema=_SectionPlanOut,
            validator=_validator,
            progress_label="小节划分",
            failure_message="模型返回的小节划分格式无效",
        )
    except AppError as exc:
        if isinstance(exc, LLMError) and (exc.kind in FATAL_KINDS):
            raise
        logger.info("章节 %s 的小节划分失败，改为整章写作: %s", leaf.id, getattr(exc, "message", exc))
        return []
    return _normalize_sections(raw.get("sections", []), target)


def _demote_inner_headings(text: str) -> str:
    """小节正文里的三级标题再降一级，避免和小节标题同级。"""
    lines = []
    for line in text.split("\n"):
        if line.startswith("### "):
            lines.append("#" + line)
        else:
            lines.append(line)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 写一章
# ---------------------------------------------------------------------------


async def write_chapter(
    llm: Any,
    ctx: WritingContext,
    leaf: LeafInfo,
    siblings: Sequence[Tuple[LeafInfo, ChapterDigest]] = (),
    live: Optional[LiveText] = None,
    on_call: CallHook = None,
) -> WriteResult:
    """写出一个叶子章节的正文。

    失败时抛 LLMError；live.text 里是到失败为止已经写出的原始文本。
    """
    live = live or LiveText()
    target = ctx.budget.get(leaf.uid)
    plan = ctx.plan_for(leaf.uid)
    points = plan.key_points if plan is not None else []
    base_messages = ctx.shared_messages + [
        {"role": "user", "content": chapter_context_text(ctx, leaf, siblings)}
    ]
    temperature = ctx.temperature
    calls = 0

    sections: List[Section] = []
    table_like = leaf.is_response_chapter or (plan is not None and plan.form == "table")
    if target and target > ctx.section_threshold and not table_like:
        sections = await _plan_sections(llm, base_messages, leaf, target)
        calls += 1

    if not sections:
        messages = base_messages + [{"role": "user", "content": chapter_task(leaf, target, table_like=table_like)}]
        text, truncated, used = await _stream_complete(llm, messages, temperature, live, on_call)
        calls += used
        text = clean_chapter_text(text, title=leaf.title, chapter_id=leaf.id)
        if target and not truncated and not table_like and count_chars(text) > 0:
            text, used = await _expand_until_enough(
                llm, messages, text, target, points, temperature, live, on_call
            )
            calls += used
        if count_chars(text) == 0:
            raise LLMError("模型调用失败: 模型返回了空内容", kind="empty", hint="模型没有返回内容")
        return WriteResult(content=text, truncated=truncated, calls=calls)

    parts: List[Tuple[str, str]] = []
    summaries: List[Tuple[str, str]] = []
    previous_tail = ""
    any_truncated = False
    for index, (title, section_points, words) in enumerate(sections):
        live.delta(("\n\n" if live.text else "") + f"### {title}\n\n")
        messages = base_messages + [
            {"role": "user", "content": section_task(leaf, sections, index, summaries, previous_tail)}
        ]
        text, truncated, used = await _stream_complete(llm, messages, temperature, live, on_call)
        calls += used
        text = _demote_inner_headings(clean_chapter_text(text, title=title))
        if not truncated and count_chars(text) > 0:
            # 小节只在明显偏短时补一轮，避免为了凑字数把每个小节都拖长
            text, used = await _expand_until_enough(
                llm, messages, text, words, section_points, temperature, live, on_call,
                max_rounds=1, lower_ratio=0.7,
            )
            calls += used
            # 补写出来的内容里的三级标题同样要降级，不能和小节标题同级
            text = _demote_inner_headings(text)
        any_truncated = any_truncated or truncated
        if count_chars(text) == 0:
            # 某一节没写出东西，整章就缺了一块：按失败处理，让使用者重试，而不是悄悄跳过
            raise LLMError(
                f"模型调用失败: 小节「{title}」没有返回内容",
                kind="empty",
                hint=f"小节「{title}」没有写出内容",
            )
        parts.append((title, text))
        summaries.append((title, clip(build_digest(text).summary, 120)))
        previous_tail = text[-300:]

    if not parts:
        raise LLMError("模型调用失败: 模型返回了空内容", kind="empty", hint="模型没有返回内容")
    content = "\n\n".join(f"### {title}\n\n{text}" for title, text in parts)
    return WriteResult(
        content=content,
        section_titles=[title for title, _ in parts],
        truncated=any_truncated,
        calls=calls,
    )


async def revise_chapter(
    llm: Any,
    ctx: WritingContext,
    leaf: LeafInfo,
    content: str,
    instruction: str,
    siblings: Sequence[Tuple[LeafInfo, ChapterDigest]] = (),
    live: Optional[LiveText] = None,
    on_call: CallHook = None,
) -> WriteResult:
    """按修改要求修订一章，输出修订后的完整正文。"""
    live = live or LiveText()
    target = ctx.budget.get(leaf.uid)
    messages = ctx.shared_messages + [
        {"role": "user", "content": chapter_context_text(ctx, leaf, siblings)},
        {"role": "user", "content": revise_task(leaf, content, instruction, target)},
    ]
    # 修订要“稳”，温度压低一些
    text, truncated, calls = await _stream_complete(llm, messages, min(ctx.temperature, 0.4), live, on_call)
    text = clean_chapter_text(text, title=leaf.title, chapter_id=leaf.id)
    if count_chars(text) == 0:
        raise LLMError("模型调用失败: 模型返回了空内容", kind="empty", hint="模型没有返回内容")
    titles = [line[4:].strip() for line in text.split("\n") if line.startswith("### ")]
    return WriteResult(content=text, section_titles=titles, truncated=truncated, calls=calls)
