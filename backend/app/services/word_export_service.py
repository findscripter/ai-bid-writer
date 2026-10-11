"""Word 导出服务。

两条路径：
- copy_index 为 None（普通单份导出）：固定的规范排版，见 _StandardDocumentBuilder；
- copy_index 不为 None（旧的多份导出）：沿用原有逻辑，见 WordExportService 中标注为旧路径的方法。
"""
from __future__ import annotations

import base64
import binascii
import html
import io
import logging
import random
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import docx
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Emu, Inches, Mm, Pt, RGBColor, Twips

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


# ---------------------------------------------------------------------------
# 规范排版（单份导出）：固定参数，不含任何随机项
# ---------------------------------------------------------------------------


class _StandardProfile:
    """单份导出使用的固定排版参数。"""

    body_font = "宋体"
    heading_font = "黑体"
    code_font = "Consolas"

    body_size = Pt(12)                              # 小四
    title_size = Pt(22)                             # 二号
    heading_sizes = (Pt(16), Pt(14), Pt(12))        # 一二三级标题：三号 / 四号 / 小四
    heading_space_before = (Pt(12), Pt(6), Pt(6))
    heading_space_after = (Pt(6), Pt(6), Pt(6))
    small_size = Pt(10.5)                           # 五号：代码、图注
    footer_size = Pt(9)                             # 小五：页码
    line_spacing = 1.5
    table_gap = Pt(6)                               # 表格与上方段落、相邻表格之间的间距

    page_width = Mm(210)                            # A4
    page_height = Mm(297)
    margin_top = Cm(2.54)
    margin_bottom = Cm(2.54)
    margin_left = Cm(3.17)
    margin_right = Cm(3.17)


_THEME_FONT_ATTRS = ("w:asciiTheme", "w:hAnsiTheme", "w:eastAsiaTheme")


def _set_style_font(style, font_name: str, size, bold: bool) -> None:
    """给样式设置中西文统一的字体。

    模板里的标题样式带主题字体属性，Word 会优先采用主题字体，必须一并去掉。
    """
    font = style.font
    font.name = font_name
    font.size = size
    font.bold = bold
    font.color.rgb = _BLACK
    rpr = style.element.rPr
    rpr.rFonts.set(qn("w:eastAsia"), font_name)
    for attr in _THEME_FONT_ATTRS:
        rpr.rFonts.attrib.pop(qn(attr), None)
    size_cs = rpr.find(qn("w:szCs"))
    if size_cs is not None:
        size_cs.set(qn("w:val"), str(int(size.pt * 2)))


def _localize_defaults(doc, font_name: str) -> None:
    """python-docx 自带模板是西文/日文环境，这里把文档级默认值改成中文环境。

    - 默认字体改成正文字体：页脚、表格等没有单独指定字体的地方不会回落到西文主题字体；
    - 东亚语言声明为中文，相邻标点按中文习惯压缩。
    """
    rpr = doc.styles.element.find(
        "/".join((qn("w:docDefaults"), qn("w:rPrDefault"), qn("w:rPr")))
    )
    if rpr is not None:
        rfonts = rpr.find(qn("w:rFonts"))
        if rfonts is not None:
            for attr in ("w:ascii", "w:hAnsi", "w:eastAsia"):
                rfonts.set(qn(attr), font_name)
            for attr in _THEME_FONT_ATTRS:
                rfonts.attrib.pop(qn(attr), None)
        lang = rpr.find(qn("w:lang"))
        if lang is not None:
            lang.set(qn("w:eastAsia"), "zh-CN")

    settings = doc.settings.element
    theme_lang = settings.find(qn("w:themeFontLang"))
    if theme_lang is not None:
        theme_lang.set(qn("w:eastAsia"), "zh-CN")
    spacing_control = settings.find(qn("w:characterSpacingControl"))
    if spacing_control is not None:
        spacing_control.set(qn("w:val"), "compressPunctuation")


# ---------------------------------------------------------------------------
# 规范排版：文本清洗
# ---------------------------------------------------------------------------

# XML 1.0 不允许出现的字符（python-docx 写入时会直接抛异常），外加没有显示意义的 C1 控制符与 BOM
_XML_ILLEGAL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ud800-\udfff\ufeff\ufffe\uffff]")
# 各种换行写法（含从 Word 粘贴带来的垂直制表符、换页符）统一成 \n
_LINE_BREAK_RE = re.compile(r"\r\n|[\r\x0b\x0c\x85\u2028\u2029]")


def _clean_text(text: object) -> str:
    """统一换行并去掉 XML 非法字符（保留制表符与换行），保证脏字符不会让导出失败。"""
    if text is None:
        return ""
    value = text if isinstance(text, str) else str(text)
    return _XML_ILLEGAL_RE.sub("", _LINE_BREAK_RE.sub("\n", value))


def _single_line(text: object) -> str:
    """标题、图注、文档属性等只占一行的文本：清洗后把连续空白折叠成一个空格。"""
    return " ".join(_clean_text(text).split())


# ---------------------------------------------------------------------------
# 规范排版：行内 Markdown 解析（加粗 / 斜体 / 行内代码 / <br>）
# ---------------------------------------------------------------------------

_BR_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)
_ENTITY_RE = re.compile(r"&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});")
_INLINE_SPECIAL_RE = re.compile(r"[*`<&\\]")
# 只还原模型为避开 Markdown 语法而加的转义；其余反斜杠（如 Windows 路径）原样保留
_ESCAPABLE = frozenset("*`|_#~")
_OPEN_PUNCT = frozenset("（([{【《〈「『“‘\"'")
_CLOSE_PUNCT = frozenset("）)]}】》〉」』”’\"'。．.！!？?…%％；;：:")
_MAX_OPENER_LOOKBACK = 64


class _InlineNode:
    """行内解析的中间节点：文本 / 行内代码 / 换行 / 一串星号。"""

    __slots__ = (
        "kind", "text", "bold", "italic",
        "count", "open1", "close1", "open2", "close2", "intraword",
    )

    def __init__(self, kind: str, text: str = ""):
        self.kind = kind            # text / code / br / delim
        self.text = text
        self.bold = 0
        self.italic = 0
        self.count = 0              # delim：还没配对掉的星号个数
        self.open1 = False          # 能否作为斜体（单星号）的起始
        self.close1 = False
        self.open2 = False          # 能否作为加粗（双星号）的起始
        self.close2 = False
        self.intraword = False      # 两侧都是西文字母或数字，如 138****1234


def _is_word_char(ch: str) -> bool:
    return bool(ch) and (ch.isalnum() or ch == "_")


def _is_ascii_alnum(ch: str) -> bool:
    return bool(ch) and ch.isascii() and ch.isalnum()


def _find_code_close(text: str, start: int, width: int) -> int:
    """从 start 起找长度恰为 width 的反引号串，返回其起始下标；找不到返回 -1。"""
    i, n = start, len(text)
    while i < n:
        if text[i] != "`":
            i += 1
            continue
        j = i
        while j < n and text[j] == "`":
            j += 1
        if j - i == width:
            return i
        i = j
    return -1


def _make_delim(text: str, start: int, end: int) -> _InlineNode:
    """为 text[start:end] 这串星号生成节点，并按两侧字符判断它能充当什么。

    加粗的判定比 CommonMark 宽松（「**注意：**正文」这类中文写法要能识别）；
    斜体的判定更严格：正文里的单个星号多半是乘号、脚注或通配符，宁可原样保留也不能吞掉。
    """
    node = _InlineNode("delim")
    node.count = end - start
    prev = text[start - 1] if start > 0 else ""
    nxt = text[end] if end < len(text) else ""
    node.open2 = bool(nxt) and not nxt.isspace()
    node.close2 = bool(prev) and not prev.isspace()
    node.open1 = (
        node.open2
        and (_is_word_char(nxt) or nxt in _OPEN_PUNCT)
        and not _is_word_char(prev)
    )
    node.close1 = (
        node.close2
        and (_is_word_char(prev) or prev in _CLOSE_PUNCT)
        and not _is_word_char(nxt)
    )
    node.intraword = _is_ascii_alnum(prev) and _is_ascii_alnum(nxt)
    return node


def _tokenize_inline(text: str) -> list[_InlineNode]:
    nodes: list[_InlineNode] = []
    buf: list[str] = []

    def flush() -> None:
        if buf:
            nodes.append(_InlineNode("text", "".join(buf)))
            buf.clear()

    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "\\" and i + 1 < n and text[i + 1] in _ESCAPABLE:
            buf.append(text[i + 1])
            i += 2
            continue
        if ch == "`":
            j = i
            while j < n and text[j] == "`":
                j += 1
            close = _find_code_close(text, j, j - i)
            if close >= 0:
                code = text[j:close]
                if len(code) >= 2 and code[0] == " " and code[-1] == " " and code.strip():
                    code = code[1:-1]
                flush()
                nodes.append(_InlineNode("code", code))
                i = close + (j - i)
            else:
                buf.append(text[i:j])  # 没有成对的反引号按普通字符处理
                i = j
            continue
        if ch == "*":
            j = i
            while j < n and text[j] == "*":
                j += 1
            flush()
            nodes.append(_make_delim(text, i, j))
            i = j
            continue
        if ch == "<":
            br = _BR_RE.match(text, i)
            if br:
                flush()
                nodes.append(_InlineNode("br"))
                i = br.end()
                continue
        elif ch == "&":
            entity = _ENTITY_RE.match(text, i)
            if entity:
                # 不认识的实体 html.unescape 会原样返回，不会丢字
                buf.append(_XML_ILLEGAL_RE.sub("", html.unescape(entity.group(0))))
                i = entity.end()
                continue
        buf.append(ch)
        i += 1
    flush()
    return nodes


def _resolve_emphasis(nodes: list[_InlineNode]) -> None:
    """给星号配对：配上的星号被消耗并给中间的节点打上加粗/斜体标记，配不上的保持字面量。"""
    openers: list[int] = []
    for index, node in enumerate(nodes):
        if node.kind != "delim":
            continue
        k = len(openers) - 1
        # 只回看最近的若干个起始标记，避免满是星号的异常输入让配对退化成平方复杂度
        floor = max(0, len(openers) - _MAX_OPENER_LOOKBACK)
        while k >= floor and node.count > 0 and (node.close1 or node.close2):
            opener = nodes[openers[k]]
            width = 2 if opener.count >= 2 and node.count >= 2 else 1
            if width == 2:
                # 两端都夹在字母数字中间的（手机号掩码、乘方）不当加粗
                matched = opener.open2 and node.close2 and not (opener.intraword and node.intraword)
            else:
                matched = opener.open1 and node.close1
            if not matched:
                k -= 1
                continue
            for inner in nodes[openers[k] + 1 : index]:
                if width == 2:
                    inner.bold += 1
                else:
                    inner.italic += 1
            opener.count -= width
            node.count -= width
            del openers[k + 1 :]  # 夹在中间没配上的星号保持字面量
            if opener.count == 0:
                openers.pop()
                k -= 1
        if node.count > 0 and (node.open1 or node.open2):
            openers.append(index)


def _parse_inline(text: str) -> list[tuple[str, str, bool, bool]]:
    """把一行文本拆成 (kind, text, bold, italic) 片段，kind 为 text / code / br。

    只有成对且位置合理的标记才会被当作格式消耗掉，其余字符一律原样保留。
    """
    if not _INLINE_SPECIAL_RE.search(text):
        return [("text", text, False, False)] if text else []
    nodes = _tokenize_inline(text)
    _resolve_emphasis(nodes)
    spans: list[tuple[str, str, bool, bool]] = []
    for node in nodes:
        kind, value = node.kind, node.text
        if kind == "delim":
            if node.count <= 0:
                continue
            kind, value = "text", "*" * node.count
        bold, italic = node.bold > 0, node.italic > 0
        if kind == "text" and spans and spans[-1][0] == "text" and spans[-1][2:] == (bold, italic):
            spans[-1] = ("text", spans[-1][1] + value, bold, italic)
        else:
            spans.append((kind, value, bold, italic))
    return spans


def _is_blank_span(span: tuple[str, str, bool, bool]) -> bool:
    return span[0] == "br" or (span[0] == "text" and not span[1].strip())


def _trim_spans(spans: list[tuple[str, str, bool, bool]]) -> list[tuple[str, str, bool, bool]]:
    """去掉首尾的换行与纯空白片段；整段都是空白时返回空列表。"""
    start, end = 0, len(spans)
    while start < end and _is_blank_span(spans[start]):
        start += 1
    while end > start and _is_blank_span(spans[end - 1]):
        end -= 1
    return spans[start:end]


# ---------------------------------------------------------------------------
# 规范排版：块级 Markdown 解析
# ---------------------------------------------------------------------------

_FENCE_RE = re.compile(r"^[ \t]*(`{3,}|~{3,})[ \t]*([^`]*)$")
# 围栏标记后面的语言名（python、c++、objective-c……）；不是这种形态的一律当正文保留
_FENCE_LANGUAGE_RE = re.compile(r"^[A-Za-z0-9_+#.\-]{0,32}$")
_HR_RE = re.compile(r"^(?:([-*_])(?:[ \t]*\1){2,}|={3,})$")
_HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?$")
# 模型常漏掉井号后的空格（##标题）；单个井号不放宽，「#1机组」这类正文不能被当成标题
_HEADING_TIGHT_RE = re.compile(r"^(#{2,6})([^#\s].*?)(?:[ \t]+#+)?$")
_LIST_RE = re.compile(r"^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(\S.*)$")
# 引用标记后必须跟空格：「>95%」这类以大于号开头的正文不是引用
_QUOTE_RE = re.compile(r"^[ \t]*>(?:[ \t]|$)")
_QUOTE_STRIP_RE = re.compile(r"^[ \t]*>[ \t]?")
_TABLE_ALIGN_CELL_RE = re.compile(r"^:?-+:?$")
_TABLE_RULE_CELL_RE = re.compile(r"^:?-{3,}:?$")
_MAX_TABLE_COLUMNS = 63  # Word 表格的列数上限，超过的按普通文本处理
_MAX_NESTING = 16        # 引用 / 围栏套娃的层数上限，再深的按普通文本处理，避免异常输入把递归撑爆


def _indent_width(whitespace: str) -> int:
    return sum(4 if ch == "\t" else 1 for ch in whitespace)


def _leading_indent(line: str) -> int:
    """行首半角空格/制表符的宽度（全角空格是中文段首缩进，不算 Markdown 缩进）。"""
    return _indent_width(line[: len(line) - len(line.lstrip(" \t"))])


def _strip_indent(line: str, width: int) -> str:
    """去掉最多 width 列行首缩进：围栏本身缩进时，围栏内的代码行相应少缩进。"""
    expanded = line.expandtabs(4).rstrip()
    body = expanded.lstrip(" ")
    return " " * max(0, len(expanded) - len(body) - width) + body


def _looks_like_prose(lines: list[str]) -> bool:
    """围栏里是不是成段的中文正文（而不是代码或字符画）：非空白字符里汉字过半。"""
    chars = [ch for line in lines for ch in line if not ch.isspace()]
    if not chars:
        return False
    return sum(1 for ch in chars if "\u4e00" <= ch <= "\u9fff") * 2 >= len(chars)


def _split_table_row(line: str) -> list[str]:
    """按未转义的竖线切分表格行，保留中间的空单元格。"""
    text = line.strip()
    cells: list[str] = []
    buf: list[str] = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "\\" and i + 1 < n and text[i + 1] == "|":
            buf.append("|")
            i += 2
            continue
        if ch == "|":
            cells.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
        i += 1
    cells.append("".join(buf))
    if text.startswith("|"):
        cells = cells[1:]
    if cells and len(text) > 1 and text.endswith("|") and not text.endswith("\\|"):
        cells = cells[:-1]
    return [cell.strip() for cell in cells]


def _parse_table_aligns(line: str) -> list[str] | None:
    """解析表格分隔行（如 |---|:---:|），返回各列对齐方式；不是分隔行时返回 None。"""
    if "-" not in line:
        return None
    aligns: list[str] = []
    for cell in _split_table_row(line):
        if not _TABLE_ALIGN_CELL_RE.match(cell):
            return None
        left, right = cell.startswith(":"), cell.endswith(":")
        aligns.append("center" if left and right else "right" if right else "left" if left else "")
    return aligns or None


def _parse_table(lines: list[str], i: int) -> tuple[tuple, int] | None:
    """从第 i 行起尝试识别标准 Markdown 表格（表头行 + 分隔行 + 数据行）。

    返回 (表格块, 下一行下标)。没有分隔行的含竖线文本不算表格，返回 None。
    """
    if "|" not in lines[i] or i + 1 >= len(lines):
        return None
    aligns = _parse_table_aligns(lines[i + 1])
    if aligns is None:
        return None
    header = _split_table_row(lines[i])
    if len(header) != len(aligns) and min(len(header), len(aligns)) < 2:
        return None
    width = len(header)
    if width > _MAX_TABLE_COLUMNS:
        return None
    aligns = (aligns + [""] * width)[:width]
    rows: list[list[str]] = []
    j = i + 2
    while j < len(lines):
        line = lines[j].strip()
        if not line or "|" not in line:
            break
        cells = _split_table_row(line)
        j += 1
        if all(_TABLE_RULE_CELL_RE.match(cell) for cell in cells):
            continue  # 模型在数据行之间多写的分隔行
        if len(cells) > width:
            # 列数以表头为准；多出来的单元格并回最后一列，不丢字
            cells = cells[: width - 1] + [" | ".join(cells[width - 1 :])]
        rows.append(cells + [""] * (width - len(cells)))
    return ("table", header, aligns, rows), j


def _starts_new_block(lines: list[str], i: int) -> bool:
    """第 i 行是否是围栏 / 引用 / 分隔线 / 标题 / 表格的开头。"""
    line = lines[i].rstrip()
    stripped = line.strip()
    return bool(
        _FENCE_RE.match(line)
        or _QUOTE_RE.match(line)
        or _HR_RE.match(stripped)
        or _HEADING_RE.match(stripped)
        or _HEADING_TIGHT_RE.match(stripped)
        or _parse_table(lines, i) is not None
    )


def _is_list_item(line: str) -> bool:
    line = line.rstrip()
    return bool(_LIST_RE.match(line)) and not _HR_RE.match(line.strip())


def _is_list_continuation(lines: list[str], i: int) -> bool:
    """第 i 行是否是列表项下面带缩进的续行。"""
    return _leading_indent(lines[i]) >= 2 and not _starts_new_block(lines, i)


def _consume_list(lines: list[str], i: int, blocks: list[tuple]) -> int:
    """从第 i 行起读取一段列表，按缩进计算嵌套层级；返回下一行下标。"""
    n = len(lines)
    indents: list[int] = []  # 当前各层列表项的缩进宽度
    level = 0
    while i < n:
        line = lines[i].rstrip()
        if not line.strip():
            j = i
            while j < n and not lines[j].strip():
                j += 1
            # 空行之后仍是列表项或缩进的续行，才算同一段列表
            if j < n and (_is_list_item(lines[j]) or _is_list_continuation(lines, j)):
                i = j
                continue
            break
        if _is_list_item(line):
            leading, marker, text = _LIST_RE.match(line).groups()
            indent = _indent_width(leading)
            while indents and indent < indents[-1]:
                indents.pop()
            if not indents or indent >= indents[-1] + 2:
                indents.append(indent)
            level = len(indents) - 1
            # 无序项的标记记为 None，有序项保留原编号
            blocks.append(("list_item", level, marker if marker[0].isdigit() else None, text.strip()))
        elif _is_list_continuation(lines, i):
            blocks.append(("list_text", level, line.strip()))
        else:
            break
        i += 1
    return i


def _consume_fence(
    lines: list[str],
    i: int,
    blocks: list[tuple],
    wraps_everything_until: int | None,
    depth: int,
) -> int:
    """处理第 i 行开始的代码围栏，返回下一行下标。

    wraps_everything_until：若该围栏从正文第一行开始，这里给出正文最后一行的下标，
    用来识别“模型把整段正文包在围栏里”的情况。
    """
    opening = _FENCE_RE.match(lines[i])
    marker, info = opening.group(1), opening.group(2).strip()
    close_re = re.compile(r"^[ \t]*%s{%d,}[ \t]*$" % (re.escape(marker[0]), len(marker)))
    n = len(lines)
    j = i + 1
    while j < n and not close_re.match(lines[j]):
        j += 1

    language = info.lower()
    if not _FENCE_LANGUAGE_RE.match(info):
        # 围栏标记后面跟的不是语言名而是正文，留作段落
        blocks.append(("paragraph", info))
        language = ""
    if j >= n:
        # 没有闭合的围栏多半是模型输出残留的标记：只丢掉标记行，其余按正文解析
        return i + 1

    body = lines[i + 1 : j]
    wraps_prose = (
        language == ""
        and wraps_everything_until == j
        and _looks_like_prose(body)
    )
    if (language in ("markdown", "md") or wraps_prose) and depth < _MAX_NESTING:
        blocks.extend(_parse_lines(body, depth=depth + 1))
    else:
        indent = _leading_indent(lines[i])
        blocks.append(("code", [_strip_indent(line, indent) for line in body]))
    return j + 1


def _parse_lines(lines: list[str], top: bool = False, depth: int = 0) -> list[tuple]:
    blocks: list[tuple] = []
    n = len(lines)
    first = last = -1
    if top:
        non_empty = [index for index, line in enumerate(lines) if line.strip()]
        if non_empty:
            first, last = non_empty[0], non_empty[-1]

    i = 0
    while i < n:
        line = lines[i].rstrip()
        stripped = line.strip()
        if not stripped:
            i += 1
            continue

        if _FENCE_RE.match(line):
            i = _consume_fence(lines, i, blocks, last if i == first else None, depth)
            continue

        if depth < _MAX_NESTING and _QUOTE_RE.match(line):
            inner: list[str] = []
            while i < n and _QUOTE_RE.match(lines[i]):
                inner.append(_QUOTE_STRIP_RE.sub("", lines[i], count=1))
                i += 1
            blocks.append(("quote", _parse_lines(inner, depth=depth + 1)))
            continue

        if _HR_RE.match(stripped):
            i += 1
            continue

        heading = _HEADING_RE.match(stripped) or _HEADING_TIGHT_RE.match(stripped)
        if heading:
            title = heading.group(2).strip()
            if title:
                blocks.append(("heading", len(heading.group(1)), title))
            i += 1
            continue

        table = _parse_table(lines, i)
        if table is not None:
            blocks.append(table[0])
            i = table[1]
            continue

        if _is_list_item(line):
            i = _consume_list(lines, i, blocks)
            continue

        # 其余一律是正文：一行一个段落（模型输出不会硬折行，换行就是分段）
        blocks.append(("paragraph", stripped))
        i += 1
    return blocks


def _parse_markdown(content: str) -> list[tuple]:
    """把 Markdown 正文解析成块序列，认不出来的行一律当普通段落，保证不丢字。

    块的形态：
    - ("paragraph", text)
    - ("heading", level, text)
    - ("list_item", level, marker, text)   marker 为 None 表示无序项，否则是原文编号（如 "3."）
    - ("list_text", level, text)           列表项下不带标记的续行
    - ("table", header, aligns, rows)
    - ("code", lines)
    - ("quote", blocks)
    """
    return _parse_lines(_clean_text(content).split("\n"), top=True)


# ---------------------------------------------------------------------------
# 规范排版：文档生成
# ---------------------------------------------------------------------------

_TABLE_CELL_ALIGN = {
    "left": WD_ALIGN_PARAGRAPH.LEFT,
    "center": WD_ALIGN_PARAGRAPH.CENTER,
    "right": WD_ALIGN_PARAGRAPH.RIGHT,
}
_MAX_INDENT_CHARS = 12      # 左缩进上限（字符），嵌套再深也不把文字挤出版心
_CELL_PADDING_TWIPS = 336   # 单元格左右边距（各 108 缇）再加一点余量
_CELL_MIN_UNITS = 4         # 内容再短的列也按两个汉字的宽度参与分配
_CELL_MAX_UNITS = 40        # 参与分配的内容宽度上限，免得一个超长单元格把其他列挤没


def _spans_display_width(spans: list[tuple[str, str, bool, bool]]) -> int:
    """单元格内容最宽一行的显示宽度：全角字符算 2，其余算 1。"""
    widest = current = 0
    for kind, text, _bold, _italic in spans:
        if kind == "br":
            current = 0
            continue
        current += sum(2 if unicodedata.east_asian_width(ch) in "WFA" else 1 for ch in text)
        widest = max(widest, current)
    return widest


def _table_column_widths(cell_units: list[list[int]], total: int, unit: int) -> list[int]:
    """按内容给各列分配宽度（缇），各列之和恰为 total。

    cell_units[r][c] 是第 r 行第 c 列内容的显示宽度，unit 是一个半角字符的宽度。
    内容都放得下时按需求等比放大到占满版心；放不下时先满足内容短的列（如序号），
    剩下的宽度由长列按需求比例分摊。
    """
    count = len(cell_units[0])
    needs = [
        min(max(max(row[c] for row in cell_units), _CELL_MIN_UNITS), _CELL_MAX_UNITS) * unit
        + _CELL_PADDING_TWIPS
        for c in range(count)
    ]
    if sum(needs) <= total:
        widths = [need * total / sum(needs) for need in needs]
    else:
        widths = [0.0] * count
        remaining = float(total)
        pending = list(range(count))
        while pending:
            share = remaining / len(pending)
            fitting = [c for c in pending if needs[c] <= share]
            if not fitting:
                break
            for c in fitting:
                widths[c] = float(needs[c])
                remaining -= needs[c]
            pending = [c for c in pending if c not in fitting]
        pending_need = sum(needs[c] for c in pending)
        for c in pending:
            widths[c] = remaining * needs[c] / pending_need

    result = [max(1, int(width)) for width in widths]
    result[-1] = max(1, total - sum(result[:-1]))  # 取整的零头并入最后一列
    return result


class _StandardDocumentBuilder:
    """按固定规范排版生成单份文档：同样的输入，每次导出的版式都一样。"""

    def __init__(self, request: WordExportRequest, persona_name: str | None = None):
        self._request = request
        self._persona_name = persona_name
        self._profile = _StandardProfile
        self._doc = docx.Document()
        # 上一个写进正文的块是不是表格：相邻两张表之间必须隔一个段落，否则 Word 会把它们并成一张
        self._after_table = False

    def build(self):
        self._apply_metadata()
        self._apply_page_setup()
        self._init_styles()
        self._add_page_number_footer()
        self._add_intro()
        self._add_outline_items(self._request.outline, 1)
        if self._after_table:
            # Word 自己保存的文档总以段落收尾；正文以表格结尾时补一个，免得各家软件处理不一致
            self._new_paragraph()
        return self._doc

    # ---- 文档级设置 ----

    def _apply_metadata(self) -> None:
        props = self._doc.core_properties
        # 文档属性里的时间按 UTC 存储
        now = datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)
        # 作者留空；模板自带的占位信息（python-docx 等）一并清掉
        props.author = ""
        props.last_modified_by = ""
        props.title = _single_line(self._request.project_name)[:255]
        props.subject = ""
        props.keywords = ""
        props.comments = ""
        props.category = _single_line(self._persona_name)[:255]
        props.created = now
        props.modified = now
        props.revision = 1

    def _apply_page_setup(self) -> None:
        profile = self._profile
        for section in self._doc.sections:
            section.page_width = profile.page_width
            section.page_height = profile.page_height
            section.top_margin = profile.margin_top
            section.bottom_margin = profile.margin_bottom
            section.left_margin = profile.margin_left
            section.right_margin = profile.margin_right

    def _init_styles(self) -> None:
        profile = self._profile
        styles = self._doc.styles

        normal = styles["Normal"]
        _set_style_font(normal, profile.body_font, profile.body_size, bold=False)
        fmt = normal.paragraph_format
        fmt.line_spacing = profile.line_spacing
        fmt.space_before = Pt(0)
        fmt.space_after = Pt(0)

        for index, size in enumerate(profile.heading_sizes):
            style = styles[f"Heading {index + 1}"]
            _set_style_font(style, profile.heading_font, size, bold=True)
            fmt = style.paragraph_format
            fmt.space_before = profile.heading_space_before[index]
            fmt.space_after = profile.heading_space_after[index]

        _localize_defaults(self._doc, profile.body_font)

    def _add_page_number_footer(self) -> None:
        footer = self._doc.sections[0].footer
        footer.is_linked_to_previous = False
        para = footer.paragraphs[0] if footer.paragraphs else footer.add_paragraph()
        para.alignment = WD_ALIGN_PARAGRAPH.CENTER
        self._add_field(para, "PAGE", "1", size=self._profile.footer_size)

    # ---- 基础写入 ----

    def _new_paragraph(self, style: str | None = None):
        self._after_table = False
        return self._doc.add_paragraph(style=style)

    def _add_run(
        self,
        para,
        text: str,
        font: str | None = None,
        ascii_font: str | None = None,
        size=None,
        bold: bool = False,
        italic: bool = False,
    ):
        """写入一个 run；所有文本都先清洗掉 XML 非法字符。"""
        text = _clean_text(text)
        run = para.add_run(text) if text else para.add_run()
        _set_run_font(run, font or self._profile.body_font)
        if ascii_font:
            run.font.name = ascii_font  # 只换西文字体，中文仍用上面设置的字体
        if size is not None:
            run.font.size = size
        if bold:
            run.bold = True
        if italic:
            run.italic = True
        return run

    def _add_spans(self, para, spans, bold: bool = False) -> bool:
        """把行内片段写进段落，返回其中是否有手动换行。"""
        has_break = False
        for kind, text, span_bold, italic in spans:
            if kind == "br":
                para.add_run().add_break()
                has_break = True
                continue
            self._add_run(
                para,
                text,
                ascii_font=self._profile.code_font if kind == "code" else None,
                bold=bold or span_bold,
                italic=italic,
            )
        return has_break

    def _add_field(self, para, instruction: str, placeholder: str, size=None) -> None:
        """插入一个域（页码、目录）；placeholder 是更新域之前显示的内容。"""

        def add_mark(mark_type: str) -> None:
            mark = OxmlElement("w:fldChar")
            mark.set(qn("w:fldCharType"), mark_type)
            self._add_run(para, "", size=size)._r.append(mark)

        add_mark("begin")
        instr = OxmlElement("w:instrText")
        instr.set(qn("xml:space"), "preserve")
        instr.text = f" {instruction} "
        self._add_run(para, "", size=size)._r.append(instr)
        add_mark("separate")
        self._add_run(para, placeholder, size=size)
        add_mark("end")

    def _set_indent(self, para, left: int = 0, first_line: int = 0) -> None:
        """按“字符”设置缩进（1 字符 = 正文字号）。

        同时写字符数和等价的绝对值：Word 以字符数为准，不认字符单位的软件用绝对值。
        """
        left = min(left, _MAX_INDENT_CHARS)
        if not left and not first_line:
            return
        unit = self._profile.body_size
        fmt = para.paragraph_format
        if left:
            fmt.left_indent = unit * left
        if first_line:
            fmt.first_line_indent = unit * first_line
        ind = para._p.pPr.ind
        if left:
            ind.set(qn("w:leftChars"), str(left * 100))
        if first_line:
            ind.set(qn("w:firstLineChars"), str(first_line * 100))

    # ---- 标题、目录、概述 ----

    def _add_intro(self) -> None:
        profile = self._profile
        title = self._new_paragraph()
        title.alignment = WD_ALIGN_PARAGRAPH.CENTER
        title.paragraph_format.space_after = Pt(12)
        self._add_run(
            title,
            _single_line(self._request.project_name) or "投标技术文件",
            font=profile.heading_font,
            size=profile.title_size,
            bold=True,
        )

        if getattr(self._request, "include_toc", False):
            self._add_toc()

        overview = _clean_text(self._request.project_overview)
        if overview.strip():
            self._add_chapter_heading("项目概述", 1)
            self._add_markdown(overview)

    def _add_toc(self) -> None:
        profile = self._profile
        # 「目录」二字不用标题样式，否则它自己也会被收进目录
        heading = self._new_paragraph()
        heading.alignment = WD_ALIGN_PARAGRAPH.CENTER
        heading.paragraph_format.space_after = Pt(6)
        self._add_run(heading, "目录", font=profile.heading_font, size=profile.heading_sizes[0], bold=True)

        toc = self._new_paragraph()
        self._add_field(
            toc,
            'TOC \\o "1-3" \\h \\z \\u',
            "（请在 Word 中右键单击此处，选择“更新域”生成目录）",
        )
        self._new_paragraph().add_run().add_break(WD_BREAK.PAGE)

    def _add_chapter_heading(self, text: str, level: int) -> None:
        text = _single_line(text)
        if not text:
            return  # 编号和标题都为空的节点不留空标题（否则目录里会多出一条空项）
        if level <= 3:
            para = self._new_paragraph(style=f"Heading {level}")
            para.alignment = WD_ALIGN_PARAGRAPH.LEFT
            self._add_run(para, text, font=self._profile.heading_font)
            return
        # 四级及更深的章节不占用 Word 的标题层级，用加粗段落表示
        para = self._new_paragraph()
        fmt = para.paragraph_format
        fmt.space_before = Pt(6)
        fmt.space_after = Pt(3)
        fmt.keep_with_next = True
        self._add_run(para, text, bold=True)

    # ---- 章节 ----

    def _add_outline_items(self, items: list[WordExportOutlineItem], level: int) -> None:
        for item in items or []:
            self._add_chapter_heading(f"{item.id} {item.title}", level)
            if item.children:
                self._add_outline_items(item.children, level + 1)
                continue
            content = item.content or ""
            if content.strip():
                self._add_markdown(content)
            self._add_chapter_image(item)

    def _add_chapter_image(self, item: WordExportOutlineItem) -> None:
        """若章节带配图（image_b64），解码后居中插入并附图注；图片有问题只跳过，不影响导出。"""
        image_b64 = getattr(item, "image_b64", None)
        if not image_b64:
            return
        try:
            raw = base64.b64decode(image_b64, validate=True)
        except (binascii.Error, ValueError) as exc:
            logger.warning("章节 %s 配图 base64 解码失败，跳过：%s", item.id, exc)
            return

        section = self._doc.sections[0]
        max_width = section.page_width - section.left_margin - section.right_margin
        max_height = int((section.page_height - section.top_margin - section.bottom_margin) * 0.8)

        para = self._new_paragraph()
        para.alignment = WD_ALIGN_PARAGRAPH.CENTER
        fmt = para.paragraph_format
        fmt.line_spacing = 1.0  # 多倍行距会按图片高度成比例留白
        fmt.space_before = Pt(6)
        try:
            shape = para.add_run().add_picture(io.BytesIO(raw), width=min(Inches(5.8), max_width))
        except Exception as exc:
            logger.warning("章节 %s 配图插入失败，跳过：%s", item.id, exc)
            para._p.getparent().remove(para._p)
            return
        if shape.height > max_height:
            # 过高的图按版心高度等比缩小，避免被裁切
            shape.width = int(shape.width * max_height / shape.height)
            shape.height = max_height

        caption = _single_line(getattr(item, "image_title", None))
        if not caption:
            fmt.space_after = Pt(6)
            return
        fmt.keep_with_next = True
        cap_para = self._new_paragraph()
        cap_para.alignment = WD_ALIGN_PARAGRAPH.CENTER
        cap_para.paragraph_format.space_after = Pt(6)
        self._add_run(cap_para, caption, size=self._profile.small_size)

    # ---- Markdown 正文 ----

    def _add_markdown(self, content: str) -> None:
        self._render_blocks(_parse_markdown(content), 0)

    def _render_blocks(self, blocks: list[tuple], quote_depth: int):
        """依次写入各块；quote_depth 是外层引用的层数，每层左缩进 2 字符。返回最后写入的段落。"""
        base = 2 * quote_depth
        first_line = 0 if quote_depth else 2  # 引用块里的段落只做左缩进，不再首行缩进
        gap = self._profile.table_gap
        last = None
        after_table = False
        for block in blocks:
            kind = block[0]
            if kind == "table":
                if last is not None:
                    last.paragraph_format.space_after = gap  # 表格与上方文字之间留一点空
                self._add_table(block[1], block[2], block[3])
                last = None
                after_table = True
                continue
            if kind == "paragraph":
                para = self._add_text_paragraph(block[1], left=base, first_line=first_line)
            elif kind == "heading":
                para = self._add_subheading(block[2], left=base)
            elif kind == "list_item":
                _, level, marker, text = block
                para = self._add_text_paragraph(
                    text,
                    left=base + 2 * level,
                    first_line=first_line,
                    prefix=f"{marker} " if marker else "• ",
                )
            elif kind == "list_text":
                para = self._add_text_paragraph(block[2], left=base + 2 * block[1], first_line=first_line)
            elif kind == "code":
                para = self._add_code_block(block[1], left=base + 2)
            elif kind == "quote":
                para = self._render_blocks(block[1], quote_depth + 1)
            else:
                para = None
            if para is not None:
                if after_table and kind in ("paragraph", "list_item", "list_text"):
                    para.paragraph_format.space_before = gap  # 表格与下方文字之间同样留空
                last = para
            after_table = False
        return last

    def _add_text_paragraph(
        self,
        text: str,
        left: int = 0,
        first_line: int = 0,
        prefix: str = "",
        bold: bool = False,
    ):
        spans = _trim_spans(_parse_inline(text))
        if not spans:
            return None
        para = self._new_paragraph()
        self._set_indent(para, left, first_line)
        if prefix:
            self._add_run(para, prefix)
        has_break = self._add_spans(para, spans, bold=bold)
        # 两端对齐遇到手动换行会把那一行的字距硬拉开，这种段落改用左对齐
        para.alignment = WD_ALIGN_PARAGRAPH.LEFT if has_break else WD_ALIGN_PARAGRAPH.JUSTIFY
        return para

    def _add_subheading(self, text: str, left: int = 0):
        """正文里的 Markdown 标题：加粗的小标题段落，不用 Word 标题样式，以免打乱章节层级和目录。"""
        para = self._add_text_paragraph(text, left=left, bold=True)
        if para is None:
            return None
        para.alignment = WD_ALIGN_PARAGRAPH.LEFT
        fmt = para.paragraph_format
        fmt.space_before = Pt(6)
        fmt.space_after = Pt(3)
        fmt.keep_with_next = True
        return para

    def _add_code_block(self, lines: list[str], left: int):
        """代码围栏：等宽字体、单倍行距，逐行输出。"""
        profile = self._profile
        para = None
        for line in lines:
            para = self._new_paragraph()
            para.alignment = WD_ALIGN_PARAGRAPH.LEFT
            para.paragraph_format.line_spacing = 1.0
            self._set_indent(para, left)
            if line:
                self._add_run(para, line, ascii_font=profile.code_font, size=profile.small_size)
        return para

    def _add_table(self, header: list[str], aligns: list[str], rows: list[list[str]]) -> None:
        if self._after_table:
            spacer = self._new_paragraph()
            spacer.paragraph_format.line_spacing = self._profile.table_gap

        span_rows = [
            [_trim_spans(_parse_inline(text)) for text in texts] for texts in [header] + rows
        ]
        section = self._doc.sections[0]
        text_width = section.page_width - section.left_margin - section.right_margin
        widths = _table_column_widths(
            [[_spans_display_width(spans) for spans in span_row] for span_row in span_rows],
            Emu(text_width).twips,
            self._profile.body_size.twips // 2,
        )

        table = self._doc.add_table(rows=len(span_rows), cols=len(header))
        table.style = "Table Grid"
        table.alignment = WD_TABLE_ALIGNMENT.CENTER
        for column, width in zip(table.columns, widths):
            column.width = Twips(width)
        for row_index, (row, span_row) in enumerate(zip(table.rows, span_rows)):
            is_header = row_index == 0
            row_props = row._tr.get_or_add_trPr()
            row_props.append(OxmlElement("w:cantSplit"))  # 一行不拆到两页
            if is_header:
                row_props.append(OxmlElement("w:tblHeader"))  # 表格跨页时在每页顶端重复表头
            for cell, spans, align, width in zip(row.cells, span_row, aligns, widths):
                cell.width = Twips(width)
                cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
                para = cell.paragraphs[0]
                fmt = para.paragraph_format
                fmt.line_spacing = 1.0
                fmt.space_before = Pt(2)
                fmt.space_after = Pt(2)
                para.alignment = _TABLE_CELL_ALIGN.get(align) or (
                    WD_ALIGN_PARAGRAPH.CENTER if is_header else WD_ALIGN_PARAGRAPH.LEFT
                )
                self._add_spans(para, spans, bold=is_header)
        self._after_table = True


class WordExportService:
    """负责将目录数据导出为 Word 文档。"""

    @staticmethod
    def export_outline(
        request: WordExportRequest,
        copy_index: int | None = None,
        persona_name: str | None = None,
    ) -> tuple[io.BytesIO, dict[str, str]]:
        # 普通单份导出走固定的规范排版；带 copy_index 的多份导出保持旧逻辑
        if copy_index is None:
            doc = _StandardDocumentBuilder(request, persona_name).build()
        else:
            doc = WordExportService._build_copy_document(request, copy_index, persona_name)

        buffer = io.BytesIO()
        doc.save(buffer)
        buffer.seek(0)

        filename = f"{request.project_name or '标书文档'}.docx"
        headers = {
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
        }
        return buffer, headers

    # -----------------------------------------------------------------------
    # 以下方法只服务于 copy_index 不为 None 的旧多份导出路径，逻辑保持原样。
    # 单份导出的排版与 Markdown 渲染都在 _StandardDocumentBuilder 里，不要在这里扩展。
    # -----------------------------------------------------------------------

    @staticmethod
    def _build_copy_document(
        request: WordExportRequest,
        copy_index: int,
        persona_name: str | None,
    ) -> docx.Document:
        profile = _CopyProfile(copy_index=copy_index)
        doc = docx.Document()

        WordExportService._apply_metadata(doc, profile, persona_name)
        WordExportService._apply_page_setup(doc, profile)
        WordExportService._init_document_styles(doc, profile)
        WordExportService._add_document_intro(
            doc, request.project_name, request.project_overview, profile
        )
        WordExportService._add_outline_items(doc, request.outline, profile=profile)
        return doc

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
