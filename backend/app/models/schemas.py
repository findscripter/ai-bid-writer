"""数据模型定义"""

from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class ConfigRequest(BaseModel):
    """OpenAI配置请求"""

    model_config = {"protected_namespaces": ()}

    api_key: str = Field(..., description="OpenAI API密钥")
    base_url: Optional[str] = Field(None, description="Base URL")
    model_name: str = Field("gpt-3.5-turbo", description="模型名称")


class ConfigResponse(BaseModel):
    """配置响应"""

    success: bool
    message: str


class ModelListResponse(BaseModel):
    """模型列表响应"""

    models: List[str]
    success: bool
    message: str = ""


class FileUploadResponse(BaseModel):
    """文件上传响应"""

    success: bool
    message: str
    file_content: Optional[str] = None
    old_outline: Optional[str] = None


class AnalysisType(str, Enum):
    """分析类型"""

    OVERVIEW = "overview"
    REQUIREMENTS = "requirements"


class OutlineMode(str, Enum):
    """目录生成模式。"""

    FREE = "free"
    ALIGNED = "aligned"


class AnalysisRequest(BaseModel):
    """文档分析请求"""

    file_content: str = Field(..., description="文档内容")
    analysis_type: AnalysisType = Field(..., description="分析类型")


class OutlineItem(BaseModel):
    """目录项"""

    id: str
    title: str
    description: str
    source_requirement_id: Optional[str] = None
    source_requirement_title: Optional[str] = None
    children: Optional[List["OutlineItem"]] = None
    content: Optional[str] = None


# 解决循环引用
OutlineItem.model_rebuild()


class OutlineResponse(BaseModel):
    """目录响应"""

    outline: List[OutlineItem]


class OutlineChildrenResponse(BaseModel):
    """指定一级目录下的子目录响应。"""

    children: List[OutlineItem]


class OutlineReviewResponse(BaseModel):
    """目录审核响应。"""

    passed: bool
    suggestions: List[str] = Field(default_factory=list)


class TechnicalRequirementGroup(BaseModel):
    """技术评分大类。"""

    requirement_id: str
    title: str
    description: str
    detail_points: List[str] = Field(default_factory=list)


class TechnicalRequirementGroupResponse(BaseModel):
    """技术评分大类提取响应。"""

    groups: List[TechnicalRequirementGroup]


class OutlineRequest(BaseModel):
    """目录生成请求"""

    overview: str = Field(..., description="项目概述")
    requirements: str = Field(..., description="技术评分要求")
    mode: OutlineMode = Field(OutlineMode.FREE, description="目录生成模式")
    uploaded_expand: Optional[bool] = Field(False, description="是否已上传方案扩写文件")
    old_outline: Optional[str] = Field(
        None, description="上传的方案扩写文件解析出的旧目录JSON"
    )
    old_document: Optional[str] = Field(
        None, description="上传的方案扩写文件解析出的旧文档"
    )


class ContentGenerationRequest(BaseModel):
    """内容生成请求"""

    outline: Dict[str, Any] = Field(..., description="目录结构")
    project_overview: str = Field("", description="项目概述")


class ChapterContentRequest(BaseModel):
    """单章节内容生成请求"""

    chapter: Dict[str, Any] = Field(..., description="章节信息")
    parent_chapters: Optional[List[Dict[str, Any]]] = Field(
        None, description="上级章节列表"
    )
    sibling_chapters: Optional[List[Dict[str, Any]]] = Field(
        None, description="同级章节列表"
    )
    project_overview: str = Field("", description="项目概述")
    target_words: Optional[int] = Field(
        None, description="本章节目标字数（不含标题）", ge=50, le=20000
    )
    persona: Optional[str] = Field(
        None, description="风格 persona 说明（注入 system prompt）"
    )
    prior_summaries: Optional[List[Dict[str, str]]] = Field(
        None,
        description="之前已生成的本章节其他份次摘要，用于跨份去重；元素形如 {copy_index, summary}",
    )


class Persona(BaseModel):
    """风格预设。"""

    id: str = Field(..., description="预设 ID")
    name: str = Field(..., description="显示名称")
    description: str = Field(..., description="风格说明，会拼接进 system prompt")


class PersonaListResponse(BaseModel):
    """风格预设列表响应。"""

    personas: List[Persona]


class MultiCopyContentRequest(BaseModel):
    """多份正文生成请求。"""

    outline: Dict[str, Any] = Field(..., description="目录结构（含叶子章节）")
    project_overview: str = Field("", description="项目概述")
    target_pages: int = Field(
        50,
        description="目标总页数（A4/小四/1.5 倍行距经验值约 750 字/页）",
        ge=1,
        le=500,
    )
    extended_target_pages: Optional[int] = Field(
        None,
        description="扩展份目标页数：如果设置，则最后 1 份用此页数（长版/完整版），其余份仍用 target_pages（短版）",
        ge=1,
        le=500,
    )
    words_per_page: int = Field(
        750, description="字数每页换算系数", ge=300, le=2000
    )
    copies: int = Field(1, description="生成份数", ge=1, le=5)
    personas: Optional[List[Persona]] = Field(
        None,
        description="每份对应的 persona（长度应等于 copies）；为空时使用内置默认轮转",
    )
    inject_response_chapters: bool = Field(
        True,
        description="是否在目录末尾自动追加'强制响应章节'（采购公告/评审/合同/采购人要求/资格响应）",
    )
    parallel_concurrency: int = Field(
        3,
        description="同份内普通章节并行生成的最大并发数（响应章节始终串行）。受 LLM 服务并发限制约束，建议 2-3。",
        ge=1,
        le=10,
    )
    models: Optional[List[str]] = Field(
        None,
        description="每份使用的模型ID列表，按份轮转（不足份数时循环）；为空则全部用全局配置的模型",
    )


class ErrorResponse(BaseModel):
    """错误响应"""

    error: str
    detail: Optional[str] = None


class WordExportOutlineItem(BaseModel):
    """Word 导出用目录项。"""

    id: str
    title: str
    description: Optional[str] = None
    children: Optional[List["WordExportOutlineItem"]] = None
    content: Optional[str] = None
    image_b64: Optional[str] = Field(
        None, description="该章节配图 PNG 的 base64（导出时解码插入正文后）"
    )
    image_title: Optional[str] = Field(None, description="配图标题（图注）")


WordExportOutlineItem.model_rebuild()


class WordExportRequest(BaseModel):
    """Word导出请求"""

    project_name: Optional[str] = Field(None, description="项目名称")
    project_overview: Optional[str] = Field(None, description="项目概述")
    outline: List[WordExportOutlineItem] = Field(..., description="目录结构，包含内容")
    copy_index: Optional[int] = Field(None, description="份次索引（用于差异化元数据和排版）")
    persona_name: Optional[str] = Field(None, description="persona 名称（写入文档属性）")
    with_diagrams: bool = Field(
        False,
        description="为 True 时，导出前由 LLM 为合适的叶子章节自动生成技术插图并嵌入",
    )
    diagram_model: Optional[str] = Field(
        None,
        description="专门用于生成插图的模型ID（留空则用全局配置模型）；插图对模型能力较敏感，建议用较强模型",
    )
    include_toc: bool = Field(
        False,
        description="为 True 时在正文前插入「目录」标题和 TOC 域（在 Word 里更新域即可生成目录）；仅对单份导出（copy_index 为空）生效",
    )
