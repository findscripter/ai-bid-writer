"""文档处理相关 API 路由。"""

import logging

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from ..models.schemas import AnalysisRequest, FileUploadResponse, WordExportRequest, WordExportOutlineItem
from ..services.file_service import FileService
from ..services.analysis_service import AnalysisService
from ..services.word_export_service import WordExportService
from ..utils.errors import AppError
from ..utils.sse import sse_chunk, sse_done, sse_error, sse_response

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/document", tags=["文档处理"])


def _find_empty_leaves(items: list[WordExportOutlineItem]) -> list[str]:
    """返回所有"叶子章节正文为空"的章节 id 列表。"""
    missing: list[str] = []

    def walk(node: WordExportOutlineItem) -> None:
        children = node.children or []
        if not children:
            text = (node.content or "").strip()
            if not text:
                missing.append(node.id)
            return
        for c in children:
            walk(c)

    for item in items:
        walk(item)
    return missing


@router.post("/upload", response_model=FileUploadResponse)
async def upload_file(file: UploadFile = File(...)):
    """上传文档文件并提取文本内容。"""
    try:
        if not FileService.is_supported_document(file.content_type):
            return FileUploadResponse(
                success=False, message="不支持的文件类型，请上传PDF或Word文档"
            )

        file_content = await FileService.process_uploaded_file(file)
        return FileUploadResponse(
            success=True,
            message=f"文件 {file.filename} 上传成功",
            file_content=file_content,
        )
    except Exception as exc:
        logger.exception("文件上传失败")
        return FileUploadResponse(success=False, message=f"文件处理失败: {exc}")


@router.post("/analyze-stream")
async def analyze_document_stream(request: AnalysisRequest):
    """流式分析文档内容。"""
    try:
        analysis_service = AnalysisService()
    except AppError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc

    async def generate():
        try:
            async for chunk in analysis_service.stream_document_analysis(
                file_content=request.file_content,
                analysis_type=request.analysis_type.value,
            ):
                yield sse_chunk(chunk)
        except AppError as exc:
            yield sse_error(exc.message)
        except Exception:
            logger.exception("文档分析失败")
            yield sse_error("文档分析失败，请稍后重试")
        finally:
            yield sse_done()

    return sse_response(generate())


@router.post("/export-word")
async def export_word(request: WordExportRequest):
    """根据目录数据导出 Word 文档。"""
    try:
        empty_leaf_ids = _find_empty_leaves(request.outline)
        if empty_leaf_ids:
            raise HTTPException(
                status_code=400,
                detail=(
                    "导出已阻止：存在未生成正文的叶子章节。"
                    f"请先补全后再导出。缺失章节: {', '.join(empty_leaf_ids[:20])}"
                    + (" ..." if len(empty_leaf_ids) > 20 else "")
                ),
            )

        if request.with_diagrams:
            try:
                from ..services.diagram_service import attach_diagrams_to_outline
                from ..utils.openai_util import OpenAIUtil

                diagram_ai = (
                    OpenAIUtil(model_name=request.diagram_model)
                    if request.diagram_model
                    else None
                )
                n = await attach_diagrams_to_outline(
                    request.outline,
                    project_overview=request.project_overview or "",
                    ai=diagram_ai,
                )
                logger.info("导出配图：成功生成 %s 张插图", n)
            except Exception:
                # 配图失败不应阻断导出
                logger.exception("自动配图失败，将导出无图版本")

        buffer, headers = WordExportService.export_outline(
            request,
            copy_index=request.copy_index,
            persona_name=request.persona_name,
        )
        return StreamingResponse(
            buffer,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            headers=headers,
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("导出 Word 失败")
        raise HTTPException(status_code=500, detail=f"导出Word失败: {exc}") from exc
