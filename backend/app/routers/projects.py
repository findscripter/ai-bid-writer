"""项目工作台 API：项目、招标文件、目录、写作蓝图、正文、后台任务、审校、导出。"""
from __future__ import annotations

import asyncio
import json
import logging
import time

import httpx
from typing import Any, Dict, List, Optional
from urllib.parse import quote

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from ..config import settings
from ..core.jobs import BUSY_CODE, INTERRUPTED_MESSAGE, job_manager, store
from ..core.llm import create_llm, demo_enabled
from ..models.schemas import OutlineMode, WordExportOutlineItem, WordExportRequest
from ..services.expand_service import ExpandService
from ..services.file_service import FileService
from ..services.outline_service import OutlineService
from ..services.word_export_service import WordExportService
from ..utils.config_manager import config_manager
from ..utils.errors import AppError, LLMError
from ..utils.openai_util import OpenAIUtil
from ..utils.personas import list_personas
from ..utils.response_chapters import append_response_chapters
from ..utils.sse import sse_chunk, sse_data, sse_done, sse_error, sse_progress, sse_response, sse_result
from ..writing.cleaner import strip_think
from ..writing.digest import build_digest
from ..writing.models import (
    Blueprint,
    ChapterPlan,
    ChapterRecord,
    ChapterVersion,
    FactSheet,
    Material,
    MaterialMeta,
    ProjectSettings,
    ReviewReport,
    TenderMeta,
)
from ..writing.outline_tree import (
    collect_leaves,
    inherit_uids,
    iter_nodes,
    leaf_set_fingerprint,
    normalize_outline,
    outline_fingerprint,
)
from ..writing.pipeline import (
    chapter_view,
    run_deep_review_job,
    run_plan_job,
    run_revise_job,
    run_write_job,
)
from ..writing.requirements import parse_requirements
from ..writing.reviewer import build_local_report
from ..writing.tender_analysis import stream_tender_analysis_events
from ..writing.textutil import count_chars, new_id, now_iso
from ..writing.writer import compute_budget

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["项目工作台"])

JOB_RUNNERS = {
    "plan": run_plan_job,
    "write": run_write_job,
    "revise": run_revise_job,
    "review": run_deep_review_job,
}


def _http(exc: AppError) -> HTTPException:
    message = exc.friendly if isinstance(exc, LLMError) else exc.message
    headers = {"X-Error-Code": exc.code} if exc.code else None
    return HTTPException(status_code=exc.status_code, detail=message, headers=headers)


# ---------------------------------------------------------------------------
# 请求体
# ---------------------------------------------------------------------------


class ProjectCreate(BaseModel):
    name: str = ""


class ProjectPatch(BaseModel):
    name: Optional[str] = None
    overview: Optional[str] = None
    requirements: Optional[str] = None
    company_profile: Optional[str] = None
    settings: Optional[ProjectSettings] = None


class AnalyzeBody(BaseModel):
    analysis_type: str = Field("overview", description="overview / requirements")


class OutlineGenerateBody(BaseModel):
    mode: OutlineMode = OutlineMode.FREE
    material_id: Optional[str] = Field(None, description="参考这份资料（旧方案）的目录来生成")


class OutlineBody(BaseModel):
    outline: List[Dict[str, Any]]


class BlueprintPatch(BaseModel):
    fact_sheet: Optional[FactSheet] = None
    plans: Optional[Dict[str, ChapterPlan]] = None
    notes: Optional[Dict[str, str]] = Field(
        None,
        description="只改这几章的“补充要求”（uid → 文本），其余字段保持服务端现有的值，不会被页面上的旧计划覆盖",
    )


class ChapterBody(BaseModel):
    content: str = ""
    base_updated_at: Optional[str] = Field(
        None,
        description="开始编辑时这一章的 updated_at；与当前不一致说明期间被别处改过，返回 409。不传则直接覆盖。",
    )


class RestoreBody(BaseModel):
    index: int = Field(0, ge=0)
    saved_at: Optional[str] = Field(
        None, description="要恢复的那个版本的 saved_at；用来确认历史版本列表在此期间没有变化"
    )


class JobBody(BaseModel):
    kind: str
    params: Dict[str, Any] = Field(default_factory=dict)


class DismissBody(BaseModel):
    issue_id: str
    dismissed: bool = True


class ExportBody(BaseModel):
    model_config = {"protected_namespaces": ()}

    with_diagrams: bool = False
    diagram_model: Optional[str] = None
    include_toc: bool = False
    include_overview: bool = False
    allow_incomplete: bool = False


class SettingsBody(BaseModel):
    model_config = {"protected_namespaces": ()}

    api_key: Optional[str] = Field(None, description="留空表示不修改已保存的密钥")
    base_url: str = ""
    model_name: str = ""


class SettingsProbe(BaseModel):
    model_config = {"protected_namespaces": ()}

    api_key: Optional[str] = None
    base_url: Optional[str] = None
    model_name: Optional[str] = None


# ---------------------------------------------------------------------------
# 应用信息与全局设置
# ---------------------------------------------------------------------------


def _key_hint(api_key: str) -> str:
    if not api_key:
        return ""
    if len(api_key) < 12:
        return "已设置"
    return f"{api_key[:3]}…{api_key[-4:]}"


def _settings_view() -> Dict[str, Any]:
    config = config_manager.load_config()
    api_key = str(config.get("api_key") or "")
    return {
        "api_key_set": bool(api_key),
        "api_key_hint": _key_hint(api_key),
        "base_url": str(config.get("base_url") or ""),
        "model_name": str(config.get("model_name") or ""),
        "demo": demo_enabled(),
    }


@router.get("/meta")
async def get_meta() -> Dict[str, Any]:
    return {
        "app_name": settings.app_name,
        "version": settings.app_version,
        "demo": demo_enabled(),
        "personas": list_personas(),
        "max_file_size": settings.max_file_size,
    }


@router.get("/settings")
async def get_settings() -> Dict[str, Any]:
    """读取模型服务设置。密钥本身不会返回，只给出是否已设置和首尾几位。"""
    return _settings_view()


@router.put("/settings")
async def put_settings(body: SettingsBody) -> Dict[str, Any]:
    config = config_manager.load_config()
    api_key = (body.api_key or "").strip() or str(config.get("api_key") or "")
    saved = config_manager.save_config(
        api_key=api_key,
        base_url=body.base_url.strip(),
        model_name=body.model_name.strip() or str(config.get("model_name") or "gpt-3.5-turbo"),
    )
    if not saved:
        raise HTTPException(status_code=500, detail="设置保存失败，请检查用户目录是否可写")
    return _settings_view()


def _probe_client(body: SettingsProbe) -> OpenAIUtil:
    config = config_manager.load_config()
    client = OpenAIUtil.from_values(
        api_key=(body.api_key or "").strip() or str(config.get("api_key") or ""),
        base_url=body.base_url if body.base_url is not None else str(config.get("base_url") or ""),
        model_name=(body.model_name or "").strip() or str(config.get("model_name") or ""),
    )
    client.client = client.client.with_options(timeout=httpx.Timeout(45.0, connect=10.0), max_retries=0)
    return client


@router.post("/settings/models")
async def list_models(body: SettingsProbe) -> Dict[str, Any]:
    """列出服务商提供的模型（用表单里填的值，不保存）。"""
    if demo_enabled():
        return {"models": ["demo-model"]}
    try:
        return {"models": await _probe_client(body).list_all_models()}
    except AppError as exc:
        raise _http(exc) from exc


@router.post("/settings/test")
async def test_settings(body: SettingsProbe) -> Dict[str, Any]:
    """用表单里填的值发一次最小的请求，确认密钥、地址和模型可用。"""
    if demo_enabled():
        return {"ok": True, "message": "演示模式：不需要连接模型服务", "latency_ms": 0}
    try:
        client = _probe_client(body)
        started = time.monotonic()
        reply = await client.collect_chat_completion(
            [{"role": "user", "content": "这是一次连通性测试，请只回复“好”。"}], temperature=0
        )
        latency = int((time.monotonic() - started) * 1000)
    except AppError as exc:
        message = exc.friendly if isinstance(exc, LLMError) else exc.message
        return {"ok": False, "message": message, "latency_ms": 0}
    return {"ok": True, "message": f"连接正常，模型 {client.model_name} 已应答：{reply.strip()[:20]}", "latency_ms": latency}


# ---------------------------------------------------------------------------
# 项目
# ---------------------------------------------------------------------------


def _review_outline_changed(review: Optional[ReviewReport], outline: List[Dict[str, Any]], leaf_count: int) -> bool:
    """审校之后增删过章节：结果里的统计、问题、覆盖情况可能已经对不上（只调整顺序不算）。"""
    if review is None:
        return False
    if review.outline_fingerprint:
        return review.outline_fingerprint != leaf_set_fingerprint(outline)
    return review.stats.leaf_total != leaf_count


def _load_state_files(project_id: str) -> Dict[str, Any]:
    # 快照时刻在读文件之前取（同一进程内严格递增）：页面据此判断两份整份状态谁更新，
    # 晚到的旧响应不会把新的计划、审校结果换回去
    state_at = now_iso()
    project = store.load_project(project_id)
    blueprint = store.load_blueprint(project_id)
    chapters = store.load_chapters(project_id)
    review = store.load_review(project_id)
    leaves = collect_leaves(project.outline)
    budget, note = compute_budget(project, blueprint)
    return {
        "state_at": state_at,
        "project": project.model_dump(),
        "leaves": [leaf.model_dump() for leaf in leaves],
        "chapters": {leaf.uid: chapter_view(chapters[leaf.uid]) for leaf in leaves if leaf.uid in chapters},
        "budget": budget,
        "budget_note": note,
        "blueprint": blueprint.model_dump() if blueprint is not None else None,
        # 有章节还没有写作计划（只调整顺序、删掉章节都不算）
        "blueprint_stale": bool(blueprint is not None and any(leaf.uid not in blueprint.plans for leaf in leaves)),
        "review": review.model_dump() if review is not None else None,
        "review_outline_changed": _review_outline_changed(review, project.outline, len(leaves)),
        "materials": [
            MaterialMeta(**material.model_dump(exclude={"text", "outline_json"})).model_dump()
            for material in store.load_materials(project_id)
        ],
        "requirements": [item.model_dump() for item in parse_requirements(project.requirements)],
    }


def _job_snapshot(project_id: str) -> Optional[Dict[str, Any]]:
    """当前或最近一次任务的快照；内存里没有时（例如服务重启过）退回到磁盘上的最后一条记录。"""
    job = job_manager.active_job(project_id) or job_manager.latest_job(project_id)
    if job is not None:
        return job.snapshot()
    try:
        records = store.load_jobs(project_id, limit=1)
    except AppError:
        return None
    if not records:
        return None
    record = records[0]
    if record.status in ("pending", "running"):
        # 记录还停在“运行中”，但内存里已经没有这个任务：它在上次服务关闭时中断了
        record.status = "interrupted"
        record.error = record.error or INTERRUPTED_MESSAGE
    return {"job": record.model_dump(), "last_seq": 0, "live": {}, "queued": []}


async def _project_state(project_id: str) -> Dict[str, Any]:
    # 先取任务快照、再读文件：快照之后发生的变化都会通过事件补发，不会漏
    snapshot = _job_snapshot(project_id)
    state = await asyncio.to_thread(_load_state_files, project_id)
    state["job"] = snapshot
    return state


@router.get("/projects")
async def list_projects() -> Dict[str, Any]:
    summaries = await asyncio.to_thread(store.list_projects)
    active = {s.id for s in summaries if job_manager.active_job(s.id) is not None}
    return {"projects": [{**s.model_dump(), "busy": s.id in active} for s in summaries]}


@router.post("/projects")
async def create_project(body: ProjectCreate) -> Dict[str, Any]:
    project = store.create_project(body.name)
    return await _project_state(project.id)


@router.post("/projects/import")
async def import_project(archive: Dict[str, Any]) -> Dict[str, Any]:
    try:
        project = await asyncio.to_thread(store.import_archive, archive)
    except AppError as exc:
        raise _http(exc) from exc
    return await _project_state(project.id)


@router.get("/projects/{project_id}")
async def get_project(project_id: str) -> Dict[str, Any]:
    try:
        return await _project_state(project_id)
    except AppError as exc:
        raise _http(exc) from exc


@router.patch("/projects/{project_id}")
async def patch_project(project_id: str, body: ProjectPatch) -> Dict[str, Any]:
    try:
        project = store.load_project(project_id)
        if body.name is not None:
            project.name = body.name.strip() or project.name
        if body.overview is not None:
            project.overview = body.overview
        if body.requirements is not None:
            project.requirements = body.requirements
        if body.company_profile is not None:
            project.company_profile = body.company_profile
        if body.settings is not None:
            project.settings = body.settings
        store.save_project(project)
        return await _project_state(project_id)
    except AppError as exc:
        raise _http(exc) from exc


@router.delete("/projects/{project_id}")
async def delete_project(project_id: str) -> Dict[str, Any]:
    try:
        active = job_manager.active_job(project_id)
        if active is not None:
            await job_manager.cancel(active.record.id)
        store.delete_project(project_id)
        job_manager.forget(project_id)
    except AppError as exc:
        raise _http(exc) from exc
    return {"success": True}


@router.get("/projects/{project_id}/archive")
async def export_project_archive(project_id: str) -> JSONResponse:
    """把整个项目导出成一个 JSON 文件（备份，或拿到另一台电脑上导入）。"""
    try:
        archive = await asyncio.to_thread(store.export_archive, project_id)
    except AppError as exc:
        raise _http(exc) from exc
    filename = quote(f"{archive['project'].get('name') or '项目'}.aibid.json")
    return JSONResponse(archive, headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"})


# ---------------------------------------------------------------------------
# 招标文件与参考资料
# ---------------------------------------------------------------------------


def _ensure_tender_replaceable(project_id: str) -> None:
    """项目被占着（任务在跑、正在解析或生成目录）时不能换招标文件：它们用的还是原来那份。"""
    reason = job_manager.busy_reason(project_id)
    if reason:
        raise AppError(f"{reason}，请等它结束后再更换招标文件", status_code=409, code=BUSY_CODE)


@router.post("/projects/{project_id}/tender")
async def upload_tender(project_id: str, file: UploadFile = File(...)) -> Dict[str, Any]:
    try:
        store.load_project(project_id)
        _ensure_tender_replaceable(project_id)
        document = await FileService.extract_document(file)
        if not document.text.strip():
            raise AppError(
                document.warnings[0] if document.warnings else "没有从文件中提取到任何文字。", status_code=400
            )
        # 读文件要一会儿，期间别处可能开始了解析或任务：保存前再确认一次
        _ensure_tender_replaceable(project_id)
        # 解析要等一会儿，期间项目可能被改过（企业资料、名称）甚至被删了：以现在的为准
        project = store.load_project(project_id)
        store.save_tender_text(project_id, document.text)
        project.tender = TenderMeta(
            filename=document.filename,
            char_count=count_chars(document.text),
            uploaded_at=now_iso(),
            warning="".join(document.warnings),
        )
        if project.name in ("", "未命名项目") and document.filename:
            project.name = document.filename.rsplit(".", 1)[0][:60] or project.name
        store.save_project(project)
        return await _project_state(project_id)
    except AppError as exc:
        raise _http(exc) from exc


@router.get("/projects/{project_id}/tender")
async def get_tender_text(project_id: str) -> Dict[str, Any]:
    try:
        store.load_project(project_id)
        return {"text": store.load_tender_text(project_id)}
    except AppError as exc:
        raise _http(exc) from exc


@router.post("/projects/{project_id}/analyze")
async def analyze_tender(project_id: str, body: AnalyzeBody):
    """解析招标文件（流式）。结束后把结果存进项目。"""
    if body.analysis_type not in ("overview", "requirements"):
        raise HTTPException(status_code=400, detail="analysis_type 只能是 overview 或 requirements")
    try:
        project = store.load_project(project_id)
        text = store.load_tender_text(project_id)
        if not text.strip():
            raise AppError("请先上传招标文件", status_code=400)
        reason = job_manager.busy_reason(project_id)
        if reason:
            raise AppError(f"{reason}，请等它结束后再解析", status_code=409, code=BUSY_CODE)
        llm = create_llm(project.settings.model_name)
    except AppError as exc:
        raise _http(exc) from exc

    async def generate():
        # 解析期间占住项目：别的页面开始写作、生成目录都会被拒绝，避免它们用上即将被替换的解析结果
        try:
            job_manager.reserve(project_id, "解析招标文件")
        except AppError as exc:
            yield sse_error(exc.message, code=exc.code)
            yield sse_done()
            return
        parts: List[str] = []
        try:
            async for kind, value in stream_tender_analysis_events(llm, text, body.analysis_type):
                if job_manager.closing:
                    yield sse_error("服务正在关闭，这次解析没有完成，结果没有保存")
                    return
                if kind == "progress":
                    yield sse_progress(value)
                elif kind == "warning":
                    # 结果可能不完整之类的提示：页面在解析结束后仍然保留
                    yield sse_data({"type": "warning", "message": value})
                else:
                    parts.append(value)
                    yield sse_chunk(value)
            # 推理模型可能把思考过程放在正文里，存进项目前去掉
            result = strip_think("".join(parts)).replace("\\n", "\n").strip()
            if not result:
                yield sse_error("模型没有返回内容，请重试")
            else:
                fresh = store.load_project(project_id)
                if body.analysis_type == "overview":
                    fresh.overview = result
                else:
                    fresh.requirements = result
                store.save_project(fresh)
                yield sse_data({"type": "result", "text": result})
        except AppError as exc:
            yield sse_error(exc.friendly if isinstance(exc, LLMError) else exc.message)
        except Exception:  # noqa: BLE001
            logger.exception("招标文件解析失败")
            yield sse_error("招标文件解析失败，请稍后重试")
        finally:
            job_manager.release(project_id)
            yield sse_done()

    return sse_response(generate())


@router.post("/projects/{project_id}/materials")
async def upload_material(project_id: str, file: UploadFile = File(...)) -> Dict[str, Any]:
    """上传参考资料（旧方案、企业介绍等）：写作时按章节检索引用。"""
    try:
        store.load_project(project_id)
        document = await FileService.extract_document(file)
        if not document.text.strip():
            raise AppError(
                document.warnings[0] if document.warnings else "没有从文件中提取到任何文字。", status_code=400
            )
        material = Material(
            id=new_id(6),
            name=document.filename,
            char_count=count_chars(document.text),
            uploaded_at=now_iso(),
            warning="".join(document.warnings),
            text=document.text,
        )
        store.save_material(project_id, material)
        return await _project_state(project_id)
    except AppError as exc:
        raise _http(exc) from exc


@router.delete("/projects/{project_id}/materials/{material_id}")
async def delete_material(project_id: str, material_id: str) -> Dict[str, Any]:
    try:
        store.load_project(project_id)
        if not store.delete_material(project_id, material_id):
            raise AppError("资料不存在", status_code=404)
        return await _project_state(project_id)
    except AppError as exc:
        raise _http(exc) from exc


# ---------------------------------------------------------------------------
# 目录
# ---------------------------------------------------------------------------


@router.post("/projects/{project_id}/outline/generate")
async def generate_outline(project_id: str, body: OutlineGenerateBody):
    """生成目录（流式进度）。结束后把目录存进项目；标题路径相同的章节沿用原来的标识。"""
    try:
        project = store.load_project(project_id)
        if not project.overview.strip() or not project.requirements.strip():
            raise AppError("请先完成招标文件解析（项目概述与技术评分要求）", status_code=400)
        reason = job_manager.busy_reason(project_id)
        if reason:
            raise AppError(f"{reason}，请等它结束后再生成目录", status_code=409, code=BUSY_CODE)
        material = store.load_material(project_id, body.material_id) if body.material_id else None
        if body.material_id and material is None:
            raise AppError("参考资料不存在", status_code=404)
        llm = create_llm(project.settings.model_name)
    except AppError as exc:
        raise _http(exc) from exc

    async def generate():
        try:
            job_manager.reserve(project_id, "生成目录")
        except AppError as exc:
            yield sse_error(exc.message, code=exc.code)
            yield sse_done()
            return
        queue: "asyncio.Queue[Optional[str]]" = asyncio.Queue()
        client_disconnected = False

        async def progress_callback(message: str) -> None:
            await queue.put(sse_progress(message))

        async def run_workflow() -> None:
            try:
                old_outline: Optional[str] = None
                if material is not None:
                    if not material.outline_json:
                        await progress_callback(f"正在从《{material.name}》提取原有目录。")
                        extracted = await ExpandService(ai=llm).generate_expand_outline(material.text)
                        material.outline_json = json.dumps(extracted, ensure_ascii=False)
                        store.save_material(project_id, material)
                    old_outline = material.outline_json
                result = await OutlineService(ai=llm).generate_outline(
                    overview=project.overview,
                    requirements=project.requirements,
                    mode=body.mode,
                    uploaded_expand=old_outline is not None,
                    old_outline=old_outline,
                    progress_callback=progress_callback,
                )
                fresh = store.load_project(project_id)
                fresh.outline = inherit_uids(result.get("outline") or [], fresh.outline)
                fresh.outline_mode = body.mode.value
                store.save_project(fresh)
                await queue.put(sse_result({"outline": fresh.outline}))
            except AppError as exc:
                await queue.put(sse_error(exc.friendly if isinstance(exc, LLMError) else exc.message))
            except Exception:  # noqa: BLE001
                logger.exception("目录生成失败")
                await queue.put(sse_error("目录生成失败，请稍后重试"))
            finally:
                await queue.put(None)

        task = asyncio.create_task(run_workflow())
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=0.5)
                except asyncio.TimeoutError:
                    if job_manager.closing:
                        yield sse_error("服务正在关闭，目录没有生成完，原来的目录保持不变")
                        break
                    continue
                if event is None:
                    break
                yield event
        except asyncio.CancelledError:
            client_disconnected = True
            raise
        finally:
            if not task.done():
                task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            finally:
                job_manager.release(project_id)
                if not client_disconnected:
                    yield sse_done()

    return sse_response(generate())


@router.put("/projects/{project_id}/outline")
async def put_outline(project_id: str, body: OutlineBody) -> Dict[str, Any]:
    try:
        reason = job_manager.busy_reason(project_id)
        if reason:
            raise AppError(f"{reason}，请等它结束后再修改目录", status_code=409, code=BUSY_CODE)
        project = store.load_project(project_id)
        project.outline = normalize_outline(body.outline)
        store.save_project(project)
        return await _project_state(project_id)
    except AppError as exc:
        raise _http(exc) from exc


@router.post("/projects/{project_id}/outline/response-chapters")
async def add_response_chapters(project_id: str) -> Dict[str, Any]:
    """在目录末尾追加“响应表型章节”（采购公告 / 评审办法 / 合同 / 采购人要求 / 资格响应）。"""
    try:
        reason = job_manager.busy_reason(project_id)
        if reason:
            raise AppError(f"{reason}，请等它结束后再修改目录", status_code=409, code=BUSY_CODE)
        project = store.load_project(project_id)
        if not project.outline:
            raise AppError("请先生成目录", status_code=400)
        if any(node.get("is_response_chapter") for node, _ in iter_nodes(project.outline)):
            raise AppError("目录里已经有响应表型章节了", status_code=400)
        project.outline = normalize_outline(append_response_chapters(project.outline))
        store.save_project(project)
        return await _project_state(project_id)
    except AppError as exc:
        raise _http(exc) from exc


# ---------------------------------------------------------------------------
# 写作蓝图
# ---------------------------------------------------------------------------


@router.put("/projects/{project_id}/blueprint")
async def put_blueprint(project_id: str, body: BlueprintPatch) -> Dict[str, Any]:
    """保存使用者对统一口径、章节计划的手动修改。"""
    try:
        _ensure_not_planning(project_id)
        project = store.load_project(project_id)
        blueprint = store.load_blueprint(project_id) or Blueprint(
            generated_at=now_iso(), outline_fingerprint=outline_fingerprint(project.outline)
        )
        if body.fact_sheet is not None:
            blueprint.fact_sheet = body.fact_sheet
        if body.plans is not None:
            leaf_uids = {leaf.uid for leaf in collect_leaves(project.outline)}
            valid_ids = {item.id for item in parse_requirements(project.requirements)}
            for uid, plan in body.plans.items():
                if uid not in leaf_uids:
                    continue
                plan.uid = uid
                plan.requirement_ids = [rid for rid in plan.requirement_ids if not valid_ids or rid in valid_ids]
                plan.auto_assigned = [rid for rid in plan.auto_assigned if rid in plan.requirement_ids]
                plan.weight = min(max(plan.weight, 0.2), 5.0)
                blueprint.plans[uid] = plan
            owned = {rid for plan in blueprint.plans.values() for rid in plan.requirement_ids}
            blueprint.unassigned_requirements = [rid for rid in sorted(valid_ids) if rid not in owned]
        if body.notes:
            for uid, note in body.notes.items():
                plan = blueprint.plans.get(uid)
                if plan is None:
                    raise AppError("这一章还没有写作计划，请先到写作计划页补全", status_code=400)
                plan.note = note.strip()
        store.save_blueprint(project_id, blueprint)
        return await _project_state(project_id)
    except AppError as exc:
        raise _http(exc) from exc


@router.delete("/projects/{project_id}/blueprint")
async def delete_blueprint(project_id: str) -> Dict[str, Any]:
    try:
        _ensure_not_planning(project_id)
        store.load_project(project_id)
        store.delete_blueprint(project_id)
        return await _project_state(project_id)
    except AppError as exc:
        raise _http(exc) from exc


# ---------------------------------------------------------------------------
# 章节正文
# ---------------------------------------------------------------------------


def _leaf_or_404(project_id: str, uid: str):
    project = store.load_project(project_id)
    for leaf in collect_leaves(project.outline):
        if leaf.uid == uid:
            return leaf
    raise AppError("章节不存在", status_code=404)


def _ensure_not_planning(project_id: str) -> None:
    job = job_manager.active_job(project_id)
    if job is not None and job.record.kind == "plan":
        raise AppError("写作计划正在生成，结束后再修改（生成的结果会覆盖现在的修改）", status_code=409, code=BUSY_CODE)


def _ensure_not_writing(project_id: str, uid: str) -> None:
    job = job_manager.active_job(project_id)
    if job is not None and uid in job.live:
        raise AppError("这一章正在生成，请等它结束或先取消任务", status_code=409, code="chapter_busy")


@router.get("/projects/{project_id}/chapters/{uid}")
async def get_chapter(project_id: str, uid: str) -> Dict[str, Any]:
    """读取一章的完整记录（含历史版本）。"""
    try:
        _leaf_or_404(project_id, uid)
        record = store.load_chapter(project_id, uid) or ChapterRecord(uid=uid)
        return record.model_dump()
    except AppError as exc:
        raise _http(exc) from exc


@router.put("/projects/{project_id}/chapters/{uid}")
async def put_chapter(project_id: str, uid: str, body: ChapterBody) -> Dict[str, Any]:
    """保存手动编辑的正文；原来的内容进历史版本。"""
    try:
        _leaf_or_404(project_id, uid)
        _ensure_not_writing(project_id, uid)
        record = store.load_chapter(project_id, uid) or ChapterRecord(uid=uid)
        if body.base_updated_at is not None and (record.updated_at or "") != body.base_updated_at:
            raise AppError(
                "这一章在你编辑期间被更新过（可能是重新生成或修订）。直接保存会覆盖新的内容。",
                status_code=409,
                code="chapter_changed",
            )
        content = body.content.replace("\r\n", "\n").strip()
        if record.content.strip() and record.content.strip() != content:
            record.versions.insert(
                0,
                ChapterVersion(
                    content=record.content,
                    saved_at=record.updated_at or now_iso(),
                    source=record.source,
                    note="手动编辑前的版本",
                ),
            )
        record.content = content
        record.chars = count_chars(content)
        record.status = "done" if record.chars > 0 else "empty"
        record.source = "manual"
        record.error = None
        record.error_kind = None
        record.truncated = False
        record.section_titles = [line[4:].strip() for line in content.split("\n") if line.startswith("### ")]
        record.digest = build_digest(content, record.section_titles) if record.chars > 0 else None
        store.save_chapter(project_id, record)
        return chapter_view(record)
    except AppError as exc:
        raise _http(exc) from exc


@router.post("/projects/{project_id}/chapters/{uid}/restore")
async def restore_chapter_version(project_id: str, uid: str, body: RestoreBody) -> Dict[str, Any]:
    """恢复某个历史版本；当前内容换进历史版本里。"""
    try:
        _leaf_or_404(project_id, uid)
        _ensure_not_writing(project_id, uid)
        record = store.load_chapter(project_id, uid)
        if record is None or body.index >= len(record.versions):
            raise AppError("历史版本不存在", status_code=404)
        if body.saved_at is not None and record.versions[body.index].saved_at != body.saved_at:
            raise AppError("历史版本已经变化了，请重新打开历史版本后再选。", status_code=409, code="versions_changed")
        chosen = record.versions.pop(body.index)
        if record.content.strip():
            record.versions.insert(
                0,
                ChapterVersion(
                    content=record.content,
                    saved_at=record.updated_at or now_iso(),
                    source=record.source,
                    note="恢复历史版本前的内容",
                ),
            )
        record.content = chosen.content
        record.chars = count_chars(chosen.content)
        record.status = "done" if record.chars > 0 else "empty"
        record.source = chosen.source
        record.error = None
        record.error_kind = None
        record.truncated = False
        record.section_titles = [line[4:].strip() for line in chosen.content.split("\n") if line.startswith("### ")]
        record.digest = build_digest(chosen.content, record.section_titles) if record.chars > 0 else None
        store.save_chapter(project_id, record)
        return record.model_dump()
    except AppError as exc:
        raise _http(exc) from exc


# ---------------------------------------------------------------------------
# 后台任务
# ---------------------------------------------------------------------------


@router.post("/projects/{project_id}/jobs")
async def start_job(project_id: str, body: JobBody) -> Dict[str, Any]:
    runner = JOB_RUNNERS.get(body.kind)
    if runner is None:
        raise HTTPException(status_code=400, detail="未知的任务类型")
    try:
        project = store.load_project(project_id)
        if not collect_leaves(project.outline):
            raise AppError("请先生成目录", status_code=400)
        # 先确认模型可用（没配 Key 时立刻报错，而不是等任务启动后才失败）
        create_llm(project.settings.model_name)
        job = job_manager.start(
            project_id,
            body.kind,
            body.params,
            lambda ctx: runner(ctx, store, create_llm),
        )
        return job.snapshot()
    except AppError as exc:
        raise _http(exc) from exc


@router.get("/projects/{project_id}/jobs/current")
async def current_job(project_id: str) -> Dict[str, Any]:
    return {"job": _job_snapshot(project_id)}


@router.post("/projects/{project_id}/jobs/{job_id}/cancel")
async def cancel_job(project_id: str, job_id: str) -> Dict[str, Any]:
    job = job_manager.get(job_id)
    if job is None or job.record.project_id != project_id:
        raise HTTPException(status_code=404, detail="任务不存在")
    await job_manager.cancel(job_id)
    return job.snapshot()


@router.get("/projects/{project_id}/jobs/{job_id}/events")
async def job_events(project_id: str, job_id: str, request: Request, after: int = 0):
    """任务事件流（SSE）。断线重连时浏览器会带上 Last-Event-ID，从那之后补发。"""
    job = job_manager.get(job_id)
    if job is None or job.record.project_id != project_id:
        raise HTTPException(status_code=404, detail="任务不存在")
    last_event_id = request.headers.get("last-event-id", "")
    if last_event_id.isdigit():
        after = max(after, int(last_event_id))

    async def generate():
        async for seq, event in job_manager.subscribe(job_id, after_seq=after):
            if event is None:
                yield ": ping\n\n"
            else:
                yield f"id: {seq}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"

    return sse_response(generate(), extra_headers={"X-Accel-Buffering": "no"})


# ---------------------------------------------------------------------------
# 审校
# ---------------------------------------------------------------------------


@router.post("/projects/{project_id}/review/run")
async def run_review(project_id: str) -> Dict[str, Any]:
    """跑一遍本地审校（不调用模型）。"""
    try:
        store.load_project(project_id)
        report = await asyncio.to_thread(build_local_report, store, project_id)
        return _review_payload(project_id, report)
    except AppError as exc:
        raise _http(exc) from exc


@router.post("/projects/{project_id}/review/dismiss")
async def dismiss_issue(project_id: str, body: DismissBody) -> Dict[str, Any]:
    try:
        store.load_project(project_id)
        report = store.load_review(project_id)
        if report is None:
            raise AppError("还没有审校结果", status_code=404)
        dismissed = [issue_id for issue_id in report.dismissed if issue_id != body.issue_id]
        if body.dismissed and any(issue.id == body.issue_id for issue in report.issues):
            dismissed.append(body.issue_id)
        report.dismissed = dismissed
        store.save_review(project_id, report)
        return _review_payload(project_id, report)
    except AppError as exc:
        raise _http(exc) from exc


def _review_payload(project_id: str, report: ReviewReport) -> Dict[str, Any]:
    """审校结果 + 它与当前目录是否对不上（outline_changed）。"""
    project = store.load_project(project_id)
    payload = report.model_dump()
    payload["outline_changed"] = _review_outline_changed(report, project.outline, len(collect_leaves(project.outline)))
    payload["state_at"] = now_iso()
    return payload


# ---------------------------------------------------------------------------
# 导出
# ---------------------------------------------------------------------------


def _export_items(nodes: List[Dict[str, Any]], chapters: Dict[str, ChapterRecord]) -> List[WordExportOutlineItem]:
    items: List[WordExportOutlineItem] = []
    for node in nodes:
        children = node.get("children") or []
        record = chapters.get(str(node.get("uid") or ""))
        items.append(
            WordExportOutlineItem(
                id=str(node.get("id") or ""),
                title=str(node.get("title") or ""),
                description=node.get("description") or None,
                children=_export_items(children, chapters) if children else None,
                content=(record.content if (record is not None and not children) else None),
            )
        )
    return items


@router.post("/projects/{project_id}/export")
async def export_word(project_id: str, body: ExportBody):
    """把项目导出成 Word。有章节没写完时默认拦截，allow_incomplete=True 可以强行导出。"""
    try:
        project = store.load_project(project_id)
        chapters = store.load_chapters(project_id)
        leaves = collect_leaves(project.outline)
        if not leaves:
            raise AppError("请先生成目录", status_code=400)
        missing = [leaf for leaf in leaves if count_chars(getattr(chapters.get(leaf.uid), "content", "")) == 0]
        if missing and not body.allow_incomplete:
            listed = "、".join(f"{leaf.id} {leaf.title}" for leaf in missing[:12])
            more = f" 等 {len(missing)} 章" if len(missing) > 12 else ""
            raise AppError(f"还有章节没有正文：{listed}{more}。请先补全，或选择“仍然导出”。", status_code=400)

        blueprint = store.load_blueprint(project_id)
        title = (blueprint.fact_sheet.project_name if blueprint is not None else "") or project.name
        request = WordExportRequest(
            project_name=title,
            project_overview=project.overview if body.include_overview else None,
            outline=_export_items(project.outline, chapters),
            with_diagrams=body.with_diagrams,
            diagram_model=body.diagram_model,
            include_toc=body.include_toc,
        )

        diagram_count = 0
        diagram_error = ""
        if body.with_diagrams:
            try:
                from ..services.diagram_service import attach_diagrams_to_outline

                diagram_ai = create_llm(body.diagram_model or project.settings.model_name)
                failures: List[str] = []
                diagram_count = await attach_diagrams_to_outline(
                    request.outline, project_overview=project.overview, ai=diagram_ai, errors=failures
                )
                if failures:
                    diagram_error = (
                        failures[0]
                        if diagram_count == 0 and len(failures) == 1
                        else f"有 {len(failures)} 处插图没有生成成功，例如{failures[0]}"
                    )[:300]
            except Exception as exc:  # noqa: BLE001 - 配图失败不应该阻断导出
                logger.exception("自动配图失败，将导出无图版本")
                diagram_error = str(getattr(exc, "message", exc))[:200]

        buffer, headers = await asyncio.to_thread(WordExportService.export_outline, request)
        headers = dict(headers)
        headers["X-Diagram-Count"] = str(diagram_count)
        headers["X-Missing-Chapters"] = str(len(missing))
        if diagram_error:
            headers["X-Diagram-Error"] = quote(diagram_error)
        return StreamingResponse(
            buffer,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            headers=headers,
        )
    except AppError as exc:
        raise _http(exc) from exc
