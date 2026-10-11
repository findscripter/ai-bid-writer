"""把「技术评分要求」文本解析成结构化条目。

解析阶段让模型按固定格式输出（见 utils/prompts/analysis_prompts.py）：

    【评审项ID】：E1
    【评审项名称】：……
    【分值或权重】：……
    【评审标准】：……
    【原文位置】：……
    【目录建议】：……

    【要求ID】：R1
    【要求名称】：……
    【关键约束/指标】：……
    【必含关键词】：……

模型的输出不一定严格守格式，使用者也可能手改过，所以这里尽量宽松：
认得出多少算多少；一条都认不出时返回空列表，调用方把整段文本当作普通上下文使用。
"""
from __future__ import annotations

import re
from typing import Dict, List, Optional

from .models import RequirementItem
from .textutil import clip

_FIELD_RE = re.compile(r"【\s*([^】\n]{1,24}?)\s*】\s*[:：]?[ \t]*")
_ID_VALUE_RE = re.compile(r"[A-Za-z]{1,3}\s*-?\s*\d{1,3}")
# 字段值在遇到这些「下一段」的迹象时截断，避免把后面的小标题、校验清单吞进来
_VALUE_STOP_RE = re.compile(r"\n\s*(?:#{1,6}\s|[一二三四五六七八九十]+、|[-*]\s*\[[ xX]?\])")
_EMPTY_VALUES = {"未提及", "无", "暂无", "/", "-", "—", "略", "不适用"}
_KEYWORD_SPLIT_RE = re.compile(r"[、，,；;\n]+")


def _is_id_label(label: str) -> bool:
    return bool(re.search(r"(ID|编号|序号)$", label, flags=re.IGNORECASE)) and ("评" in label or "要求" in label)


def _field_name(label: str) -> Optional[str]:
    if "名称" in label:
        return "name"
    if "分值" in label or "权重" in label:
        return "score"
    if "关键词" in label:
        return "keywords"
    if "位置" in label:
        return "location"
    if "建议" in label:
        return "suggestion"
    if "标准" in label or "约束" in label or "指标" in label or "要求" in label:
        return "detail"
    return None


def _clean_value(value: str) -> str:
    stop = _VALUE_STOP_RE.search(value)
    if stop:
        value = value[: stop.start()]
    # 「**【要求ID】**：R1」这种加粗写法里，冒号落在了字段值的开头
    value = value.replace("**", "").strip().lstrip(":： \t").strip("-*·• \t")
    value = re.sub(r"\n{2,}", "\n", value).strip()
    return "" if value in _EMPTY_VALUES else value


def _split_keywords(value: str) -> List[str]:
    # 去掉「（数字、型号、术语，如 …）」这类说明性括注的开头，保留括号里的实际内容
    value = re.sub(r"^[（(]\s*(?:数字|型号|术语)[^）)]{0,40}?如\s*", "", value).rstrip("）)")
    result: List[str] = []
    for part in _KEYWORD_SPLIT_RE.split(value):
        word = part.strip().strip("。.()（）\"“”'` ")
        if not word or word in _EMPTY_VALUES or len(word) > 30:
            continue
        if word not in result:
            result.append(word)
    return result[:20]


def parse_requirements(text: Optional[str]) -> List[RequirementItem]:
    """解析评审项与采购人要求条目；解析不出时返回空列表。"""
    if not text or "【" not in text:
        return []

    markers = list(_FIELD_RE.finditer(text))
    items: List[RequirementItem] = []
    current: Optional[Dict[str, str]] = None
    current_start = 0

    def _finish(end: int) -> None:
        nonlocal current
        if not current:
            return
        raw = text[current_start:end]
        stop = _VALUE_STOP_RE.search(raw)
        if stop:
            raw = raw[: stop.start()]
        items.append(
            RequirementItem(
                id=current["id"],
                kind=current["kind"],
                name=current.get("name", ""),
                score=current.get("score", ""),
                detail=current.get("detail", ""),
                keywords=_split_keywords(current.get("keywords", "")),
                location=current.get("location", ""),
                suggestion=current.get("suggestion", ""),
                raw=raw.strip(),
            )
        )
        current = None

    for index, marker in enumerate(markers):
        label = marker.group(1).strip()
        value_end = markers[index + 1].start() if index + 1 < len(markers) else len(text)
        value = _clean_value(text[marker.end():value_end])

        if _is_id_label(label):
            _finish(marker.start())
            id_match = _ID_VALUE_RE.search(value)
            if not id_match:
                continue
            item_id = re.sub(r"[\s-]", "", id_match.group()).upper()
            if "评" in label or item_id.startswith("E"):
                kind = "scoring"
            else:
                kind = "requirement"
            current = {"id": item_id, "kind": kind}
            current_start = marker.start()
            continue

        if current is None:
            continue
        field = _field_name(label)
        if field and value and field not in current:
            current[field] = value

    _finish(len(text))

    # 编号去重：重复的编号加后缀，保证后续按 id 建索引不会互相覆盖
    seen: Dict[str, int] = {}
    for item in items:
        count = seen.get(item.id, 0)
        seen[item.id] = count + 1
        if count:
            item.id = f"{item.id}-{count + 1}"
    return items


def requirement_line(item: RequirementItem, detail_chars: int = 120) -> str:
    """把一条要求压成一行，放进提示词。"""
    parts = [f"{item.id} {item.name}".strip()]
    if item.score:
        parts.append(f"（{clip(item.score, 20)}）")
    line = "".join(parts)
    if item.detail:
        line += f"：{clip(item.detail.replace(chr(10), ' '), detail_chars)}"
    if item.keywords:
        line += f"；必含关键词：{'、'.join(item.keywords[:10])}"
    return line


def requirements_brief(items: List[RequirementItem], max_chars: int = 6000, detail_chars: int = 120) -> str:
    """把全部要求压成紧凑清单；过长时逐步缩短每条的说明。"""
    for limit in (detail_chars, 60, 30, 0):
        lines = [requirement_line(item, limit) if limit else f"{item.id} {item.name}".strip() for item in items]
        text = "\n".join(f"- {line}" for line in lines)
        if len(text) <= max_chars:
            return text
    return clip(text, max_chars)
