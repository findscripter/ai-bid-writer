"""演示模式的应答器：不联网，按提示词类型给出像样的示意输出。

只用于体验界面与流程（AI_BID_DEMO=1）。它写出来的“正文”是模板拼接的示意文本，
不能当作真实的标书内容使用。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from typing import Any, List, Optional

from .fake_llm import FakeCall, FakeLLM

_PLAN_LEAF_RE = re.compile(r"^- ([\d.]+) (.+?)（位于", re.MULTILINE)
_CHAPTER_RE = re.compile(r"请撰写「([\d.]+) (.+)」的正文")
_TARGET_RE = re.compile(r"篇幅约 (\d+) 字")
_SECTION_RE = re.compile(r"第 (\d+) 个小节「([^」]+)」，约 (\d+) 字")
_SECTION_TARGET_RE = re.compile(r"目标篇幅约 (\d+) 字")
_REVISE_RE = re.compile(r"【当前正文】\n(.*?)\n\n【修改要求】\n(.*?)\n\n【任务】", re.DOTALL)
_GROUP_TITLE_RE = re.compile(r"【评审项名称】[:：]\s*(.+)")
_PARENT_TITLE_RE = re.compile(r"一级目录：\n编号：.*\n标题：(.+)")

_SENTENCES = [
    "围绕{t}，本方案先梳理现状与约束，再给出分步实施的做法，每一步都明确责任人和交付物。",
    "{t}的实施按“调研确认、方案设计、部署实施、验证交付”四个环节推进，各环节设置检查点。",
    "在{t}方面，项目组安排专人对接采购人，重要事项以书面形式确认并留存记录。",
    "针对{t}可能出现的风险，方案预先制定了应对措施，并在周例会上跟踪处置进展。",
    "{t}所涉及的接口与数据格式遵循招标文件的要求，联调前先完成接口文档的双方确认。",
    "为保证{t}的质量，交付前由独立的测试人员按验收标准逐项核对，问题清零后再提交验收。",
    "{t}的成果物包括设计说明、实施记录和验证报告，全部纳入项目文档库统一管理。",
    "{t}相关的配置和参数在测试环境验证通过后，再按变更流程发布到生产环境。",
    "{t}完成后安排一次专题培训，使采购人的运维人员能够独立完成日常操作。",
    "对{t}的执行情况，项目经理每周汇总一次，偏差超过阈值时启动纠偏措施。",
    "{t}相关的问题在 2 小时内响应，阶段成果在 5 个工作日内提交确认。",
]

_TABLE = (
    "\n\n| 阶段 | 主要工作 | 交付物 |\n| --- | --- | --- |\n"
    "| 调研确认 | 现场调研、需求确认 | 需求确认单 |\n"
    "| 方案设计 | 详细设计、评审 | 设计说明书 |\n"
    "| 部署实施 | 安装部署、联调 | 实施记录 |\n"
    "| 验证交付 | 测试、试运行、验收 | 验收报告 |\n\n"
)


def _seed(text: str) -> int:
    return int(hashlib.md5(text.encode("utf-8")).hexdigest()[:8], 16)


def demo_body(title: str, chars: int, with_table: bool = False, with_placeholder: bool = False) -> str:
    """拼出一段约 chars 字的示意正文；同一标题每次结果相同。"""
    chars = max(int(chars), 60)
    start = _seed(title)
    paragraphs: List[str] = []
    current: List[str] = []
    total = 0
    index = 0
    while total < chars:
        sentence = _SENTENCES[(start + index) % len(_SENTENCES)].format(t=title)
        if index >= len(_SENTENCES):
            sentence = f"（{index // len(_SENTENCES) + 1}）" + sentence
        current.append(sentence)
        total += len(sentence)
        index += 1
        if len(current) == 3:
            paragraphs.append("".join(current))
            current = []
    if current:
        paragraphs.append("".join(current))
    text = "\n\n".join(paragraphs)
    if with_table and len(paragraphs) > 1:
        text = paragraphs[0] + _TABLE + "\n\n".join(paragraphs[1:])
    if with_placeholder:
        text += f"\n\n在同类项目经验方面，本公司已完成【待补充：与{title}相关的同类项目业绩】，项目负责人为【待补充：项目经理姓名及证书】。"
    return text


def _outline_json() -> str:
    def leaf(title: str, tag: str) -> dict:
        return {"id": "", "title": title, "description": f"对应评审项: {tag}; 对应采购要求: 未提及"}

    outline = [
        {
            "id": "1", "title": "项目理解与总体方案", "description": "对应评审项: E1; 对应采购要求: R1",
            "children": [
                {"id": "1.1", "title": "项目理解", "description": "对应评审项: E1", "children": [
                    leaf("项目背景与建设目标", "E1"), leaf("需求分析", "E1"), leaf("重点与难点分析", "E1")]},
                {"id": "1.2", "title": "总体技术方案", "description": "对应评审项: E1", "children": [
                    leaf("总体架构设计", "E1"), leaf("技术路线", "E1"), leaf("系统性能设计", "E1")]},
            ],
        },
        {
            "id": "2", "title": "项目实施方案", "description": "对应评审项: E2",
            "children": [
                {"id": "2.1", "title": "实施组织", "description": "对应评审项: E2", "children": [
                    leaf("项目组织架构", "E2"), leaf("人员配置与职责", "E2")]},
                {"id": "2.2", "title": "实施计划", "description": "对应评审项: E2", "children": [
                    leaf("进度计划与里程碑", "E2"), leaf("质量保障措施", "E2"), leaf("风险管理", "E2")]},
            ],
        },
        {
            "id": "3", "title": "服务与保障", "description": "对应评审项: E3",
            "children": [
                {"id": "3.1", "title": "售后服务", "description": "对应评审项: E3", "children": [
                    leaf("服务体系与响应机制", "E3"), leaf("培训方案", "E3")]},
            ],
        },
    ]
    return json.dumps({"outline": outline}, ensure_ascii=False)


_OVERVIEW = """**项目名称**：示例项目（演示模式）

**项目背景与目的**：采购人拟建设一套业务系统，用于提升现有业务的自动化与管理水平。

**项目规模与预算**：招标文件未提及具体预算。

**时间安排**：服务期为合同签订后 180 日历天。

**实施内容**：完成系统的需求调研、设计开发、部署实施、测试验收与培训，并提供质保期内的运维服务。

**主要技术要求**：系统响应时间不超过 3 秒；系统可用性不低于 99.9%；支持不少于 500 个并发用户。

（以上为演示模式生成的示意内容。配置 API Key 后会基于你上传的招标文件真实解析。）"""

_REQUIREMENTS = """# 一、评审表要点清单
【评审项ID】：E1
【评审项名称】：项目理解与总体方案
【分值或权重】：25分
【评审标准】：对项目理解准确、总体方案完整合理得 20-25 分；较完整得 12-19 分；其余得 0-11 分。
【原文位置】：第三章 评审办法
【目录建议】：项目理解与总体方案

【评审项ID】：E2
【评审项名称】：项目实施方案
【分值或权重】：20分
【评审标准】：组织架构清晰、进度计划合理、质量与风险措施到位得 16-20 分。
【原文位置】：第三章 评审办法
【目录建议】：项目实施方案

【评审项ID】：E3
【评审项名称】：服务与保障
【分值或权重】：10分
【评审标准】：服务体系完善、响应及时、培训方案可行得 8-10 分。
【原文位置】：第三章 评审办法
【目录建议】：服务与保障

# 二、采购人要求要点清单
【要求ID】：R1
【要求名称】：系统性能指标
【关键约束/指标】：系统响应时间不超过 3 秒；系统可用性不低于 99.9%；支持不少于 500 个并发用户。
【必含关键词】：3 秒、99.9%、500
【原文位置】：第五章 采购人要求
【目录建议】：系统性能设计

【要求ID】：R2
【要求名称】：服务期限
【关键约束/指标】：服务期为合同签订后 180 日历天。
【必含关键词】：180 日历天
【原文位置】：第一章 采购公告
【目录建议】：进度计划与里程碑

# 三、覆盖校验清单（用于目录审核）
- [ ] E1 是否被目录独立覆盖
- [ ] E2 是否被目录独立覆盖
- [ ] E3 是否被目录独立覆盖
- [ ] R1 是否被目录独立覆盖
- [ ] R2 是否被目录独立覆盖
"""


def demo_responder(call: FakeCall) -> Any:
    system = call.system
    last = call.last_user

    # ---- 解析 ----
    if "招标文件分析助手" in system:
        if "本段无相关内容" in last:
            return "本段无相关内容"
        return _OVERVIEW if "提取并总结项目概述信息" in last else _REQUIREMENTS

    # ---- 目录 ----
    if "目录审核专家" in system:
        return json.dumps({"passed": True, "suggestions": []}, ensure_ascii=False)
    if "提取适合作为技术标一级目录的评分大类" in system:
        titles = _GROUP_TITLE_RE.findall(call.text) or ["项目理解与总体方案", "项目实施方案", "服务与保障"]
        groups = [
            {"requirement_id": f"R{i}", "title": t.strip(), "description": f"{t.strip()}相关内容", "detail_points": ["方案完整性", "措施可行性"]}
            for i, t in enumerate(titles[:6], start=1)
        ]
        return json.dumps({"groups": groups}, ensure_ascii=False)
    if "生成二级和三级目录" in system or "生成其下属的二级目录和三级目录" in system:
        parent = _PARENT_TITLE_RE.search(call.text)
        name = parent.group(1).strip() if parent else "本章"
        children = [
            {"id": "x.1", "title": f"{name}的总体思路", "description": "对应评审项: 未提及", "children": [
                {"id": "x.1.1", "title": f"{name}的目标与原则", "description": ""},
                {"id": "x.1.2", "title": f"{name}的实现方法", "description": ""}]},
            {"id": "x.2", "title": f"{name}的具体措施", "description": "对应评审项: 未提及", "children": [
                {"id": "x.2.1", "title": f"{name}的实施步骤", "description": ""},
                {"id": "x.2.2", "title": f"{name}的保障措施", "description": ""}]},
        ]
        return json.dumps({"children": children}, ensure_ascii=False)
    if "标书编写专家" in system or "标书目录重构专家" in system:
        return _outline_json()

    # ---- 规划 ----
    if "总体设计负责人" in system:
        return json.dumps(
            {
                "project_name": "示例项目（演示模式）",
                "purchaser": "示例采购人",
                "facts": [
                    {"key": "服务期", "value": "合同签订后 180 日历天"},
                    {"key": "系统响应时间", "value": "不超过 3 秒"},
                    {"key": "系统可用性", "value": "不低于 99.9%"},
                    {"key": "并发用户", "value": "不少于 500 个"},
                ],
                "decisions": [
                    {"key": "总体架构", "value": "采用“接入层—平台层—应用层”三层架构，各层通过标准接口解耦"},
                    {"key": "实施阶段", "value": "分为调研确认、方案设计、部署实施、验证交付四个阶段"},
                    {"key": "项目组织", "value": "实行项目经理负责制，下设技术组、实施组、质量组"},
                    {"key": "服务响应", "value": "7×24 小时受理，2 小时内响应，24 小时内给出解决方案"},
                ],
                "terminology": [
                    {"term": "业务平台", "definition": "本项目建设的核心业务系统"},
                    {"term": "试运行", "definition": "系统上线后、正式验收前的连续运行考核期"},
                ],
                "placeholders": ["近三年同类项目业绩", "项目经理姓名及证书", "企业资质证书"],
            },
            ensure_ascii=False,
        )
    if "投标技术方案的主笔" in system:
        plans = []
        for position, (leaf_id, title) in enumerate(_PLAN_LEAF_RE.findall(last)):
            top = leaf_id.split(".")[0]
            ids = {"1": ["E1"], "2": ["E2"], "3": ["E3"]}.get(top, [])
            if "性能" in title:
                ids = ids + ["R1"]
            if "进度" in title:
                ids = ids + ["R2"]
            plans.append(
                {
                    "id": leaf_id,
                    "key_points": [f"说明{title}的目标与范围", f"给出{title}的具体做法与步骤", f"明确{title}的交付物与验收方式"],
                    "requirement_ids": ids,
                    "avoid": [],
                    "weight": 1.6 if ("架构" in title or "进度" in title) else (0.7 if "背景" in title else 1.0),
                    "form": "steps" if "计划" in title or "进度" in title else "paragraph",
                }
            )
        return json.dumps({"plans": plans}, ensure_ascii=False)

    # ---- 审校 ----
    if "终审人" in system:
        return json.dumps({"issues": []}, ensure_ascii=False)
    if "JSON 修复助手" in system:
        return "{}"

    # ---- 写作 ----
    if "需要分成小节依次撰写" in last:
        match = _SECTION_TARGET_RE.search(last)
        target = int(match.group(1)) if match else 2400
        names = ["设计思路", "实现方案", "保障措施"]
        return json.dumps(
            {"sections": [{"title": n, "points": [f"{n}的要点"], "words": target // len(names)} for n in names]},
            ensure_ascii=False,
        )
    if "【修改要求】" in last:
        match = _REVISE_RE.search(last)
        content = match.group(1).strip() if match else ""
        instruction = match.group(2).strip() if match else ""
        return content + f"\n\n针对“{instruction[:40]}”，本章补充说明如下：相关措施已按要求调整，并与统一口径保持一致。"
    if "现在只撰写" in last:
        match = _SECTION_RE.search(last)
        return demo_body(match.group(2) if match else "本小节", int(match.group(3)) if match else 600)
    if "请接着上文继续写" in last:
        return demo_body("补充措施", 300)
    if "因为单次输出的长度限制在中途断开" in last:
        return "相关工作按既定计划推进。"
    match = _CHAPTER_RE.search(last)
    if match:
        title = match.group(2)
        target = _TARGET_RE.search(last)
        seed = _seed(title)
        return demo_body(
            title,
            int(target.group(1)) if target else 600,
            with_table=seed % 3 == 0,
            with_placeholder=seed % 4 == 0,
        )
    return "{}"


def create_demo_llm(model_name: Optional[str] = None) -> FakeLLM:
    try:
        delay = float(os.environ.get("AI_BID_DEMO_DELAY", "0.02"))
    except ValueError:
        delay = 0.02
    return FakeLLM(demo_responder, model_name=model_name or "demo-model", chunk_size=14, delay=max(delay, 0.0))
