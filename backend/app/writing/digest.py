"""章节摘记：一章写完后提炼出“写了什么、定了哪些数”。

后面的章节拿它当上下文（避免重复、保持一致），审校拿它查前后矛盾。
用本地规则提取，不调用模型：零成本、不会失败。
"""
from __future__ import annotations

import re
from typing import List, Optional

from .models import ChapterDigest
from .textutil import clip, split_sentences

_SKIP_LINE_RE = re.compile(r"^\s*(#{1,6}\s|\||```|[-*_]{3,}\s*$)")
_LIST_MARK_RE = re.compile(r"^\s*(?:[-*•·]|\d+[\.、)）])\s+")
_MARKUP_RE = re.compile(r"[*`]+")
_NUMBER_RE = re.compile(r"\d")
_UNIT_RE = re.compile(
    r"\d\s*(?:%|％|‰|小时|分钟|秒|毫秒|ms|天|日历天|工作日|日|周|个月|月|年|人|名|台|套|个|项|次|"
    r"万元|元|万|GB|TB|MB|Mbps|kW|MW|℃|米|公里|km|ppm|mg)"
)
_COMMIT_RE = re.compile(r"不低于|不少于|不超过|不大于|不高于|不小于|以内|以上|≥|≤|<=|>=|承诺|保证|确保|达到")

MAX_SUMMARY_CHARS = 150
MAX_CLAIMS = 8
MAX_CLAIM_CHARS = 90


def _body_sentences(content: str) -> List[str]:
    sentences: List[str] = []
    for line in (content or "").splitlines():
        if not line.strip() or _SKIP_LINE_RE.match(line):
            continue
        text = _MARKUP_RE.sub("", _LIST_MARK_RE.sub("", line)).strip()
        sentences.extend(split_sentences(text))
    return sentences


def _table_claims(content: str) -> List[str]:
    """表格行里带数字的也算（指标表、配置清单常见），整行压成一句。"""
    rows: List[str] = []
    for line in (content or "").splitlines():
        stripped = line.strip()
        if not stripped.startswith("|") or re.match(r"^\|?[\s:\-|]+\|?$", stripped):
            continue
        cells = [c.strip() for c in stripped.strip("|").split("|") if c.strip()]
        row = "：".join(cells[:2]) + ("；" + "；".join(cells[2:]) if len(cells) > 2 else "")
        if _UNIT_RE.search(row):
            rows.append(_MARKUP_RE.sub("", row))
    return rows


def build_digest(content: str, section_titles: Optional[List[str]] = None) -> ChapterDigest:
    """从正文提炼摘记。"""
    sentences = _body_sentences(content)

    summary_parts: List[str] = []
    used = 0
    for sentence in sentences:
        if used and used + len(sentence) > MAX_SUMMARY_CHARS:
            break
        summary_parts.append(sentence)
        used += len(sentence)
        if used >= 80:
            break
    summary = clip("".join(summary_parts), MAX_SUMMARY_CHARS)
    if section_titles:
        summary = clip(f"{summary}（小节：{'；'.join(section_titles[:8])}）", MAX_SUMMARY_CHARS + 120)

    candidates = [s for s in sentences if _NUMBER_RE.search(s) and _UNIT_RE.search(s)]
    candidates.extend(_table_claims(content))
    committed = [s for s in candidates if _COMMIT_RE.search(s)]
    others = [s for s in candidates if not _COMMIT_RE.search(s)]

    claims: List[str] = []
    for sentence in committed + others:
        claim = clip(sentence, MAX_CLAIM_CHARS)
        if claim not in claims:
            claims.append(claim)
        if len(claims) >= MAX_CLAIMS:
            break

    return ChapterDigest(summary=summary, claims=claims)
