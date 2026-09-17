"""强制响应章节注入器。

针对中国政府/央企招标文件的常见评审逻辑，技术标往往需要若干
「响应表型章节」。这些章节如果缺失，初步评审可能直接判废标，
或在详细评审里被批量扣分。

本模块在多份生成时把这些章节追加到目录末尾。章节 description
只约束写作格式与覆盖范围，具体数字、地点、型号必须由模型从
项目概述 / 招标文件原文提取，不得使用任何预置项目事实。
"""
from __future__ import annotations

import copy
from typing import Any, Dict, List


RESPONSE_CHAPTERS_TEMPLATE: List[Dict[str, Any]] = [
    {
        "id": "R1",
        "title": "采购公告响应",
        "description": (
            "对应招标文件第一章 采购公告，逐项响应：项目名称、标段/包件编号、"
            "采购方式、工期/交货期/服务期限、建设或交付地点、供应商资格条件"
            "（是否接受联合体、法人资格、许可证等）。"
            "所有数字、期限、地点必须引用招标文件原文，原文未提及的写「未提及」，禁止编造。"
            "每条须以「响应：完全满足，本公司……」格式作答。"
        ),
        "children": [],
    },
    {
        "id": "R2",
        "title": "评审办法逐项响应表",
        "description": (
            "对应招标文件中的评审办法 / 详细评审标准，按评分项逐条响应。"
            "本章必须以「评分项响应表」格式呈现，列至少包括："
            "评审因素 | 招标要求 | 本公司响应 | 自评分 | 支撑章节。"
            "分值、评审标准、业绩年限等必须来自招标文件原文；"
            "不得编造业绩合同、客户名称或评分权重。"
        ),
        "children": [],
    },
    {
        "id": "R3",
        "title": "服务采购合同响应",
        "description": (
            "对应招标文件合同条款及格式，逐条声明是否接受合同主要条款，"
            "包括：合同标的、付款方式、履约保证金、验收标准、违约责任、"
            "保密责任、知识产权归属、争议解决方式、合同期限。"
            "条款内容以招标文件为准；每条须以「响应：完全满足，本公司承诺……」格式作答。"
        ),
        "children": [],
    },
    {
        "id": "R4",
        "title": "采购人要求逐项响应",
        "description": (
            "对应招标文件「采购人要求 / 发包人要求 / 技术需求」章节，按原文板块逐项响应。"
            "须覆盖：量化性能或服务指标承诺、供货或交付清单、核心技术方案、"
            "建设原则、数据采集或接口要求、实施与运维保障。"
            "指标、型号、数量、接口协议必须抄录招标文件；原文没有的写「未提及」。"
            "供货/交付清单建议用对照表：招标要求 | 本公司响应。"
        ),
        "children": [],
    },
    {
        "id": "R5",
        "title": "资格与商务响应",
        "description": (
            "对应招标文件供应商须知与资格要求，逐项响应："
            "营业执照、法定代表人身份证明、授权委托书、知识产权声明、"
            "保密承诺、反商业贿赂 / 廉洁从业 / 无重大违法记录承诺。"
            "每条须明确写出「本公司声明：……」，并标注对应附件编号；"
            "不得编造证书编号或尚未提供的附件内容。"
        ),
        "children": [],
    },
]


def append_response_chapters(
    outline: List[Dict[str, Any]],
    start_index: int | None = None,
) -> List[Dict[str, Any]]:
    """在已有目录末尾追加强制响应章节。

    - outline: 用户原有的目录（一级章节列表）
    - start_index: 强制响应章节的起始一级编号；
                   None 时自动 = 已有最大一级编号 + 1
    返回新的 outline 列表（新对象，不修改入参）。
    """
    new_outline = copy.deepcopy(outline)

    if start_index is None:
        max_idx = 0
        for item in new_outline:
            try:
                first_seg = str(item.get("id", "")).split(".")[0]
                if first_seg.isdigit():
                    max_idx = max(max_idx, int(first_seg))
            except Exception:
                pass
        start_index = max_idx + 1

    for i, tmpl in enumerate(RESPONSE_CHAPTERS_TEMPLATE):
        chapter = copy.deepcopy(tmpl)
        chapter["id"] = str(start_index + i)
        chapter["is_response_chapter"] = True
        new_outline.append(chapter)

    return new_outline
