"""审校：本地检查的组织，以及需要模型参与的前后一致性检查。

本地检查（review_checks）不花钱、几秒内完成，每次写作结束后自动跑一遍；
一致性检查要调用模型，由使用者按需发起。
"""
from __future__ import annotations

import hashlib
import re
import logging
from typing import Any, Dict, List, Optional, Sequence, Tuple

from pydantic import BaseModel, ConfigDict, field_validator, model_validator

from ..utils.errors import AppError, LLMError
from .models import ChapterRecord, FactSheet, LeafInfo, ReviewIssue, ReviewReport
from .outline_tree import collect_leaves, leaf_set_fingerprint
from .planner import FATAL_KINDS, _as_str, _as_str_list
from .prompts import build_consistency_messages
from .requirements import parse_requirements
from .textutil import clip, now_iso
from .writer import compute_budget

logger = logging.getLogger(__name__)

CLAIMS_BATCH_CHARS = 24000
_SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}
_ID_RE = re.compile(r"\d+(?:\.\d+)*")


def sort_issues(issues: Sequence[ReviewIssue]) -> List[ReviewIssue]:
    """按严重度排序（同级保持原有顺序）。"""
    return sorted(issues, key=lambda issue: _SEVERITY_ORDER.get(issue.severity, 3))


def build_local_report(
    store: Any,
    project_id: str,
    carry_consistency: bool = True,
    save: bool = True,
) -> ReviewReport:
    """跑一遍本地审校；save=True 时保存。

    carry_consistency：沿用上一次深度审校里仍然有效的一致性问题
    （涉及的章节在那之后没有改动过）。
    """
    from .review_checks import run_local_review

    # 以开始检查的时刻为准（与深度审校一致）：检查期间保存的修改，之后会被正确判为“检查之后又改过”
    started = now_iso()
    project = store.load_project(project_id)
    blueprint = store.load_blueprint(project_id)
    chapters: Dict[str, ChapterRecord] = store.load_chapters(project_id)
    leaves = collect_leaves(project.outline)
    budget, _note = compute_budget(project, blueprint)
    requirements = parse_requirements(project.requirements)

    report = run_local_review(leaves, chapters, budget, requirements, blueprint)
    report.generated_at = started
    report.outline_fingerprint = leaf_set_fingerprint(project.outline)

    previous: Optional[ReviewReport] = store.load_review(project_id)
    if previous is not None:
        leaf_uids = {leaf.uid for leaf in leaves}
        if carry_consistency and previous.deep:
            kept = [
                issue
                for issue in previous.issues
                if issue.type == "consistency"
                and issue.chapter_uids
                and all(
                    uid in leaf_uids
                    and uid in chapters
                    and (chapters[uid].updated_at or "") <= (previous.generated_at or "")
                    for uid in issue.chapter_uids
                )
            ]
            if kept:
                report.issues = sort_issues(list(report.issues) + kept)
                report.deep = True
        current_ids = {issue.id for issue in report.issues}
        report.dismissed = [issue_id for issue_id in previous.dismissed if issue_id in current_ids]

    report.stats.issue_count = len(report.issues)
    if save:
        store.save_review(project_id, report)
    return report


# ---------------------------------------------------------------------------
# 前后一致性（模型参与）
# ---------------------------------------------------------------------------


class _ConsistencyIssueOut(BaseModel):
    model_config = ConfigDict(extra="ignore")

    chapter_ids: List[str] = []
    problem: str = ""
    suggestion: str = ""

    @field_validator("chapter_ids", mode="before")
    @classmethod
    def _ids(cls, value: Any) -> List[str]:
        return _as_str_list(value)

    @field_validator("problem", "suggestion", mode="before")
    @classmethod
    def _text(cls, value: Any) -> str:
        return _as_str(value)


class _ConsistencyOut(BaseModel):
    model_config = ConfigDict(extra="ignore")

    issues: List[_ConsistencyIssueOut] = []

    @model_validator(mode="before")
    @classmethod
    def _shape(cls, data: Any) -> Any:
        if isinstance(data, list):
            return {"issues": data}
        if isinstance(data, dict) and "issues" not in data:
            for alias in ("problems", "conflicts", "items", "data", "result"):
                if isinstance(data.get(alias), list):
                    return {"issues": data[alias]}
        return data


def _claim_blocks(
    leaves: Sequence[LeafInfo],
    chapters: Dict[str, ChapterRecord],
) -> List[Tuple[LeafInfo, str]]:
    blocks: List[Tuple[LeafInfo, str]] = []
    for leaf in leaves:
        record = chapters.get(leaf.uid)
        if record is None or record.status != "done" or record.digest is None or not record.digest.claims:
            continue
        lines = "\n".join(f"- {claim}" for claim in record.digest.claims)
        blocks.append((leaf, f"〔{leaf.id} {leaf.title}〕\n{lines}"))
    return blocks


def _issue_id(uids: Sequence[str], problem: str) -> str:
    raw = "consistency|" + ",".join(sorted(uids)) + "|" + problem[:60]
    return "c" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:11]


async def check_consistency(
    llm: Any,
    leaves: Sequence[LeafInfo],
    chapters: Dict[str, ChapterRecord],
    fact_sheet: Optional[FactSheet],
    on_batch: Any = None,
) -> Tuple[List[ReviewIssue], List[str], int, int]:
    """让模型在各章的关键表述里找前后矛盾。

    返回 (问题列表, 提示列表, 实际完成检查的批数, 总批数)；完成的批数为 0 表示一致性检查没有真正做成。
    """
    blocks = _claim_blocks(leaves, chapters)
    if len(blocks) < 2:
        return [], ["已完成的章节里没有足够的带数字、指标的表述，未做一致性检查。"], 0, 0

    batches: List[List[Tuple[LeafInfo, str]]] = []
    current: List[Tuple[LeafInfo, str]] = []
    size = 0
    for block in blocks:
        if current and size + len(block[1]) > CLAIMS_BATCH_CHARS:
            batches.append(current)
            current, size = [], 0
        current.append(block)
        size += len(block[1])
    if current:
        batches.append(current)

    by_id = {leaf.id: leaf for leaf in leaves}
    order = {leaf.uid: position for position, leaf in enumerate(leaves)}
    issues: List[ReviewIssue] = []
    warnings: List[str] = []
    seen: set = set()
    checked = 0
    if len(batches) > 1:
        warnings.append(f"章节较多，一致性检查分 {len(batches)} 批进行，跨批的矛盾可能检查不到。")

    for index, batch in enumerate(batches, start=1):
        if on_batch is not None:
            on_batch(index, len(batches))
        messages = build_consistency_messages(fact_sheet, "\n\n".join(text for _, text in batch))
        try:
            raw = await llm.collect_json_response(
                messages=messages,
                temperature=0.2,
                schema=_ConsistencyOut,
                progress_label="一致性检查",
                failure_message="模型返回的一致性检查结果格式无效",
            )
        except AppError as exc:
            if isinstance(exc, LLMError) and exc.kind in FATAL_KINDS:
                raise
            detail = exc.friendly if isinstance(exc, LLMError) else exc.message
            warnings.append(f"第 {index} 批一致性检查没有完成（{detail}）。")
            continue

        checked += 1
        for item in raw.get("issues", []):
            problem = str(item.get("problem", "")).strip()
            if not problem:
                continue
            uids: List[str] = []
            for value in item.get("chapter_ids", []):
                for match in _ID_RE.findall(str(value)):
                    leaf = by_id.get(match)
                    if leaf is not None and leaf.uid not in uids:
                        uids.append(leaf.uid)
            if not uids:
                continue
            # 按文档顺序排列：修订时默认改“靠后的一章”，它通常是与前文不一致的那一处
            uids.sort(key=lambda uid: order.get(uid, 0))
            issue_id = _issue_id(uids, problem)
            if issue_id in seen:
                continue
            seen.add(issue_id)
            suggestion = str(item.get("suggestion", "")).strip()
            issues.append(
                ReviewIssue(
                    id=issue_id,
                    type="consistency",
                    severity="high",
                    chapter_uids=uids,
                    title=clip(problem, 48),
                    detail=problem,
                    suggestion=suggestion,
                    fixable=True,
                    fix_instruction=(
                        f"本章与其他章节的表述前后矛盾：{problem}"
                        + (f"修改建议：{suggestion}" if suggestion else "")
                        + "请修改本章里相关的表述，使它与统一口径和其他章节一致；只改这一处相关的内容。"
                    ),
                )
            )
    if batches and not checked:
        warnings.append("一致性检查的各批都没有完成，这次没有核对前后矛盾。")
    return issues, warnings, checked, len(batches)
