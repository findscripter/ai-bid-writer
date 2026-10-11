"""写作规划：动笔之前先定下「统一口径」和各章的写作计划。

为什么要有这一步：上百个章节分头写，如果每章只知道自己的标题，必然各说各话——
同一个指标前后不一、相邻章节内容重叠、评分项没人响应。蓝图把这些提前定死。

每一步都能降级：统一口径生成失败就留空，某一批章节计划失败就用本地规则兜底，
规划本身永远不会卡住后面的写作。
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Awaitable, Callable, Dict, List, Optional, Sequence, Set, Tuple

from pydantic import BaseModel, ConfigDict, field_validator, model_validator

from ..utils.errors import AppError, LLMError
from .models import Blueprint, ChapterPlan, FactItem, FactSheet, LeafInfo, Project, RequirementItem, TermItem
from .outline_tree import collect_leaves, outline_fingerprint, outline_overview, top_level_batches
from .prompts import (
    build_fact_sheet_messages,
    build_plan_shared_messages,
    plan_batch_task,
)
from .requirements import parse_requirements, requirements_brief
from .retrieval import BM25Index, TextIndex
from .textutil import clip, now_iso

logger = logging.getLogger(__name__)

PLAN_BATCH_SIZE = 16
"""一次规划请求里最多放多少个章节——再多，弱模型的输出就容易被截断。"""

FATAL_KINDS = {"auth", "balance"}
"""遇到这些错误没有必要再试下一批：Key 不对或没钱，后面只会全部失败。"""

TRANSIENT_KINDS = {"timeout", "connection", "server", "rate_limit"}
"""模型服务没有正常响应。连续出现说明服务出了状况，剩下的批次不必再一批批地等超时。"""

MAX_TRANSIENT_STRIKES = 2

_ID_IN_TEXT_RE = re.compile(r"\d+(?:\.\d+)*")
_REQ_ID_RE = re.compile(r"[A-Za-z]{1,3}\s*-?\s*\d{1,3}(?:-\d+)?")
_FORM_ALIASES = {
    "paragraph": "paragraph",
    "段落": "paragraph",
    "table": "table",
    "表格": "table",
    "steps": "steps",
    "step": "steps",
    "步骤": "steps",
    "流程": "steps",
    "mixed": "mixed",
    "混合": "mixed",
}

FACT_QUERY = "工期 服务期 交付期 实施地点 建设范围 数量 规模 技术指标 性能指标 验收 质保期 预算 最高限价"

StageCallback = Callable[[str, str], None]
BatchCallback = Callable[[int, int], None]


# ---------------------------------------------------------------------------
# 模型输出的宽松解析：弱模型给的结构五花八门，尽量都认
# ---------------------------------------------------------------------------


def _as_str(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, list):
        return "；".join(_as_str(v) for v in value if _as_str(v))
    if isinstance(value, dict):
        return "；".join(f"{k}：{_as_str(v)}" for k, v in value.items() if _as_str(v))
    return str(value)


def _as_str_list(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        parts = [p.strip(" -•·\t") for p in re.split(r"[\n；;]+", value)]
        return [p for p in parts if p]
    if isinstance(value, dict):
        return [_as_str({k: v}) for k, v in value.items()]
    if isinstance(value, list):
        return [text for text in (_as_str(v) for v in value) if text]
    return [_as_str(value)]


def _pair_list(value: Any, key_names: Sequence[str], value_names: Sequence[str]) -> List[Dict[str, str]]:
    """把各种形态的“键值对列表”归一成 [{key, value}]。"""
    result: List[Dict[str, str]] = []
    if isinstance(value, dict):
        value = [{k: v} for k, v in value.items()]
    if not isinstance(value, list):
        value = _as_str_list(value)
    for item in value:
        key, val = "", ""
        if isinstance(item, dict):
            for name in key_names:
                if item.get(name):
                    key = _as_str(item[name])
                    break
            for name in value_names:
                if item.get(name):
                    val = _as_str(item[name])
                    break
            if not key and not val and len(item) == 1:
                (key, raw), = item.items()
                key, val = _as_str(key), _as_str(raw)
        else:
            text = _as_str(item)
            if "：" in text or ":" in text:
                key, _, val = text.replace(":", "：", 1).partition("：")
                key, val = key.strip(), val.strip()
            else:
                val = text
        if key or val:
            result.append({"key": key, "value": val})
    return result


class _FactSheetOut(BaseModel):
    model_config = ConfigDict(extra="ignore")

    project_name: str = ""
    purchaser: str = ""
    facts: List[Dict[str, str]] = []
    decisions: List[Dict[str, str]] = []
    terminology: List[Dict[str, str]] = []
    placeholders: List[str] = []

    @field_validator("project_name", "purchaser", mode="before")
    @classmethod
    def _text(cls, value: Any) -> str:
        return _as_str(value)

    @field_validator("facts", "decisions", mode="before")
    @classmethod
    def _pairs(cls, value: Any) -> List[Dict[str, str]]:
        return _pair_list(value, ("key", "name", "item", "title"), ("value", "content", "desc", "description"))

    @field_validator("terminology", mode="before")
    @classmethod
    def _terms(cls, value: Any) -> List[Dict[str, str]]:
        return _pair_list(value, ("term", "name", "key"), ("definition", "desc", "description", "value"))

    @field_validator("placeholders", mode="before")
    @classmethod
    def _list(cls, value: Any) -> List[str]:
        return _as_str_list(value)


class _PlanOut(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = ""
    title: str = ""
    key_points: List[str] = []
    requirement_ids: List[str] = []
    avoid: List[str] = []
    weight: float = 1.0
    form: str = "paragraph"

    @field_validator("id", "title", mode="before")
    @classmethod
    def _text(cls, value: Any) -> str:
        return _as_str(value)

    @field_validator("key_points", "requirement_ids", "avoid", mode="before")
    @classmethod
    def _list(cls, value: Any) -> List[str]:
        return _as_str_list(value)

    @field_validator("weight", mode="before")
    @classmethod
    def _weight(cls, value: Any) -> float:
        try:
            number = float(value)
        except (TypeError, ValueError):
            return 1.0
        if number != number or number <= 0:
            return 1.0
        return min(max(number, 0.3), 3.0)

    @field_validator("form", mode="before")
    @classmethod
    def _form(cls, value: Any) -> str:
        text = _as_str(value).lower()
        for alias, form in _FORM_ALIASES.items():
            if alias in text:
                return form
        return "paragraph"


class _PlanBatchOut(BaseModel):
    model_config = ConfigDict(extra="ignore")

    plans: List[_PlanOut] = []

    @model_validator(mode="before")
    @classmethod
    def _shape(cls, data: Any) -> Any:
        if isinstance(data, list):
            return {"plans": data}
        if isinstance(data, dict):
            plans = data.get("plans")
            if plans is None:
                for alias in ("chapters", "items", "data", "result"):
                    if isinstance(data.get(alias), (list, dict)):
                        plans = data[alias]
                        break
            if plans is None and data and all(isinstance(v, dict) for v in data.values()):
                plans = data  # {"2.1.1": {...}, "2.1.2": {...}}
            if isinstance(plans, dict):
                plans = [{**v, "id": v.get("id") or k} for k, v in plans.items() if isinstance(v, dict)]
            return {"plans": plans or []}
        return {"plans": []}


# ---------------------------------------------------------------------------
# 本地兜底
# ---------------------------------------------------------------------------


def normalize_requirement_id(value: str) -> str:
    return re.sub(r"[\s]", "", value or "").upper()


def _canonical_id(raw: str) -> str:
    """“E 1”“E-1”→“E1”；重复编号的去重后缀要保留：“E1-2”仍是“E1-2”，不能变成“E12”。"""
    match = re.match(r"\s*([A-Za-z]{1,3})\s*-?\s*(\d{1,3})(-\d+)?", raw or "")
    if not match:
        return re.sub(r"\s", "", raw or "").upper()
    return (match.group(1) + match.group(2) + (match.group(3) or "")).upper()


def _ids_in_text(text: str, valid_ids: Set[str]) -> List[str]:
    found: List[str] = []
    for match in _REQ_ID_RE.finditer(text or ""):
        candidate = _canonical_id(match.group())
        if candidate in valid_ids and candidate not in found:
            found.append(candidate)
    return found


def default_plan(leaf: LeafInfo, valid_ids: Set[str]) -> ChapterPlan:
    """不依赖模型的章节计划：从目录描述里能挖多少算多少。"""
    points: List[str] = []
    for line in (leaf.description or "").splitlines():
        stripped = line.strip()
        if stripped.startswith("·"):
            points.append(clip(stripped.lstrip("· ").strip(), 80))
    return ChapterPlan(
        uid=leaf.uid,
        key_points=points[:8],
        requirement_ids=[] if leaf.is_response_chapter else _ids_in_text(leaf.description, valid_ids),
        form="table" if leaf.is_response_chapter else "paragraph",
    )


def assign_unowned_requirements(
    leaves: Sequence[LeafInfo],
    plans: Dict[str, ChapterPlan],
    requirements: Sequence[RequirementItem],
    allowed_uids: Optional[Set[str]] = None,
) -> List[str]:
    """没有章节认领的评分项，按文本相似度分给最贴切的章节；实在对不上的返回出来。

    allowed_uids 不为空时，只往这些章节里补（“补全计划”时只动新章节，不改使用者调整过的计划）。
    """
    owned: Set[str] = set()
    for plan in plans.values():
        owned.update(plan.requirement_ids)
    orphans = [item for item in requirements if item.id not in owned]
    candidates = [
        leaf
        for leaf in leaves
        if not leaf.is_response_chapter and (allowed_uids is None or leaf.uid in allowed_uids)
    ]
    if not orphans or not candidates:
        return [item.id for item in orphans]

    docs = []
    for leaf in candidates:
        plan = plans.get(leaf.uid)
        docs.append(
            " ".join(
                [leaf.title, leaf.title, " ".join(leaf.path_titles), leaf.description]
                + (plan.key_points if plan else [])
            )
        )
    index = BM25Index(docs)

    unassigned: List[str] = []
    for item in orphans:
        scores = index.scores(" ".join([item.name, item.name, item.detail, " ".join(item.keywords), item.suggestion]))
        best = max(range(len(scores)), key=lambda i: scores[i]) if scores else -1
        if best < 0 or scores[best] <= 0:
            unassigned.append(item.id)
            continue
        leaf = candidates[best]
        plan = plans.setdefault(leaf.uid, ChapterPlan(uid=leaf.uid))
        plan.requirement_ids.append(item.id)
        plan.auto_assigned.append(item.id)
    return unassigned


# ---------------------------------------------------------------------------
# 调用模型
# ---------------------------------------------------------------------------


def _error_text(exc: BaseException) -> str:
    if isinstance(exc, LLMError):
        return exc.friendly
    if isinstance(exc, AppError):
        return exc.message
    return f"{type(exc).__name__}: {exc}"


async def plan_fact_sheet(
    llm: Any,
    project: Project,
    outline_text: str,
    tender_index: Optional[TextIndex] = None,
) -> Tuple[FactSheet, Optional[str]]:
    """生成统一口径；失败时返回只有项目名的空口径和一条提示。"""
    excerpt = ""
    if tender_index is not None and len(tender_index):
        chunks = tender_index.search(FACT_QUERY, top_k=6, max_chars=3000, min_ratio=0.25)
        excerpt = "\n\n".join(f"〔{c.heading}〕\n{c.text}" if c.heading else c.text for c in chunks)

    # 评分要求能解析出条目时用压缩后的完整清单：原文太长时截断会把排在后面的采购人要求整段丢掉
    items = parse_requirements(project.requirements)
    requirements_text = requirements_brief(items, max_chars=8000) if items else project.requirements
    messages = build_fact_sheet_messages(
        overview=project.overview,
        requirements_text=requirements_text,
        outline_text=outline_text,
        company_profile=project.company_profile,
        tender_excerpt=excerpt,
    )
    try:
        raw = await llm.collect_json_response(
            messages=messages,
            temperature=0.3,
            schema=_FactSheetOut,
            progress_label="统一口径",
            failure_message="模型返回的统一口径格式无效",
        )
    except AppError as exc:
        if isinstance(exc, LLMError) and exc.kind in FATAL_KINDS:
            raise
        logger.warning("统一口径生成失败: %s", _error_text(exc))
        return FactSheet(project_name=project.name), f"统一口径没有生成成功（{_error_text(exc)}），可以手动填写或稍后重试。"

    fact_sheet = FactSheet(
        project_name=raw.get("project_name") or project.name,
        purchaser=raw.get("purchaser", ""),
        facts=[FactItem(key=i["key"], value=i["value"], source="tender") for i in raw.get("facts", [])][:30],
        decisions=[FactItem(key=i["key"], value=i["value"], source="design") for i in raw.get("decisions", [])][:24],
        terminology=[TermItem(term=i["key"] or i["value"], definition=i["value"] if i["key"] else "") for i in raw.get("terminology", [])][:20],
        placeholders=raw.get("placeholders", [])[:20],
    )
    return fact_sheet, None


def _match_plans(
    batch: Sequence[LeafInfo],
    raw_plans: Sequence[Dict[str, Any]],
    valid_ids: Set[str],
) -> Dict[str, ChapterPlan]:
    by_id = {leaf.id: leaf for leaf in batch}
    by_title = {leaf.title: leaf for leaf in batch}
    result: Dict[str, ChapterPlan] = {}
    for raw in raw_plans:
        raw_id = str(raw.get("id", ""))
        leaf = by_id.get(raw_id.strip())
        if leaf is None:
            match = _ID_IN_TEXT_RE.search(raw_id)
            leaf = by_id.get(match.group()) if match else None
        if leaf is None:
            leaf = by_title.get(str(raw.get("title", "")).strip())
        if leaf is None or leaf.uid in result:
            continue
        requirement_ids: List[str] = []
        for value in raw.get("requirement_ids", []):
            for candidate in _ids_in_text(value, valid_ids) or [normalize_requirement_id(value)]:
                if candidate in valid_ids and candidate not in requirement_ids:
                    requirement_ids.append(candidate)
        result[leaf.uid] = ChapterPlan(
            uid=leaf.uid,
            key_points=[clip(p, 120) for p in raw.get("key_points", [])][:8],
            requirement_ids=requirement_ids,
            avoid=[clip(a, 100) for a in raw.get("avoid", [])][:4],
            weight=float(raw.get("weight", 1.0) or 1.0),
            form=str(raw.get("form", "paragraph")),
        )
    return result


async def plan_batch(
    llm: Any,
    shared_messages: List[Dict[str, str]],
    batch: Sequence[LeafInfo],
    valid_ids: Set[str],
) -> Tuple[Dict[str, ChapterPlan], Optional[str], Optional[str]]:
    """为一批章节生成写作计划；失败或缺项的章节用本地兜底补齐。

    返回 (计划, 提示, 失败类别)。失败类别是模型调用失败时的 LLMError.kind（格式问题为 "format"），成功为 None。
    """
    batch_ids = {leaf.id for leaf in batch}
    batch_titles = {leaf.title for leaf in batch}

    def _validator(payload: Dict[str, Any]) -> None:
        plans = payload.get("plans", [])
        ids = {str(p.get("id", "")).strip() for p in plans}
        titles = {str(p.get("title", "")).strip() for p in plans}
        by_id = bool(ids & batch_ids) or any(
            _ID_IN_TEXT_RE.search(i) and _ID_IN_TEXT_RE.search(i).group() in batch_ids for i in ids
        )
        if not by_id and not (titles & batch_titles):
            raise ValueError("plans 里没有任何一条的 id 属于指定的章节，请为指定章节逐个输出计划并原样照抄 id")

    messages = shared_messages + [{"role": "user", "content": plan_batch_task(batch)}]
    warning: Optional[str] = None
    failure: Optional[str] = None
    plans: Dict[str, ChapterPlan] = {}
    try:
        raw = await llm.collect_json_response(
            messages=messages,
            temperature=0.3,
            schema=_PlanBatchOut,
            validator=_validator,
            progress_label="章节写作计划",
            failure_message="模型返回的章节写作计划格式无效",
        )
        plans = _match_plans(batch, raw.get("plans", []), valid_ids)
    except AppError as exc:
        if isinstance(exc, LLMError) and exc.kind in FATAL_KINDS:
            raise
        first, last = batch[0].id, batch[-1].id
        warning = f"章节 {first}～{last} 的写作计划没有生成成功（{_error_text(exc)}），已按目录描述生成简化计划。"
        failure = exc.kind if isinstance(exc, LLMError) else "format"
        logger.warning(warning)

    missing = [leaf for leaf in batch if leaf.uid not in plans]
    for leaf in missing:
        plans[leaf.uid] = default_plan(leaf, valid_ids)
    if missing and warning is None and len(missing) < len(batch):
        warning = f"有 {len(missing)} 个章节模型没有给出计划（{'、'.join(l.id for l in missing[:6])}），已按目录描述生成简化计划。"
    return plans, warning, failure


async def gather_cancellable(coroutines: Sequence[Awaitable[Any]]) -> List[Any]:
    """并发执行；任何一个出错或外部取消时，先把其余的取消并等它们收尾，再把异常抛出去。"""
    tasks = [asyncio.ensure_future(c) for c in coroutines]
    try:
        return list(await asyncio.gather(*tasks))
    except BaseException:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise


async def build_blueprint(
    llm: Any,
    project: Project,
    tender_text: str = "",
    existing: Optional[Blueprint] = None,
    only_missing: bool = False,
    concurrency: int = 3,
    on_stage: Optional[StageCallback] = None,
    on_batch: Optional[BatchCallback] = None,
) -> Blueprint:
    """生成（或补全）写作蓝图。

    only_missing=True 且已有蓝图时：保留统一口径和已有的章节计划，只给新增的章节补计划。
    """
    leaves = collect_leaves(project.outline)
    if not leaves:
        raise AppError("请先生成目录", status_code=400)

    requirements = parse_requirements(project.requirements)
    valid_ids = {item.id for item in requirements}
    outline_text = outline_overview(project.outline)
    warnings: List[str] = []
    keep = existing if (only_missing and existing is not None) else None

    def _stage(stage: str, message: str) -> None:
        if on_stage is not None:
            on_stage(stage, message)

    # 1) 统一口径
    if keep is not None:
        fact_sheet = keep.fact_sheet
        # 沿用的统一口径如果当初就没生成成功，这条提示也要沿用，不能悄悄消失
        warnings.extend(w for w in keep.warnings if "统一口径" in w)
    else:
        _stage("facts", "正在统一全书口径")
        tender_index = TextIndex.from_text(tender_text) if tender_text.strip() else None
        fact_sheet, warning = await plan_fact_sheet(llm, project, outline_text, tender_index)
        if warning:
            warnings.append(warning)

    # 2) 各章写作计划
    plans: Dict[str, ChapterPlan] = {}
    if keep is not None:
        leaf_uids = {leaf.uid for leaf in leaves}
        plans = {uid: plan for uid, plan in keep.plans.items() if uid in leaf_uids}

    todo = [leaf for leaf in leaves if leaf.uid not in plans]
    for leaf in todo:
        if leaf.is_response_chapter:
            # 响应表型章节的写法由模板描述决定，不需要模型规划
            plans[leaf.uid] = default_plan(leaf, valid_ids)
    todo_uids = {leaf.uid for leaf in todo if not leaf.is_response_chapter}

    batches: List[List[LeafInfo]] = []
    for batch in top_level_batches(project.outline, max_leaves=PLAN_BATCH_SIZE):
        picked = [leaf for leaf in batch if leaf.uid in todo_uids]
        if picked:
            batches.append(picked)

    if batches:
        _stage("chapters", f"正在制定各章写作计划（共 {len(todo_uids)} 章，分 {len(batches)} 批）")
        shared = build_plan_shared_messages(
            overview=project.overview,
            fact_sheet=fact_sheet,
            outline_text=outline_text,
            requirements_brief_text=requirements_brief(requirements) if requirements else "",
        )
        semaphore = asyncio.Semaphore(max(1, concurrency))
        finished = 0
        strikes = 0
        skipped: List[str] = []

        async def _run(batch: List[LeafInfo]) -> Tuple[Dict[str, ChapterPlan], Optional[str]]:
            nonlocal finished, strikes
            async with semaphore:
                if strikes >= MAX_TRANSIENT_STRIKES:
                    # 模型服务连续没有正常响应：剩下的批次直接用本地兜底，不再一批批地等超时
                    skipped.extend(leaf.id for leaf in batch)
                    result: Tuple[Dict[str, ChapterPlan], Optional[str]] = (
                        {leaf.uid: default_plan(leaf, valid_ids) for leaf in batch},
                        None,
                    )
                else:
                    batch_plans, warning, failure = await plan_batch(llm, shared, batch, valid_ids)
                    if failure in TRANSIENT_KINDS:
                        strikes += 1
                    elif failure is None:
                        strikes = 0
                    result = (batch_plans, warning)
            finished += 1
            if on_batch is not None:
                on_batch(finished, len(batches))
            return result

        for batch_plans, warning in await gather_cancellable([_run(b) for b in batches]):
            plans.update(batch_plans)
            if warning:
                warnings.append(warning)
        if skipped:
            warnings.append(
                f"模型服务连续没有正常响应，其余 {len(skipped)} 章没有再请求模型，已按目录描述生成简化计划。"
                "可以检查模型服务后点“重新生成”。"
            )

    # 3) 没人认领的评分项，本地补分配（补全计划时只往新章节里补）
    _stage("coverage", "正在核对评分项的章节归属")
    unassigned = assign_unowned_requirements(
        leaves, plans, requirements, allowed_uids=todo_uids if keep is not None else None
    )
    if requirements and unassigned:
        warnings.append(
            f"有 {len(unassigned)} 条评审项/采购人要求找不到合适的章节承接（{'、'.join(unassigned[:8])}），"
            "建议在目录里补充对应章节，或手动指定负责章节。"
        )
    if not requirements and project.requirements.strip():
        warnings.append("技术评分要求不是标准的条目格式，没能解析出评审项，评分点覆盖核对将不可用。")

    return Blueprint(
        version=(existing.version + 1) if existing is not None else 1,
        generated_at=now_iso(),
        model=str(getattr(llm, "model_name", "")),
        fact_sheet=fact_sheet,
        plans={leaf.uid: plans[leaf.uid] for leaf in leaves if leaf.uid in plans},
        unassigned_requirements=unassigned,
        warnings=warnings,
        outline_fingerprint=outline_fingerprint(project.outline),
    )
