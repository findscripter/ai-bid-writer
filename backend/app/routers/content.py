"""内容相关 API 路由。"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from ..models.schemas import (
    ChapterContentRequest,
    MultiCopyContentRequest,
    Persona,
    PersonaListResponse,
)
from ..services.content_service import ContentService
from ..utils.errors import AppError
from ..utils.personas import list_personas
from ..utils.sse import sse_data, sse_done, sse_error, sse_response

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/content", tags=["内容管理"])


@router.get("/personas", response_model=PersonaListResponse)
async def get_personas() -> PersonaListResponse:
    """返回内置 persona 预设列表。"""
    items = [Persona(**p) for p in list_personas()]
    return PersonaListResponse(personas=items)


@router.post("/generate-chapter")
async def generate_chapter_content(request: ChapterContentRequest):
    """为单个章节生成完整内容。"""
    try:
        content_service = ContentService()
        content = await content_service.generate_chapter_content(
            chapter=request.chapter,
            parent_chapters=request.parent_chapters,
            sibling_chapters=request.sibling_chapters,
            project_overview=request.project_overview,
            target_words=request.target_words,
            persona=request.persona,
            prior_summaries=request.prior_summaries,
        )
        return {"success": True, "content": content}
    except AppError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
    except Exception as exc:
        logger.exception("章节内容生成失败")
        raise HTTPException(status_code=500, detail=f"章节内容生成失败: {exc}") from exc


@router.post("/generate-chapter-stream")
async def generate_chapter_content_stream(request: ChapterContentRequest):
    """流式生成单章节内容。"""
    try:
        content_service = ContentService()
    except AppError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc

    async def generate():
        try:
            async for chunk in content_service.stream_chapter_content(
                chapter=request.chapter,
                parent_chapters=request.parent_chapters,
                sibling_chapters=request.sibling_chapters,
                project_overview=request.project_overview,
                target_words=request.target_words,
                persona=request.persona,
                prior_summaries=request.prior_summaries,
            ):
                yield sse_data({"chunk": chunk})
        except AppError as exc:
            yield sse_error(exc.message)
        except Exception:
            logger.exception("章节内容流式生成失败")
            yield sse_error("章节内容生成失败，请稍后重试")
        finally:
            yield sse_done()

    return sse_response(generate())


@router.post("/generate-multi-copies")
async def generate_multi_copies(request: MultiCopyContentRequest):
    """一次任务生成多份不雷同的标书正文（SSE 流）。

    事件类型：meta / copy_start / chapter_start / chapter_chunk /
    chapter_end / copy_end / all_done / 以及统一错误格式。
    """
    try:
        content_service = ContentService()
    except AppError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc

    personas_payload = (
        [p.model_dump() for p in request.personas] if request.personas else None
    )

    async def generate():
        try:
            async for event in content_service.stream_multi_copies(
                outline=request.outline,
                project_overview=request.project_overview,
                target_pages=request.target_pages,
                words_per_page=request.words_per_page,
                copies=request.copies,
                personas=personas_payload,
                extended_target_pages=request.extended_target_pages,
                inject_response_chapters=request.inject_response_chapters,
                parallel_concurrency=request.parallel_concurrency,
                models=request.models,
            ):
                yield sse_data(event)
        except AppError as exc:
            yield sse_error(exc.message)
        except Exception:
            logger.exception("多份正文生成失败")
            yield sse_error("多份正文生成失败，请稍后重试")
        finally:
            yield sse_done()

    return sse_response(generate())
