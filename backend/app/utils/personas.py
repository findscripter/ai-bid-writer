"""内置风格 persona 预设，用于多份生成时让每份呈现不同侧重点。"""
from __future__ import annotations

from typing import Dict, List


BUILTIN_PERSONAS: List[Dict[str, str]] = [
    {
        "id": "tech_depth",
        "name": "技术深度派",
        "description": (
            "强调架构合理性、关键技术选型依据、性能与可扩展性指标，"
            "多用技术术语，章节内适度引入数据流/调用链/性能数字，"
            "突出方案的工程深度与可验证性。"
        ),
    },
    {
        "id": "delivery_assurance",
        "name": "实施保障派",
        "description": (
            "强调项目管理、交付里程碑、风险控制、质量与变更管理流程，"
            "突出团队能力与服务体系，多用 PMI/ITIL/ISO 等行业方法论用语，"
            "让评审感到落地稳健、可控。"
        ),
    },
    {
        "id": "innovation_value",
        "name": "创新价值派",
        "description": (
            "强调方案的差异化创新点、对客户业务价值的提升路径，"
            "结合行业趋势（如大模型、智能化、低碳）给出前瞻性论述，"
            "适度引用案例与对标，但仍保持技术专业性。"
        ),
    },
    {
        "id": "compliance_first",
        "name": "合规规范派",
        "description": (
            "强调对招标文件条款的逐项响应、对国家/行业标准的对齐情况，"
            "条款引用清晰，措辞严谨克制，适合评分细则严格的项目，"
            "让评审感到无遗漏、无歧义、易于打分。"
        ),
    },
    {
        "id": "cost_effective",
        "name": "性价比派",
        "description": (
            "强调方案在投入产出、TCO、运维成本与人力成本上的优势，"
            "讲清架构选型如何降低长期成本，但避免显得粗放，"
            "在保证技术合理性的前提下突出经济性。"
        ),
    },
]


def list_personas() -> List[Dict[str, str]]:
    """返回内置 persona 列表副本。"""
    return [dict(p) for p in BUILTIN_PERSONAS]


def default_persona_rotation(copies: int) -> List[Dict[str, str]]:
    """按需轮转返回 persona，长度等于 copies。

    例如 copies=3 → 取前三个；copies=7 → 5 个内置之后循环再取 2 个。
    """
    if copies <= 0:
        return []
    base = BUILTIN_PERSONAS
    if not base:
        return []
    return [dict(base[i % len(base)]) for i in range(copies)]
