"""长文本写作管线的提示词。

消息的排列有讲究：凡是全书各章都相同的内容（写作规范、统一口径、全书目录）
放在最前面且逐字不变，各章不同的内容放在后面。这样服务商的前缀缓存可以命中，
上百次调用里大部分输入只按缓存价计费，速度也更快。
"""
from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple

from .models import ChapterDigest, ChapterPlan, FactSheet, LeafInfo, RequirementItem
from .outline_tree import leaf_path
from .requirements import requirement_line
from .retrieval import Chunk
from .textutil import clip

Message = Dict[str, str]

PLACEHOLDER_EXAMPLE = "【待补充：近三年同类项目业绩】"

# ---------------------------------------------------------------------------
# 写作
# ---------------------------------------------------------------------------

WRITER_SYSTEM = """你是一名资深的投标技术方案撰写人，正在和团队一起撰写一份投标技术文件。全书由多人分章撰写，你负责其中一章。所有人共用同一份「统一口径」和同一份目录，你写的内容必须与它们保持一致。

写作规范：
1. 依据的优先级：招标文件原文与评分要求 > 统一口径 > 本章写作计划 > 你的专业知识。
2. 只写本章范围内的内容。目录里其他章节负责的主题，本章点到为止，不要展开。
3. 内容要具体、可执行：讲清做法、流程、参数、分工和交付物。不要空泛的口号、形容词堆砌和宣传语。
4. 不得编造事实。投标人的名称、业绩案例、合同金额、资质证书、人员姓名与证书、专利与软著、检测报告、客户评价等企业信息，只能使用「企业资料」和「参考资料」里明确给出的内容；资料里没有的，一律写成“【待补充：需要补充的内容】”的形式，由投标人自行填写。
5. 招标文件给出的数字、期限、型号、指标要原样引用，不要改动，也不要擅自“优化”招标要求。本方案自拟的指标与参数必须与统一口径一致。
6. 语言正式、平实、准确，用陈述句。不要用“首先、其次、最后”“综上所述”“值得注意的是”这类套话，不要出现对写作过程本身的说明。
7. 格式：直接输出正文。不要输出章节标题，不要输出前言、解释或结束语。可以使用 Markdown 的列表和表格；需要小标题时用“### 小标题”，不要用一级、二级标题，不要用代码块。"""

FORM_HINTS = {
    "paragraph": "以连贯的段落为主，必要时辅以列表。",
    "table": "以表格为主（Markdown 表格），表格前后配简要的文字说明。",
    "steps": "按流程或步骤组织，步骤用有序列表，每步讲清做什么、谁来做、产出什么。",
    "mixed": "段落、列表、表格结合使用，选最清楚的方式表达。",
}


def render_fact_sheet(fact_sheet: Optional[FactSheet]) -> str:
    """把统一口径渲染成文本；内容为空时返回空串。"""
    if fact_sheet is None:
        return ""
    lines: List[str] = []
    if fact_sheet.project_name:
        lines.append(f"项目名称：{fact_sheet.project_name}")
    if fact_sheet.purchaser:
        lines.append(f"采购人：{fact_sheet.purchaser}")
    if fact_sheet.facts:
        lines.append("招标文件给定的约束（原样引用）：")
        lines.extend(f"- {item.key}：{item.value}" if item.key else f"- {item.value}" for item in fact_sheet.facts)
    if fact_sheet.decisions:
        lines.append("本方案的总体设定（全书保持一致）：")
        lines.extend(
            f"- {item.key}：{item.value}" if item.key else f"- {item.value}" for item in fact_sheet.decisions
        )
    if fact_sheet.terminology:
        lines.append("统一术语：")
        lines.extend(
            f"- {item.term}：{item.definition}" if item.definition else f"- {item.term}"
            for item in fact_sheet.terminology
        )
    if fact_sheet.placeholders:
        lines.append("以下企业信息需由投标人补充，正文中遇到时用【待补充：…】占位：")
        lines.extend(f"- {item}" for item in fact_sheet.placeholders)
    return "\n".join(lines)


def build_shared_messages(
    overview: str,
    fact_sheet: Optional[FactSheet],
    outline_text: str,
    company_profile: str = "",
    persona: str = "",
    style_notes: str = "",
) -> List[Message]:
    """全书各章共用的前缀消息（逐字稳定，利于缓存）。"""
    system = WRITER_SYSTEM
    if persona.strip():
        system += f"\n\n本方案的整体风格定位：{persona.strip()}"
    if style_notes.strip():
        system += f"\n\n投标人对全书的写作要求：\n{style_notes.strip()}"

    sections: List[str] = []
    if overview.strip():
        sections.append(f"【项目概述】\n{clip(overview, 3000)}")
    facts_text = render_fact_sheet(fact_sheet)
    if facts_text:
        sections.append(f"【统一口径】\n{facts_text}")
    if company_profile.strip():
        sections.append(f"【企业资料】（引用企业事实时以此为准）\n{clip(company_profile, 4000)}")
    else:
        sections.append(
            "【企业资料】\n投标人尚未填写企业资料。涉及企业名称、业绩、资质、人员等信息时，"
            "只能引用下文「参考资料」里明确出现的内容；参考资料里也没有的，一律用【待补充：…】占位。"
        )
    if outline_text.strip():
        sections.append(f"【全书目录】\n{outline_text}")

    return [
        {"role": "system", "content": system},
        {"role": "user", "content": "\n\n".join(sections)},
    ]


def _render_chunks(chunks: Sequence[Chunk]) -> str:
    parts: List[str] = []
    for chunk in chunks:
        label = " · ".join(p for p in (chunk.source, chunk.heading) if p)
        parts.append(f"〔{label}〕\n{chunk.text}" if label else chunk.text)
    return "\n\n".join(parts)


def render_sibling_digests(
    siblings: Sequence[Tuple[LeafInfo, ChapterDigest]],
    max_chars: int = 1400,
) -> str:
    lines: List[str] = []
    used = 0
    for leaf, digest in siblings:
        line = f"- {leaf.id} {leaf.title}：{digest.summary}"
        if digest.claims:
            line += f"（关键数据：{'；'.join(digest.claims[:3])}）"
        line = clip(line, 320)
        if used + len(line) > max_chars:
            break
        lines.append(line)
        used += len(line)
    return "\n".join(lines)


def build_chapter_context(
    leaf: LeafInfo,
    plan: Optional[ChapterPlan],
    requirements: Sequence[RequirementItem],
    tender_chunks: Sequence[Chunk] = (),
    material_chunks: Sequence[Chunk] = (),
    siblings: Sequence[Tuple[LeafInfo, ChapterDigest]] = (),
    coverage_map: str = "",
) -> str:
    """本章专属的上下文：位置、计划、招标原文、参考资料、相邻章节。"""
    blocks: List[str] = []

    head = [f"位置：{leaf_path(leaf)}", f"编号与标题：{leaf.id} {leaf.title}"]
    if leaf.description:
        head.append(f"说明：{leaf.description}")
    blocks.append("【本章】\n" + "\n".join(head))

    plan_lines: List[str] = []
    if plan is not None:
        if plan.key_points:
            plan_lines.append("必须写到的要点：")
            plan_lines.extend(f"{i}. {point}" for i, point in enumerate(plan.key_points, start=1))
        if plan.avoid:
            plan_lines.append("本章不展开的内容：")
            plan_lines.extend(f"- {item}" for item in plan.avoid)
        plan_lines.append(f"呈现形式：{FORM_HINTS.get(plan.form, FORM_HINTS['paragraph'])}")
        if plan.note.strip():
            plan_lines.append(f"投标人对本章的补充要求：{plan.note.strip()}")
    if requirements:
        plan_lines.append("本章需要正面响应的评审项 / 采购人要求（逐条落实，必含关键词要出现在正文里）：")
        plan_lines.extend(f"- {requirement_line(item, 200)}" for item in requirements)
    if plan_lines:
        blocks.append("【写作计划】\n" + "\n".join(plan_lines))

    if coverage_map:
        blocks.append("【评审项与支撑章节对照】（填写响应表的“支撑章节”时使用）\n" + coverage_map)

    if tender_chunks:
        blocks.append(
            "【招标文件相关原文】（摘录；引用其中的数字与要求时保持原样）\n" + _render_chunks(tender_chunks)
        )
    if material_chunks:
        blocks.append(
            "【参考资料】（来自投标人提供的资料，可以改写后使用，其中的企业事实可以引用；与本项目招标要求冲突时以招标文件为准）\n"
            + _render_chunks(material_chunks)
        )

    sibling_text = render_sibling_digests(siblings)
    if sibling_text:
        blocks.append("【已完成的相邻章节】（不要重复其中已写的内容；涉及相同事项时保持一致）\n" + sibling_text)

    return "\n\n".join(blocks)


def word_range(target: int) -> Tuple[int, int]:
    """目标字数对应的可接受区间。"""
    lower = max(int(target * 0.85), 100)
    upper = max(int(target * 1.25), lower + 150)
    return lower, upper


def chapter_task(leaf: LeafInfo, target_words: Optional[int], table_like: bool = False) -> str:
    task = f"【任务】\n请撰写「{leaf.id} {leaf.title}」的正文。"
    if table_like:
        # 响应表、清单类章节：完整性优先，篇幅只作参考，不能为了控制字数合并或删减条目
        task += "本章以表格为主：需要逐条响应的条目要一条不落地列全，不要合并、省略或缩写条目。"
        if target_words and target_words > 0:
            task += f"篇幅以写全为准（参考约 {target_words} 字）。"
    elif target_words and target_words > 0:
        lower, upper = word_range(target_words)
        task += (
            f"篇幅约 {target_words} 字（{lower}～{upper} 字，不含标题）。"
            "按这个篇幅安排详略：写到位就收，不要为凑字数重复，也不要明显超出。"
        )
    task += "直接输出正文。"
    return task


def continuation_task(current: int, target: int, pending_points: Sequence[str]) -> str:
    """篇幅不足时的补写指令。"""
    gap = max(target - current, 100)
    text = (
        f"以上正文约 {current} 字，本章目标约 {target} 字，还差约 {gap} 字。"
        "请接着上文继续写：补充还没有展开的内容"
    )
    if pending_points:
        text += "（优先：" + "；".join(clip(p, 40) for p in pending_points[:4]) + "）"
    text += "，给出更具体的做法、参数或流程。不要重复已经写过的内容，不要重新开头，不要写总结。直接输出续写的正文。"
    return text


TRUNCATED_TASK = (
    "上文因为单次输出的长度限制在中途断开了。请从断开的地方接着往下写，"
    "不要重复已经输出的内容，不要重新开头，把这一部分写完整。直接输出后续正文。"
)


def section_plan_task(leaf: LeafInfo, target_words: int, section_count: int) -> str:
    return (
        "【任务】\n"
        f"「{leaf.id} {leaf.title}」的目标篇幅约 {target_words} 字，篇幅较长，需要分成小节依次撰写。"
        f"请把本章划分为 {section_count} 个左右的小节（最少 2 个，最多 8 个）。\n"
        "要求：\n"
        "1. 小节之间按逻辑顺序排列，内容互不重叠，合起来完整覆盖写作计划里的全部要点和需要响应的条目。\n"
        "2. title 是小节标题，简短的名词短语，不带编号。\n"
        "3. points 是这个小节要写的 2-4 个要点，每个一句话。\n"
        f"4. words 是这个小节的目标字数，各小节之和约等于 {target_words}。\n"
        "5. 只输出 JSON，不要输出其他内容。\n"
        '格式：{"sections": [{"title": "", "points": ["", ""], "words": 800}]}'
    )


def section_task(
    leaf: LeafInfo,
    sections: Sequence[Tuple[str, Sequence[str], int]],
    index: int,
    done_summaries: Sequence[Tuple[str, str]],
    previous_tail: str,
) -> str:
    """撰写第 index 个小节的指令（index 从 0 开始）。"""
    lines: List[str] = ["【本章的小节划分】"]
    for i, (title, points, words) in enumerate(sections, start=1):
        detail = "；".join(clip(p, 60) for p in points)
        lines.append(f"{i}. {title}（约 {words} 字）" + (f"：{detail}" if detail else ""))
    if done_summaries:
        lines.append("")
        lines.append("【已经写完的小节】（不要重复其中的内容）")
        lines.extend(f"- {title}：{summary}" for title, summary in done_summaries)
    if previous_tail.strip():
        lines.append("")
        lines.append("【上一小节的结尾】（仅供衔接，不要重复）")
        lines.append(previous_tail.strip())

    title, _points, words = sections[index]
    lower, upper = word_range(words)
    lines.append("")
    lines.append(
        "【任务】\n"
        f"现在只撰写「{leaf.id} {leaf.title}」的第 {index + 1} 个小节「{title}」，约 {words} 字（{lower}～{upper} 字）。"
        "直接输出这个小节的正文：不要输出小节标题，不要写其他小节的内容，不要写全章的总结。"
    )
    return "\n".join(lines)


def revise_task(leaf: LeafInfo, content: str, instruction: str, target_words: Optional[int]) -> str:
    text = (
        f"【当前正文】\n{content.strip()}\n\n"
        f"【修改要求】\n{instruction.strip()}\n\n"
        "【任务】\n"
        f"请按修改要求修订「{leaf.id} {leaf.title}」，输出修订后的完整正文。"
        "只改动与修改要求有关的部分，其余内容尽量保持原样；不要丢掉原文里的表格、数据和小标题。"
    )
    text += "除非修改要求里另有说明（例如要求扩写或压缩），修订后的篇幅与当前正文大致相当。"
    text += "不要输出任何说明，直接输出正文。"
    return text


# ---------------------------------------------------------------------------
# 规划
# ---------------------------------------------------------------------------

FACT_SHEET_SYSTEM = """你是投标技术方案的总体设计负责人。团队即将分头撰写各个章节，在此之前你要先定下全书的「统一口径」，让所有章节在事实、方案设定和术语上保持一致，不出现前后矛盾。

要求：
1. facts：只收录招标文件明确给出的硬约束，例如工期或服务期、实施地点、建设范围、数量、技术指标、验收要求、质保期。value 原样摘录原文的数字和表述，不要改写，不要推测；原文没有的不要写。8-20 条。
2. decisions：本方案自拟的总体设定，只定到“全书必须保持一致”的粒度，例如总体技术路线、系统架构怎么分层、关键技术选型、实施分几个阶段及各阶段时长、项目组织方式、服务响应口径。每条一句话，8-15 条。设定必须满足 facts 里的约束。不要编造投标人的业绩、资质、人员姓名等企业事实。
3. terminology：需要全书统一叫法的名词，例如系统、平台、模块的名称和缩写。5-12 条。
4. placeholders：撰写时需要投标人自己提供的企业信息，例如类似项目业绩、资质证书、项目经理及其证书、公司简介。正文里这些内容会用【待补充：…】占位。
5. 只输出 JSON，不要输出其他内容。

JSON 格式：
{"project_name": "", "purchaser": "", "facts": [{"key": "", "value": ""}], "decisions": [{"key": "", "value": ""}], "terminology": [{"term": "", "definition": ""}], "placeholders": [""]}"""


def build_fact_sheet_messages(
    overview: str,
    requirements_text: str,
    outline_text: str,
    company_profile: str = "",
    tender_excerpt: str = "",
) -> List[Message]:
    parts = [f"【项目概述】\n{clip(overview, 6000)}"]
    if requirements_text.strip():
        parts.append(f"【技术评分要求与采购人要求】\n{clip(requirements_text, 8000)}")
    if tender_excerpt.strip():
        parts.append(f"【招标文件中与工期、指标、范围有关的原文摘录】\n{tender_excerpt}")
    if company_profile.strip():
        parts.append(f"【企业资料】\n{clip(company_profile, 3000)}")
    if outline_text.strip():
        parts.append(f"【已确定的全书目录】\n{outline_text}")
    return [
        {"role": "system", "content": FACT_SHEET_SYSTEM},
        {"role": "user", "content": "\n\n".join(parts)},
        {"role": "user", "content": "请给出全书的统一口径，按规定的 JSON 格式输出。"},
    ]


CHAPTER_PLAN_SYSTEM = """你是投标技术方案的主笔。全书目录已经确定，现在要给一组章节分别制定写作计划，交给不同的人分头撰写。计划有三个作用：划清各章的边界，避免内容重复；把每一条评审项和采购人要求落实到具体章节，避免漏项；让篇幅向评分分值高的章节倾斜。

要求：
1. key_points：这一章必须写到的 3-6 个要点，每个一句话，具体到“写什么”，不要写空话。
2. requirement_ids：这一章负责正面响应的评审项 / 采购人要求的编号，只能从给出的编号里选。一条要求可以由多个章节共同负责，但要选最贴切的；与这一章无关就给空数组。
3. avoid：这一章不展开的相邻内容，以及它们在哪一章，例如“系统安全设计见 3.4”。0-3 条。
4. weight：篇幅权重，1 表示平均水平。评分分值高、内容核心的章节取 1.5-3；概述、说明性的章节取 0.5-0.8。
5. form：paragraph（以段落为主）、table（以表格为主，例如响应表、配置清单、人员表）、steps（以流程步骤为主）、mixed（混合）。
6. 给出的每一个章节都必须有一条计划，id 原样照抄。
7. 只输出 JSON，不要输出其他内容。

JSON 格式：
{"plans": [{"id": "2.1.1", "key_points": ["", ""], "requirement_ids": ["E1"], "avoid": [""], "weight": 1.0, "form": "paragraph"}]}"""


def build_plan_shared_messages(
    overview: str,
    fact_sheet: Optional[FactSheet],
    outline_text: str,
    requirements_brief_text: str,
) -> List[Message]:
    """各批章节规划共用的前缀。"""
    sections: List[str] = []
    if overview.strip():
        sections.append(f"【项目概述】\n{clip(overview, 3000)}")
    facts_text = render_fact_sheet(fact_sheet)
    if facts_text:
        sections.append(f"【统一口径】\n{facts_text}")
    if outline_text.strip():
        sections.append(f"【全书目录】\n{outline_text}")
    if requirements_brief_text.strip():
        sections.append(f"【评审项与采购人要求】\n{requirements_brief_text}")
    else:
        sections.append("【评审项与采购人要求】\n（没有可用的结构化条目，requirement_ids 一律给空数组。）")
    return [
        {"role": "system", "content": CHAPTER_PLAN_SYSTEM},
        {"role": "user", "content": "\n\n".join(sections)},
    ]


def plan_batch_task(batch: Sequence[LeafInfo]) -> str:
    lines = ["【需要制定写作计划的章节】"]
    for leaf in batch:
        path = leaf_path(leaf)
        desc = f"：{clip(leaf.description, 160)}" if leaf.description else ""
        lines.append(f"- {leaf.id} {leaf.title}（位于：{path}）{desc}")
    lines.append("")
    lines.append(f"请为以上 {len(batch)} 个章节各输出一条写作计划，按规定的 JSON 格式输出。")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 深度审校
# ---------------------------------------------------------------------------

CONSISTENCY_SYSTEM = """你是投标文件的终审人，负责检查一份分章撰写的技术方案有没有前后矛盾。下面给出全书的「统一口径」和各章摘出的关键表述（主要是带数字、期限、指标的句子）。

要求：
1. 只报告确实互相矛盾的地方：同一件事在不同章节给出了不同的数字、期限、数量、名称或做法；或者某章的表述违反了统一口径里招标文件给定的约束。
2. 表述角度不同但不冲突的，不要报。证据不足的，不要报。宁缺毋滥。
3. 每个问题给出：涉及的章节编号 chapter_ids（至少一个）、矛盾说明 problem（引用双方的原话）、修改建议 suggestion（以谁为准、怎么改）。
4. 没有发现矛盾就返回空数组。
5. 只输出 JSON，不要输出其他内容。

JSON 格式：
{"issues": [{"chapter_ids": ["2.1.1", "4.2"], "problem": "", "suggestion": ""}]}"""


def build_consistency_messages(fact_sheet: Optional[FactSheet], claims_text: str) -> List[Message]:
    parts: List[str] = []
    facts_text = render_fact_sheet(fact_sheet)
    if facts_text:
        parts.append(f"【统一口径】\n{facts_text}")
    parts.append(f"【各章关键表述】\n{claims_text}")
    return [
        {"role": "system", "content": CONSISTENCY_SYSTEM},
        {"role": "user", "content": "\n\n".join(parts)},
        {"role": "user", "content": "请检查以上内容是否存在前后矛盾，按规定的 JSON 格式输出。"},
    ]
