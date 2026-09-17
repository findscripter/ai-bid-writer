"""标书插图相关提示词：判断章节是否配图、生成图表 DSL、渲染失败纠错。"""
from __future__ import annotations

from typing import Any, Dict, List, Optional


# 引擎 → 适用图型，给 LLM 选型用
_ENGINE_GUIDE = """可用绘图引擎与适用图型（五选一，全部统一蓝色商务卡片框图风）：
- layered：分层能力全景图/平台总体架构图——左右"层标签"、中间分层"分组容器"、容器内网格功能块、底部基础设施。
  用于"系统总体架构/技术架构/平台架构/能力全景/技术方案总体框架"。
- blocks：区块架构框图——按"行"组织，每行可左右并列若干"分区"(公有云/私有云、内外网、数据源/网关/平台)。
  用于"系统部署架构/数据接入架构/数据存储架构/网络部署/集成架构"等分区或多层框图。
- flow：流程/进度卡片框图——阶段(phase)横向排列、阶段间箭头、卡片内竖排步骤。
  process 子模式用于"业务流程/处理流程/方法步骤/技术路线/生命周期"；
  timeline 子模式（卡片带时间标签）用于"实施进度/计划/工期/里程碑/实施步骤"。
- mermaid：仅用于 flow 不擅长的——时序图(sequenceDiagram)、状态机(stateDiagram-v2)。
- plantuml：组织架构(@startwbs)、用例图。

选型原则：
- "系统总体架构/技术架构/平台架构/总体设计/能力全景/技术方案框架" → layered
- "部署架构/数据接入/数据存储/网络部署/集成架构/多端协同(公私云/内外网)" → blocks
  （凡涉及"端/层/区"空间结构，即使含数据流向，用 blocks）
- "业务流程/处理流程/工作流/方法步骤/技术路线/生命周期" → flow（mode=process）
- "实施进度/计划/工期/里程碑/实施步骤安排" → flow（mode=timeline）
- "交互/调用时序" → mermaid sequenceDiagram
- "状态机" → mermaid stateDiagram-v2
- "组织架构/人员分工" → plantuml @startwbs
"""

_RULES = """硬性规则：
1. 所有文字标签用中文，简洁（每个节点不超过 12 字）。
2. mermaid 节点文字若含括号、引号、冒号、斜杠等特殊字符，必须用双引号包裹，如 A["数据采集（含校验）"]。
3. mermaid flowchart 画架构图时：用 subgraph 把同层/同模块的节点框在一起并命名，整体方向 TB(自上而下)或 LR；
   节点数 8-16 个，体现清晰的层次与数据流向，不要画成一条直线。
4. plantuml 必须用 @start.../@end... 完整包裹；不要自己写 skinparam（系统会统一注入美观主题）。
5. 只输出能直接渲染的纯 DSL 代码，不要 markdown 代码围栏(```)，不要任何解释。
6. 图要服务于该章节主题，结构清晰、层级合理、信息充实但不堆砌。
"""


def build_diagram_decision_messages(
    chapter_title: str,
    chapter_description: str = "",
    chapter_content: str = "",
    project_overview: str = "",
) -> List[Dict[str, str]]:
    """让 LLM 判断该章节是否适合配一张技术插图，并直接产出 DSL。

    返回 JSON：{need, engine, diagram_type, title, code}
    """
    content_excerpt = (chapter_content or "")[:1500]
    system = (
        "你是标书技术编辑，负责为标书章节配专业技术插图。标书配图越丰富越显专业，"
        "请积极配图：只要章节涉及架构、流程、步骤、时序、进度、拓扑、组织结构、数据流向、"
        "技术路线、方案对比、生命周期等任何可结构化表达的内容，都应配一张图。"
        "只有纯论述性、纯文字（如公司简介、售后承诺等无结构信息）的章节才不配图（need=false）。\n\n"
        + _ENGINE_GUIDE + "\n" + _RULES + "\n"
        '严格输出 JSON：{"need": true/false, "engine": "layered"/"blocks"/"flow"/"mermaid"/"plantuml", '
        '"diagram_type": "图型名", "title": "图表中文标题(如：系统总体架构图)", "code": "完整DSL"}。'
        '注意：engine 为 layered/blocks/flow 时不要填 code（数据会单独生成），mermaid/plantuml 必须填 code。'
        '若判断不需要配图，输出 {"need": false}。'
    )
    parts = [f"章节标题：{chapter_title}"]
    if chapter_description:
        parts.append(f"章节描述：{chapter_description}")
    if project_overview:
        parts.append(f"项目背景：{project_overview[:400]}")
    if content_excerpt:
        parts.append(f"章节正文节选：\n{content_excerpt}")
    user = "\n\n".join(parts) + "\n\n请判断是否配图并按要求输出 JSON。"
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def build_diagram_fix_messages(
    engine: str,
    broken_code: str,
    error_message: str,
) -> List[Dict[str, str]]:
    """渲染失败时，把 DSL + 报错回喂模型，让它返回修正后的 DSL（纯代码）。"""
    system = (
        f"你是 {engine} 图表语法专家。下面的 {engine} 代码渲染失败了，请修正语法错误。\n"
        + _RULES + "\n"
        "只输出修正后的完整 DSL 代码，不要 markdown 围栏，不要任何解释。"
    )
    user = (
        f"渲染报错：\n{error_message}\n\n"
        f"出错的 {engine} 代码：\n{broken_code}\n\n"
        "请返回修正后的完整代码。"
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def validate_diagram_decision(payload: Dict[str, Any]) -> None:
    """校验配图决策 JSON。"""
    if not isinstance(payload, dict):
        raise ValueError("配图决策必须是 JSON 对象")
    if not payload.get("need"):
        return  # 不配图，无需其它字段
    engine = str(payload.get("engine") or "").strip().lower()
    if engine not in ("mermaid", "plantuml", "layered", "blocks", "flow"):
        raise ValueError("engine 必须是 layered / blocks / flow / mermaid / plantuml")
    if engine not in ("layered", "blocks", "flow") and not str(payload.get("code") or "").strip():
        raise ValueError("mermaid/plantuml 配图缺少 code")


# 分层架构 spec 的结构示例（few-shot，给 LLM 照着填）
_LAYERED_EXAMPLE = """{
  "title": "系统总体架构图",
  "layers": [
    {"left": "应用层", "right": "业务应用", "groups": [
      {"name": "监测应用", "cells": ["实时监控", "排放预警", "趋势分析"], "columns": 3},
      {"name": "管理应用", "cells": ["报表中心", "工单管理"], "columns": 2}
    ]},
    {"left": "平台层", "right": "AI 中台", "groups": [
      {"name": "AI 能力", "cells": ["治理优化模型", "参数寻优", "异常诊断", "预测分析"], "columns": 4},
      {"name": "数据引擎", "subgroups": [
        {"name": "数据处理", "cells": ["数据清洗", "数据校验"], "columns": 2},
        {"name": "数据存储", "cells": ["时序数据库", "对象存储"], "columns": 2}
      ]}
    ]},
    {"left": "接入层", "right": "数据采集", "groups": [
      {"name": "现场接入", "cells": ["烟气传感器", "DCS 接口", "边缘网关", "协议适配"], "columns": 4}
    ]}
  ],
  "infra": {"left": "基础设施", "items": ["服务器", "GPU 算力", "网络设备", "安全设备"]}
}"""


def build_layered_spec_messages(
    chapter_title: str,
    chapter_description: str = "",
    chapter_content: str = "",
    project_overview: str = "",
) -> List[Dict[str, str]]:
    """为「分层架构全景图」生成结构化 spec(JSON)。"""
    system = (
        "你是标书架构师，要为本章节产出一张分层能力全景图的结构化数据。"
        "图的版式：从上到下若干『层』，每层左右各一个层标签(left/right)，"
        "中间是若干『分组容器』(groups)，每个容器有标题(name)和一组功能模块方块(cells)；"
        "容器也可再分子容器(subgroups)。最底部可有一行基础设施(infra)。\n\n"
        "要求：\n"
        "1. 严格输出符合下面示例结构的 JSON，不要 markdown 围栏、不要解释。\n"
        "2. 层数 3-5 层；自上而下通常是 应用层→平台/能力层→数据层→接入/基础架构层。\n"
        "3. left 是技术分层名(如 应用层/平台层/基础架构)，right 是业务视角名(如 业务应用/AI中台/数据采集)，都要简短(≤6字)。\n"
        "4. 每个 cells 模块名 ≤8 字；每个容器 2-8 个模块；用 columns 指定每行列数让排版整齐。\n"
        "5. 内容要紧扣本项目（结合项目背景与章节正文），模块要具体、专业、丰富（整图 30-60 个模块为宜），不要空泛。\n"
        "6. infra.items 放硬件/算力/网络等基础设施，3-5 个。\n\n"
        "结构示例：\n" + _LAYERED_EXAMPLE
    )
    parts = [f"章节标题：{chapter_title}"]
    if chapter_description:
        parts.append(f"章节描述：{chapter_description}")
    if project_overview:
        parts.append(f"项目背景：{project_overview[:500]}")
    if chapter_content:
        parts.append(f"章节正文节选：\n{chapter_content[:1800]}")
    user = "\n\n".join(parts) + "\n\n请输出该项目的分层架构全景图 JSON。"
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def validate_layered_spec(payload: Dict[str, Any]) -> None:
    """校验分层架构 spec。"""
    if not isinstance(payload, dict):
        raise ValueError("spec 必须是 JSON 对象")
    layers = payload.get("layers")
    if not isinstance(layers, list) or not layers:
        raise ValueError("spec.layers 不能为空")
    for ly in layers:
        groups = ly.get("groups")
        if not isinstance(groups, list) or not groups:
            raise ValueError("每层必须有 groups")


# 区块架构图 spec 示例（few-shot）
_BLOCKS_EXAMPLE = """{
  "title": "系统部署架构图",
  "rows": [
    {"left": "浏览器", "zones": [
      {"color": "green", "cells": ["租户A", "租户B", "监管用户", "运维用户"], "columns": 4}
    ]},
    {"left": "服务端", "zones": [
      {"title": "公有云", "color": "blue", "groups": [
        {"name": "应用服务器", "cells": ["基础应用", "智能应用", "移动应用"], "columns": 3},
        {"name": "数据存储", "cells": ["时序数据库", "关系型数据库", "对象存储"], "columns": 3},
        {"cells": ["统一接入网关"], "full": true}
      ]},
      {"title": "私有云", "color": "orange", "groups": [
        {"name": "数据计算", "cells": ["流计算", "离线计算", "算法库"], "columns": 3},
        {"name": "应用服务", "cells": ["治理应用", "分析应用"], "columns": 2}
      ]}
    ]},
    {"left": "接入层", "zones": [
      {"color": "gray", "groups": [
        {"cells": ["IoT 边缘网关"], "full": true},
        {"cells": ["烟气传感器", "DCS 接口", "环境数据", "业务系统"], "columns": 4}
      ]}
    ]}
  ]
}"""


def build_blocks_spec_messages(
    chapter_title: str,
    chapter_description: str = "",
    chapter_content: str = "",
    project_overview: str = "",
) -> List[Dict[str, str]]:
    """为「区块架构框图」生成结构化 spec(JSON)。"""
    system = (
        "你是标书架构师，要为本章节产出一张区块架构框图的结构化数据（蓝色商务风框图）。"
        "版式：从上到下若干『行』(rows)，每行左侧一个行标签(left)，右侧是一个或多个并列的"
        "『分区』(zones)；分区可有标题(title)和配色(color)，内部用『分组容器』(groups)装功能块，"
        "或直接用 cells。\n\n"
        "要求：\n"
        "1. 严格输出符合下面示例结构的 JSON，不要 markdown 围栏、不要解释。\n"
        "2. 行(rows) 2-4 个；典型分层：访问端/浏览器 → 服务端(可左右分 公有云/私有云 或 内网/外网) → 接入层/数据源。\n"
        "3. color 取值：blue/orange/green/gray/purple；同一行并列分区用不同色区分(如公有云 blue、私有云 orange)。\n"
        "4. 关键枢纽节点(网关/总线/平台入口)用 {\"cells\":[\"xxx\"],\"full\":true} 做成整条深色横块。\n"
        "5. cells 模块名 ≤8 字；用 columns 控制每行列数让排版整齐；内容紧扣本项目、具体专业、丰富(整图 25-50 个模块)。\n"
        "6. left 行标签 ≤8 字。\n\n"
        "结构示例：\n" + _BLOCKS_EXAMPLE
    )
    parts = [f"章节标题：{chapter_title}"]
    if chapter_description:
        parts.append(f"章节描述：{chapter_description}")
    if project_overview:
        parts.append(f"项目背景：{project_overview[:500]}")
    if chapter_content:
        parts.append(f"章节正文节选：\n{chapter_content[:1800]}")
    user = "\n\n".join(parts) + "\n\n请输出该项目的区块架构框图 JSON。"
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def validate_blocks_spec(payload: Dict[str, Any]) -> None:
    """校验区块架构 spec。"""
    if not isinstance(payload, dict):
        raise ValueError("spec 必须是 JSON 对象")
    rows = payload.get("rows")
    if not isinstance(rows, list) or not rows:
        raise ValueError("spec.rows 不能为空")
    for r in rows:
        zones = r.get("zones")
        if not isinstance(zones, list) or not zones:
            raise ValueError("每行必须有 zones")


# 流程/进度卡片框图 spec 示例（few-shot）
_FLOW_EXAMPLE = """{
  "title": "项目实施流程",
  "mode": "process",
  "direction": "horizontal",
  "phases": [
    {"name": "需求调研", "steps": ["现场勘查", "需求访谈", "痛点分析"]},
    {"name": "方案设计", "steps": ["架构设计", "算法选型", "方案评审"]},
    {"name": "开发实施", "steps": ["模型开发", "平台开发", "系统集成"]},
    {"name": "测试上线", "steps": ["联调测试", "现场部署", "培训验收"]}
  ]
}
（timeline 子模式：mode 设为 "timeline"，每个 phase 额外加 "time" 字段，如 "time": "第1月"）"""


def build_flow_spec_messages(
    chapter_title: str,
    chapter_description: str = "",
    chapter_content: str = "",
    project_overview: str = "",
) -> List[Dict[str, str]]:
    """为「流程/进度卡片框图」生成结构化 spec(JSON)。"""
    system = (
        "你是标书编辑，要为本章节产出一张流程/进度卡片框图的结构化数据（蓝色商务卡片风）。"
        "版式：若干『阶段』(phases)横向排列、阶段间有流向箭头，每个阶段是一张卡片，"
        "卡片有标题(name)和竖排的若干步骤(steps)。\n\n"
        "要求：\n"
        "1. 严格输出符合下面示例结构的 JSON，不要 markdown 围栏、不要解释。\n"
        "2. mode：业务流程/处理流程/方法步骤/技术路线/生命周期 → \"process\"；"
        "实施进度/工期/计划/里程碑 → \"timeline\"（此时每个 phase 加 time 字段标注时间，如 \"第1-2月\"）。\n"
        "3. 阶段数 3-6 个；每阶段 2-5 个步骤；阶段名 ≤8 字，步骤 ≤10 字。\n"
        "4. direction 一般用 \"horizontal\"；若阶段很多(>6)或步骤很长可用 \"vertical\"。\n"
        "5. 内容紧扣本项目、具体专业、按真实先后顺序组织。\n\n"
        "结构示例：\n" + _FLOW_EXAMPLE
    )
    parts = [f"章节标题：{chapter_title}"]
    if chapter_description:
        parts.append(f"章节描述：{chapter_description}")
    if project_overview:
        parts.append(f"项目背景：{project_overview[:400]}")
    if chapter_content:
        parts.append(f"章节正文节选：\n{chapter_content[:1500]}")
    user = "\n\n".join(parts) + "\n\n请输出该章节的流程/进度卡片框图 JSON。"
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def validate_flow_spec(payload: Dict[str, Any]) -> None:
    """校验流程/进度 spec。"""
    if not isinstance(payload, dict):
        raise ValueError("spec 必须是 JSON 对象")
    phases = payload.get("phases")
    if not isinstance(phases, list) or not phases:
        raise ValueError("spec.phases 不能为空")
    for p in phases:
        if not str(p.get("name") or "").strip():
            raise ValueError("每个阶段必须有 name")


def strip_code_fence(text: str) -> str:
    """去掉模型偶尔多带的 markdown 代码围栏。"""
    t = (text or "").strip()
    if t.startswith("```"):
        lines = t.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        t = "\n".join(lines).strip()
    return t
