"""长文本写作管线的数据模型（也是落盘格式与接口契约）。

约定：
- 目录节点有两个标识：id 是显示用的位置编号（如 "2.1.3"，目录一改就会变）；
  uid 是稳定标识，正文、写作计划、审校结果都按 uid 关联，目录调整后不会错位。
- 字数一律指非空白字符数（见 textutil.count_chars）。
- 时间戳一律是 UTC 的 ISO 8601 字符串。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# 招标要求
# ---------------------------------------------------------------------------


class RequirementItem(BaseModel):
    """从「技术评分要求」文本里解析出的一条评审项或采购人要求。"""

    id: str = Field(..., description="条目编号，如 E1 / R3")
    kind: str = Field("scoring", description="scoring=评审项，requirement=采购人要求")
    name: str = ""
    score: str = Field("", description="分值或权重（原文表述）")
    detail: str = Field("", description="评审标准，或关键约束/指标")
    keywords: List[str] = Field(default_factory=list, description="必含关键词（数字、型号、术语）")
    location: str = Field("", description="原文位置")
    suggestion: str = Field("", description="目录建议")
    raw: str = Field("", description="该条目的原始文本")


# ---------------------------------------------------------------------------
# 目录
# ---------------------------------------------------------------------------


class LeafInfo(BaseModel):
    """叶子章节的扁平视图（由 outline_tree.collect_leaves 产出）。"""

    uid: str
    id: str = Field(..., description="位置编号，如 2.1.3")
    title: str
    description: str = ""
    path_titles: List[str] = Field(default_factory=list, description="从一级章节到父章节的标题链")
    parent_uid: Optional[str] = None
    level: int = Field(1, description="层级，一级章节为 1")
    is_response_chapter: bool = False


# ---------------------------------------------------------------------------
# 写作蓝图
# ---------------------------------------------------------------------------


class FactItem(BaseModel):
    """事实表里的一条：招标文件给定的约束，或方案层面的统一设定。"""

    key: str
    value: str
    source: str = Field("tender", description="tender=招标文件 / design=方案设定 / company=企业资料")


class TermItem(BaseModel):
    """统一术语。"""

    term: str
    definition: str = ""


class FactSheet(BaseModel):
    """全书统一口径：所有章节都以它为准，避免前后矛盾。"""

    project_name: str = ""
    purchaser: str = ""
    facts: List[FactItem] = Field(default_factory=list, description="招标文件给定的硬约束：工期、地点、数量、指标等")
    decisions: List[FactItem] = Field(default_factory=list, description="方案级设定：总体架构、关键选型、阶段划分等")
    terminology: List[TermItem] = Field(default_factory=list)
    placeholders: List[str] = Field(default_factory=list, description="需要投标人自行补充的企业信息")


class ChapterPlan(BaseModel):
    """单个叶子章节的写作计划。"""

    uid: str
    key_points: List[str] = Field(default_factory=list, description="本章必须写到的要点")
    requirement_ids: List[str] = Field(default_factory=list, description="本章负责响应的评审项/采购人要求编号")
    auto_assigned: List[str] = Field(default_factory=list, description="由本地算法补分配进来的要求编号")
    avoid: List[str] = Field(default_factory=list, description="边界：不在本章展开的内容（及其所在章节）")
    weight: float = Field(1.0, description="篇幅权重，1 为平均")
    form: str = Field("paragraph", description="呈现形式：paragraph / table / steps / mixed")
    note: str = Field("", description="使用者给本章追加的写作要求")


class Blueprint(BaseModel):
    """写作蓝图 = 事实表 + 各章写作计划。"""

    version: int = 1
    generated_at: str = ""
    model: str = ""
    fact_sheet: FactSheet = Field(default_factory=FactSheet)
    plans: Dict[str, ChapterPlan] = Field(default_factory=dict, description="uid → 章节计划")
    unassigned_requirements: List[str] = Field(default_factory=list, description="没有任何章节负责的要求编号")
    warnings: List[str] = Field(default_factory=list, description="规划过程中的降级与提示")
    outline_fingerprint: str = Field("", description="规划时叶子章节 uid 的指纹，用来判断蓝图是否已过期")


# ---------------------------------------------------------------------------
# 项目
# ---------------------------------------------------------------------------


class ProjectSettings(BaseModel):
    """项目级写作设置。"""

    model_config = {"protected_namespaces": ()}

    target_pages: int = Field(40, ge=1, le=500, description="目标页数")
    words_per_page: int = Field(750, ge=300, le=2000, description="每页字数换算系数")
    concurrency: int = Field(3, ge=1, le=10, description="同时进行的模型请求数上限")
    section_threshold: int = Field(1800, ge=600, le=8000, description="单章目标字数超过该值时分小节写作")
    use_tender_excerpts: bool = Field(True, description="写作时是否附带招标原文中的相关片段")
    persona_id: Optional[str] = Field(None, description="写作风格预设 ID")
    model_name: Optional[str] = Field(None, description="本项目使用的模型（留空用全局配置）")
    temperature: float = Field(0.7, ge=0, le=2)
    style_notes: str = Field("", description="使用者自定义的全局写作要求")


class TenderMeta(BaseModel):
    """招标文件的元信息（全文单独存放）。"""

    filename: str = ""
    char_count: int = 0
    uploaded_at: str = ""
    warning: str = Field("", description="解析时的提示，例如疑似扫描件")


class Material(BaseModel):
    """投标人提供的参考资料（旧方案、企业介绍等），写作时按章节检索引用。"""

    id: str
    name: str = ""
    kind: str = Field("reference", description="reference=可改写复用的素材")
    char_count: int = 0
    uploaded_at: str = ""
    warning: str = ""
    text: str = ""
    outline_json: str = Field("", description="从这份资料里提取出的目录（参考旧方案生成目录时缓存）")


class MaterialMeta(BaseModel):
    """参考资料的元信息（不含全文）。"""

    id: str
    name: str = ""
    kind: str = "reference"
    char_count: int = 0
    uploaded_at: str = ""
    warning: str = ""


class Project(BaseModel):
    """一个投标项目的工作区。"""

    schema_version: int = 1
    id: str
    name: str = "未命名项目"
    created_at: str = ""
    updated_at: str = ""
    tender: TenderMeta = Field(default_factory=TenderMeta)
    overview: str = Field("", description="项目概述（解析结果，可手改）")
    requirements: str = Field("", description="技术评分要求（解析结果，可手改）")
    outline: List[Dict[str, Any]] = Field(default_factory=list, description="目录树；节点字段见 outline_tree")
    outline_mode: str = Field("free", description="最近一次生成目录所用的模式")
    company_profile: str = Field("", description="企业资料：唯一可引用的企业侧事实来源")
    settings: ProjectSettings = Field(default_factory=ProjectSettings)


class ProjectSummary(BaseModel):
    """项目列表里的一行。"""

    id: str
    name: str
    created_at: str = ""
    updated_at: str = ""
    tender_filename: str = ""
    leaf_total: int = 0
    leaf_done: int = 0
    leaf_truncated: int = Field(0, description="写完的章节里，结尾因输出上限被截断、可能不完整的章数")
    total_chars: int = 0
    has_blueprint: bool = False
    has_analysis: bool = Field(False, description="项目概述与技术评分要求是否都已经有了")


# ---------------------------------------------------------------------------
# 章节正文
# ---------------------------------------------------------------------------


class ChapterDigest(BaseModel):
    """章节写完后的摘记：给后续章节做上下文，也给审校用。"""

    summary: str = ""
    claims: List[str] = Field(default_factory=list, description="本章出现的含具体数字/期限/指标的句子")


class ChapterVersion(BaseModel):
    """章节的历史版本。"""

    content: str
    saved_at: str = ""
    source: str = Field("ai", description="ai / manual / revised")
    note: str = ""


class ChapterRecord(BaseModel):
    """一个叶子章节的正文与状态。"""

    uid: str
    status: str = Field("empty", description="empty / writing / done / failed / cancelled")
    content: str = ""
    chars: int = 0
    target_words: Optional[int] = None
    source: str = Field("ai", description="ai / manual / revised")
    error: Optional[str] = None
    truncated: bool = Field(False, description="是否因输出上限被截断且未能续完")
    error_kind: Optional[str] = Field(
        None,
        description="error 的类型：write（撰写没写成）/ rewrite（重新生成没成功，保留了原正文）/ revise（修订没成功，保留了原正文）",
    )
    section_titles: List[str] = Field(default_factory=list, description="分节写作时的小节标题")
    digest: Optional[ChapterDigest] = None
    updated_at: str = ""
    versions: List[ChapterVersion] = Field(default_factory=list, description="历史版本，新的在前，最多保留 5 个")


# ---------------------------------------------------------------------------
# 审校
# ---------------------------------------------------------------------------


class ReviewIssue(BaseModel):
    """审校发现的一个问题。"""

    id: str
    type: str = Field(
        ...,
        description="empty / failed / partial / length / duplicate / repeat / boilerplate / markup / coverage / consistency",
    )
    severity: str = Field("medium", description="high / medium / low")
    chapter_uids: List[str] = Field(default_factory=list)
    title: str
    detail: str = ""
    suggestion: str = ""
    excerpt: str = Field("", description="相关的原文片段")
    fixable: bool = Field(False, description="是否支持一键修订")
    fix_instruction: str = Field("", description="一键修订时交给模型的修改指令")


class CoverageItem(BaseModel):
    """一条评审项/采购人要求的响应情况。"""

    requirement_id: str
    name: str = ""
    kind: str = "scoring"
    status: str = Field("unassigned", description="covered / partial / missing / unassigned")
    chapter_uids: List[str] = Field(default_factory=list)
    missing_keywords: List[str] = Field(default_factory=list)
    note: str = ""


class PlaceholderItem(BaseModel):
    """正文里的一处「待补充」占位。"""

    chapter_uid: str
    text: str
    context: str = ""


class ReviewStats(BaseModel):
    leaf_total: int = 0
    done: int = 0
    failed: int = 0
    empty: int = 0
    total_chars: int = 0
    target_chars: int = 0
    placeholder_count: int = 0
    issue_count: int = 0


class ReviewReport(BaseModel):
    """一次审校的完整结果。"""

    generated_at: str = ""
    deep: bool = Field(False, description="是否包含模型参与的深度审校")
    stats: ReviewStats = Field(default_factory=ReviewStats)
    issues: List[ReviewIssue] = Field(default_factory=list)
    coverage: List[CoverageItem] = Field(default_factory=list)
    placeholders: List[PlaceholderItem] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)
    dismissed: List[str] = Field(default_factory=list, description="使用者标记为“已处理/忽略”的问题 id")
    outline_fingerprint: str = Field("", description="检查时叶子章节集合的指纹，用来判断结果是否因目录变化而过时")


# ---------------------------------------------------------------------------
# 后台任务
# ---------------------------------------------------------------------------


class JobProgress(BaseModel):
    total: int = 0
    done: int = 0
    failed: int = 0
    chars: int = 0


class JobRecord(BaseModel):
    """一个后台任务（规划 / 写作 / 修订 / 深度审校）。"""

    id: str
    project_id: str
    kind: str = Field(..., description="plan / write / revise / review")
    status: str = Field("pending", description="pending / running / done / failed / cancelled / interrupted")
    stage: str = ""
    message: str = ""
    params: Dict[str, Any] = Field(default_factory=dict)
    progress: JobProgress = Field(default_factory=JobProgress)
    error: Optional[str] = None
    created_at: str = ""
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    usage: Dict[str, int] = Field(default_factory=dict, description="累计的调用次数与 token 用量")
    result: Dict[str, Any] = Field(default_factory=dict, description="任务的结果摘要，例如深度审校是否真的核对了一致性")
