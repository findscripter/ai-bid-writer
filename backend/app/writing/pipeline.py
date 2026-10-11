"""写作管线的任务执行体：规划、写作、修订、深度审校。

每个函数都是后台任务的 runner：从项目工作区读数据，调用规划器/写作器，
把结果写回工作区，并沿途发事件。它们不直接认识 HTTP，也不直接创建模型客户端
（由 llm_factory 注入），所以可以用假模型完整地测。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from ..core.jobs import JobContext
from ..core.store import ProjectStore
from ..utils.errors import AppError, LLMError
from ..utils.openai_util import StreamInfo
from .cleaner import clean_chapter_text
from .digest import build_digest
from .models import ChapterDigest, ChapterRecord, ChapterVersion, LeafInfo
from .outline_tree import leaf_groups
from .planner import FATAL_KINDS, build_blueprint, gather_cancellable
from .reviewer import build_local_report, check_consistency, sort_issues
from .textutil import count_chars, now_iso
from .writer import LiveText, WriteResult, WritingContext, build_writing_context, revise_chapter, write_chapter

logger = logging.getLogger(__name__)

LLMFactory = Callable[[Optional[str]], Any]

MAX_FAILURE_STREAK = 5
"""连续这么多章失败就停下整个任务：多半是配置有问题（模型名不对、服务不可用），
继续下去只会把剩下的章节全部白白试一遍。"""


def chapter_view(record: ChapterRecord) -> Dict[str, Any]:
    """给前端的章节数据：不带历史版本的正文，只带个数。"""
    data = record.model_dump(exclude={"versions"})
    data["version_count"] = len(record.versions)
    return data


def sibling_digests(
    ctx: WritingContext,
    leaf: LeafInfo,
    digests: Dict[str, ChapterDigest],
) -> List[Tuple[LeafInfo, ChapterDigest]]:
    """同一父节点下已经写完的兄弟章节的摘记（按文档顺序）。"""
    if not leaf.parent_uid:
        return []
    result: List[Tuple[LeafInfo, ChapterDigest]] = []
    for other in ctx.leaves:
        if other.uid == leaf.uid or other.parent_uid != leaf.parent_uid:
            continue
        digest = digests.get(other.uid)
        if digest is not None and digest.summary:
            result.append((other, digest))
    return result


def apply_result(
    record: ChapterRecord,
    result: WriteResult,
    target: Optional[int],
    source: str,
    note: str = "",
) -> ChapterRecord:
    """把新写出的正文落到章节记录上；原有正文进历史版本。"""
    if record.content.strip() and record.content != result.content:
        record.versions.insert(
            0,
            ChapterVersion(
                content=record.content,
                saved_at=record.updated_at or now_iso(),
                source=record.source,
                note=note,
            ),
        )
    record.content = result.content
    record.chars = count_chars(result.content)
    record.status = "done"
    record.target_words = target
    record.source = source
    record.error = None
    record.error_kind = None
    record.truncated = result.truncated
    record.section_titles = list(result.section_titles)
    record.digest = build_digest(result.content, result.section_titles)
    return record


def _error_message(exc: BaseException) -> str:
    if isinstance(exc, LLMError):
        return exc.friendly
    if isinstance(exc, AppError):
        return exc.message
    return f"内部错误：{type(exc).__name__}: {exc}"


def _make_live(ctx: JobContext, uid: str) -> LiveText:
    holder: Dict[str, LiveText] = {}

    def _on_delta(text: str) -> None:
        ctx.live_update(uid, holder["live"].text)
        ctx.emit("chapter_delta", uid=uid, text=text)

    def _on_reset(text: str) -> None:
        ctx.live_update(uid, text)
        ctx.emit("chapter_reset", uid=uid, text=text)

    holder["live"] = LiveText(on_delta=_on_delta, on_reset=_on_reset)
    return holder["live"]


def _call_hook(ctx: JobContext) -> Callable[[StreamInfo], None]:
    def _hook(info: StreamInfo) -> None:
        ctx.note_call(info.prompt_tokens, info.completion_tokens, info.cached_tokens)

    return _hook


# ---------------------------------------------------------------------------
# 规划
# ---------------------------------------------------------------------------


async def run_plan_job(ctx: JobContext, store: ProjectStore, llm_factory: LLMFactory) -> None:
    project = store.load_project(ctx.project_id)
    existing = store.load_blueprint(project.id)
    only_missing = bool(ctx.params.get("only_missing")) and existing is not None
    llm = llm_factory(project.settings.model_name)

    blueprint = await build_blueprint(
        llm,
        project,
        tender_text=store.load_tender_text(project.id),
        existing=existing,
        only_missing=only_missing,
        concurrency=project.settings.concurrency,
        on_stage=ctx.stage,
        on_batch=ctx.set_progress,
    )
    # 使用者给各章写的补充要求不能因为重新规划而丢掉。以保存前磁盘上的版本为准，
    # 而不是任务开始时读到的那一份
    latest = store.load_blueprint(project.id) or existing
    if latest is not None:
        for uid, plan in blueprint.plans.items():
            old = latest.plans.get(uid)
            if old is not None and old.note and not plan.note:
                plan.note = old.note

    store.save_blueprint(project.id, blueprint)
    ctx.emit("blueprint_ready", plan_count=len(blueprint.plans), warnings=blueprint.warnings)


# ---------------------------------------------------------------------------
# 写作
# ---------------------------------------------------------------------------


def _save_unfinished(
    store: ProjectStore,
    project_id: str,
    record: ChapterRecord,
    leaf: LeafInfo,
    raw_text: str,
    status: str,
    error: Optional[str],
    had_content: bool,
    target: Optional[int],
) -> ChapterRecord:
    """一章没写成（失败或被取消）时的落盘规则：绝不用更差的东西顶掉已有的正文。"""
    if had_content:
        if error:
            record.error = f"重新生成没有成功，已保留原来的正文。原因：{error}"
            record.error_kind = "rewrite"
            # 正文没变，不刷新 updated_at：否则正在编辑这一章的页面会以为有了新内容
            store.save_chapter(project_id, record, touch=False)
        return record

    partial = clean_chapter_text(raw_text, title=leaf.title, chapter_id=leaf.id)
    previous = record.content or ""
    if count_chars(previous) > count_chars(partial):
        # 上一次失败或取消留下的半成品比这次的更完整：保留它，只更新状态（正文没变，不刷新 updated_at）
        record.status = status
        record.error = error
        record.error_kind = "write" if error else None
        store.save_chapter(project_id, record, touch=False)
        return record
    if previous.strip() and previous != partial:
        record.versions.insert(
            0,
            ChapterVersion(
                content=previous,
                saved_at=record.updated_at or now_iso(),
                source=record.source,
                note="上一次没写完的部分",
            ),
        )
    record.content = partial
    record.chars = count_chars(partial)
    record.status = status
    record.error = error
    record.error_kind = "write" if error else None
    record.target_words = target
    record.source = "ai"
    record.truncated = False
    record.section_titles = []
    record.digest = None
    store.save_chapter(project_id, record)
    return record


async def run_write_job(ctx: JobContext, store: ProjectStore, llm_factory: LLMFactory) -> None:
    """撰写正文。

    参数：
    - uids：只写这些章节（单章重写、重试失败章节时用）；
    - mode：missing（默认，只写还没完成的）/ all（全部重写）。
    """
    project = store.load_project(ctx.project_id)
    blueprint = store.load_blueprint(project.id)
    chapters = store.load_chapters(project.id)
    wctx = build_writing_context(
        project,
        blueprint,
        tender_text=store.load_tender_text(project.id),
        materials=store.load_materials(project.id),
    )
    if not wctx.leaves:
        raise AppError("请先生成目录", status_code=400)

    wanted = set(ctx.params.get("uids") or [])
    mode = str(ctx.params.get("mode") or "missing")
    targets: List[LeafInfo] = []
    for leaf in wctx.leaves:
        if wanted:
            if leaf.uid in wanted:
                targets.append(leaf)
            continue
        record = chapters.get(leaf.uid)
        finished = record is not None and record.status == "done" and record.chars > 0
        if mode == "missing" and finished:
            continue
        targets.append(leaf)

    if not targets:
        ctx.stage("write", "没有需要撰写的章节")
        return

    llm = llm_factory(project.settings.model_name)
    target_uids = {leaf.uid for leaf in targets}
    ctx.stage("write", f"正在撰写正文（共 {len(targets)} 章）")
    ctx.set_progress(0, len(targets))
    ctx.emit(
        "write_plan",
        uids=[leaf.uid for leaf in targets],
        budget={leaf.uid: wctx.budget.get(leaf.uid) for leaf in targets},
        note=wctx.budget_note,
    )
    ctx.set_queued([leaf.uid for leaf in targets])

    # 已经写完、且这次不重写的章节，其摘记可以直接给相邻章节做上下文
    digests: Dict[str, ChapterDigest] = {
        uid: record.digest
        for uid, record in chapters.items()
        if record.digest is not None and record.status == "done" and uid not in target_uids
    }
    semaphore = asyncio.Semaphore(max(1, project.settings.concurrency))
    on_call = _call_hook(ctx)
    failure_streak = 0

    async def write_one(leaf: LeafInfo) -> None:
        nonlocal failure_streak
        uid = leaf.uid
        # 开写前重新读一次：任务运行期间使用者可能手动改过这一章，改动要进历史版本而不是被悄悄盖掉
        record = store.load_chapter(project.id, uid) or ChapterRecord(uid=uid)
        had_content = record.status == "done" and count_chars(record.content) > 0
        target = wctx.budget.get(uid)
        live = _make_live(ctx, uid)
        ctx.dequeue(uid)
        ctx.live_update(uid, "")
        ctx.emit("chapter_start", uid=uid, id=leaf.id, title=leaf.title, target_words=target)
        try:
            result = await write_chapter(
                llm,
                wctx,
                leaf,
                siblings=sibling_digests(wctx, leaf, digests),
                live=live,
                on_call=on_call,
            )
        except asyncio.CancelledError:
            _save_unfinished(store, project.id, record, leaf, live.text, "cancelled", None, had_content, target)
            chapters[uid] = record
            ctx.live_clear(uid)
            ctx.emit("chapter_stopped", uid=uid, chapter=chapter_view(record))
            raise
        except Exception as exc:  # noqa: BLE001 - 一章失败不应该拖垮整个任务
            if not isinstance(exc, AppError):
                logger.exception("章节 %s 写作时出现未预期的错误", leaf.id)
            message = _error_message(exc)
            _save_unfinished(store, project.id, record, leaf, live.text, "failed", message, had_content, target)
            chapters[uid] = record
            ctx.live_clear(uid)
            ctx.emit("chapter_failed", uid=uid, error=message, chapter=chapter_view(record))
            ctx.advance(failed=1)
            if isinstance(exc, LLMError) and exc.kind in FATAL_KINDS:
                # Key 不对或余额不足：后面的章节只会全部失败，直接停下
                raise
            failure_streak += 1
            if failure_streak >= MAX_FAILURE_STREAK:
                raise AppError(
                    f"连续 {failure_streak} 章没有写成，已停止。最近一次的原因：{message}",
                    status_code=502,
                ) from exc
            return

        failure_streak = 0
        apply_result(record, result, target, source="ai", note="重新生成前的版本")
        store.save_chapter(project.id, record)
        chapters[uid] = record
        if record.digest is not None:
            digests[uid] = record.digest
        ctx.live_clear(uid)
        ctx.emit("chapter_done", uid=uid, chapter=chapter_view(record))
        ctx.advance(done=1, chars=record.chars)

    async def run_group(group: Sequence[LeafInfo]) -> None:
        # 同一父节点下的章节顺序写：后写的能看到前面兄弟章节写了什么
        for leaf in group:
            async with semaphore:
                await write_one(leaf)

    normal = [leaf for leaf in targets if not leaf.is_response_chapter]
    response = [leaf for leaf in targets if leaf.is_response_chapter]
    await gather_cancellable([run_group(group) for group in leaf_groups(normal)])
    # 响应表型章节放到最后：它们要引用“哪条评分项由哪一章支撑”
    for leaf in response:
        async with semaphore:
            await write_one(leaf)

    ctx.stage("review", "正在做本地审校")
    try:
        report = build_local_report(store, project.id)
        ctx.emit("review_ready", stats=report.stats.model_dump())
    except Exception:  # noqa: BLE001 - 审校失败不影响已经写好的正文
        logger.exception("写作结束后的本地审校失败")


# ---------------------------------------------------------------------------
# 修订
# ---------------------------------------------------------------------------


async def run_revise_job(ctx: JobContext, store: ProjectStore, llm_factory: LLMFactory) -> None:
    """按使用者的修改要求（或审校问题给出的修改指令）修订一章。"""
    uid = str(ctx.params.get("uid") or "")
    instruction = str(ctx.params.get("instruction") or "").strip()
    if not instruction:
        raise AppError("请填写修改要求", status_code=400)

    project = store.load_project(ctx.project_id)
    blueprint = store.load_blueprint(project.id)
    chapters = store.load_chapters(project.id)
    wctx = build_writing_context(
        project,
        blueprint,
        tender_text=store.load_tender_text(project.id),
        materials=store.load_materials(project.id),
    )
    leaf = wctx.leaf_by_uid.get(uid)
    if leaf is None:
        raise AppError("章节不存在", status_code=404)
    record = chapters.get(uid)
    if record is None or count_chars(record.content) == 0:
        raise AppError("这一章还没有正文，无法修订", status_code=400)

    llm = llm_factory(project.settings.model_name)
    digests = {
        other_uid: other.digest
        for other_uid, other in chapters.items()
        if other.digest is not None and other.status == "done" and other_uid != uid
    }
    ctx.stage("revise", f"正在修订 {leaf.id} {leaf.title}")
    ctx.set_progress(0, 1)
    live = _make_live(ctx, uid)
    ctx.live_update(uid, "")
    ctx.emit("chapter_start", uid=uid, id=leaf.id, title=leaf.title, target_words=wctx.budget.get(uid), revise=True)
    try:
        result = await revise_chapter(
            llm,
            wctx,
            leaf,
            content=record.content,
            instruction=instruction,
            siblings=sibling_digests(wctx, leaf, digests),
            live=live,
            on_call=_call_hook(ctx),
        )
    except asyncio.CancelledError:
        ctx.live_clear(uid)
        ctx.emit("chapter_stopped", uid=uid, chapter=chapter_view(record))
        raise
    except AppError as exc:
        message = _error_message(exc)
        record.error = f"修订没有成功，已保留原来的正文。原因：{message}"
        record.error_kind = "revise"
        store.save_chapter(project.id, record, touch=False)
        ctx.live_clear(uid)
        ctx.emit("chapter_failed", uid=uid, error=message, chapter=chapter_view(record))
        ctx.advance(failed=1)
        raise

    apply_result(record, result, wctx.budget.get(uid), source="revised", note=f"修订前的版本（修改要求：{instruction[:60]}）")
    store.save_chapter(project.id, record)
    ctx.live_clear(uid)
    ctx.emit("chapter_done", uid=uid, chapter=chapter_view(record))
    ctx.advance(done=1, chars=record.chars)

    if store.load_review(project.id) is not None:
        ctx.stage("review", "正在重新检查")
        try:
            report = build_local_report(store, project.id)
            ctx.emit("review_ready", stats=report.stats.model_dump())
        except Exception:  # noqa: BLE001 - 审校失败不影响修订结果
            logger.exception("修订结束后的本地审校失败")


# ---------------------------------------------------------------------------
# 深度审校
# ---------------------------------------------------------------------------


async def run_deep_review_job(ctx: JobContext, store: ProjectStore, llm_factory: LLMFactory) -> None:
    """本地审校 + 模型参与的前后一致性检查。"""
    project = store.load_project(ctx.project_id)
    previous = store.load_review(project.id)
    # 以开始检查的时刻为准：检查期间手动改过的章节，之后会被正确判为“检查之后又改过”
    started = now_iso()
    ctx.stage("local", "正在做本地审校")
    # 先不保存：中途取消或出错时，上一次的审校结果（含一致性问题）原样保留
    report = build_local_report(store, project.id, carry_consistency=False, save=False)

    ctx.stage("consistency", "正在检查前后一致性")
    blueprint = store.load_blueprint(project.id)
    wctx = build_writing_context(project, blueprint)
    llm = llm_factory(project.settings.model_name)
    issues, warnings, checked, batches = await check_consistency(
        llm,
        wctx.leaves,
        store.load_chapters(project.id),
        blueprint.fact_sheet if blueprint is not None else None,
        on_batch=ctx.set_progress,
    )
    report.issues = sort_issues(list(report.issues) + issues)
    report.warnings = list(report.warnings) + warnings
    report.deep = checked > 0
    report.generated_at = started
    # 页面据此给出结束提示：一致性检查没做成、或者有批次没检查完时，不能说成“已完成”
    ctx.set_result(deep=report.deep, batches=batches, failed_batches=batches - checked)
    report.stats.issue_count = len(report.issues)
    if previous is not None:
        current_ids = {issue.id for issue in report.issues}
        report.dismissed = [issue_id for issue_id in previous.dismissed if issue_id in current_ids]
    store.save_review(project.id, report)
    ctx.emit("review_ready", stats=report.stats.model_dump())
