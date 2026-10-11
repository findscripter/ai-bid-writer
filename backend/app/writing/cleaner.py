"""模型输出的清洗与拼接。

模型常见的小毛病：把章节标题又写一遍、开头来一句“好的，以下是……”、结尾附上
“以上就是本章的全部内容”或字数统计、整段包在代码围栏里、用一二级标题、把思考过程
（<think>…</think>）混在正文里。这些都在这里收拾掉。

原则是保守：只删明确属于“对提问者说话”的整行，绝不动正文内容。正文里本来就有
“以下为部署方案：”“如需进一步支持，我方将……”这类句子，它们不能被当成废话删掉。
"""
from __future__ import annotations

import re
from typing import List

_FENCE_OPEN_RE = re.compile(r"^```[A-Za-z]*\s*$")
_HEADING_RE = re.compile(r"^(#{1,6})\s*(.*)$")
_NUMBERING_RE = re.compile(r"^[\s\d\.、．)）(（一二三四五六七八九十第章节]+")
_THINK_RE = re.compile(r"<think>.*?</think>\s*", re.DOTALL)

# 开场白：只认明确是在回应提问者的句式
_PREAMBLE_RE = re.compile(
    r"^(?:好的|好|当然|没问题|明白|收到)[，,！!。]*$"
    r"|^(?:好的|好|当然|没问题|明白|收到)[，,！!]\s*(?:以下|下面|这是|现在|我(?:来|将|已|会)|为您|为你|给您|给你)"
    r"|^根据(?:您|你)(?:的)?(?:要求|提供|给出|需求)"
    r"|^现(?:在)?(?:为您|为你)"
    r"|^(?:以下|下面)(?:是|为)(?:为您|为你|您要的|你要的|撰写的|编写的|本章节?的?(?:正文|内容)|该章节?的?(?:正文|内容))"
    r"|^本章节?(?:的)?(?:正文|内容)如下"
)

# 结束语：同样只认对提问者说的话
_CLOSING_RE = re.compile(
    r"^(?:以上(?:就)?(?:是|为)(?:本|该)?(?:章节?|节|部分)?(?:的)?(?:全部|完整)?(?:正文|内容)"
    r"|以上内容(?:仅供参考|供参考|可根据)"
    r"|希望(?:以上|这些|本)[^。！!]{0,20}(?:帮助|有用|满足|参考|需要)"
    r"|如(?:需|有需要|果需要|需要)[^。！!]{0,16}(?:请(?:告诉|告知|随时|提出|说明)|欢迎|可以告诉我|随时告诉我)"
    r"|若(?:需|有需要)[^。！!]{0,16}(?:请(?:告诉|告知|随时|提出)|欢迎)"
    r"|请根据(?:实际|具体)情况(?:调整|修改|补充|完善|填写)"
    r"|(?:注|说明)[:：]\s*以上(?:内容|正文|数据))"
)
# 出现这些词说明是正文里对采购人的承诺（例如售后服务章节的结尾），不是对提问者说话
_CONTENT_MARKERS_RE = re.compile(r"我方|本公司|我公司|我单位|投标人|项目组|热线|电话|邮箱|采购人|甲方")

_WORD_COUNT_RE = re.compile(
    r"^(?:[（(\[【]\s*(?:注[:：]\s*)?[^，。]{0,10}(?:共|约|合计|总计|统计|字数)[^，。]{0,12}\d+\s*余?字[^，。]{0,8}[）)\]】]"
    r"|(?:注[:：]\s*)?(?:全文|本章|本节|正文|字数(?:统计)?)[^，。]{0,8}(?:共|约|合计|总计|统计|[:：])[^，。]{0,12}\d+\s*余?字[^，。]{0,8})"
    r"[。.]?$"
)

# 截断后续写时，模型常在开头先客气一句“好的，接下来继续撰写。”——这句要去掉
_CONTINUE_PREAMBLE_RE = re.compile(
    r"^\s*(?:好的|好|当然|没问题|明白|收到)[，,]?[^。\n！!：:]{0,20}(?:继续|接着|续写|接下来)[^。\n！!：:]{0,20}[。！!：:]\s*"
)
# 续写内容以这些开头时是新的一行（表格行、列表项、小标题），不能直接粘到上一行末尾
_BLOCK_START_RE = re.compile(r"^(?:\||#{1,6}\s|[-*•]\s|\d+[\.、)）]\s?)")
_BLANK_RUN_RE = re.compile(r"\n{3,}")


def strip_think(text: str) -> str:
    """去掉推理模型混在正文里的思考过程。只有开头的 <think> 没有结束标记时，说明全是思考，返回空串。"""
    if not text or "<think>" not in text:
        return text
    value = _THINK_RE.sub("", text)
    if value.lstrip().startswith("<think>") and "</think>" not in value:
        return ""
    return value


def _normalize_title(text: str) -> str:
    """去掉井号、星号、编号、标点和空白，只留标题文字，用来判断“是不是把标题又写了一遍”。"""
    value = text.strip().strip("#*＊ \t")
    value = _NUMBERING_RE.sub("", value)
    value = re.sub(r"[\s:：*＊。.·、]+", "", value)
    return value


def _strip_wrapping_fence(text: str) -> str:
    lines = text.strip().splitlines()
    if len(lines) >= 2 and _FENCE_OPEN_RE.match(lines[0].strip()) and lines[-1].strip() == "```":
        inner = lines[1:-1]
        # 只有整段被包住才拆：里面还有别的围栏说明是正文里的代码块，别动
        if not any(line.strip().startswith("```") for line in inner):
            return "\n".join(inner)
    return text


def _is_preamble(line: str, standalone: bool) -> bool:
    return (
        len(line) <= 60
        and bool(_PREAMBLE_RE.match(line))
        and (line.endswith(("：", ":")) or standalone)
        and not _CONTENT_MARKERS_RE.search(line)
    )


def _is_closing(line: str) -> bool:
    if len(line) > 80:
        return False
    if _WORD_COUNT_RE.match(line):
        return True
    return bool(_CLOSING_RE.match(line)) and not _CONTENT_MARKERS_RE.search(line)


def demote_headings(text: str) -> str:
    """把正文里的一二级标题降为三级，避免和章节标题的层级打架。"""
    lines: List[str] = []
    in_fence = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("```"):
            in_fence = not in_fence
            lines.append(line)
            continue
        if not in_fence:
            match = _HEADING_RE.match(stripped)
            if match and len(match.group(1)) < 3 and match.group(2).strip():
                lines.append(f"### {match.group(2).strip()}")
                continue
        lines.append(line)
    return "\n".join(lines)


def clean_chapter_text(text: str, title: str = "", chapter_id: str = "") -> str:
    """清洗一章（或一个小节）的模型输出。"""
    if not text:
        return ""
    value = strip_think(text.replace("\r\n", "\n").replace("\r", "\n"))
    value = _strip_wrapping_fence(value).strip()
    lines = value.split("\n")

    title_key = _normalize_title(title) if title else ""

    # 开头：最多清掉三行“标题重复 / 开场白”
    for _ in range(3):
        while lines and not lines[0].strip():
            lines.pop(0)
        if not lines:
            break
        head = lines[0].strip()
        is_title = bool(title_key) and len(head) <= len(title) + 16 and _normalize_title(head) == title_key
        standalone = len(lines) == 1 or not lines[1].strip()
        if is_title or _is_preamble(head, standalone):
            lines.pop(0)
            continue
        break

    # 结尾：最多清掉三行“结束语 / 字数统计”
    for _ in range(3):
        while lines and not lines[-1].strip():
            lines.pop()
        if not lines:
            break
        tail = lines[-1].strip()
        if _is_closing(tail) or tail in ("---", "***", "___"):
            lines.pop()
            continue
        break

    value = demote_headings("\n".join(lines))
    value = _BLANK_RUN_RE.sub("\n\n", value)
    return value.strip()


def strip_preamble(text: str) -> str:
    """去掉续写内容开头的客套话，其余原样保留（截断后的续写开头可能正处在句子中间）。"""
    value = strip_think(text)
    match = _CONTINUE_PREAMBLE_RE.match(value)
    if match:
        return value[match.end():]
    lines = value.split("\n")
    index = 0
    while index < len(lines) and not lines[index].strip():
        index += 1
    if index < len(lines):
        head = lines[index].strip()
        if _is_preamble(head, standalone=False):
            return "\n".join(lines[index + 1:]).lstrip("\n")
    return value


def strip_overlap(previous: str, more: str, min_overlap: int = 12, window: int = 800) -> str:
    """续写时模型常把上文最后一两句再抄一遍；把这段重复从续写内容的开头去掉。"""
    if not previous or not more:
        return more
    tail = previous[-window:]
    head = more.lstrip()
    limit = min(len(tail), len(head))
    for size in range(limit, min_overlap - 1, -1):
        if tail.endswith(head[:size]):
            return head[size:]
    return more


def join_continuation(previous: str, more: str, truncated: bool) -> str:
    """把续写内容接到已有正文后面。

    truncated=True 表示上文是被长度上限拦腰截断的，直接相接；但续写以表格行、列表项、
    小标题开头时，说明截断点正好落在行尾，要换行再接，否则两行会粘成一行。
    否则是“写完了但篇幅不够”的补写，另起一段。
    """
    more = strip_overlap(previous, more)
    if not more.strip():
        return previous
    if truncated:
        if previous and not previous.endswith("\n") and _BLOCK_START_RE.match(more.lstrip(" ")):
            return previous + "\n" + more.lstrip(" ")
        return previous + more
    return previous.rstrip() + "\n\n" + more.lstrip()
