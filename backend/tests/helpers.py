"""测试公用的小工具：样例项目、按提示词内容作答的假模型应答器。"""
from __future__ import annotations

import json
import re
from typing import Any, Callable, Dict, List, Optional

from app.core.fake_llm import FakeCall, FakeReply
from app.core.store import ProjectStore
from app.writing.models import Project
from app.writing.outline_tree import collect_leaves, normalize_outline

REQUIREMENTS_TEXT = """# 一、评审表要点清单
【评审项ID】：E1
【评审项名称】：总体技术方案
【分值或权重】：20分
【评审标准】：方案完整、架构合理得 16-20 分。
【原文位置】：第三章 2.1
【目录建议】：总体技术方案

【评审项ID】：E2
【评审项名称】：项目实施计划
【分值或权重】：10分
【评审标准】：计划合理、里程碑清晰得 8-10 分。
【原文位置】：第三章 2.2
【目录建议】：项目实施方案

# 二、采购人要求要点清单
【要求ID】：R1
【要求名称】：系统性能指标
【关键约束/指标】：设备在线率不低于 90%；系统响应时间不超过 3 秒。
【必含关键词】：90%、3 秒
【原文位置】：第五章 2.3
【目录建议】：系统性能设计
"""

TENDER_TEXT = (
    "第一章 采购公告\n本项目为智慧园区综合管理平台建设服务，服务期为合同签订后 180 日历天，实施地点为采购人园区。\n"
    "第三章 评审办法\n总体技术方案 20 分；项目实施计划 10 分。\n"
    "第五章 采购人要求\n设备在线率不低于 90%，系统响应时间不超过 3 秒，支持不少于 500 个设备接入。\n"
)

OUTLINE = [
    {
        "title": "总体技术方案",
        "description": "对应评审项: E1; 对应采购要求: R1",
        "children": [
            {
                "title": "系统架构设计",
                "description": "对应评审项: E1",
                "children": [
                    {"title": "总体架构", "description": "说明系统总体架构与分层"},
                    {"title": "系统性能设计", "description": "说明性能指标与达成措施"},
                ],
            },
            {
                "title": "关键技术",
                "description": "对应评审项: E1",
                "children": [
                    {"title": "控制算法", "description": "说明控制算法与模型"},
                ],
            },
        ],
    },
    {
        "title": "项目实施方案",
        "description": "对应评审项: E2",
        "children": [
            {
                "title": "实施计划",
                "description": "对应评审项: E2",
                "children": [
                    {"title": "进度安排", "description": "说明里程碑与进度"},
                    {"title": "质量保障", "description": "说明质量管理措施"},
                ],
            },
        ],
    },
]


def make_project(store: ProjectStore, target_pages: int = 4, with_tender: bool = True) -> Project:
    """建一个带目录、概述、评分要求的样例项目（5 个叶子章节）。"""
    project = store.create_project("智慧园区管理平台")
    project.overview = "本项目建设智慧园区管理平台，服务期 180 日历天。"
    project.requirements = REQUIREMENTS_TEXT
    project.outline = normalize_outline(OUTLINE)
    project.settings.target_pages = target_pages
    project.settings.words_per_page = 500
    project.settings.concurrency = 3
    store.save_project(project)
    if with_tender:
        store.save_tender_text(project.id, TENDER_TEXT)
    return store.load_project(project.id)


def leaf_ids(project: Project) -> Dict[str, str]:
    """位置编号 → uid。"""
    return {leaf.id: leaf.uid for leaf in collect_leaves(project.outline)}


def body_text(label: str, chars: int) -> str:
    """生成一段指定字数、句子互不相同的正文。"""
    sentences: List[str] = []
    total = 0
    index = 0
    while total < chars:
        index += 1
        sentence = f"{label}第{index}项措施明确了实施步骤与责任分工并给出验收方式。"
        sentences.append(sentence)
        total += len(sentence)
    return "".join(sentences)[:chars]


_TASK_TITLE_RE = re.compile(r"请撰写「([\d.]+) ([^」]+)」的正文")
_SECTION_TITLE_RE = re.compile(r"第 (\d+) 个小节「([^」]+)」，约 (\d+) 字")
_TARGET_RE = re.compile(r"篇幅约 (\d+) 字")
_PLAN_LEAF_RE = re.compile(r"^- ([\d.]+) ", re.MULTILINE)


class WritingResponder:
    """按提示词内容作答的应答器，覆盖管线里的全部请求类型。

    可以通过 overrides 改写某一类请求的应答：键是请求类型
    （facts / plans / sections / chapter / section / continue / truncated / revise / consistency / repair），
    值是字符串、FakeReply、异常，或接收 (call, 默认应答) 的函数。
    """

    def __init__(self, overrides: Optional[Dict[str, Any]] = None, length_ratio: float = 1.0):
        self.overrides = overrides or {}
        self.length_ratio = length_ratio
        self.kinds: List[str] = []

    def classify(self, call: FakeCall) -> str:
        system = call.system
        last = call.last_user
        if "JSON 修复助手" in system:
            return "repair"
        if "总体设计负责人" in system:
            return "facts"
        if "投标技术方案的主笔" in system:
            return "plans"
        if "终审人" in system:
            return "consistency"
        if "需要分成小节依次撰写" in last:
            return "sections"
        if "因为单次输出的长度限制在中途断开" in last:
            return "truncated"
        if "请接着上文继续写" in last:
            return "continue"
        if "【修改要求】" in last:
            return "revise"
        if "现在只撰写" in last:
            return "section"
        if "请撰写「" in last:
            return "chapter"
        return "other"

    def default(self, kind: str, call: FakeCall) -> Any:
        last = call.last_user
        if kind == "facts":
            return json.dumps(
                {
                    "project_name": "智慧园区管理平台",
                    "purchaser": "某电厂",
                    "facts": [{"key": "服务期", "value": "180 日历天"}, {"key": "设备在线率", "value": "不低于 90%"}],
                    "decisions": [{"key": "总体架构", "value": "采用感知层、平台层、应用层三层架构"}],
                    "terminology": [{"term": "控制平台", "definition": "园区综合管理平台"}],
                    "placeholders": ["近三年同类项目业绩"],
                },
                ensure_ascii=False,
            )
        if kind == "plans":
            ids = _PLAN_LEAF_RE.findall(last)
            plans = []
            for position, leaf_id in enumerate(ids):
                plans.append(
                    {
                        "id": leaf_id,
                        "key_points": [f"{leaf_id} 的要点一", f"{leaf_id} 的要点二", f"{leaf_id} 的要点三"],
                        "requirement_ids": ["E1"] if leaf_id.startswith("1.") else ["E2"],
                        "avoid": [],
                        "weight": 2.0 if position == 0 else 1.0,
                        "form": "paragraph",
                    }
                )
            return json.dumps({"plans": plans}, ensure_ascii=False)
        if kind == "sections":
            match = re.search(r"目标篇幅约 (\d+) 字", last)
            target = int(match.group(1)) if match else 2000
            return json.dumps(
                {
                    "sections": [
                        {"title": "设计思路", "points": ["思路一", "思路二"], "words": target // 2},
                        {"title": "实现方案", "points": ["方案一", "方案二"], "words": target - target // 2},
                    ]
                },
                ensure_ascii=False,
            )
        if kind == "chapter":
            title = _TASK_TITLE_RE.search(last)
            target = _TARGET_RE.search(last)
            chars = int(int(target.group(1)) * self.length_ratio) if target else 400
            return body_text(title.group(2) if title else "本章", chars)
        if kind == "section":
            match = _SECTION_TITLE_RE.search(last)
            chars = int(int(match.group(3)) * self.length_ratio) if match else 400
            return body_text(match.group(2) if match else "小节", chars)
        if kind == "continue":
            return body_text("补充内容", 300)
        if kind == "truncated":
            return "这是截断之后接着写完的部分。"
        if kind == "revise":
            return body_text("修订后的内容", 400)
        if kind == "consistency":
            return json.dumps({"issues": []}, ensure_ascii=False)
        return ""

    def __call__(self, call: FakeCall) -> Any:
        kind = self.classify(call)
        self.kinds.append(kind)
        answer = self.default(kind, call)
        override = self.overrides.get(kind)
        if override is None:
            return answer
        if callable(override):
            return override(call, answer)
        return override


def truncated_once(text: str) -> Callable[[FakeCall, Any], Any]:
    """第一次调用返回被截断的 text，之后恢复默认应答。"""
    state = {"used": False}

    def _answer(call: FakeCall, default: Any) -> Any:
        if not state["used"]:
            state["used"] = True
            return FakeReply(text=text, finish_reason="length")
        return default

    return _answer
