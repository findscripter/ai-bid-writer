"""Word 导出服务。"""
from __future__ import annotations

import base64
import binascii
import io
import logging
import random
import re
from datetime import datetime, timedelta
from urllib.parse import quote

import docx
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Cm, Inches, Pt, RGBColor

logger = logging.getLogger(__name__)

from ..models.schemas import WordExportOutlineItem, WordExportRequest

_BLACK = RGBColor(0x00, 0x00, 0x00)

# ---------------------------------------------------------------------------
# 反雷同：字体/字号/间距/页边距的候选池
# ---------------------------------------------------------------------------

_BODY_FONT_CANDIDATES = ["宋体", "仿宋", "楷体_GB2312", "楷体"]
_HEADING_FONT_CANDIDATES = ["黑体", "微软雅黑", "宋体"]

_BODY_SIZE_CANDIDATES = [Pt(10.5), Pt(11), Pt(12)]      # 五号 / 小五 / 小四
_H1_SIZE_CANDIDATES = [Pt(15), Pt(16), Pt(17)]
_H2_SIZE_CANDIDATES = [Pt(13), Pt(14), Pt(14.5)]
_H3_SIZE_CANDIDATES = [Pt(12), Pt(12.5), Pt(13)]

_LINE_SPACING_CANDIDATES = [1.25, 1.35, 1.5, 1.15]

_MARGIN_LEFT_CM = [2.4, 2.8, 3.0, 3.17]
_MARGIN_RIGHT_CM = [2.0, 2.4, 2.54, 2.8]
_MARGIN_TOP_CM = [2.4, 2.54, 3.0]
_MARGIN_BOTTOM_CM = [2.0, 2.4, 2.54]

_FAKE_AUTHORS = [
    "张伟", "李强", "王敏", "刘洋", "陈静",
    "赵磊", "黄辉", "周杰", "吴涛", "孙芳",
    "朱建华", "马骏", "郑宇", "何军", "徐凯",
]
_FAKE_COMPANIES = [
    "技术研发部", "项目管理部", "方案中心", "投标事业部",
    "系统集成部", "解决方案部", "工程技术中心",
]


class _CopyProfile:
    """为单份文档随机选定一组排版参数，确保每份都有微差异。"""

    def __init__(self, copy_index: int | None = None, seed: int | None = None):
        rng = random.Random(seed or random.randint(0, 2**32))

        self.body_font = rng.choice(_BODY_FONT_CANDIDATES)
        self.heading_font = rng.choice(_HEADING_FONT_CANDIDATES)
        self.body_size = rng.choice(_BODY_SIZE_CANDIDATES)
        self.h1_size = rng.choice(_H1_SIZE_CANDIDATES)
        self.h2_size = rng.choice(_H2_SIZE_CANDIDATES)
        self.h3_size = rng.choice(_H3_SIZE_CANDIDATES)
        self.line_spacing = rng.choice(_LINE_SPACING_CANDIDATES)

        self.margin_left = Cm(rng.choice(_MARGIN_LEFT_CM))
        self.margin_right = Cm(rng.choice(_MARGIN_RIGHT_CM))
        self.margin_top = Cm(rng.choice(_MARGIN_TOP_CM))
        self.margin_bottom = Cm(rng.choice(_MARGIN_BOTTOM_CM))

        self.space_after_body = Pt(rng.choice([4, 6, 8]))
        self.space_after_heading = Pt(rng.choice([8, 10, 12]))

        self.author = rng.choice(_FAKE_AUTHORS)
        self.company = rng.choice(_FAKE_COMPANIES)
        self.revision = rng.randint(3, 25)

        base = datetime.now() - timedelta(days=rng.randint(1, 14))
        self.created = base - timedelta(hours=rng.randint(0, 72))
        self.modified = base - timedelta(minutes=rng.randint(0, 300))


def _set_run_font(run: docx.text.run.Run, font_name: str) -> None:
    run.font.name = font_name
    rpr = run._element.rPr
    if rpr is not None and rpr.rFonts is not None:
        rpr.rFonts.set(qn("w:eastAsia"), font_name)
    # 强制黑色字体（任何主题色/自动色都会被覆盖）
    run.font.color.rgb = _BLACK


def _set_paragraph_font(paragraph: docx.text.paragraph.Paragraph, font_name: str) -> None:
    for run in paragraph.runs:
        _set_run_font(run, font_name)


class WordExportService:
    """负责将目录数据导出为 Word 文档。"""

    @staticmethod
    def export_outline(
        request: WordExportRequest,
        copy_index: int | None = None,
        persona_name: str | None = None,
    ) -> tuple[io.BytesIO, dict[str, str]]:
        profile = _CopyProfile(copy_index=copy_index)
        doc = docx.Document()

        WordExportService._apply_metadata(doc, profile, persona_name)
        WordExportService._apply_page_setup(doc, profile)
        WordExportService._init_document_styles(doc, profile)
        WordExportService._add_document_intro(
            doc, request.project_name, request.project_overview, profile
        )
        WordExportService._add_outline_items(doc, request.outline, profile=profile)

        buffer = io.BytesIO()
        doc.save(buffer)
        buffer.seek(0)

        filename = f"{request.project_name or '标书文档'}.docx"
        headers = {
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
        }
        return buffer, headers

    @staticmethod
    def _apply_metadata(
        doc: docx.Document, profile: _CopyProfile, persona_name: str | None
    ) -> None:
        props = doc.core_properties
        props.author = profile.author
        props.last_modified_by = profile.author
        props.created = profile.created
        props.modified = profile.modified
        props.revision = profile.revision
        props.category = persona_name or ""
        props.comments = ""
        props.keywords = ""
        try:
            props.content_status = ""
        except Exception:
            pass

    @staticmethod
    def _apply_page_setup(doc: docx.Document, profile: _CopyProfile) -> None:
        for section in doc.sections:
            section.left_margin = profile.margin_left
            section.right_margin = profile.margin_right
            section.top_margin = profile.margin_top
            section.bottom_margin = profile.margin_bottom

    @staticmethod
    def _init_document_styles(doc: docx.Document, profile: _CopyProfile) -> None:
        try:
            styles = doc.styles

            if "Normal" in styles:
                style = styles["Normal"]
                style.font.name = profile.body_font
                style.font.size = profile.body_size
                style.font.color.rgb = _BLACK
                if style._element.rPr is None:
                    style._element._add_rPr()
                style._element.rPr.rFonts.set(qn("w:eastAsia"), profile.body_font)
                style.font.bold = False
                style.paragraph_format.line_spacing = profile.line_spacing

            size_map = {
                "Heading 1": profile.h1_size,
                "Heading 2": profile.h2_size,
                "Heading 3": profile.h3_size,
            }
            for style_name, size in size_map.items():
                if style_name not in styles:
                    continue
                style = styles[style_name]
                style.font.name = profile.heading_font
                style.font.size = size
                style.font.color.rgb = _BLACK
                if style._element.rPr is None:
                    style._element._add_rPr()
                style._element.rPr.rFonts.set(qn("w:eastAsia"), profile.heading_font)

            if "Title" in styles:
                ts = styles["Title"]
                ts.font.name = profile.heading_font
                ts.font.color.rgb = _BLACK
                if ts._element.rPr is None:
                    ts._element._add_rPr()
                ts._element.rPr.rFonts.set(qn("w:eastAsia"), profile.heading_font)
        except Exception:
            pass

    @staticmethod
    def _add_document_intro(
        doc: docx.Document,
        project_name: str | None,
        project_overview: str | None,
        profile: _CopyProfile,
    ) -> None:
        title_paragraph = doc.add_paragraph()
        title_run = title_paragraph.add_run(project_name or "投标技术文件")
        title_run.bold = True
        title_run.font.size = profile.h1_size
        _set_run_font(title_run, profile.heading_font)
        title_paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER

        if project_overview:
            heading = doc.add_heading("项目概述", level=1)
            heading.alignment = WD_ALIGN_PARAGRAPH.LEFT
            _set_paragraph_font(heading, profile.heading_font)
            overview_paragraph = doc.add_paragraph(project_overview)
            _set_paragraph_font(overview_paragraph, profile.body_font)
            overview_paragraph.paragraph_format.space_after = profile.space_after_body

    @staticmethod
    def _add_markdown_runs(para: docx.text.paragraph.Paragraph, text: str, font_name: str) -> None:
        pattern = r"(\*\*.*?\*\*|\*.*?\*|`.*?`)"
        parts = re.split(pattern, text)
        for part in parts:
            if not part:
                continue
            run = para.add_run()
            if part.startswith("**") and part.endswith("**") and len(part) > 4:
                run.text = part[2:-2]
                run.bold = True
            elif part.startswith("*") and part.endswith("*") and len(part) > 2:
                run.text = part[1:-1]
                run.italic = True
            elif part.startswith("`") and part.endswith("`") and len(part) > 2:
                run.text = part[1:-1]
            else:
                run.text = part
            _set_run_font(run, font_name)

    @staticmethod
    def _add_markdown_paragraph(doc: docx.Document, text: str, profile: _CopyProfile) -> None:
        para = doc.add_paragraph()
        WordExportService._add_markdown_runs(para, text, profile.body_font)
        para.paragraph_format.space_after = profile.space_after_body

    @staticmethod
    def _parse_markdown_blocks(content: str) -> list[tuple]:
        blocks: list[tuple] = []
        lines = content.split("\n")
        i = 0

        while i < len(lines):
            line = lines[i].rstrip("\r").strip()
            if not line:
                i += 1
                continue

            if (
                line.startswith("- ")
                or line.startswith("* ")
                or re.match(r"^\d+\.\s", line)
            ):
                items: list[tuple] = []
                while i < len(lines):
                    raw = lines[i].rstrip("\r")
                    stripped = raw.strip()
                    if stripped.startswith("- ") or stripped.startswith("* "):
                        text = re.sub(r"^[-*]\s+", "", stripped).strip()
                        if text:
                            items.append(("unordered", None, text))
                        i += 1
                        continue
                    match_number = re.match(r"^(\d+)\.\s+(.*)$", stripped)
                    if match_number:
                        num_str, text = match_number.groups()
                        if text.strip():
                            items.append(("ordered", num_str, text.strip()))
                        i += 1
                        continue
                    break
                if items:
                    blocks.append(("list", items))
                continue

            if "|" in line:
                rows: list[str] = []
                while i < len(lines):
                    stripped = lines[i].rstrip("\r").strip()
                    if "|" not in stripped:
                        break
                    if not re.match(r"^\|?[-\s\|]+\|?$", stripped):
                        cells = [cell.strip() for cell in stripped.split("|")]
                        row_text = " | ".join([cell for cell in cells if cell])
                        if row_text:
                            rows.append(row_text)
                    i += 1
                if rows:
                    blocks.append(("table", rows))
                continue

            if line.startswith("#"):
                match_heading = re.match(r"^(#+)\s*(.*)$", line)
                if match_heading:
                    level_marks, title_text = match_heading.groups()
                    blocks.append(
                        ("heading", min(len(level_marks), 3), title_text.strip())
                    )
                i += 1
                continue

            para_lines: list[str] = []
            while i < len(lines):
                stripped = lines[i].rstrip("\r").strip()
                if (
                    stripped
                    and not stripped.startswith("-")
                    and not stripped.startswith("*")
                    and "|" not in stripped
                    and not stripped.startswith("#")
                ):
                    para_lines.append(stripped)
                    i += 1
                else:
                    break
            if para_lines:
                blocks.append(("paragraph", " ".join(para_lines)))
            else:
                i += 1

        return blocks

    @staticmethod
    def _render_markdown_blocks(doc: docx.Document, blocks: list[tuple], profile: _CopyProfile) -> None:
        for block in blocks:
            kind = block[0]
            if kind == "list":
                for item_kind, num_str, text in block[1]:
                    paragraph = doc.add_paragraph()
                    prefix = "• " if item_kind == "unordered" else f"{num_str}. "
                    run = paragraph.add_run(prefix)
                    _set_run_font(run, profile.body_font)
                    WordExportService._add_markdown_runs(paragraph, text, profile.body_font)
            elif kind == "table":
                for row in block[1]:
                    WordExportService._add_markdown_paragraph(doc, row, profile)
            elif kind == "heading":
                _, level, text = block
                heading = doc.add_heading(text, level=level)
                heading.alignment = WD_ALIGN_PARAGRAPH.LEFT
                _set_paragraph_font(heading, profile.heading_font)
            elif kind == "paragraph":
                WordExportService._add_markdown_paragraph(doc, block[1], profile)

    @staticmethod
    def _add_markdown_content(doc: docx.Document, content: str, profile: _CopyProfile) -> None:
        blocks = WordExportService._parse_markdown_blocks(content)
        WordExportService._render_markdown_blocks(doc, blocks, profile)

    @staticmethod
    def _add_outline_items(
        doc: docx.Document,
        items: list[WordExportOutlineItem],
        level: int = 1,
        profile: _CopyProfile | None = None,
    ) -> None:
        if profile is None:
            profile = _CopyProfile()

        for item in items:
            if level <= 3:
                heading = doc.add_heading(f"{item.id} {item.title}", level=level)
                heading.alignment = WD_ALIGN_PARAGRAPH.LEFT
                _set_paragraph_font(heading, profile.heading_font)
            else:
                para = doc.add_paragraph()
                run = para.add_run(f"{item.id} {item.title}")
                run.bold = True
                _set_run_font(run, profile.body_font)
                para.paragraph_format.space_before = profile.space_after_body
                para.paragraph_format.space_after = Pt(3)

            if not item.children:
                content = item.content or ""
                if content.strip():
                    WordExportService._add_markdown_content(doc, content, profile)
                WordExportService._add_chapter_image(doc, item, profile)
                continue

            WordExportService._add_outline_items(doc, item.children, level + 1, profile)

    @staticmethod
    def _add_chapter_image(
        doc: docx.Document,
        item: WordExportOutlineItem,
        profile: _CopyProfile,
    ) -> None:
        """若章节带配图（image_b64），解码并居中插入，附图注。"""
        if not getattr(item, "image_b64", None):
            return
        try:
            raw = base64.b64decode(item.image_b64, validate=True)
        except (binascii.Error, ValueError) as exc:
            logger.warning("章节 %s 配图 base64 解码失败，跳过：%s", item.id, exc)
            return
        try:
            pic_para = doc.add_paragraph()
            pic_para.alignment = WD_ALIGN_PARAGRAPH.CENTER
            run = pic_para.add_run()
            run.add_picture(io.BytesIO(raw), width=Inches(5.8))
        except Exception as exc:
            logger.warning("章节 %s 配图插入失败，跳过：%s", item.id, exc)
            return
        caption = (getattr(item, "image_title", None) or "").strip()
        if caption:
            cap_para = doc.add_paragraph()
            cap_para.alignment = WD_ALIGN_PARAGRAPH.CENTER
            cap_run = cap_para.add_run(caption)
            cap_run.italic = True
            cap_run.font.size = Pt(9)
            _set_run_font(cap_run, profile.body_font)
