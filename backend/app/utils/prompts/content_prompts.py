"""正文生成相关提示词。"""
from __future__ import annotations

import random
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# 反雷同：每份 / 每次生成时随机抽取的写作约束，让句法层面也出现差异
# ---------------------------------------------------------------------------

_OPENING_CONSTRAINTS = [
    "首段禁止以'本'字开头，改用具体的项目名称或技术名词引入。",
    "首段以一个行业现状或项目背景事实句开头，不要直接谈方案。",
    "首段直接从技术问题或需求痛点切入，不要使用背景铺垫。",
    "首段从预期效果或建设目标倒推引入，再展开具体做法。",
    "首段以时间线或项目阶段逻辑作为引导句式。",
    "首段以数据指标或性能要求作为引导，再展开技术路径。",
]

_STRUCTURE_CONSTRAINTS = [
    "全文按'问题-分析-方案-预期效果'的四段逻辑展开。",
    "全文按'总-分-总'结构组织，先给结论，再拆解，末尾回扣。",
    "全文按'需求理解-技术路线-实施要点'三段式组织。",
    "全文先列举关键技术指标，再逐项阐述达成路径。",
    "全文以流程或步骤为线索展开，先总述后分述每个环节。",
    "全文从系统架构分层角度展开，每层独立阐述。",
]

_EXPRESSION_CONSTRAINTS = [
    "正文中不使用'首先、其次、最后'这类序数连接词，改用语义衔接。",
    "正文中不使用'综上所述、总而言之'等总结性套话。",
    "段落衔接时避免使用'此外、与此同时、值得注意的是'等模板化连词。",
    "正文中避免出现'赋能、抓手、闭环、全链路'等流行营销用语。",
    "段落之间通过内容逻辑自然过渡，不使用显式转折连接词。",
]


def _pick_anti_similarity_constraints() -> str:
    """随机选一组写作约束，注入 system prompt 让句法产生差异。"""
    parts = [
        random.choice(_OPENING_CONSTRAINTS),
        random.choice(_STRUCTURE_CONSTRAINTS),
        random.choice(_EXPRESSION_CONSTRAINTS),
    ]
    return "\n".join(f"- {p}" for p in parts)


def build_chapter_content_messages(
    chapter: Dict[str, Any],
    parent_chapters: List[Dict[str, Any]] | None = None,
    sibling_chapters: List[Dict[str, Any]] | None = None,
    project_overview: str = "",
    target_words: Optional[int] = None,
    persona: Optional[str] = None,
    prior_summaries: Optional[List[Dict[str, str]]] = None,
) -> List[Dict[str, str]]:
    """构建章节正文生成消息。

    新增三个可选参数：
    - target_words: 字数预算，注入到正文要求中。
    - persona: 风格说明，拼接到 system prompt。
    - prior_summaries: 同章节其他份次的摘要列表，用于跨份去重。
    """
    chapter_id = chapter.get("id", "unknown")
    chapter_title = chapter.get("title", "未命名章节")
    chapter_description = chapter.get("description", "")

    system_prompt = """你是一个专业的标书编写专家，负责为投标文件的技术标部分生成具体内容。

要求：
1. 内容要专业、准确，与章节标题和描述保持一致。
2. 这是技术方案，不是宣传报告，注意朴实无华，不要假大空。
3. 语言要正式、规范，符合标书写作要求，但不要使用奇怪的连接词，不要让人觉得内容像是 AI 生成的。
4. 内容要详细具体，避免空泛的描述。
5. 注意避免与同级章节内容重复，保持内容的独特性和互补性。
6. 直接返回章节内容，不生成标题，不要任何额外说明或格式标记。
"""

    if persona and persona.strip():
        system_prompt += (
            "\n\n本份标书的风格定位：\n"
            f"{persona.strip()}\n"
            "请在不偏离章节主题的前提下，按上述风格组织内容。"
        )

    anti_sim = _pick_anti_similarity_constraints()
    system_prompt += (
        "\n\n反雷同写作约束（必须严格遵守）：\n"
        f"{anti_sim}\n"
    )

    messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]

    if project_overview.strip():
        messages.append(
            {"role": "user", "content": f"项目概述信息：\n{project_overview}"}
        )

    if parent_chapters:
        parent_lines = ["上级章节信息："]
        for parent in parent_chapters:
            parent_lines.append(
                f"- {parent.get('id', 'unknown')} {parent.get('title', '未命名章节')}\n  {parent.get('description', '')}"
            )
        messages.append({"role": "user", "content": "\n".join(parent_lines)})

    if sibling_chapters:
        sibling_lines = ["同级章节信息（请避免内容重复）："]
        for sibling in sibling_chapters:
            if sibling.get("id") == chapter_id:
                continue
            sibling_lines.append(
                f"- {sibling.get('id', 'unknown')} {sibling.get('title', '未命名章节')}\n  {sibling.get('description', '')}"
            )
        if len(sibling_lines) > 1:
            messages.append({"role": "user", "content": "\n".join(sibling_lines)})

    if prior_summaries:
        prior_lines = [
            "本章节在更早的份次中已经写过以下要点（请明确避开雷同的开篇句、相同的论述顺序、相同的举例与数据，"
            "改用不同的切入角度、不同的论述结构、不同的案例或数据维度，最终结论方向可以一致但表达必须明显不同）："
        ]
        for item in prior_summaries:
            idx = item.get("copy_index", "?")
            summary = (item.get("summary") or "").strip()
            if not summary:
                continue
            prior_lines.append(f"- 第 {idx} 份摘要：{summary}")
        if len(prior_lines) > 1:
            messages.append({"role": "user", "content": "\n".join(prior_lines)})

    word_clause = ""
    if target_words and target_words > 0:
        lower = max(int(target_words * 0.85), 100)
        upper = max(int(target_words * 1.25), lower + 200)
        word_clause = (
            f"\n\n字数要求（硬性指标）：本章节正文必须控制在 {lower}-{upper} 字之间，目标约 {target_words} 字（不含标题）。"
            f"下限 {lower} 字是评标篇幅硬指标，不得少写；同时严禁明显超出上限，写到目标字数附近就收尾，"
            "不要为凑篇幅堆砌重复内容。请按目标字数规划小节数量与每节详略，"
            "对关键技术点给出具体做法与关键参数/指标，详略得当。"
        )

    messages.append(
        {
            "role": "user",
            "content": f"""请为以下标书章节生成具体内容：

当前章节信息：
章节ID: {chapter_id}
章节标题: {chapter_title}
章节描述: {chapter_description}

请根据项目概述信息和上述章节层级关系，生成详细的专业内容，确保与上级章节的内容逻辑相承，同时避免与同级章节内容重复，突出本章节的独特性和技术方案优势。
直接返回编写的正文内容，不要输出标题、解释、总结等任何其他内容{word_clause}""",
        }
    )

    return messages
