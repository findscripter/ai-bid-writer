"""本地审校：不调用模型，用纯算法找出成稿里明显的问题。

一本标书由几十到上百个叶子章节分别写成，写完后先过一遍这里的检查：
状态、篇幅、占位符、跨章重复、章内重复、套话与模型口吻、标记残留、评分点覆盖。
产出的问题清单供使用者逐条处理，fixable 的可以交给模型一键修订。

分三层，便于单独调用与测试：
- 文本级函数：只看一段文本（find_placeholders_in_text、find_markup_residue 等）；
- 章节级检查：吃 build_views() 产出的章节视图，各自返回问题列表；
- run_local_review：把全部检查串起来，产出 ReviewReport。
"""
from __future__ import annotations

import hashlib
import heapq
import logging
import re
import unicodedata
import zlib
from functools import cached_property
from typing import Callable, Collection, Dict, FrozenSet, Iterable, List, Optional, Sequence, Set, Tuple, TypeVar

from .models import (
    Blueprint,
    ChapterRecord,
    CoverageItem,
    LeafInfo,
    PlaceholderItem,
    RequirementItem,
    ReviewIssue,
    ReviewReport,
    ReviewStats,
)
from .textutil import clip, count_chars, now_iso, split_sentences

logger = logging.getLogger(__name__)

T = TypeVar("T")

# ---------------------------------------------------------------------------
# 阈值
# ---------------------------------------------------------------------------

SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}

# 篇幅：实际字数 / 目标字数 低于下限或高于上限才提示。用百分数做整数比较，避免 0.6 这类浮点边界误判
LENGTH_SHORT_PERCENT = 60
LENGTH_LONG_PERCENT = 160

MIN_SENTENCE_LEN = 18  # 归一化后达到这个长度的句子才参与重复比较
LONG_SENTENCE_LEN = 40  # 达到这个长度的句子，两章共有 1 句就算重复
MIN_SHARED_SENTENCES = 2
HIGH_SHARED_SENTENCES = 5
MAX_DUPLICATE_ISSUES_PER_CHAPTER = 5  # 同一章作为「靠后的那一章」最多报几条，防止病态输入刷屏
REFERENCE_MAX_REST = 10  # 去掉标准 / 法规名称后剩下的字不到这么多，就当它只是一条引用
# 章内「复读」：不够长的句子接连出现这么多次也算重复（太短的不算，「同上。」连着出现是正常的）
RUN_MIN_SENTENCE_LEN = 6
RUN_MIN_TIMES = 3

SHINGLE_SIZE = 8
# 8-gram Jaccard。实测真实标书里主题不同的两章不到 0.05，真正雷同的在 0.25 以上；
# 0.3 相当于每章近一半的文字能在另一章里找到，取这个值很保守
SIMILARITY_THRESHOLD = 0.3
MIN_SHINGLES = 40  # 太短的章节不做近似比较，样本少、相似度不可靠
SKETCH_SIZE = 128  # 每章抽多少个 shingle 做粗筛
# 抽样里出现在对方章节的不到 1/8 就不细算。相似度过线时这个比例不低于 0.3，留了一倍多的余量
SKETCH_MIN_HIT_RATIO = 8

FILLER_THRESHOLD = 3
COVERAGE_HIT_PERCENT = 70
MIN_KEYWORD_LEN = 2
CONTEXT_CHARS = 20  # 占位符上下文：前后各取多少字
MAX_LISTED_SENTENCES = 8  # 修订指令里最多列出多少个句子
EXCERPT_SENTENCES = 3

# 章节状态（把 ChapterRecord.status 与「有没有正文」归并成审校关心的几种）
STATE_EMPTY = "empty"
STATE_FAILED = "failed"
STATE_PARTIAL = "partial"  # 被取消或中断，留有部分正文
STATE_DONE = "done"

# ---------------------------------------------------------------------------
# 词表（按需增删）
# ---------------------------------------------------------------------------

# 括号里以这些词开头的内容视为占位，如【待补充：企业资质】、（待定）
PLACEHOLDER_LEAD_WORDS = (
    "待补充", "待补", "待填写", "待填", "待定", "待确认", "待核实", "待完善", "待提供", "待明确", "待插入",
    "此处填写", "此处补充", "此处插入", "此处添加",
    "请填写", "请补充", "请插入", "请根据实际",
    "需补充", "需填写",
)
# 不带括号也算占位的词
PLACEHOLDER_BARE_WORDS = ("待补充",)
# 「某某」后面跟着这些词时一并算进占位文本，如 某某公司 / 某某项目
PLACEHOLDER_GENERIC_NOUNS = (
    "有限责任公司", "股份有限公司", "有限公司", "集团", "公司", "项目", "单位", "医院", "银行", "大学", "学校", "平台", "系统",
)
PLACEHOLDER_MAX_INNER = 120  # 括号占位里说明文字的最大长度

# 填充套话：单个出现无妨，一章里堆了好几个才提示
FILLER_PHRASES = (
    "综上所述", "总而言之", "总的来说",
    "值得注意的是", "值得一提的是", "需要指出的是", "需要强调的是",
    "众所周知", "不言而喻", "毋庸置疑", "不可否认", "显而易见",
)
# 「首先…其次…最后」这种三段式铺排，整组算一次
FILLER_SEQUENCES = (("首先", "其次", "最后"),)
FILLER_SEQUENCE_GAP = 300  # 三段式里相邻两个词最多隔多少字

# 模型口吻残留（正则）。标书正文自称「我方 / 我司 / 我们」，所以这里只认明显的对话式自称与客套，
# 「作为AI中台的核心」「如有需要，请联系我方」这类正常行文不算
AI_VOICE_PATTERNS = (
    r"作为(?:一个|一名|一款)?\s*(?:AI|人工智能|(?:大型?)?语言模型|大模型)\s*(?:助手|语言模型|模型)?\s*[，,]?\s*"
    r"(?:我(?![方司们公院校行局单])|无法|不能|并不|没有|不具备)",
    r"以下是我?(?:为|给)(?:您|你)",
    r"以下是(?:根据|按照|依据)(?:您|你)",
    r"希望(?:以上|这些|上述)(?:内容|信息|回答|建议)",
    r"希望(?:能够?)?对(?:您|你)有所?帮助",
    r"如有(?:需要|其他需求|其他需要|任何疑问|任何问题|其他问题)[，,]?\s*(?:请|欢迎)(?:随时)?"
    r"(?:告诉我(?![方司们公])|告知我(?![方司们公])|(?:告知|提出|指出|说明)(?=[，,。！!；;\s]|$))",
    r"如需我?(?:进一步|继续)?(?:调整|修改|补充|完善|扩写|展开|细化|优化)[^。！？\n]{0,12}?"
    r"(?:请(?:随时)?(?:告诉我(?![方司们公])|告知(?=[，,。！!；;\s]|$))|我(?:可以|可|会|将))",
    r"请(?:随时)?(?:告诉|告知)我(?![方司们公])",
    r"请注意[:：，,]?\s*以上",
    r"以上(?:内容|方案|信息|回答)?仅供参考",
    r"我(?:无法|不能)(?:为您|为你|直接|提供|访问|获取|确认|核实)",
    r"(?:很|非常)抱歉",
    r"(?m:^[ \t]*(?:好的|没问题)[，,。！!：:])",
)

# 正文里不该出现的 HTML 标签（只认常见标签名，避免把 <10ms、<项目名称> 当成标签）
HTML_TAG_NAMES = (
    "br", "p", "div", "span", "b", "i", "u", "strong", "em", "a", "img", "sub", "sup", "font", "center", "hr",
    "table", "thead", "tbody", "tr", "td", "th", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
    "pre", "code", "blockquote", "small", "mark", "del", "ins",
)

MARKUP_LABELS = {
    "fence": "代码围栏（```）",
    "heading": "一二级 Markdown 标题（# / ##）",
    "html": "HTML 标签",
    "bold": "未闭合的 **",
}

# ---------------------------------------------------------------------------
# 预编译
# ---------------------------------------------------------------------------


def _alternation(words: Iterable[str]) -> str:
    """把词表拼成正则的多选分支，长词在前，避免短词抢先匹配。"""
    return "|".join(re.escape(word) for word in sorted(dict.fromkeys(words), key=len, reverse=True))


_WS_RE = re.compile(r"\s+")
_NON_WORD_RE = re.compile(r"[\W_]+")
_SURROGATE_RE = re.compile(r"[\ud800-\udfff]")
# 行首的列表序号（1. / 2、 / （3） / 一、 / ①）。数字和汉字不会被当标点去掉，不剥掉的话
# 同一句话换个序号就比不出来了；「3.5 米」这种小数不算序号
_LIST_MARKER_RE = re.compile(
    r"^[\W_]*(?:\d{1,3}(?:[、)）]|\.(?!\d))|[一二三四五六七八九十]{1,3}[、)）.]|[①-⑳⑴-⒇])"
)
_TABLE_RULE_RE = re.compile(r"^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?$")
_MD_ANY_HEADING_RE = re.compile(r"^[ \t]{0,3}#{1,6}[ \t]")
# 标准 / 法规引用：《……》与 GB/T 22239-2019、ISO/IEC 27001:2022 这类编号
_STANDARD_NO = r"[A-Za-z]{2,6}(?:/[A-Za-z]{1,6}){0,3}\s*\d{3,}(?:[.\-—–/:：]\d+)*"
_REFERENCE_HINT_RE = re.compile(rf"《|{_STANDARD_NO}")
_REFERENCE_STRIP_RE = re.compile(rf"《[^《》\n]*》|{_STANDARD_NO}")
# 以标准编号开头、后面只跟着名称的一行，如「GB 50174-2017 数据中心设计规范」
_REFERENCE_LEAD_RE = re.compile(rf"^[\W\d_]*{_STANDARD_NO}[^，,。；;！？!?]{{0,50}}[。；;]?$")
_SENTENCE_END_RE = re.compile(r"[。！？!?；;\n]")

_PLACEHOLDER_LEAD = _alternation(PLACEHOLDER_LEAD_WORDS)
# 每种括号各一条分支：(开括号, 闭括号, 括号内不允许出现的字符)。闭括号缺失时只取到引导词为止
_BRACKET_PLACEHOLDER_RE = re.compile(
    "|".join(
        rf"{opening}[^\S\n]*(?:{_PLACEHOLDER_LEAD})(?:[^{inner}\n]{{0,{PLACEHOLDER_MAX_INNER}}}{closing})?"
        for opening, closing, inner in (
            ("【", "】", "【】"),
            ("〖", "〗", "〖〗"),
            ("〔", "〕", "〔〕"),
            (r"[\[［]", r"[\]］]", r"\[\]［］"),
            ("[（(]", "[）)]", "（）()"),
        )
    )
)
# 掩码串：XX公司、×××、____ 。X 两侧不能是英文字母，免得误伤 XXL、Linux 这类词；
# 前面带数字时只认 20XX年、138xxxxxxxx 这两种，免得误伤 5xx 错误、型号通配
_MASK_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:[XxＸｘ]{2,}|\d{1,6}[XxＸｘ]{4,}|\d{2}[XxＸｘ]{2}(?=\s*年))(?![A-Za-z])"
    r"|[×✕╳＊]{2,}|[□○]{2,}|_{3,}|＿{2,}"
)
_MASK_JOINERS_EXCLUDED = frozenset(" \t\n，,、；;。！!？?：:")  # 隔着这些字符的两个掩码串不算同一处
_GENERIC_RE = re.compile(rf"某某(?:{_alternation(PLACEHOLDER_GENERIC_NOUNS)})?")
# 示例人名；排除 张三丰、李四光 这类真实人名
_NAME_RE = re.compile(r"张三(?!丰)|李四(?!光)|王五")
# 「等待补充」「期待补充」里的不算
_BARE_PLACEHOLDER_RE = re.compile(rf"(?<![等期对接招])(?:{_alternation(PLACEHOLDER_BARE_WORDS)})")

_FILLER_RE = re.compile(_alternation(FILLER_PHRASES))
_AI_VOICE_RE = re.compile("|".join(f"(?:{pattern})" for pattern in AI_VOICE_PATTERNS), re.IGNORECASE)

_MD_HEADING_RE = re.compile(r"^[ \t]{0,3}#{1,2}[ \t]+\S.*$", re.MULTILINE)
_HTML_RE = re.compile(
    rf"</?(?:{_alternation(HTML_TAG_NAMES)})(?:\s+[A-Za-z][^<>\n]{{0,200}})?\s*/?>"
    r"|<!--|&(?:nbsp|lt|gt|amp|quot|ensp|emsp);",
    re.IGNORECASE,
)
_BOLD_RUN_RE = re.compile(r"\*{2,}")
_POWER_RE = re.compile(r"(?<=[0-9A-Za-z)])\*\*(?=[0-9A-Za-z(])")  # 2**10 这种乘方写法不是加粗
_RULE_LINE_RE = re.compile(r"^[\s*\-_]+$")

# 关键词前面的比较符号：正文常把「≥99.9%」写成「不低于 99.9%」，去掉符号再找一次
_COMPARATORS = "≥≤<>=≧≦≈~"
# 关键词比对时抹平的写法差异：各种横线算同一个，「7*24」「7x24」「7×24」算同一个
_FOLD_TABLE = {code: "-" for code in (0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212)}
_FOLD_TABLE.update({0x301C: "~", 0x223C: "~"})
_TIMES_RE = re.compile(r"(?<=\d)\s*[*xX×✕]\s*(?=\d)")


# ---------------------------------------------------------------------------
# 文本级函数
# ---------------------------------------------------------------------------


def _clean_text(value: object) -> str:
    """把外部文本变成可以安全处理与序列化的字符串。

    孤立的代理项（JSON 里被截断的 emoji 转义会产生）无法编码成 UTF-8，
    原样带进审校结果会让整份报告序列化失败，这里换成替换符。
    """
    if value is None:
        return ""
    text = value if isinstance(value, str) else str(value)
    if "\r" in text:
        text = text.replace("\r\n", "\n").replace("\r", "\n")
    return _SURROGATE_RE.sub("\N{REPLACEMENT CHARACTER}", text)


def _squash(text: str) -> str:
    """去掉全部空白与标点，统一全半角与大小写。"""
    return _NON_WORD_RE.sub("", unicodedata.normalize("NFKC", text)).casefold()


def _fold(text: str) -> str:
    """关键词比对用的宽松形式：去空白与强调标记，统一全半角、大小写和常见的符号写法；标点保留（如 99.9%）。"""
    value = unicodedata.normalize("NFKC", text).translate(_FOLD_TABLE)
    value = _TIMES_RE.sub("×", value)
    return _WS_RE.sub("", value).replace("*", "").replace("`", "").casefold()


def normalize_sentence(sentence: str) -> str:
    """把句子归一化成比较重复用的键：去掉行首序号、空白与标点，统一全半角与大小写。"""
    return _squash(_LIST_MARKER_RE.sub("", sentence or "", count=1))


def _partition(text: str) -> Tuple[List[str], str]:
    """把正文分成（一段段叙述文字, 表格数据行）。

    小标题行、表格的表头行与分隔行两边都不要；这些行和表格把叙述文字隔成几段。
    """
    if not text:
        return [], ""
    if "#" not in text and "|" not in text:
        return [text], ""
    lines = text.split("\n")
    rules = [bool(_TABLE_RULE_RE.match(line.strip())) for line in lines]
    blocks: List[str] = []
    current: List[str] = []
    table: List[str] = []
    for index, line in enumerate(lines):
        stripped = line.strip()
        dropped = (
            rules[index]
            or bool(_MD_ANY_HEADING_RE.match(line))
            or ("|" in line and index + 1 < len(lines) and rules[index + 1])
        )
        is_table_row = len(stripped) > 1 and stripped[0] == "|" and stripped[-1] == "|"
        if not dropped and not is_table_row:
            current.append(line)
            continue
        if is_table_row and not dropped:
            table.append(line)
        if current:
            blocks.append("\n".join(current))
            current = []
    if current:
        blocks.append("\n".join(current))
    return blocks, "\n".join(table)


def split_for_compare(text: str) -> List[str]:
    """切句，供逐句的重复比较用。

    只取叙述文字：小标题和表头在不同章节里相同是正常的；表格数据行重复多半是有意引用同一张表，
    而且「改写句子」的修订方式用在表格上容易把数据改错。
    """
    return [sentence for block in _partition(text)[0] for sentence in split_sentences(block)]


def _is_reference_entry(sentence: str) -> bool:
    """整句基本只是一个标准 / 法规 / 文件的名称（如「编制依据」里的一行）。"""
    if not _REFERENCE_HINT_RE.search(sentence):
        return False
    if _REFERENCE_LEAD_RE.match(sentence):
        return True
    return len(_squash(_REFERENCE_STRIP_RE.sub("", sentence))) < REFERENCE_MAX_REST


def _shingles(squashed: str, size: int = SHINGLE_SIZE) -> FrozenSet[str]:
    if size <= 0 or len(squashed) < size:
        return frozenset()
    return frozenset(squashed[i:i + size] for i in range(len(squashed) - size + 1))


def _stable_order(gram: str) -> Tuple[int, str]:
    """shingle 抽样用的排序键。不能用内置 hash()：它每个进程都不一样，抽样结果就不可复现了。"""
    return zlib.crc32(gram.encode("utf-8", "surrogatepass")), gram


def shingle_set(text: str, size: int = SHINGLE_SIZE) -> FrozenSet[str]:
    """文本的字符级 shingle 集合（先去掉空白与标点）。"""
    return _shingles(_squash(text or ""), size)


def jaccard(a: FrozenSet[str], b: FrozenSet[str]) -> float:
    """两个集合的 Jaccard 相似度；任一为空时为 0。"""
    if not a or not b:
        return 0.0
    shared = len(a & b)
    if not shared:
        return 0.0
    return shared / (len(a) + len(b) - shared)


def _context(text: str, start: int, end: int, radius: int = CONTEXT_CHARS) -> str:
    """取 [start, end) 连同前后各 radius 个字。

    前后文里的空白压成单个空格；[start, end) 本身原样保留，界面要在上下文里把它找出来标亮。
    """
    before = _WS_RE.sub(" ", text[max(start - radius, 0):start]).lstrip()
    after = _WS_RE.sub(" ", text[end:end + radius]).rstrip()
    return before + text[start:end] + after


def _sentence_around(text: str, start: int, end: int, limit: int = 100) -> str:
    """取包含 [start, end) 的那句话（找不到句界时退化为前后一小段）。"""
    window_start = max(start - limit, 0)
    head = window_start
    for match in _SENTENCE_END_RE.finditer(text, window_start, start):
        head = match.end()
    tail_match = _SENTENCE_END_RE.search(text, end, min(end + limit, len(text)))
    tail = tail_match.end() if tail_match else min(end + limit, len(text))
    return clip(_WS_RE.sub(" ", text[head:tail]), limit * 2)


def _stands_alone(text: str, start: int, end: int) -> bool:
    """[start, end) 是否独占一行（两边到行首行尾只有空白）。"""
    left = start
    while left > 0 and text[left - 1] in " \t":
        left -= 1
    right = end
    while right < len(text) and text[right] in " \t":
        right += 1
    return (left == 0 or text[left - 1] == "\n") and (right == len(text) or text[right] == "\n")


def find_placeholder_spans(text: str) -> List[Tuple[int, int]]:
    """找出占位符在文本里的位置 [start, end)，按出现顺序，互不重叠。"""
    if not text:
        return []
    found: List[Tuple[int, int, bool]] = []  # (start, end, 是否掩码串)
    for regex in (_BRACKET_PLACEHOLDER_RE, _GENERIC_RE, _NAME_RE, _BARE_PLACEHOLDER_RE):
        found.extend((m.start(), m.end(), False) for m in regex.finditer(text))
    for m in _MASK_RE.finditer(text):
        # 独占一行的 ___ 是 Markdown 分隔线，不是填空位
        if m.group()[0] in "_＿" and _stands_alone(text, m.start(), m.end()):
            continue
        found.append((m.start(), m.end(), True))

    found.sort(key=lambda span: (span[0], span[0] - span[1]))
    merged: List[Tuple[int, int, bool]] = []
    for start, end, is_mask in found:
        if merged:
            last_start, last_end, last_mask = merged[-1]
            if start < last_end:  # 落在前一个占位里面，如【待补充：XXX公司资质】里的 XXX
                continue
            # 「XX年XX月XX日」这样只隔一个字的掩码串是同一处占位
            if is_mask and last_mask and start - last_end <= 1 and text[last_end:start] not in _MASK_JOINERS_EXCLUDED:
                merged[-1] = (last_start, end, True)
                continue
        merged.append((start, end, is_mask))
    return [(start, end) for start, end, _ in merged]


def find_placeholders_in_text(text: str) -> List[Tuple[str, str]]:
    """找出一段文本里的全部占位，返回 (占位本身, 上下文) 列表。"""
    return [(text[start:end], _context(text, start, end)) for start, end in find_placeholder_spans(text)]


def _is_mostly_placeholder(sentence: str) -> bool:
    """去掉占位符后剩不下多少字的句子，如「项目经理：【待补充：姓名及证书编号】」。"""
    spans = find_placeholder_spans(sentence)
    if not spans:
        return False
    rest: List[str] = []
    cursor = 0
    for start, end in spans:
        rest.append(sentence[cursor:start])
        cursor = end
    rest.append(sentence[cursor:])
    return len(normalize_sentence("".join(rest))) < MIN_SENTENCE_LEN


def _count_sequence(text: str, parts: Sequence[str], gap: int = FILLER_SEQUENCE_GAP) -> int:
    """数一数 parts 里的词依次出现了几组（相邻两个词之间最多隔 gap 个字）。

    用顺序查找而不用正则：正则在「首先其次首先其次……」这种文本上回溯会很慢。
    """
    count = 0
    position = 0
    while True:
        start = text.find(parts[0], position)
        if start < 0:
            return count
        cursor = start + len(parts[0])
        for part in parts[1:]:
            found = text.find(part, cursor, cursor + gap + len(part))
            if found < 0:
                cursor = -1
                break
            cursor = found + len(part)
        if cursor < 0:
            position = start + len(parts[0])
        else:
            count += 1
            position = cursor


def count_filler_phrases(text: str) -> Dict[str, int]:
    """统计填充套话的出现次数，返回 {套话: 次数}（只含出现过的，按词表顺序）。"""
    if not text:
        return {}
    seen: Dict[str, int] = {}
    for match in _FILLER_RE.finditer(text):
        seen[match.group()] = seen.get(match.group(), 0) + 1
    counts = {phrase: seen[phrase] for phrase in FILLER_PHRASES if phrase in seen}
    for parts in FILLER_SEQUENCES:
        times = _count_sequence(text, parts) if parts and all(parts) else 0
        if times:
            counts["…".join(parts)] = times
    return counts


def _first_filler_sentence(text: str) -> str:
    """第一处套话所在的句子，给问题清单做摘录。"""
    spans: List[Tuple[int, int]] = []
    match = _FILLER_RE.search(text)
    if match:
        spans.append((match.start(), match.end()))
    for parts in FILLER_SEQUENCES:
        if parts and all(parts) and _count_sequence(text, parts):
            start = text.find(parts[0])
            spans.append((start, start + len(parts[0])))
    if not spans:
        return ""
    start, end = min(spans)
    return _sentence_around(text, start, end)


def find_ai_voice(text: str) -> List[str]:
    """找出带模型口吻的句子（去重，按出现顺序）。"""
    if not text:
        return []
    result: List[str] = []
    seen: Set[str] = set()
    for match in _AI_VOICE_RE.finditer(text):
        sentence = _sentence_around(text, match.start(), match.end())
        if sentence and sentence not in seen:
            seen.add(sentence)
            result.append(sentence)
    return result


def find_markup_residue(text: str) -> Dict[str, List[str]]:
    """找出标记残留，返回 {种类: [命中的行或片段]}。

    种类：fence 代码围栏 / heading 一二级 Markdown 标题 / html HTML 标签 / bold 未闭合的 **。
    """
    result: Dict[str, List[str]] = {}
    if not text:
        return result
    if "```" in text:
        result["fence"] = [line.strip() for line in text.split("\n") if "```" in line]
    if "#" in text:
        headings = [match.group().strip() for match in _MD_HEADING_RE.finditer(text)]
        if headings:
            result["heading"] = headings
    if "<" in text or "&" in text:
        tags = [match.group() for match in _HTML_RE.finditer(text)]
        if tags:
            result["html"] = tags
    if "**" in text:
        # 加粗几乎不跨行，按行数 ** 的个数；单独成行的 *** 是分隔线，不算
        unclosed = [
            line.strip()
            for line in text.split("\n")
            if "**" in line
            and not _RULE_LINE_RE.match(line)
            and sum(len(run) // 2 for run in _BOLD_RUN_RE.findall(_POWER_RE.sub("", line))) % 2 == 1
        ]
        if unclosed:
            result["bold"] = unclosed
    return result


def issue_id(kind: str, *parts: object) -> str:
    """问题的稳定 ID：类型 + 关键信息的短哈希，同样的输入永远得到同样的值。"""
    raw = "\x1f".join([kind] + [str(part) for part in parts])
    digest = hashlib.sha1(raw.encode("utf-8", "backslashreplace")).hexdigest()[:10]
    return f"{kind}-{digest}"


# ---------------------------------------------------------------------------
# 章节视图
# ---------------------------------------------------------------------------


class ChapterView:
    """一个叶子章节在审校里的视图：叶子信息 + 清洗后的正文 + 归并后的状态。

    切句、shingle 等较贵的中间结果按需计算并缓存，多项检查共用。
    """

    def __init__(self, leaf: LeafInfo, index: int, record: Optional[ChapterRecord]) -> None:
        self.leaf = leaf
        self.index = index
        self.record = record
        self.uid = leaf.uid
        self.text = _clean_text(record.content) if record is not None else ""
        self.chars = count_chars(self.text)
        self.status = (_clean_text(record.status).strip().lower() if record is not None else "") or "empty"
        self.state = self._resolve_state()

    def _resolve_state(self) -> str:
        if self.record is None:
            return STATE_EMPTY
        if self.status == "failed":
            return STATE_FAILED
        if not self.chars:
            return STATE_EMPTY
        if self.status in ("cancelled", "writing"):
            return STATE_PARTIAL
        # 有正文而状态字段没跟上（如手动粘贴后仍标着 empty）的，按已完成对待
        return STATE_DONE

    @property
    def has_text(self) -> bool:
        return self.chars > 0

    @cached_property
    def label(self) -> str:
        """给人看的章节名：编号 + 标题。"""
        name = _clean_text(f"{self.leaf.id} {self.leaf.title}").strip()
        return clip(_WS_RE.sub(" ", name), 40) or self.uid

    @cached_property
    def placeholder_spans(self) -> List[Tuple[int, int]]:
        """正文里各处占位的位置 [start, end)。"""
        return find_placeholder_spans(self.text)

    @cached_property
    def _parts(self) -> Tuple[List[str], str]:
        return _partition(self.text)

    @cached_property
    def sentences(self) -> List[Tuple[str, str]]:
        """叙述文字的 (原文, 归一化键) 列表，含短句。被小标题或表格隔开的两段之间夹一个空条目。"""
        result: List[Tuple[str, str]] = []
        for block in self._parts[0]:
            if result:
                result.append(("", ""))
            result.extend((raw, normalize_sentence(raw)) for raw in split_sentences(block))
        return result

    @cached_property
    def long_sentences(self) -> List[Tuple[str, str]]:
        """参与逐句重复比较的句子（保留重复出现的）。

        够长才算；另外排除两类「重复了也正常、且不该让模型去改写」的句子：
        只是引用标准 / 法规名称的，和主体是占位符的。
        """
        # 整章都没有占位符时（多数章节如此），不必逐句再找一遍
        has_placeholders = bool(self.placeholder_spans)
        return [
            (raw, key)
            for raw, key in self.sentences
            if len(key) >= MIN_SENTENCE_LEN
            and not _is_reference_entry(raw)
            and not (has_placeholders and _is_mostly_placeholder(raw))
        ]

    @cached_property
    def sentence_index(self) -> Dict[str, str]:
        """归一化键 → 首次出现的原文，按出现顺序。"""
        index: Dict[str, str] = {}
        for raw, key in self.long_sentences:
            index.setdefault(key, raw)
        return index

    @cached_property
    def shingles(self) -> FrozenSet[str]:
        """整章的 shingle 集合：叙述文字加表格数据，衡量两章整体上有多像。"""
        return _shingles("".join(key for _, key in self.sentences) + _squash(self._parts[1]))

    @cached_property
    def sketch(self) -> FrozenSet[str]:
        """shingle 的固定抽样（按内容哈希取最小的若干个），用来快速排除明显不相似的章节。"""
        if len(self.shingles) <= SKETCH_SIZE:
            return self.shingles
        return frozenset(heapq.nsmallest(SKETCH_SIZE, self.shingles, key=_stable_order))

    @cached_property
    def folded(self) -> str:
        return _fold(self.text)


def build_views(leaves: Sequence[LeafInfo], chapters: Optional[Dict[str, ChapterRecord]]) -> List[ChapterView]:
    """按文档顺序为每个叶子建立视图；没有记录的叶子视为未生成。uid 重复的叶子只取第一个。"""
    records = chapters or {}
    views: List[ChapterView] = []
    seen: Set[str] = set()
    for leaf in leaves or []:
        if leaf.uid in seen:
            continue
        seen.add(leaf.uid)
        views.append(ChapterView(leaf, len(views), records.get(leaf.uid)))
    return views


def _positive_int(value: object) -> int:
    try:
        number = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError):
        return 0
    return number if number > 0 else 0


def _target_of(view: ChapterView, budget: Optional[Dict[str, int]]) -> int:
    """章节的目标字数：以当前预算为准，预算缺项时退回写作时记下的目标。"""
    target = _positive_int((budget or {}).get(view.uid))
    if not target and view.record is not None:
        target = _positive_int(view.record.target_words)
    return target


def _issue(
    kind: str,
    severity: str,
    uids: Sequence[str],
    key: Sequence[object],
    title: str,
    detail: str = "",
    suggestion: str = "",
    excerpt: str = "",
    fixable: bool = False,
    fix_instruction: str = "",
) -> ReviewIssue:
    return ReviewIssue(
        id=issue_id(kind, *key),
        type=kind,
        severity=severity,
        chapter_uids=list(uids),
        title=_clean_text(title),
        detail=_clean_text(detail),
        suggestion=_clean_text(suggestion),
        excerpt=_clean_text(excerpt),
        fixable=fixable,
        fix_instruction=_clean_text(fix_instruction),
    )


def _numbered(sentences: Sequence[str], limit: int = MAX_LISTED_SENTENCES, each: int = 120) -> str:
    """把句子列成编号清单，放进修订指令。"""
    lines = [
        f"{number}. {clip(_WS_RE.sub(' ', sentence), each)}" for number, sentence in enumerate(sentences[:limit], 1)
    ]
    if len(sentences) > limit:
        lines.append(f"（另有 {len(sentences) - limit} 句未列出，请一并检查）")
    return "\n".join(lines)


def _excerpt(sentences: Sequence[str], limit: int = EXCERPT_SENTENCES, each: int = 120) -> str:
    return "\n".join(clip(_WS_RE.sub(" ", sentence), each) for sentence in sentences[:limit])


# ---------------------------------------------------------------------------
# 1. 状态
# ---------------------------------------------------------------------------


def check_status(views: Sequence[ChapterView]) -> List[ReviewIssue]:
    """未生成、生成失败、没写完的章节。"""
    issues: List[ReviewIssue] = []
    for view in views:
        if view.state == STATE_EMPTY:
            issues.append(
                _issue(
                    "empty",
                    "high",
                    [view.uid],
                    [view.uid],
                    "章节尚未生成",
                    detail=f"「{view.label}」还没有正文。",
                    suggestion="生成本章，或手动填写正文。",
                )
            )
        elif view.state == STATE_FAILED:
            error = clip(_clean_text(view.record.error if view.record else ""), 300) or "未记录原因"
            kept = f"（失败前已写出的 {view.chars} 字还留着，不完整）" if view.has_text else ""
            issues.append(
                _issue(
                    "failed",
                    "high",
                    [view.uid],
                    [view.uid],
                    "章节生成失败",
                    detail=f"「{view.label}」生成失败{kept}：{error}",
                    suggestion="检查模型配置与网络后重新生成本章。",
                )
            )
        elif view.state == STATE_PARTIAL:
            reason = "写作被取消" if view.status == "cancelled" else "写作尚未结束或被中断"
            issues.append(
                _issue(
                    "partial",
                    "medium",
                    [view.uid],
                    [view.uid, "unfinished"],
                    "章节未写完",
                    detail=f"「{view.label}」{reason}，只有 {view.chars} 字的部分正文。",
                    suggestion="重新生成本章，或手动补全。",
                    excerpt=clip(view.text[-60:], 60),
                )
            )
        elif view.record is not None and view.record.truncated:
            issues.append(
                _issue(
                    "truncated",
                    "medium",
                    [view.uid],
                    [view.uid, "truncated"],
                    "章节正文被截断",
                    detail=f"「{view.label}」因输出长度上限被截断且未能续完，结尾可能不完整。",
                    suggestion="重新生成本章，或手动补全结尾。",
                    excerpt=clip(view.text[-60:], 60),
                )
            )
    return issues


# ---------------------------------------------------------------------------
# 2. 篇幅
# ---------------------------------------------------------------------------


def check_length(views: Sequence[ChapterView], budget: Optional[Dict[str, int]]) -> List[ReviewIssue]:
    """已完成章节的实际字数与目标字数相差过大。"""
    issues: List[ReviewIssue] = []
    for view in views:
        if view.state != STATE_DONE:
            continue
        target = _target_of(view, budget)
        if not target:
            continue
        actual = view.chars
        percent = actual * 100 // target
        if actual * 100 < target * LENGTH_SHORT_PERCENT:
            issues.append(
                _issue(
                    "length",
                    "medium",
                    [view.uid],
                    [view.uid, "short"],
                    "篇幅不足",
                    detail=f"「{view.label}」目标约 {target} 字，实际 {actual} 字（{percent}%）。",
                    suggestion="扩写本章，补充具体做法与细节。",
                    fixable=True,
                    fix_instruction=(
                        f"本章目标约 {target} 字，目前只有 {actual} 字。请在保留现有内容与结构的基础上扩写到约 {target} 字："
                        "补充具体做法、步骤、参数、分工与保障措施，不要重复已有内容，不要空泛铺陈；"
                        "需要企业自身的信息而资料里没有时，用【待补充：……】占位，不要编造。"
                    ),
                )
            )
        elif actual * 100 > target * LENGTH_LONG_PERCENT:
            issues.append(
                _issue(
                    "length",
                    "low",
                    [view.uid],
                    [view.uid, "long"],
                    "篇幅超出",
                    detail=f"「{view.label}」目标约 {target} 字，实际 {actual} 字（{percent}%）。",
                    suggestion="压缩本章；如果这一章确实需要这么长，可以调高它的篇幅权重。",
                    fixable=True,
                    fix_instruction=(
                        f"本章目标约 {target} 字，目前有 {actual} 字。请压缩到约 {target} 字："
                        "合并重复的表述，删去空泛的铺垫与套话，保留全部要点、数据和对评分项的响应。"
                    ),
                )
            )
    return issues


# ---------------------------------------------------------------------------
# 3. 占位符
# ---------------------------------------------------------------------------


def find_placeholders(views: Sequence[ChapterView]) -> List[PlaceholderItem]:
    """全书的占位清单。占位符是留给使用者的待办，不算缺陷，所以不产生 issue。"""
    items: List[PlaceholderItem] = []
    for view in views:
        if not view.has_text:
            continue
        for start, end in view.placeholder_spans:
            items.append(
                PlaceholderItem(
                    chapter_uid=view.uid, text=view.text[start:end], context=_context(view.text, start, end)
                )
            )
    return items


# ---------------------------------------------------------------------------
# 4. 跨章重复
# ---------------------------------------------------------------------------


def _is_duplicate(keys: Collection[str]) -> bool:
    """共有的句子够不够算重复：够多，或者有一句够长。"""
    return len(keys) >= MIN_SHARED_SENTENCES or any(len(key) >= LONG_SENTENCE_LEN for key in keys)


def _shared_sentences(views: Sequence[ChapterView]) -> Dict[Tuple[int, int], List[str]]:
    """两两章节共有的句子：{(靠前章序号, 靠后章序号): [归一化键]}。"""
    occurrences: Dict[str, List[int]] = {}
    for position, view in enumerate(views):
        for key in view.sentence_index:
            occurrences.setdefault(key, []).append(position)
    shared: Dict[Tuple[int, int], List[str]] = {}
    for key, positions in occurrences.items():
        if len(positions) < 2:
            continue
        for i, earlier in enumerate(positions):
            for later in positions[i + 1:]:
                shared.setdefault((earlier, later), []).append(key)
    return shared


def _similar_sentences(later: ChapterView, earlier: ChapterView, limit: int = EXCERPT_SENTENCES) -> List[str]:
    """靠后一章里与靠前一章最雷同的几个句子（按雷同程度）。"""
    scored: List[Tuple[float, int, str]] = []
    for order, (raw, key) in enumerate(later.long_sentences):
        grams = _shingles(key)
        if not grams:
            continue
        overlap = len(grams & earlier.shingles) / len(grams)
        if overlap >= 0.5:
            scored.append((-overlap, order, raw))
    scored.sort()
    return [raw for _, _, raw in scored[:limit]]


def check_cross_duplicates(views: Sequence[ChapterView]) -> List[ReviewIssue]:
    """不同章节之间的重复：先比完全相同的句子，再用 shingle 相似度补查改写式的雷同。"""
    texts = [view for view in views if view.has_text]
    issues: List[ReviewIssue] = []

    shared = _shared_sentences(texts)
    by_later: Dict[int, List[Tuple[int, List[str]]]] = {}
    sentence_pairs: Set[Tuple[int, int]] = set()
    for (earlier, later), keys in shared.items():
        if _is_duplicate(keys):
            sentence_pairs.add((earlier, later))
            by_later.setdefault(later, []).append((earlier, keys))

    for later in sorted(by_later):
        view = texts[later]
        # 同一句话可能和前面好几章都重复：每句只跟着共有句最多的那一章报一次，
        # 其余章节只有在还剩下够多没报过的句子时才另报，免得一句话刷出一串问题
        covered: Set[str] = set()
        reported = 0
        for earlier, keys in sorted(by_later[later], key=lambda item: (-len(item[1]), item[0])):
            fresh = {key for key in keys if key not in covered}
            if not _is_duplicate(fresh):
                continue
            covered |= fresh
            other = texts[earlier]
            sentences = [raw for key, raw in view.sentence_index.items() if key in fresh]
            total = len(keys)
            note = f"（其中 {total - len(sentences)} 句已在本章与其他章节的重复里列出）" if total > len(sentences) else ""
            issues.append(
                _issue(
                    "duplicate",
                    "high" if total >= HIGH_SHARED_SENTENCES else "medium",
                    [other.uid, view.uid],
                    # 重复的句子换了就是另一个问题：使用者之前标过「忽略」的不应把新问题也盖住
                    [other.uid, view.uid, "sentence", "|".join(sorted(keys))],
                    f"「{clip(view.label, 24)}」与「{clip(other.label, 24)}」有 {total} 句重复",
                    detail=f"「{view.label}」里有 {total} 个句子在前面的「{other.label}」里也出现过{note}。",
                    suggestion="保留前一章的表述，改写或删去后一章里的重复句子。",
                    excerpt=_excerpt(sentences),
                    fixable=True,
                    # 使用者也可能选择改靠前的那一章，所以指令两章都要读得通
                    fix_instruction=(
                        f"「{other.label}」与「{view.label}」这两章有 {len(sentences)} 个句子重复。"
                        "请只改写本章里的这些句子：换成本章特有的角度、对象或细节，确实多余的直接删去并理顺上下文；"
                        "句子里的数字、指标与专有名称不要改动，其余内容保持不变。重复的句子：\n"
                        + _numbered(sentences)
                    ),
                )
            )
            reported += 1
            if reported >= MAX_DUPLICATE_ISSUES_PER_CHAPTER:
                break

    # 近似重复：没有整句相同、但大段文字只是换了几个词。每章只报最像的那一章
    candidates = [(position, view) for position, view in enumerate(texts) if len(view.shingles) >= MIN_SHINGLES]
    for j in range(1, len(candidates)):
        later, view = candidates[j]
        size = len(view.shingles)
        sketch = view.sketch
        best_score = 0.0
        best: Optional[ChapterView] = None
        for i in range(j):
            earlier, other = candidates[i]
            if (earlier, later) in sentence_pairs:
                continue
            other_size = len(other.shingles)
            # Jaccard 不会超过 小集合/大集合，长度悬殊的直接跳过
            if min(size, other_size) < max(size, other_size) * SIMILARITY_THRESHOLD:
                continue
            # 粗筛：两两精确比较是全书最费时的一步，绝大多数章节对在这里就能排除
            if len(sketch & other.shingles) * SKETCH_MIN_HIT_RATIO < len(sketch):
                continue
            score = jaccard(other.shingles, view.shingles)
            if score >= SIMILARITY_THRESHOLD and score > best_score:
                best_score, best = score, other
        if best is None:
            continue
        percent = int(round(best_score * 100))
        samples = _similar_sentences(view, best)
        listed = ("雷同较明显的句子（按后一章的写法）例如：\n" + _numbered(samples)) if samples else ""
        issues.append(
            _issue(
                "duplicate",
                "medium",
                [best.uid, view.uid],
                [best.uid, view.uid, "similar"],
                f"「{clip(view.label, 24)}」与「{clip(best.label, 24)}」内容高度相似",
                detail=f"「{view.label}」与前面的「{best.label}」文字相似度约 {percent}%，像是同一段内容的改写。",
                suggestion="重写后一章里雷同的部分，突出本章特有的内容。",
                excerpt=_excerpt(samples),
                fixable=True,
                # 使用者也可能选择改靠前的那一章，所以指令两章都要读得通
                fix_instruction=(
                    f"「{best.label}」与「{view.label}」这两章内容高度相似（相似度约 {percent}%）。"
                    "请重写本章里与另一章雷同的部分：围绕本章标题写出本章特有的对象、做法、指标与细节，换掉雷同的句式；"
                    "本章已有的要点、表格数据和对评分项的响应要保留，数字与指标不要改动。" + listed
                ),
            )
        )
    return issues


# ---------------------------------------------------------------------------
# 5. 章内重复
# ---------------------------------------------------------------------------


def _inner_repeats(view: ChapterView) -> List[Tuple[str, str, int]]:
    """一章里重复出现的句子：[(归一化键, 首次出现的原文, 出现次数)]，按首次出现的顺序。

    两种情况算重复：够长的句子出现两次以上；较短的句子接连出现好几次（模型「复读」）。
    """
    counts: Dict[str, int] = {}
    first_raw: Dict[str, str] = {}
    longest_run: Dict[str, int] = {}
    previous = ""
    run = 0
    for raw, key in view.sentences:
        if not key:  # 只有标点的行，把前后隔开
            previous, run = "", 0
            continue
        counts[key] = counts.get(key, 0) + 1
        first_raw.setdefault(key, raw)
        run = run + 1 if key == previous else 1
        previous = key
        longest_run[key] = max(longest_run.get(key, 0), run)

    result: List[Tuple[str, str, int]] = []
    for key, times in counts.items():
        if times < 2:
            continue
        stuck = len(key) >= RUN_MIN_SENTENCE_LEN and longest_run[key] >= RUN_MIN_TIMES
        if len(key) < MIN_SENTENCE_LEN and not stuck:
            continue
        raw = first_raw[key]
        if _is_reference_entry(raw) or _is_mostly_placeholder(raw):
            continue
        result.append((key, raw, times))
    return result


def check_inner_repeats(views: Sequence[ChapterView]) -> List[ReviewIssue]:
    """同一章里同一句话出现多次（续写拼接的常见瑕疵）。每章汇总成一条。"""
    issues: List[ReviewIssue] = []
    for view in views:
        if not view.has_text:
            continue
        found = _inner_repeats(view)
        if not found:
            continue
        repeated_keys = [key for key, _, _ in found]
        repeated = [(raw, times) for _, raw, times in found]
        sentences = [raw for raw, _ in repeated]
        extra = sum(times - 1 for _, times in repeated)
        listing = "\n".join(
            f"{number}. {clip(_WS_RE.sub(' ', raw), 120)}（出现 {times} 次）"
            for number, (raw, times) in enumerate(repeated[:MAX_LISTED_SENTENCES], 1)
        )
        if len(repeated) > MAX_LISTED_SENTENCES:
            listing += f"\n（另有 {len(repeated) - MAX_LISTED_SENTENCES} 句未列出，请一并检查）"
        issues.append(
            _issue(
                "repeat",
                "medium",
                [view.uid],
                [view.uid, "|".join(sorted(repeated_keys))],
                "章内有句子重复出现",
                detail=f"「{view.label}」里有 {len(repeated)} 个句子重复出现，共多出 {extra} 处。",
                suggestion="每句只保留一处，删去其余重复。",
                excerpt=_excerpt(sentences),
                fixable=True,
                fix_instruction=(
                    "本章以下句子重复出现（多为续写拼接造成）。请每句只保留位置最合适的一处，删去其余重复并理顺上下文衔接，"
                    "不要改动其他内容：\n" + listing
                ),
            )
        )
    return issues


# ---------------------------------------------------------------------------
# 6. 套话与模型口吻
# ---------------------------------------------------------------------------


def check_boilerplate(views: Sequence[ChapterView]) -> List[ReviewIssue]:
    """填充套话堆砌（low）与模型口吻残留（medium）。"""
    issues: List[ReviewIssue] = []
    for view in views:
        if not view.has_text:
            continue
        counts = count_filler_phrases(view.text)
        total = sum(counts.values())
        if total >= FILLER_THRESHOLD:
            summary = "、".join(f"{phrase}（{times} 次）" for phrase, times in counts.items())
            issues.append(
                _issue(
                    "boilerplate",
                    "low",
                    [view.uid],
                    [view.uid, "filler"],
                    "套话偏多",
                    detail=f"「{view.label}」里填充式套话出现 {total} 次：{summary}。",
                    suggestion="删掉这些套话，直接写具体内容。",
                    excerpt=_first_filler_sentence(view.text),
                    fixable=True,
                    fix_instruction=(
                        f"本章有 {total} 处填充式套话：{summary}。请删去这些套话，或改成直接陈述具体内容的句子；"
                        "其余内容、要点与数据保持不变。"
                    ),
                )
            )
        voices = find_ai_voice(view.text)
        if voices:
            issues.append(
                _issue(
                    "boilerplate",
                    "medium",
                    [view.uid],
                    [view.uid, "voice", "|".join(sorted(_squash(voice) for voice in voices))],
                    "有模型口吻残留",
                    detail=f"「{view.label}」里有 {len(voices)} 处像是模型对话的语句，不应出现在标书正文里。",
                    suggestion="删掉这些语句。",
                    excerpt=_excerpt(voices),
                    fixable=True,
                    fix_instruction=(
                        "本章残留了模型对话口吻的语句（自我介绍、面向提问者的开场白、结束语或提示）。"
                        "请把它们删掉，只保留标书正文，其余内容保持不变。涉及的语句：\n" + _numbered(voices)
                    ),
                )
            )
    return issues


# ---------------------------------------------------------------------------
# 7. 标记残留
# ---------------------------------------------------------------------------


def check_markup(views: Sequence[ChapterView]) -> List[ReviewIssue]:
    """代码围栏、一二级 Markdown 标题、HTML 标签、未闭合的 **。每章汇总成一条。"""
    issues: List[ReviewIssue] = []
    for view in views:
        if not view.has_text:
            continue
        residue = find_markup_residue(view.text)
        if not residue:
            continue
        summary = "、".join(f"{MARKUP_LABELS[kind]} {len(hits)} 处" for kind, hits in residue.items())
        samples = [hits[0] for hits in residue.values()]
        issues.append(
            _issue(
                "markup",
                "low",
                [view.uid],
                [view.uid, "|".join(sorted(residue))],
                "正文里有标记残留",
                detail=f"「{view.label}」里有：{summary}。",
                suggestion="删掉这些标记或改成正文文字，避免原样带进导出的文档。",
                excerpt=_excerpt(samples, limit=len(MARKUP_LABELS), each=80),
            )
        )
    return issues


# ---------------------------------------------------------------------------
# 8. 评分点覆盖
# ---------------------------------------------------------------------------


def _requirement_key(value: object) -> str:
    return _clean_text(value).strip().upper()


def _owners(views: Sequence[ChapterView], blueprint: Optional[Blueprint]) -> Dict[str, List[ChapterView]]:
    """要求编号 → 负责章节（按文档顺序）。只认当前目录里还存在的章节。"""
    owners: Dict[str, List[ChapterView]] = {}
    if blueprint is None:
        return owners
    plans = blueprint.plans or {}
    for view in views:
        plan = plans.get(view.uid)
        if plan is None:
            continue
        for raw in plan.requirement_ids or []:
            bucket = owners.setdefault(_requirement_key(raw), [])
            if view not in bucket:
                bucket.append(view)
    return owners


def _effective_keywords(item: RequirementItem) -> List[Tuple[str, str]]:
    """参与覆盖判断的关键词：(原词, 比对用形式)，去掉过短与重复的。"""
    result: List[Tuple[str, str]] = []
    seen: Set[str] = set()
    for raw in item.keywords or []:
        word = _clean_text(raw).strip()
        folded = _fold(word)
        if len(folded) < MIN_KEYWORD_LEN or folded in seen:
            continue
        seen.add(folded)
        result.append((word, folded))
    return result


def _keyword_found(folded: str, texts: Sequence[str]) -> bool:
    forms = [folded]
    core = folded.lstrip(_COMPARATORS)
    if core != folded and len(core) >= MIN_KEYWORD_LEN:
        forms.append(core)
    return any(form in text for text in texts for form in forms)


def check_coverage(
    views: Sequence[ChapterView],
    requirements: Optional[Sequence[RequirementItem]],
    blueprint: Optional[Blueprint],
) -> Tuple[List[CoverageItem], List[ReviewIssue]]:
    """逐条检查评审项 / 采购人要求有没有章节负责、负责章节写了没有、必含关键词出现了没有。"""
    coverage: List[CoverageItem] = []
    issues: List[ReviewIssue] = []
    owners = _owners(views, blueprint)

    for item in requirements or []:
        rid = _clean_text(item.id).strip()
        name = _clean_text(item.name).strip()
        kind = _clean_text(item.kind).strip() or "scoring"
        noun = "采购人要求" if kind == "requirement" else "评分项"
        display = f"{rid} {name}".strip()
        score = f"（{clip(_clean_text(item.score), 20)}）" if item.score else ""
        responsible = owners.get(_requirement_key(item.id), [])
        uids = [view.uid for view in responsible]

        if not responsible:
            if blueprint is None:
                note = "尚未生成写作计划"
                reason = "还没有写作计划，无法确定由哪一章负责响应"
                suggestion = "先生成写作计划，把各评分项分配到章节。"
            else:
                note = "没有章节负责"
                reason = "在写作计划里没有分配给任何章节，正文很可能没有针对性的响应"
                suggestion = "在写作计划里把它分配给合适的章节；没有合适的章节时调整目录后重新规划。"
            coverage.append(
                CoverageItem(requirement_id=rid, name=name, kind=kind, status="unassigned", note=note)
            )
            issues.append(
                _issue(
                    "coverage",
                    "high",
                    [],
                    [rid, "unassigned"],
                    f"{noun}没有章节负责：{clip(display, 40)}",
                    detail=f"{display}{score}{reason}。"
                    + (f"要求：{clip(_clean_text(item.detail), 160)}" if item.detail else ""),
                    suggestion=suggestion,
                )
            )
            continue

        written = [view for view in responsible if view.has_text]
        if not written:
            coverage.append(
                CoverageItem(
                    requirement_id=rid,
                    name=name,
                    kind=kind,
                    status="missing",
                    chapter_uids=uids,
                    note="负责章节都还没有正文",
                )
            )
            continue

        keywords = _effective_keywords(item)
        texts = [view.folded for view in written]
        missing = [word for word, folded in keywords if not _keyword_found(folded, texts)]
        hit = len(keywords) - len(missing)
        hit_ok = hit * 100 >= len(keywords) * COVERAGE_HIT_PERCENT
        unfinished = [view for view in responsible if view.state != STATE_DONE]
        hit_note = f"关键词命中 {hit}/{len(keywords)}" if keywords else "没有必含关键词"

        if not unfinished and hit_ok:
            coverage.append(
                CoverageItem(
                    requirement_id=rid,
                    name=name,
                    kind=kind,
                    status="covered",
                    chapter_uids=uids,
                    missing_keywords=missing,
                    note=hit_note,
                )
            )
            continue

        notes = [hit_note]
        if unfinished:
            notes.append(f"{len(unfinished)} 个负责章节未完成")
        coverage.append(
            CoverageItem(
                requirement_id=rid,
                name=name,
                kind=kind,
                status="partial",
                chapter_uids=uids,
                missing_keywords=missing,
                note="，".join(notes),
            )
        )
        chapters_text = "、".join(f"「{view.label}」" for view in responsible[:6])
        details = [f"{display}{score}的负责章节：{chapters_text}。"]
        if unfinished:
            details.append("其中未完成：" + "、".join(f"「{view.label}」" for view in unfinished[:6]) + "。")
        if missing:
            details.append(f"{hit_note}，正文里没有出现：{'、'.join(missing)}。")
        # 关键词已经够了、只差章节没写完时，修订帮不上忙，得先把章节写完
        fixable = not hit_ok
        issues.append(
            _issue(
                "coverage",
                "medium",
                uids,
                [rid, "partial"],
                f"{noun}响应不充分：{clip(display, 40)}",
                detail="".join(details),
                suggestion="在负责章节里补上针对性的响应与缺失的关键词。" if fixable else "先把未完成的负责章节写完，再重新检查。",
                fixable=fixable,
                fix_instruction=(
                    f"{noun}「{display}」{score}的响应还不充分，正文里没有出现这些关键词：{'、'.join(missing)}。"
                    "请在本章合适的位置补充对它的针对性响应，把上述关键词自然地写进去（用词与招标文件保持一致）；"
                    "不要改动与此无关的内容；需要企业自身的信息而资料里没有时，用【待补充：……】占位，不要编造。"
                    + (f"招标文件的要求：{clip(_clean_text(item.detail), 300)}" if item.detail else "")
                )
                if fixable
                else "",
            )
        )
    return coverage, issues


# ---------------------------------------------------------------------------
# 9. 统计、排序与总入口
# ---------------------------------------------------------------------------


def compute_stats(
    views: Sequence[ChapterView],
    budget: Optional[Dict[str, int]],
    placeholder_count: int = 0,
    issue_count: int = 0,
) -> ReviewStats:
    budget = budget or {}
    return ReviewStats(
        leaf_total=len(views),
        done=sum(1 for view in views if view.state == STATE_DONE),
        failed=sum(1 for view in views if view.state == STATE_FAILED),
        empty=sum(1 for view in views if view.state == STATE_EMPTY),
        total_chars=sum(view.chars for view in views),
        target_chars=sum(_positive_int(budget.get(view.uid)) for view in views),
        placeholder_count=placeholder_count,
        issue_count=issue_count,
    )


def sort_issues(issues: Sequence[ReviewIssue], uid_order: Sequence[str]) -> List[ReviewIssue]:
    """按严重度（high → medium → low）再按文档顺序排序。

    多章节的问题按其中最靠前的章节算；不涉及具体章节的排在同级最后。其余保持原有先后。
    """
    position: Dict[str, int] = {}
    for index, uid in enumerate(uid_order):
        position.setdefault(uid, index)
    tail = len(position)

    def sort_key(issue: ReviewIssue) -> Tuple[int, int]:
        places = [position[uid] for uid in issue.chapter_uids if uid in position]
        return SEVERITY_ORDER.get(issue.severity, len(SEVERITY_ORDER)), min(places) if places else tail

    return sorted(issues, key=sort_key)


def _guarded(label: str, check: Callable[[], T], fallback: T, warnings: List[str]) -> T:
    """单项检查出错时跳过它并记一条提示，不让整次审校失败。"""
    try:
        return check()
    except Exception as exc:  # noqa: BLE001
        logger.exception("本地审校的「%s」检查出错", label)
        warnings.append(f"「{label}」检查出错，已跳过：{clip(_clean_text(exc), 120)}")
        return fallback


def run_local_review(
    leaves: List[LeafInfo],
    chapters: Dict[str, ChapterRecord],
    budget: Dict[str, int],
    requirements: List[RequirementItem],
    blueprint: Optional[Blueprint] = None,
) -> ReviewReport:
    """对全书做一轮本地审校（不调用模型）。"""
    views = build_views(leaves, chapters)
    warnings: List[str] = []
    issues: List[ReviewIssue] = []

    issues += _guarded("章节状态", lambda: check_status(views), [], warnings)
    issues += _guarded("篇幅", lambda: check_length(views, budget), [], warnings)
    issues += _guarded("跨章重复", lambda: check_cross_duplicates(views), [], warnings)
    issues += _guarded("章内重复", lambda: check_inner_repeats(views), [], warnings)
    issues += _guarded("套话与模型口吻", lambda: check_boilerplate(views), [], warnings)
    issues += _guarded("标记残留", lambda: check_markup(views), [], warnings)
    empty_coverage: Tuple[List[CoverageItem], List[ReviewIssue]] = ([], [])
    coverage, coverage_issues = _guarded(
        "评分点覆盖", lambda: check_coverage(views, requirements, blueprint), empty_coverage, warnings
    )
    issues += coverage_issues
    placeholders = _guarded("占位符", lambda: find_placeholders(views), [], warnings)

    if not requirements:
        warnings.append("没有结构化的评分项，已跳过评分点覆盖检查。")
    elif blueprint is None:
        warnings.append("尚未生成写作计划，无法判断各评分项由哪些章节负责。")

    issues = sort_issues(issues, [view.uid for view in views])
    # 正常情况下 ID 不会相同；万一撞上（如要求编号重复），加序号保证清单里唯一
    seen: Dict[str, int] = {}
    for issue in issues:
        count = seen.get(issue.id, 0)
        seen[issue.id] = count + 1
        if count:
            issue.id = f"{issue.id}-{count + 1}"

    stats = _guarded(
        "统计", lambda: compute_stats(views, budget, len(placeholders), len(issues)), ReviewStats(), warnings
    )
    return ReviewReport(
        generated_at=now_iso(),
        deep=False,
        stats=stats,
        issues=issues,
        coverage=coverage,
        placeholders=placeholders,
        warnings=warnings,
    )
