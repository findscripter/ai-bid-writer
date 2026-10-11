"""本地审校（review_checks）的测试：每项检查的命中与不命中、边界、排序、ID 稳定性、综合场景与性能。"""
from __future__ import annotations

import hashlib
import json
import os
import random
import subprocess
import sys
import time
import zlib
from datetime import datetime
from typing import Dict, List, Optional

import pytest

from app.writing import review_checks as rc
from app.writing.models import (
    Blueprint,
    ChapterPlan,
    ChapterRecord,
    LeafInfo,
    RequirementItem,
    ReviewIssue,
)
from app.writing.textutil import count_chars, split_sentences

# ---------------------------------------------------------------------------
# 造数据的小工具
# ---------------------------------------------------------------------------

# 只用这一段里的汉字随机造句：里面凑不出任何占位词、套话或模型口吻，不会干扰别的检查
_POOL = [chr(code) for code in range(0x4E00, 0x4E00 + 2500)]


def chars_of(seed: object, length: int) -> str:
    """由 seed 决定的 length 个随机汉字（不带标点）。"""
    rng = random.Random(f"chars-{seed}")
    return "".join(rng.choice(_POOL) for _ in range(length))


def sentence(seed: object, length: int = 30) -> str:
    """一个归一化后恰好 length 个字的句子。"""
    return chars_of(seed, length) + "。"


def body(seed: object, chars: int) -> str:
    """约 chars 字、互不重复的正文。"""
    rng = random.Random(f"body-{seed}")
    parts: List[str] = []
    total = 0
    while total < chars:
        length = rng.randint(20, 40)
        parts.append("".join(rng.choice(_POOL) for _ in range(length)) + "。")
        total += length + 1
    return "".join(parts)


def exact_body(seed: object, chars: int) -> str:
    """恰好 chars 个非空白字符的正文。"""
    text = body(seed, chars + 60)
    return text[:chars]


def leaf(uid: str, number: str = "", title: str = "") -> LeafInfo:
    return LeafInfo(uid=uid, id=number or uid, title=title or f"章节{uid}")


def done(uid: str, content: str, **extra: object) -> ChapterRecord:
    return ChapterRecord(uid=uid, status="done", content=content, chars=count_chars(content), **extra)


def make_views(contents: Dict[str, Optional[ChapterRecord]]) -> List[rc.ChapterView]:
    """contents：uid → 章节记录（None 表示没有记录），按字典顺序作为文档顺序。"""
    leaves = [leaf(uid) for uid in contents]
    chapters = {uid: record for uid, record in contents.items() if record is not None}
    return rc.build_views(leaves, chapters)


def texts_view(**contents: str) -> List[rc.ChapterView]:
    return make_views({uid: done(uid, text) for uid, text in contents.items()})


def only(issues: List[ReviewIssue], kind: str) -> List[ReviewIssue]:
    return [issue for issue in issues if issue.type == kind]


# ---------------------------------------------------------------------------
# 文本级函数
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw",
    [
        "建立质量管理体系，落实责任制。",
        "1. 建立质量管理体系，落实责任制。",
        "（2）建立质量管理体系，落实责任制。",
        "二、建立质量管理体系,落实责任制",
        "- **建立质量管理体系**，落实 责任制。",
        "① 建立质量管理体系，落实责任制！",
    ],
)
def test_normalize_sentence_ignores_markers_and_punctuation(raw: str) -> None:
    assert rc.normalize_sentence(raw) == "建立质量管理体系落实责任制"


def test_normalize_sentence_details() -> None:
    # 小数不是序号
    assert rc.normalize_sentence("3.5 米宽的道路") == "35米宽的道路"
    # 全半角与大小写统一
    assert rc.normalize_sentence("ＡＢＣ　１２３ abc") == "abc123abc"
    # 数字不同就是不同的句子
    assert rc.normalize_sentence("响应时间不超过2小时") != rc.normalize_sentence("响应时间不超过4小时")
    assert rc.normalize_sentence("") == ""
    assert rc.normalize_sentence("。。。！！") == ""


def test_split_for_compare_keeps_only_prose() -> None:
    text = "### 小节标题\n| 序号 | 名称 |\n| --- | :---: |\n| 1 | 服务器 |\n正文第一句。正文第二句；第三句\n序号 | 名称\n---|---\n"
    assert rc.split_for_compare(text) == ["正文第一句。", "正文第二句；", "第三句"]
    assert rc.split_for_compare("") == []
    assert rc.split_for_compare("只有一句") == ["只有一句"]
    assert rc.split_for_compare("a | b 不是表格。竖线 | 只是普通字符") == ["a | b 不是表格。", "竖线 | 只是普通字符"]


def test_table_rows_count_towards_similarity_but_not_sentences() -> None:
    rows = "".join(f"| {i} | {chars_of(f'cell-{i}', 30)} |\n" for i in range(1, 13))
    table = "| 序号 | 设备名称与规格型号及主要技术参数 |\n|---|---|\n" + rows
    (view,) = texts_view(a=table)
    assert view.sentences == []
    assert len(view.shingles) > 300
    assert rc.shingle_set(chars_of("cell-3", 30)) <= view.shingles
    # 表头不算：不同章节的表格用同样的表头是正常的
    assert not rc.shingle_set("设备名称与规格型号及主要技术参数") & view.shingles


@pytest.mark.parametrize(
    "text, expected",
    [
        ("GB/T 22239-2019《信息安全技术 网络安全等级保护基本要求》", True),
        ("（1）《建筑工程施工质量验收统一标准》GB50300-2013；", True),
        ("《中华人民共和国网络安全法》《中华人民共和国数据安全法》", True),
        ("- 《政府采购货物和服务招标投标管理办法》（财政部令第87号）", True),
        ("GB 50174-2017 数据中心设计规范", True),
        ("ISO/IEC 27001:2022 信息安全管理体系", True),
        ("3. GB/T 22239-2019 信息安全技术 网络安全等级保护基本要求；", True),
        ("GB/T 22239-2019 是本项目安全设计的主要依据，各子系统均按其第三级要求落实。", False),
        ("本项目严格遵循《信息安全技术 网络安全等级保护基本要求》三级标准进行设计。", False),
        ("系统部署 2 台 CPU 不低于 2400 分值的服务器并配置冗余电源模块。", False),
        ("我方将严格按照招标文件的要求组织实施并按期交付全部成果。", False),
    ],
)
def test_reference_entries(text: str, expected: bool) -> None:
    assert rc._is_reference_entry(text) is expected


def test_shingles_and_jaccard() -> None:
    text = chars_of("shingle", 50)
    grams = rc.shingle_set(text)
    assert len(grams) == 50 - rc.SHINGLE_SIZE + 1
    # 空白与标点不影响
    assert rc.shingle_set(" ".join(text) + "。") == grams
    assert rc.shingle_set("太短") == frozenset()
    assert rc.jaccard(grams, grams) == 1.0
    assert rc.jaccard(grams, rc.shingle_set(chars_of("other", 50))) == 0.0
    assert rc.jaccard(grams, frozenset()) == 0.0
    assert rc.jaccard(frozenset(), frozenset()) == 0.0
    half = rc.shingle_set(text[:30] + chars_of("tail", 20))
    assert 0.0 < rc.jaccard(grams, half) < 1.0


@pytest.mark.parametrize(
    "text, expected",
    [
        ("项目经理由【待补充：项目经理姓名及证书】担任。", ["【待补充：项目经理姓名及证书】"]),
        ("电话【待补充:联系电话】，地址【待补充】。", ["【待补充:联系电话】", "【待补充】"]),
        ("资质见【待填写企业资质】，时间【待定】，金额【待确认：合同金额】。", ["【待填写企业资质】", "【待定】", "【待确认：合同金额】"]),
        ("（待定）进场时间；[待补充] 资料；〔待核实〕数据。", ["（待定）", "[待补充]", "〔待核实〕"]),
        ("【此处插入系统架构图】与【请填写公司名称】", ["【此处插入系统架构图】", "【请填写公司名称】"]),
        ("【待补充：公司名称（全称）】", ["【待补充：公司名称（全称）】"]),
        # 没有闭合括号时只取到引导词
        ("【待补充：未闭合的占位\n下一行正文", ["【待补充"]),
        # 括号里的掩码不重复计
        ("【待补充：XXX公司的资质证书】", ["【待补充：XXX公司的资质证书】"]),
        ("由XXX公司承建，负责人×××，合同编号HT-XXXX。", ["XXX", "×××", "XXXX"]),
        # 只隔一个字的掩码串是同一处
        ("于20XX年XX月XX日完成", ["20XX年XX月XX"]),
        ("地址：XX省XX市XX区", ["XX省XX市XX"]),
        ("服务器地址 xxx.xxx.xxx.xxx", ["xxx.xxx.xxx.xxx"]),
        ("XXX、XXX", ["XXX", "XXX"]),
        ("电话138xxxxxxxx，编号2024XXXX", ["138xxxxxxxx", "2024XXXX"]),
        ("金额：____元（大写：＿＿＿＿）", ["____", "＿＿＿＿"]),
        ("□□□□；○○公司", ["□□□□", "○○"]),
        ("某某公司在某某项目中的经验；某某市", ["某某公司", "某某项目", "某某"]),
        ("联系人：张三、李四", ["张三", "李四"]),
        ("相关材料待补充。", ["待补充"]),
    ],
)
def test_find_placeholders_hits(text: str, expected: List[str]) -> None:
    assert [found for found, _ in rc.find_placeholders_in_text(text)] == expected


@pytest.mark.parametrize(
    "text",
    [
        "",
        "本项目采用分层架构，确保系统具备良好的扩展能力。",
        "【待遇】【待机功耗】【待办事项】【重要】",
        "尺码为 XXL，系统为 Linux，型号 MAX，分辨率 1920x1080，Xbox。",
        "返回 5xx 错误和 4XX 错误，型号 DS-2CD3XX。",
        "二〇〇八年；□是 □否；3×4 的矩阵。",
        "等待补充完善后提交；期待补充更多案例。",
        "李四光地质科学奖、张三丰。",
        "正文\n___\n下一段",
        "变量名 max_retry_count 与 __init__。",
        "某些情况下，某一节点故障不影响整体。",
    ],
)
def test_find_placeholders_misses(text: str) -> None:
    assert rc.find_placeholders_in_text(text) == []


def test_placeholder_context_is_about_twenty_chars_each_side() -> None:
    before = chars_of("before", 50)
    after = chars_of("after", 50)
    found = rc.find_placeholders_in_text(f"{before}【待补充：资质】{after}")
    assert found == [("【待补充：资质】", before[-20:] + "【待补充：资质】" + after[:20])]
    # 靠近开头与结尾时不越界，换行压成空格
    found = rc.find_placeholders_in_text("前文\n【待定】\n后文")
    assert found == [("【待定】", "前文 【待定】 后文")]
    # 占位本身原样出现在上下文里（界面靠它在上下文里定位并标亮）
    odd = "前文  很多\t空白 【 待补充：资质   证书\t扫描件】  后文\n\n下一段"
    ((text, context),) = rc.find_placeholders_in_text(odd)
    assert text == "【 待补充：资质   证书\t扫描件】"
    assert context == "前文 很多 空白 " + text + " 后文 下一段"
    for sample in _WEIRD_TEXTS:
        assert all(found in around for found, around in rc.find_placeholders_in_text(sample)[:50])


def test_placeholder_spans_do_not_overlap_and_are_ordered() -> None:
    text = "【待补充：XXX】某某公司XX年待补充张三____"
    spans = rc.find_placeholder_spans(text)
    assert spans == sorted(spans)
    for (_, end), (start, _) in zip(spans, spans[1:]):
        assert end <= start


def test_count_filler_phrases() -> None:
    assert rc.count_filler_phrases("") == {}
    assert rc.count_filler_phrases("本项目采用分层架构。") == {}
    counts = rc.count_filler_phrases("综上所述，甲。总而言之，乙。值得注意的是，丙。综上所述，丁。")
    assert counts == {"综上所述": 2, "总而言之": 1, "值得注意的是": 1}
    # 三段式整组算一次
    assert rc.count_filler_phrases("首先，做甲。其次，做乙。最后，做丙。") == {"首先…其次…最后": 1}
    # 只有「首先」「最后」，或者三个词隔得太远，都不算
    assert rc.count_filler_phrases("首先，做甲。最后，做丙。") == {}
    far = "首先做甲。" + chars_of("gap", rc.FILLER_SEQUENCE_GAP + 10) + "其次做乙。最后做丙。"
    assert rc.count_filler_phrases(far) == {}
    # 前一个「首先」没凑成一组，不影响后面的；一组里多出来的「首先」不重复计
    assert rc.count_filler_phrases(far + "首先做丁。其次做戊。最后做己。") == {"首先…其次…最后": 1}
    assert rc.count_filler_phrases("首先，首先要说明的是甲。其次是乙。最后是丙。") == {"首先…其次…最后": 1}
    assert rc.count_filler_phrases("首先甲。其次乙。最后丙。" * 3) == {"首先…其次…最后": 3}


@pytest.mark.parametrize(
    "text",
    [
        "作为AI，我无法提供真实的企业资质信息。",
        "作为一个人工智能助手，我会尽力帮助您。",
        "作为一个人工智能，无法访问贵公司的内部资料。",
        "作为 ai 语言模型，我不能确认该数据。",
        "作为ai助手，我会尽力把这一章写完整。",
        "以下是为您撰写的技术方案：",
        "希望以上内容对您有所帮助。",
        "如有需要请告诉我，我可以继续完善。",
        "如有需要，请随时提出。",
        "如有任何疑问，欢迎随时提出！",
        "如需调整，请告知。",
        "如需进一步完善某一部分，我可以继续补充。",
        "请注意：以上内容为示例。",
        "请注意:以上内容为示例。",
        "以上内容仅供参考。",
        "很抱歉，这部分信息缺失。",
        "正文第一段。\n好的，下面继续撰写第二部分。",
    ],
)
def test_find_ai_voice_hits(text: str) -> None:
    assert rc.find_ai_voice(text), text


@pytest.mark.parametrize(
    "text",
    [
        "",
        "本平台作为AI中台的核心组件，为上层应用提供能力。",
        "作为AI助手产品，本系统可为市民提供咨询服务。",
        "作为人工智能领域的领军企业，我司拥有多项专利。",
        "作为一个人工智能平台，本系统具备自学习能力。",
        "如有需要，请联系我方项目经理。",
        "如有需要，请告知我方服务热线。",
        "采购人如有需要，请提出书面变更申请。",
        "如需扩容，可通过增加节点实现。",
        "如需调整，请告知我方项目经理。",
        "请及时告知我司售后人员。",
        "我方无法提供的资料将另行说明。",
        "系统运行良好的情况下无需人工干预。",
        "希望通过本项目的实施提升服务水平。",
    ],
)
def test_find_ai_voice_misses(text: str) -> None:
    assert rc.find_ai_voice(text) == [], text


def test_find_ai_voice_returns_sentence_once() -> None:
    text = "系统采用分层架构。希望以上内容对您有所帮助。部署在政务云。"
    assert rc.find_ai_voice(text) == ["希望以上内容对您有所帮助。"]
    assert rc.find_ai_voice(text + "\n希望以上内容对您有所帮助。") == ["希望以上内容对您有所帮助。"]


@pytest.mark.parametrize(
    "text, kinds",
    [
        ("```python\nprint(1)\n```", ["fence"]),
        ("# 一级标题\n正文", ["heading"]),
        ("正文\n## 二级标题\n正文", ["heading"]),
        ("换行<br>符号", ["html"]),
        ('<div class="a">块</div>', ["html"]),
        ("空格&nbsp;实体", ["html"]),
        ("**未闭合的加粗", ["bold"]),
        ("**一处** 正常，**另一处没闭合", ["bold"]),
        ("# 标题\n```\n<br>\n**x", ["fence", "heading", "html", "bold"]),
    ],
)
def test_find_markup_residue_hits(text: str, kinds: List[str]) -> None:
    assert list(rc.find_markup_residue(text)) == kinds


@pytest.mark.parametrize(
    "text",
    [
        "",
        "正常文本，没有任何标记。",
        "### 三级小标题\n正文\n#### 四级小标题",
        "行内的 # 号与 ## 号不在行首。",
        "#1 机组与 #2 机组",
        "**加粗** 与 **另一处加粗** 都闭合了。",
        "***加粗斜体***",
        "正文\n***\n正文",
        "2**10 的结果是 1024。",
        "响应时间<10ms，a<b 且 c>d，<项目名称>。",
        "| 序号 | 名称 |\n|---|---|\n| 1 | 服务器 |",
    ],
)
def test_find_markup_residue_misses(text: str) -> None:
    assert rc.find_markup_residue(text) == {}


def test_issue_id_is_stable_and_distinct() -> None:
    first = rc.issue_id("length", "u1", "short")
    assert first == rc.issue_id("length", "u1", "short")
    assert first.startswith("length-")
    assert first != rc.issue_id("length", "u1", "long")
    assert first != rc.issue_id("length", "u2", "short")
    assert first != rc.issue_id("repeat", "u1", "short")
    # 分隔方式不会让不同的参数组合撞在一起
    assert rc.issue_id("x", "ab", "c") != rc.issue_id("x", "a", "bc")
    # 孤立代理项不报错
    assert rc.issue_id("x", chr(0xD83D))


# ---------------------------------------------------------------------------
# 章节视图
# ---------------------------------------------------------------------------


def test_build_views_states() -> None:
    views = make_views(
        {
            "none": None,
            "blank": done("blank", "  \n\t "),
            "failed": ChapterRecord(uid="failed", status="failed", error="超时"),
            "failed_text": ChapterRecord(uid="failed_text", status="failed", content="写了一半"),
            "cancelled": ChapterRecord(uid="cancelled", status="cancelled", content="写了一半"),
            "cancelled_blank": ChapterRecord(uid="cancelled_blank", status="cancelled"),
            "writing": ChapterRecord(uid="writing", status="writing", content="正在写"),
            "done": done("done", "写完了"),
            "stale": ChapterRecord(uid="stale", status="empty", content="手动粘贴的正文"),
            "upper": ChapterRecord(uid="upper", status=" FAILED ", content="状态的大小写与空白不影响"),
        }
    )
    states = {view.uid: view.state for view in views}
    assert states.pop("upper") == rc.STATE_FAILED
    assert states == {
        "none": rc.STATE_EMPTY,
        "blank": rc.STATE_EMPTY,
        "failed": rc.STATE_FAILED,
        "failed_text": rc.STATE_FAILED,
        "cancelled": rc.STATE_PARTIAL,
        "cancelled_blank": rc.STATE_EMPTY,
        "writing": rc.STATE_PARTIAL,
        "done": rc.STATE_DONE,
        "stale": rc.STATE_DONE,
    }
    assert [view.index for view in views] == list(range(len(views)))


def test_build_views_skips_duplicate_uids_and_tolerates_missing_inputs() -> None:
    views = rc.build_views([leaf("a"), leaf("a"), leaf("b")], None)
    assert [view.uid for view in views] == ["a", "b"]
    assert rc.build_views([], {}) == []
    assert rc.build_views(None, None) == []  # type: ignore[arg-type]


def test_long_titles_are_clipped_in_messages() -> None:
    views = rc.build_views([LeafInfo(uid="a", id="1.1", title="很长的标题" * 30)], {})
    (issue,) = rc.check_status(views)
    assert len(views[0].label) <= 40 and views[0].label.endswith("…")
    assert views[0].label in issue.detail


# ---------------------------------------------------------------------------
# 1. 状态
# ---------------------------------------------------------------------------


def test_status_empty_failed_partial() -> None:
    views = make_views(
        {
            "none": None,
            "blank": done("blank", " \n "),
            "failed": ChapterRecord(uid="failed", status="failed", error="模型服务超时"),
            "cancelled": ChapterRecord(uid="cancelled", status="cancelled", content="写了一半的正文"),
            "cancelled_blank": ChapterRecord(uid="cancelled_blank", status="cancelled"),
            "ok": done("ok", "正常写完的正文。"),
        }
    )
    issues = {issue.chapter_uids[0]: issue for issue in rc.check_status(views)}
    assert set(issues) == {"none", "blank", "failed", "cancelled", "cancelled_blank"}

    for uid in ("none", "blank", "cancelled_blank"):
        assert (issues[uid].type, issues[uid].severity, issues[uid].title) == ("empty", "high", "章节尚未生成")
    assert (issues["failed"].type, issues["failed"].severity) == ("failed", "high")
    assert "模型服务超时" in issues["failed"].detail
    assert (issues["cancelled"].type, issues["cancelled"].severity) == ("partial", "medium")
    assert issues["cancelled"].excerpt == "写了一半的正文"  # 摘录正文的结尾，方便看断在哪
    assert all(not issue.fixable for issue in issues.values())


def test_status_failed_wins_over_partial_text() -> None:
    views = make_views({"a": ChapterRecord(uid="a", status="failed", content="失败前写出的部分", error="余额不足")})
    (issue,) = rc.check_status(views)
    assert issue.type == "failed"
    assert "余额不足" in issue.detail


def test_status_failed_without_error_and_truncated_and_writing() -> None:
    views = make_views(
        {
            "failed": ChapterRecord(uid="failed", status="failed"),
            "cut": done("cut", "写到一半被截断的正文", truncated=True),
            "writing": ChapterRecord(uid="writing", status="writing", content="还在写"),
            "stale": ChapterRecord(uid="stale", status="empty", content="手动粘贴的正文"),
        }
    )
    issues = {issue.chapter_uids[0]: issue for issue in rc.check_status(views)}
    assert set(issues) == {"failed", "cut", "writing"}
    assert issues["failed"].detail  # 没有 error 也有说明
    # 结尾被截断单独一个类型：它已经写完，只是结尾可能不完整，不和“未写完”混在一起
    assert (issues["cut"].type, issues["cut"].severity) == ("truncated", "medium")
    assert (issues["writing"].type, issues["writing"].severity) == ("partial", "medium")
    # 「被截断」与「被取消」是两个不同的问题
    cancelled = make_views({"cut": ChapterRecord(uid="cut", status="cancelled", content="写了一半")})
    assert issues["cut"].id != rc.check_status(cancelled)[0].id


# ---------------------------------------------------------------------------
# 2. 篇幅
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "actual, expected",
    [
        (300, ("medium", "篇幅不足")),
        (599, ("medium", "篇幅不足")),
        (600, None),  # 恰好 0.6 不算不足
        (1000, None),
        (1600, None),  # 恰好 1.6 不算超出
        (1601, ("low", "篇幅超出")),
        (3000, ("low", "篇幅超出")),
    ],
)
def test_length_thresholds(actual: int, expected: Optional[tuple]) -> None:
    views = texts_view(a=exact_body("len", actual))
    assert views[0].chars == actual
    issues = rc.check_length(views, {"a": 1000})
    if expected is None:
        assert issues == []
        return
    (issue,) = issues
    assert (issue.type, issue.severity, issue.title) == ("length",) + expected
    assert issue.fixable
    assert issue.chapter_uids == ["a"]
    assert "1000" in issue.fix_instruction
    assert ("扩写" if actual < 1000 else "压缩") in issue.fix_instruction
    assert str(actual) in issue.detail


def test_length_needs_done_chapter_and_target() -> None:
    short = exact_body("short", 100)
    views = make_views(
        {
            "no_budget": done("no_budget", short),
            "zero": done("zero", short),
            "negative": done("negative", short),
            "cancelled": ChapterRecord(uid="cancelled", status="cancelled", content=short),
            "failed": ChapterRecord(uid="failed", status="failed", content=short),
            "none": None,
        }
    )
    budget = {"zero": 0, "negative": -5, "cancelled": 1000, "failed": 1000, "none": 1000}
    assert rc.check_length(views, budget) == []
    assert rc.check_length(views, {}) == []
    assert rc.check_length(views, None) == []


def test_length_falls_back_to_recorded_target() -> None:
    views = make_views({"a": done("a", exact_body("fallback", 100), target_words=1000)})
    (issue,) = rc.check_length(views, {})
    assert issue.title == "篇幅不足"
    # 当前预算优先于写作时记下的目标
    assert rc.check_length(views, {"a": 120}) == []


def test_length_ids_differ_by_direction() -> None:
    short = rc.check_length(texts_view(a=exact_body("x", 100)), {"a": 1000})[0]
    long = rc.check_length(texts_view(a=exact_body("x", 2000)), {"a": 1000})[0]
    assert short.id != long.id


# ---------------------------------------------------------------------------
# 3. 占位符
# ---------------------------------------------------------------------------


def test_placeholders_listed_in_document_order_without_issues() -> None:
    views = make_views(
        {
            "a": done("a", "项目经理【待补充：姓名】，电话【待补充】。"),
            "b": None,
            "c": ChapterRecord(uid="c", status="cancelled", content="由XXX公司承建。"),
            "d": done("d", "没有占位的正文。"),
        }
    )
    items = rc.find_placeholders(views)
    assert [(item.chapter_uid, item.text) for item in items] == [
        ("a", "【待补充：姓名】"),
        ("a", "【待补充】"),
        ("c", "XXX"),
    ]
    assert all(item.text in item.context for item in items)


def test_placeholders_do_not_become_issues() -> None:
    leaves = [leaf("a")]
    chapters = {"a": done("a", "项目经理由【待补充：姓名】担任，联系电话【待补充】，由某某公司提供支持。")}
    report = rc.run_local_review(leaves, chapters, {}, [])
    assert report.stats.placeholder_count == 3
    assert len(report.placeholders) == 3
    assert report.issues == []


# ---------------------------------------------------------------------------
# 4. 跨章重复
# ---------------------------------------------------------------------------


def test_duplicate_two_shared_sentences() -> None:
    s1, s2 = sentence("dup-1", 20), sentence("dup-2", 25)
    views = texts_view(
        a=body("a", 300) + s1 + body("a2", 100) + s2,
        b=body("b", 300) + s2 + s1 + body("b2", 100),
        c=body("c", 300),
    )
    (issue,) = rc.check_cross_duplicates(views)
    assert (issue.type, issue.severity) == ("duplicate", "medium")
    assert issue.chapter_uids == ["a", "b"]
    assert issue.fixable
    # 摘录与修订指令列的是靠后那一章里的句子，按它们在那一章出现的顺序
    assert issue.excerpt.split("\n") == [s2, s1]
    assert s1 in issue.fix_instruction and s2 in issue.fix_instruction
    # 标题和指令都点明是哪两章：使用者可能在任何一章的页面上看到它、对任何一章发起修订
    for text in (issue.title, issue.fix_instruction):
        assert "章节a" in text and "章节b" in text
    assert "本章" in issue.fix_instruction and "前面的章节" not in issue.fix_instruction


def test_duplicate_order_follows_document_not_dict() -> None:
    s1, s2 = sentence("order-1", 20), sentence("order-2", 20)
    leaves = [leaf("later"), leaf("earlier")]
    chapters = {
        "earlier": done("earlier", body("e", 200) + s1 + s2),
        "later": done("later", body("l", 200) + s1 + s2),
    }
    (issue,) = rc.check_cross_duplicates(rc.build_views(leaves, chapters))
    assert issue.chapter_uids == ["later", "earlier"]


@pytest.mark.parametrize(
    "shared, expected",
    [
        ([sentence("one-short", 18)], False),  # 只有 1 句且不够长
        ([sentence("one-39", 39)], False),
        ([sentence("one-40", 40)], True),  # 1 句达到 40 字
        ([sentence("two-a", 18), sentence("two-b", 18)], True),  # 2 句达到 18 字
        ([sentence("tiny-a", 17), sentence("tiny-b", 17), sentence("tiny-c", 17)], False),  # 不到 18 字的不参与
        ([sentence("mix-a", 17), sentence("mix-b", 18)], False),
    ],
)
def test_duplicate_thresholds(shared: List[str], expected: bool) -> None:
    views = texts_view(a=body("a", 300) + "".join(shared), b="".join(shared) + body("b", 300))
    issues = rc.check_cross_duplicates(views)
    assert bool(issues) is expected


@pytest.mark.parametrize("count, severity", [(4, "medium"), (5, "high"), (9, "high")])
def test_duplicate_severity_by_shared_count(count: int, severity: str) -> None:
    shared = [sentence(f"sev-{i}", 22) for i in range(count)]
    views = texts_view(a=body("a", 200) + "".join(shared), b=body("b", 200) + "".join(shared))
    (issue,) = rc.check_cross_duplicates(views)
    assert issue.severity == severity
    assert len(issue.excerpt.split("\n")) == min(count, 3)
    assert str(count) in issue.title
    # 句子多时指令里只列一部分，并说明还有多少
    listed = sum(1 for line in issue.fix_instruction.split("\n") if line[:1].isdigit())
    assert listed == min(count, rc.MAX_LISTED_SENTENCES)
    assert ("另有" in issue.fix_instruction) is (count > rc.MAX_LISTED_SENTENCES)


def test_duplicate_matches_after_normalization() -> None:
    core1, core2 = chars_of("norm-1", 24), chars_of("norm-2", 24)
    views = texts_view(
        a=body("a", 200) + f"1. {core1}。\n2. {core2}。",
        b=body("b", 200) + f"（1）{core1[:10]} {core1[10:]}！\n- **{core2}**；",
    )
    (issue,) = rc.check_cross_duplicates(views)
    assert issue.chapter_uids == ["a", "b"]


def test_duplicate_ignores_headings_tables_references_and_placeholders() -> None:
    """这几类内容在不同章节里相同是正常的，而且不该让模型去「改写」。"""
    heading = "### 实施阶段划分与各阶段主要工作内容及交付成果说明\n"
    table = (
        "| 序号 | 阶段名称 | 主要工作内容 | 交付成果 | 时间节点 | 责任人 |\n| --- | --- | --- | --- | --- | --- |\n"
        f"| 1 | {chars_of('row-1', 30)} |\n| 2 | {chars_of('row-2', 30)} |\n"
    )
    references = (
        "- GB/T 22239-2019《信息安全技术 网络安全等级保护基本要求》\n"
        "- GB/T 25070-2019《信息安全技术 网络安全等级保护安全设计技术要求》\n"
        "- 《中华人民共和国网络安全法》《中华人民共和国数据安全法》\n"
    )
    placeholders = (
        "项目经理：【待补充：项目经理姓名、职称及执业资格证书编号】\n"
        "【待补充：近三年类似项目业绩（项目名称、合同金额、完成时间、联系人）】\n"
    )
    common = heading + table + references + placeholders
    views = texts_view(a=common + body("a", 400), b=common + body("b", 400))
    assert rc.check_cross_duplicates(views) == []
    # 同一章里出现两次也不算章内重复
    assert rc.check_inner_repeats(texts_view(a=common + body("a", 400) + "\n" + common)) == []


def test_duplicate_still_counts_sentences_that_merely_contain_placeholders_or_references() -> None:
    s1 = "我方指派【待补充：项目经理姓名】担任项目经理，全面负责项目的进度、质量、成本与沟通协调工作。"
    s2 = "系统安全设计严格遵循《信息安全技术 网络安全等级保护基本要求》第三级的各项技术与管理要求。"
    views = texts_view(a=body("a", 300) + s1 + s2, b=body("b", 300) + s1 + s2)
    (issue,) = rc.check_cross_duplicates(views)
    assert issue.excerpt.split("\n") == [s1, s2]


def test_identical_tables_show_up_as_similar_chapters() -> None:
    rows = "".join(f"| {i} | {chars_of(f'spec-{i}', 40)} |\n" for i in range(1, 21))
    table = "| 序号 | 规格参数 |\n|---|---|\n" + rows
    views = texts_view(a=table + body("a", 100), b=table + body("b", 100))
    (issue,) = rc.check_cross_duplicates(views)
    assert "相似" in issue.title
    assert issue.severity == "medium"


def test_duplicate_same_sentences_in_three_chapters_reported_once_per_later_chapter() -> None:
    s1, s2 = sentence("tri-1", 22), sentence("tri-2", 22)
    views = texts_view(
        a=body("a", 200) + s1 + s2,
        b=body("b", 200) + s1 + s2,
        c=body("c", 200) + s1 + s2,
    )
    issues = rc.check_cross_duplicates(views)
    # b、c 各报一次，都指向最早出现的 a；b 与 c 之间不再重复报同样的句子
    assert [issue.chapter_uids for issue in issues] == [["a", "b"], ["a", "c"]]


def test_duplicate_reports_second_source_when_it_adds_new_sentences() -> None:
    s = [sentence(f"multi-{i}", 22) for i in range(5)]
    views = texts_view(
        a=body("a", 200) + s[0] + s[1] + s[2],
        b=body("b", 200) + s[3] + s[4],
        c=body("c", 200) + "".join(s),
    )
    issues = rc.check_cross_duplicates(views)
    assert [issue.chapter_uids for issue in issues] == [["a", "c"], ["b", "c"]]
    assert s[3] in issues[1].fix_instruction and s[0] not in issues[1].fix_instruction


def test_duplicate_caps_issues_per_chapter() -> None:
    sources = rc.MAX_DUPLICATE_ISSUES_PER_CHAPTER + 3
    shared = {i: [sentence(f"cap-{i}-{k}", 22) for k in range(2)] for i in range(sources)}
    contents = {f"s{i}": body(f"s{i}", 200) + "".join(shared[i]) for i in range(sources)}
    contents["last"] = body("last", 200) + "".join("".join(pair) for pair in shared.values())
    issues = rc.check_cross_duplicates(texts_view(**contents))
    assert len(issues) == rc.MAX_DUPLICATE_ISSUES_PER_CHAPTER
    assert all(issue.chapter_uids[1] == "last" for issue in issues)


def _mutate(text: str, per_sentence: int) -> str:
    """把每个句子里的若干个字换掉，制造「改写式」的雷同。"""
    result = []
    for index, part in enumerate(text.split("。")):
        if not part:
            continue
        chars = list(part)
        step = len(chars) // (per_sentence + 1)
        for k in range(1, per_sentence + 1):
            chars[k * step] = chr(0x9000 + (index * 7 + k) % 500)
        result.append("".join(chars))
    return "。".join(result) + "。"


def test_near_duplicate_by_shingles() -> None:
    base = body("near", 900)
    views = texts_view(a=base, b=_mutate(base, 1), c=body("far", 900))
    assert rc._shared_sentences(views) == {}  # 没有任何一句完全相同
    (issue,) = rc.check_cross_duplicates(views)
    assert (issue.type, issue.severity) == ("duplicate", "medium")
    assert issue.chapter_uids == ["a", "b"]
    assert issue.fixable and "章节a" in issue.fix_instruction
    assert "相似" in issue.title
    # 摘录的是靠后那一章里雷同最明显的句子，并且写进了修订指令
    samples = issue.excerpt.split("\n")
    later_sentences = {raw for raw, _ in views[1].sentences}
    assert len(samples) == 3 and set(samples) <= later_sentences
    assert all(sample in issue.fix_instruction for sample in samples)


def test_near_duplicate_threshold_is_conservative() -> None:
    base = body("near-2", 900)
    # 每句改三处：仍有不少相同的片段，但相似度已落到阈值以下
    views = texts_view(a=base, b=_mutate(base, 3))
    assert 0.05 < rc.jaccard(views[0].shingles, views[1].shingles) < rc.SIMILARITY_THRESHOLD
    assert rc.check_cross_duplicates(views) == []
    # 太短的章节不做近似比较
    short = chars_of("short", rc.MIN_SHINGLES + rc.SHINGLE_SIZE - 2)
    assert rc.check_cross_duplicates(texts_view(a=short, b=short[:-1] + "乙")) == []


def _short_sentences(seed: object, total: int) -> str:
    """总共 total 个字、每句都不到 18 字的文本（没有一句够得上逐句比较）。"""
    text = chars_of(seed, total)
    return "".join(text[start:start + 12] + "。" for start in range(0, total, 12))


@pytest.mark.parametrize("total, expected", [(46, 0), (47, 1)])
def test_near_duplicate_needs_enough_shingles(total: int, expected: int) -> None:
    text = _short_sentences("tiny", total)
    views = texts_view(a=text, b=text)
    assert views[0].long_sentences == []
    assert len(views[0].shingles) == total - 7  # 46 字 → 39 个，47 字 → 40 个
    assert len(rc.check_cross_duplicates(views)) == expected


def test_near_duplicate_picks_the_most_similar_earlier_chapter() -> None:
    base = _short_sentences("pick", 600)
    lighter = base[:-130] + _short_sentences("pick-tail", 120)  # 与 base 大部分相同
    views = texts_view(a=lighter, b=base, c=base[:-13] + _short_sentences("pick-end", 12))
    issues = rc.check_cross_duplicates(views)
    # b 像 a；c 同时像 a 和 b，只报最像的 b
    assert [issue.chapter_uids for issue in issues] == [["a", "b"], ["b", "c"]]
    # 一样像的时候报最靠前的那一章
    same = texts_view(a=base, b=base, c=base)
    assert [issue.chapter_uids for issue in rc.check_cross_duplicates(same)] == [["a", "b"], ["a", "c"]]


def test_sketch_order_does_not_depend_on_hash_randomization() -> None:
    gram = chars_of("gram", rc.SHINGLE_SIZE)
    assert rc._stable_order(gram) == (zlib.crc32(gram.encode("utf-8")), gram)
    (view,) = texts_view(a=body("sketch-fixed", 1500))
    assert len(view.sketch) == rc.SKETCH_SIZE
    by_content_hash = sorted(view.shingles, key=lambda g: (zlib.crc32(g.encode("utf-8")), g))
    assert view.sketch == frozenset(by_content_hash[:rc.SKETCH_SIZE])
    (small,) = texts_view(a=_short_sentences("sketch-small", 60))
    assert small.sketch == small.shingles


def test_near_duplicate_not_reported_twice_for_sentence_pairs() -> None:
    base = body("both", 900)
    views = texts_view(a=base, b=base)
    issues = rc.check_cross_duplicates(views)
    assert len(issues) == 1
    assert issues[0].severity == "high"
    assert "相似" not in issues[0].title


def test_sketch_prefilter_never_hides_a_real_match() -> None:
    """粗筛只是提速：凡是相似度过线的章节对，粗筛都必须放行。"""
    for seed in range(20):
        base = body(f"sketch-{seed}", 1200)
        near = _mutate(base, 1)
        a, b = texts_view(a=base, b=near)
        assert rc.jaccard(a.shingles, b.shingles) >= rc.SIMILARITY_THRESHOLD
        assert len(b.sketch) == rc.SKETCH_SIZE
        assert len(b.sketch & a.shingles) * rc.SKETCH_MIN_HIT_RATIO >= len(b.sketch)
        assert len(rc.check_cross_duplicates([a, b])) == 1


def _random_book(seed: int) -> List[str]:
    """随机造一本小书：各章从同一个句子池里抽句子（带各种序号和标点），偶尔再加一章改写式的雷同。"""
    rng = random.Random(f"book-{seed}")
    lengths = [10, 17, 18, 19, 25, 39, 40, 41, 60]
    pool = [chars_of(f"pool-{seed}-{i}", rng.choice(lengths)) for i in range(rng.randint(5, 30))]
    texts: List[str] = []
    for chapter in range(rng.randint(2, 12)):
        parts: List[str] = []
        for position in range(rng.randint(0, 20)):
            if rng.random() < 0.45:
                parts.append(rng.choice(["{}。", "1. {}。", "（2）{}！", "- {}；", " {} 。"]).format(rng.choice(pool)))
            else:
                parts.append(chars_of(f"own-{seed}-{chapter}-{position}", rng.randint(5, 50)) + "。")
            if rng.random() < 0.3:
                parts.append("\n")
        texts.append("".join(parts))
    if rng.random() < 0.6:
        rate = rng.choice([0.03, 0.05, 0.08, 0.15])
        source = list(rng.choice(texts))
        for index, char in enumerate(source):
            if char not in "。！；\n" and rng.random() < rate:
                source[index] = chr(0x9000 + rng.randrange(500))
        texts.append("".join(source))
    return texts


def _naive_duplicates(texts: List[str]):
    """用最直白的写法重算跨章重复：两两求交集，不做倒排，也不做粗筛。"""

    def qualifies(keys: List[str]) -> bool:
        return len(keys) >= 2 or any(len(key) >= 40 for key in keys)

    all_keys = [[rc.normalize_sentence(raw) for raw in split_sentences(text)] for text in texts]
    long_keys = [list(dict.fromkeys(key for key in keys if len(key) >= 18)) for keys in all_keys]
    grams = [rc.shingle_set("".join(keys)) for keys in all_keys]

    shared = {}
    for later in range(len(texts)):
        for earlier in range(later):
            common = [key for key in long_keys[later] if key in long_keys[earlier]]
            if qualifies(common):
                shared[(earlier, later)] = common

    by_sentence, by_similarity = [], []
    for later in range(len(texts)):
        candidates = sorted(
            ((earlier, common) for (earlier, target), common in shared.items() if target == later),
            key=lambda item: (-len(item[1]), item[0]),
        )
        covered: set = set()
        reported = 0
        for earlier, common in candidates:
            fresh = [key for key in common if key not in covered]
            if not qualifies(fresh):
                continue
            covered.update(fresh)
            by_sentence.append((earlier, later, len(common), min(len(fresh), rc.MAX_LISTED_SENTENCES)))
            reported += 1
            if reported >= rc.MAX_DUPLICATE_ISSUES_PER_CHAPTER:
                break

        best, best_score = None, 0.0
        for earlier in range(later):
            if (earlier, later) in shared or min(len(grams[earlier]), len(grams[later])) < rc.MIN_SHINGLES:
                continue
            score = rc.jaccard(grams[earlier], grams[later])
            if score >= rc.SIMILARITY_THRESHOLD and score > best_score:
                best, best_score = earlier, score
        if best is not None:
            by_similarity.append((best, later))
    return sorted(by_sentence), sorted(by_similarity)


@pytest.mark.parametrize("seed", range(60))
def test_cross_duplicates_agree_with_naive_reference(seed: int) -> None:
    texts = _random_book(seed)
    views = make_views({f"{index:02d}": done(f"{index:02d}", text) for index, text in enumerate(texts)})
    by_sentence, by_similarity = [], []
    for issue in rc.check_cross_duplicates(views):
        earlier, later = (int(uid) for uid in issue.chapter_uids)
        assert earlier < later
        if "相似" in issue.title:
            by_similarity.append((earlier, later))
            assert issue.severity == "medium"
            continue
        total = int(issue.title.split("有 ")[1].split(" 句")[0])
        listed = sum(1 for line in issue.fix_instruction.split("\n") if line[:1].isdigit())
        by_sentence.append((earlier, later, total, listed))
        assert issue.severity == ("high" if total >= 5 else "medium")
    assert (sorted(by_sentence), sorted(by_similarity)) == _naive_duplicates(texts)


def test_duplicate_skips_chapters_without_text() -> None:
    s1, s2 = sentence("skip-1", 22), sentence("skip-2", 22)
    views = make_views({"a": done("a", s1 + s2), "b": None, "c": done("c", "   "), "d": done("d", s1 + s2)})
    (issue,) = rc.check_cross_duplicates(views)
    assert issue.chapter_uids == ["a", "d"]


def test_duplicate_covers_unfinished_chapters_that_have_text() -> None:
    s1, s2 = sentence("unfinished-1", 22), sentence("unfinished-2", 22)
    views = make_views(
        {
            "a": done("a", body("a", 200) + s1 + s2),
            "b": ChapterRecord(uid="b", status="cancelled", content=body("b", 100) + s1 + s2),
        }
    )
    (issue,) = rc.check_cross_duplicates(views)
    assert issue.chapter_uids == ["a", "b"]


def test_near_duplicate_excerpt_lists_the_closest_sentences_first() -> None:
    parts = [sentence(f"closest-{i}", 30) for i in range(30)]
    base = "".join(parts)
    # 前 29 句各改一处，最后一句原样照搬（只有这一句相同，够不上逐句重复的标准）
    near = _mutate("".join(parts[:29]), 1) + parts[29]
    views = texts_view(a=base, b=near)
    (issue,) = rc.check_cross_duplicates(views)
    assert "相似" in issue.title
    assert issue.excerpt.split("\n")[0] == parts[29]


# ---------------------------------------------------------------------------
# 5. 章内重复
# ---------------------------------------------------------------------------


def test_inner_repeat_hit() -> None:
    s1, s2 = sentence("rep-1", 18), sentence("rep-2", 30)
    text = body("x", 200) + s1 + body("y", 100) + s1 + s2 + body("z", 100) + s2 + s2
    (issue,) = rc.check_inner_repeats(texts_view(a=text, b=body("b", 300)))
    assert (issue.type, issue.severity, issue.fixable) == ("repeat", "medium", True)
    assert issue.chapter_uids == ["a"]
    assert issue.excerpt.split("\n") == [s1, s2]
    assert s1 in issue.fix_instruction and s2 in issue.fix_instruction
    assert "出现 3 次" in issue.fix_instruction


def test_inner_repeat_misses() -> None:
    short = sentence("rep-short", 17)
    views = make_views(
        {
            "unique": done("unique", body("u", 500)),
            # 不到 18 字的句子：分散出现几次、或只是连着出现两次，都不算
            "scattered": done("scattered", short + body("s1", 100) + short + body("s2", 100) + short),
            "twice": done("twice", body("t", 200) + short + short),
            "none": None,
        }
    )
    assert rc.check_inner_repeats(views) == []


def test_inner_repeat_catches_stuck_short_sentences() -> None:
    """模型「复读」：同一个短句接连出现好几次。"""
    stuck = sentence("stuck", 12)
    (issue,) = rc.check_inner_repeats(texts_view(a=body("x", 200) + stuck * 4 + body("y", 100)))
    assert (issue.type, issue.severity, issue.fixable) == ("repeat", "medium", True)
    assert issue.excerpt == stuck
    assert "出现 4 次" in issue.fix_instruction

    tiny = sentence("tiny", 5)
    assert rc.check_inner_repeats(texts_view(a=body("x", 200) + tiny * 6)) == []  # 太短的不算
    assert rc.check_inner_repeats(texts_view(a=f"{stuck}\n---\n{stuck}\n***\n{stuck}")) == []  # 没有连着
    placeholder = "【待补充：证书扫描件】\n"
    assert rc.check_inner_repeats(texts_view(a=body("x", 200) + "\n" + placeholder * 4)) == []
    # 每张表前面都有的引导句、每个小节开头都有的短句：中间隔着表格或小标题，不是复读
    with_tables = "具体参数见下表：\n| 序号 | 参数 |\n|---|---|\n| 1 | 甲 |\n" * 3
    with_headings = "### 小节\n本节内容如下。\n" * 3
    assert rc.check_inner_repeats(texts_view(a=with_tables, b=with_headings)) == []


def test_inner_repeat_normalizes_before_comparing() -> None:
    core = chars_of("rep-norm", 24)
    text = f"1. {core}。\n" + body("x", 100) + f"\n2. {core[:8]} {core[8:]}！"
    assert len(rc.check_inner_repeats(texts_view(a=text))) == 1


def test_inner_repeat_id_follows_the_repeated_sentences() -> None:
    s1, s2 = sentence("rep-id-1", 22), sentence("rep-id-2", 22)
    first = rc.check_inner_repeats(texts_view(a=s1 + body("x", 100) + s1))[0]
    same = rc.check_inner_repeats(texts_view(a=body("y", 200) + s1 + s1 + s1))[0]
    changed = rc.check_inner_repeats(texts_view(a=s2 + body("x", 100) + s2))[0]
    assert first.id == same.id
    assert first.id != changed.id


# ---------------------------------------------------------------------------
# 6. 套话与模型口吻
# ---------------------------------------------------------------------------


def test_boilerplate_filler_threshold() -> None:
    two = body("f2", 200) + "综上所述，方案可行。" + body("f2b", 100) + "值得注意的是，工期较紧。"
    three = two + "总而言之，我方有信心。"
    assert rc.check_boilerplate(texts_view(a=two)) == []
    (issue,) = rc.check_boilerplate(texts_view(a=three))
    assert (issue.type, issue.severity, issue.fixable) == ("boilerplate", "low", True)
    assert "3" in issue.detail
    assert "综上所述" in issue.fix_instruction and "总而言之" in issue.fix_instruction
    assert issue.excerpt == "综上所述，方案可行。"


def test_boilerplate_sequence_counts_once() -> None:
    text = "首先，完成调研。其次，完成设计。最后，完成部署。综上所述，方案可行。"
    assert rc.check_boilerplate(texts_view(a=text)) == []  # 三段式 1 次 + 综上所述 1 次 = 2
    (issue,) = rc.check_boilerplate(texts_view(a=text + "不言而喻，这很重要。"))
    assert issue.severity == "low"
    assert issue.excerpt == "首先，完成调研。"
    assert "首先…其次…最后（1 次）" in issue.detail


def test_boilerplate_ai_voice() -> None:
    text = body("v", 200) + "希望以上内容对您有所帮助。如有需要请告诉我。"
    (issue,) = rc.check_boilerplate(texts_view(a=text))
    assert (issue.type, issue.severity, issue.fixable) == ("boilerplate", "medium", True)
    assert "希望以上内容对您有所帮助。" in issue.excerpt
    assert "希望以上内容对您有所帮助。" in issue.fix_instruction
    assert "如有需要请告诉我。" in issue.fix_instruction


def test_boilerplate_both_kinds_have_distinct_ids() -> None:
    text = "综上所述，甲。总而言之，乙。众所周知，丙。作为AI，我无法提供企业资质。"
    issues = rc.check_boilerplate(texts_view(a=text))
    assert sorted(issue.severity for issue in issues) == ["low", "medium"]
    assert issues[0].id != issues[1].id


def test_boilerplate_clean_text() -> None:
    text = "本平台作为AI中台的核心组件，为上层应用提供能力。如有需要，请联系我方项目经理。" + body("c", 300)
    assert rc.check_boilerplate(make_views({"a": done("a", text), "b": None})) == []


# ---------------------------------------------------------------------------
# 7. 标记残留
# ---------------------------------------------------------------------------


def test_markup_issue() -> None:
    text = "# 总体方案\n" + body("m", 100) + "\n```\ncode\n```\n换行<br>符号\n**没闭合"
    views = make_views({"a": done("a", text), "b": done("b", "### 小标题\n**加粗**正文"), "c": None})
    (issue,) = rc.check_markup(views)
    assert (issue.type, issue.severity) == ("markup", "low")
    assert issue.chapter_uids == ["a"]
    for label in rc.MARKUP_LABELS.values():
        assert label in issue.detail
    assert "# 总体方案" in issue.excerpt
    assert not issue.fixable


def test_markup_id_changes_with_kinds_not_counts() -> None:
    one = rc.check_markup(texts_view(a="换行<br>符号"))[0]
    more = rc.check_markup(texts_view(a="换行<br>符号<br>再来"))[0]
    other = rc.check_markup(texts_view(a="换行<br>符号\n# 标题"))[0]
    assert one.id == more.id
    assert one.id != other.id


# ---------------------------------------------------------------------------
# 8. 评分点覆盖
# ---------------------------------------------------------------------------


def req(rid: str, keywords: Optional[List[str]] = None, kind: str = "scoring", name: str = "") -> RequirementItem:
    return RequirementItem(
        id=rid, kind=kind, name=name or f"要求{rid}", keywords=keywords or [], score="10分", detail="评审标准说明"
    )


def plan(**owners: List[str]) -> Blueprint:
    return Blueprint(plans={uid: ChapterPlan(uid=uid, requirement_ids=ids) for uid, ids in owners.items()})


def test_coverage_unassigned_without_blueprint() -> None:
    views = texts_view(a=body("a", 200))
    coverage, issues = rc.check_coverage(views, [req("E1", ["关键词"])], None)
    assert [(item.requirement_id, item.status, item.chapter_uids) for item in coverage] == [("E1", "unassigned", [])]
    (issue,) = issues
    assert (issue.type, issue.severity, issue.fixable, issue.chapter_uids) == ("coverage", "high", False, [])
    assert issue.title.startswith("评分项没有章节负责")
    assert "E1" in issue.title


def test_coverage_unassigned_with_blueprint_and_stale_owner() -> None:
    views = texts_view(a=body("a", 200))
    # E1 没人负责；E2 的负责章节已不在目录里
    blueprint = plan(a=["E9"], gone=["E2"])
    coverage, issues = rc.check_coverage(views, [req("E1"), req("E2"), req("R1", kind="requirement")], blueprint)
    assert [item.status for item in coverage] == ["unassigned"] * 3
    assert [issue.severity for issue in issues] == ["high"] * 3
    assert coverage[2].kind == "requirement"
    assert issues[2].title.startswith("采购人要求没有章节负责")
    assert len({issue.id for issue in issues}) == 3


def test_coverage_missing_when_no_owner_has_text() -> None:
    views = make_views({"a": None, "b": done("b", "  "), "c": ChapterRecord(uid="c", status="failed", error="x")})
    coverage, issues = rc.check_coverage(views, [req("E1", ["关键词"])], plan(a=["E1"], b=["E1"], c=["E1"]))
    (item,) = coverage
    assert (item.status, item.chapter_uids) == ("missing", ["a", "b", "c"])
    assert issues == []  # 这些章节各自已有「尚未生成 / 生成失败」的问题


def test_coverage_covered() -> None:
    text = body("a", 200) + "系统可用性不低于99.9%，提供7×24小时服务，通过等保三级测评。"
    views = texts_view(a=text)
    coverage, issues = rc.check_coverage(views, [req("E1", ["99.9%", "7×24小时", "等保三级"])], plan(a=["E1"]))
    (item,) = coverage
    assert (item.status, item.chapter_uids, item.missing_keywords) == ("covered", ["a"], [])
    assert issues == []


@pytest.mark.parametrize(
    "total, hit, status",
    [
        (10, 10, "covered"),
        (10, 7, "covered"),  # 恰好 70%
        (10, 6, "partial"),
        (10, 0, "partial"),
        (20, 14, "covered"),
        (20, 13, "partial"),  # 65%
    ],
)
def test_coverage_hit_rate_boundary(total: int, hit: int, status: str) -> None:
    keywords = [f"关键词{chars_of(f'kw-{i}', 3)}" for i in range(total)]
    views = texts_view(a=body("a", 200) + "，".join(keywords[:hit]))
    coverage, issues = rc.check_coverage(views, [req("E1", keywords)], plan(a=["E1"]))
    (item,) = coverage
    assert item.status == status
    assert item.missing_keywords == keywords[hit:]
    assert len(issues) == (1 if status == "partial" else 0)


def test_coverage_partial_issue() -> None:
    views = texts_view(a=body("a", 200) + "提供7×24小时服务。", b=body("b", 200))
    requirement = req("E1", ["7×24小时", "双机热备", "异地容灾"], name="可靠性设计")
    coverage, issues = rc.check_coverage(views, [requirement], plan(a=["E1"], b=["E1"]))
    (item,) = coverage
    assert (item.status, item.chapter_uids, item.missing_keywords) == ("partial", ["a", "b"], ["双机热备", "异地容灾"])
    (issue,) = issues
    assert (issue.type, issue.severity, issue.fixable) == ("coverage", "medium", True)
    assert issue.chapter_uids == ["a", "b"]
    assert "双机热备" in issue.fix_instruction and "异地容灾" in issue.fix_instruction
    assert "7×24小时" not in issue.fix_instruction.split("关键词：")[1].split("。")[0]
    assert "可靠性设计" in issue.fix_instruction
    assert issue.title.startswith("评分项响应不充分")


def test_coverage_keywords_found_across_owner_chapters() -> None:
    views = texts_view(a=body("a", 200) + "采用双机热备。", b=body("b", 200) + "建设异地容灾中心。")
    coverage, issues = rc.check_coverage(views, [req("E1", ["双机热备", "异地容灾"])], plan(a=["E1"], b=["E1"]))
    assert coverage[0].status == "covered"
    assert issues == []


def test_coverage_without_keywords_depends_on_completion() -> None:
    views = make_views({"a": done("a", body("a", 200)), "b": None})
    coverage, issues = rc.check_coverage(views, [req("E1"), req("E2", ["甲", " 乙 "])], plan(a=["E1", "E2"]))
    # 没有关键词、或关键词都太短：写完了就算覆盖
    assert [item.status for item in coverage] == ["covered", "covered"]
    assert issues == []
    # 两个字的关键词就算数了
    coverage, issues = rc.check_coverage(views, [req("E3", ["容灾"])], plan(a=["E3"]))
    assert (coverage[0].status, coverage[0].missing_keywords) == ("partial", ["容灾"])
    assert issues[0].fixable

    coverage, issues = rc.check_coverage(views, [req("E1")], plan(a=["E1"], b=["E1"]))
    assert coverage[0].status == "partial"
    assert coverage[0].missing_keywords == []
    (issue,) = issues
    # 只差章节没写完：修订帮不上忙
    assert (issue.severity, issue.fixable, issue.fix_instruction) == ("medium", False, "")
    assert issue.chapter_uids == ["a", "b"]


def test_coverage_unfinished_owner_keeps_partial_even_when_keywords_hit() -> None:
    views = make_views(
        {
            "a": done("a", body("a", 200) + "采用双机热备。"),
            "b": ChapterRecord(uid="b", status="cancelled", content="建设异地容灾中心"),
        }
    )
    coverage, issues = rc.check_coverage(views, [req("E1", ["双机热备", "异地容灾"])], plan(a=["E1"], b=["E1"]))
    assert (coverage[0].status, coverage[0].missing_keywords) == ("partial", [])
    assert not issues[0].fixable


def test_coverage_keyword_matching_is_lenient() -> None:
    text = (
        body("a", 200)
        + "通过 ISO 9001 认证，可用性不低于 99.9％，部署ＧＰＵ服务器，响应时间不超过 2 小时，"
        + "提供 7*24 小时值守，采用**双机**热备，符合 GB/T 22239—2019。"
    )
    keywords = ["ISO9001", "≥99.9%", "gpu服务器", "2小时", "7×24小时", "双机热备", "GB/T 22239-2019"]
    coverage, _ = rc.check_coverage(texts_view(a=text), [req("E1", keywords)], plan(a=["E1"]))
    assert (coverage[0].status, coverage[0].missing_keywords) == ("covered", [])


def test_coverage_counts_each_keyword_once() -> None:
    views = texts_view(a=body("a", 200) + "核心节点采用双机热备。")
    keywords = ["双机热备", "双机热备", " 双机 热备 ", "异地容灾"]
    coverage, _ = rc.check_coverage(views, [req("E1", keywords)], plan(a=["E1"]))
    # 重复的关键词只算一个：命中 1/2，而不是 3/4
    assert (coverage[0].status, coverage[0].missing_keywords) == ("partial", ["异地容灾"])
    assert "1/2" in coverage[0].note


def test_coverage_keyword_matching_is_not_too_lenient() -> None:
    text = body("a", 200) + "可用性不低于 99.5%，响应时间不超过 4 小时，提供 5×8 小时服务。"
    keywords = ["99.9%", "2小时", "7×24小时"]
    coverage, _ = rc.check_coverage(texts_view(a=text), [req("E1", keywords)], plan(a=["E1"]))
    assert (coverage[0].status, coverage[0].missing_keywords) == ("partial", keywords)


def test_coverage_requirement_id_matching_is_lenient() -> None:
    views = texts_view(a=body("a", 200))
    coverage, _ = rc.check_coverage(views, [req("E1"), req("r2")], plan(a=[" e1 ", "R2"]))
    assert [item.status for item in coverage] == ["covered", "covered"]


def test_coverage_only_counts_requirement_ids() -> None:
    views = texts_view(a=body("a", 200))
    blueprint = Blueprint(plans={"a": ChapterPlan(uid="a", requirement_ids=[], auto_assigned=["E1"])})
    coverage, _ = rc.check_coverage(views, [req("E1")], blueprint)
    assert coverage[0].status == "unassigned"


def test_coverage_empty_requirements() -> None:
    assert rc.check_coverage(texts_view(a="正文"), [], plan(a=["E1"])) == ([], [])
    assert rc.check_coverage(texts_view(a="正文"), None, None) == ([], [])


# ---------------------------------------------------------------------------
# 9. 统计与排序
# ---------------------------------------------------------------------------


def test_compute_stats() -> None:
    views = make_views(
        {
            "a": done("a", "一二三 四五\n六"),
            "b": None,
            "c": ChapterRecord(uid="c", status="failed", content="七八", error="x"),
            "d": ChapterRecord(uid="d", status="cancelled", content="九十"),
            "e": done("e", "  "),
        }
    )
    stats = rc.compute_stats(views, {"a": 100, "b": 200, "c": 300, "zzz": 999}, placeholder_count=4, issue_count=7)
    assert stats.model_dump() == {
        "leaf_total": 5,
        "done": 1,
        "failed": 1,
        "empty": 2,
        "total_chars": 10,
        "target_chars": 600,  # 只算当前目录里的章节
        "placeholder_count": 4,
        "issue_count": 7,
    }
    assert rc.compute_stats([], None).model_dump()["leaf_total"] == 0


def _bare_issue(name: str, severity: str, uids: List[str]) -> ReviewIssue:
    return ReviewIssue(id=name, type="length", severity=severity, chapter_uids=uids, title=name)


def test_sort_issues_by_severity_then_document_order() -> None:
    order = ["u1", "u2", "u3"]
    issues = [
        _bare_issue("low-u1", "low", ["u1"]),
        _bare_issue("med-u3", "medium", ["u3"]),
        _bare_issue("high-none", "high", []),
        _bare_issue("med-u2-first", "medium", ["u2"]),
        _bare_issue("high-u3", "high", ["u3"]),
        _bare_issue("med-pair", "medium", ["u3", "u1"]),
        _bare_issue("med-u2-second", "medium", ["u2"]),
        _bare_issue("high-u1", "high", ["u1"]),
        _bare_issue("odd", "unknown", ["u1"]),
        _bare_issue("high-gone", "high", ["gone"]),
    ]
    assert [issue.id for issue in rc.sort_issues(issues, order)] == [
        "high-u1",
        "high-u3",
        "high-none",  # 不涉及具体章节的排在同级最后
        "high-gone",
        "med-pair",  # 多章节的按最靠前的章节算
        "med-u2-first",  # 同一位置保持原有先后
        "med-u2-second",
        "med-u3",
        "low-u1",
        "odd",
    ]
    assert rc.sort_issues([], order) == []


# ---------------------------------------------------------------------------
# 总入口
# ---------------------------------------------------------------------------


def _scenario():
    """一本八章的小标书，每种问题都放一点。"""
    shared = [
        "我方将严格按照招标文件的要求组织实施并按期交付全部成果。",
        "项目团队实行项目经理负责制并建立周例会与月度汇报机制。",
        "所有交付物在提交前均须经过内部三级评审并留存评审记录。",
        "对实施过程中发现的问题建立台账并明确责任人与整改期限。",
        "验收通过后我方提供为期三年的免费质保与上门巡检服务。",
    ]
    repeated = "系统上线前须完成不少于三轮的全流程联调测试并出具测试报告。"
    leaves = [
        leaf("u1", "1.1", "总体技术方案"),
        leaf("u2", "1.2", "系统可靠性设计"),
        leaf("u3", "1.3", "数据安全方案"),
        leaf("u4", "2.1", "实施进度计划"),
        leaf("u5", "2.2", "项目团队配置"),
        leaf("u6", "2.3", "质量保证措施"),
        leaf("u7", "3.1", "培训方案"),
        leaf("u8", "3.2", "售后服务方案"),
    ]
    chapters = {
        "u1": done("u1", body("u1", 900) + "系统整体采用微服务架构，部署在政务云平台。" + "".join(shared)),
        "u2": done("u2", body("u2", 300) + "项目经理由【待补充：项目经理姓名及证书】担任，由XXX公司提供原厂支持。提供7×24小时服务。"),
        # u3 没有记录
        "u4": ChapterRecord(uid="u4", status="failed", error="模型服务超时"),
        "u5": ChapterRecord(uid="u5", status="cancelled", content=body("u5", 200)),
        "u6": done("u6", body("u6", 700) + "".join(shared) + repeated + body("u6b", 100) + repeated),
        "u7": done(
            "u7",
            "## 培训目标\n" + body("u7", 800) + "综上所述，培训体系完整。总而言之，覆盖全员。值得注意的是，需提前排期。"
            "希望以上内容对您有所帮助。",
        ),
        "u8": done("u8", body("u8", 2000)),
    }
    budget = {"u1": 1000, "u2": 1000, "u3": 1000, "u4": 1000, "u5": 1000, "u6": 1000, "u7": 1000, "u8": 1000}
    requirements = [
        RequirementItem(id="E1", name="总体方案", score="20分", keywords=["微服务架构", "政务云"]),
        RequirementItem(id="E2", name="可靠性", score="10分", keywords=["7×24小时", "双机热备", "异地容灾"]),
        RequirementItem(id="E3", name="数据安全", score="10分", keywords=["等保三级"]),
        RequirementItem(id="R1", kind="requirement", name="驻场服务", keywords=["驻场"]),
    ]
    blueprint = Blueprint(
        plans={
            "u1": ChapterPlan(uid="u1", requirement_ids=["E1"]),
            "u2": ChapterPlan(uid="u2", requirement_ids=["E2"]),
            "u3": ChapterPlan(uid="u3", requirement_ids=["E3"]),
        }
    )
    return leaves, chapters, budget, requirements, blueprint


def test_run_local_review_full_scenario() -> None:
    leaves, chapters, budget, requirements, blueprint = _scenario()
    report = rc.run_local_review(leaves, chapters, budget, requirements, blueprint)

    assert report.deep is False
    parsed = datetime.fromisoformat(report.generated_at)
    assert parsed.tzinfo is not None
    assert report.warnings == []
    assert report.dismissed == []

    found = sorted((issue.type, issue.severity, tuple(issue.chapter_uids)) for issue in report.issues)
    assert found == sorted(
        [
            ("empty", "high", ("u3",)),
            ("failed", "high", ("u4",)),
            ("partial", "medium", ("u5",)),
            ("length", "medium", ("u2",)),
            ("length", "low", ("u8",)),
            ("duplicate", "high", ("u1", "u6")),
            ("repeat", "medium", ("u6",)),
            ("boilerplate", "low", ("u7",)),
            ("boilerplate", "medium", ("u7",)),
            ("markup", "low", ("u7",)),
            ("coverage", "medium", ("u2",)),
            ("coverage", "high", ()),
        ]
    )

    # 排序：先严重度，再文档顺序
    position = {item.uid: index for index, item in enumerate(leaves)}
    keys = [
        (rc.SEVERITY_ORDER[issue.severity], min([position[uid] for uid in issue.chapter_uids] or [len(leaves)]))
        for issue in report.issues
    ]
    assert keys == sorted(keys)
    assert [issue.severity for issue in report.issues][:4] == ["high"] * 4
    assert report.issues[3].type == "coverage"  # 不涉及章节的排在 high 的最后

    # 可一键修订的都带着修订指令，反之没有
    for issue in report.issues:
        assert bool(issue.fix_instruction) is issue.fixable
        assert issue.title and issue.detail
    fixable = {issue.type for issue in report.issues if issue.fixable}
    assert fixable == {"length", "duplicate", "repeat", "boilerplate", "coverage"}

    assert [(item.requirement_id, item.status) for item in report.coverage] == [
        ("E1", "covered"),
        ("E2", "partial"),
        ("E3", "missing"),
        ("R1", "unassigned"),
    ]
    assert report.coverage[1].missing_keywords == ["双机热备", "异地容灾"]

    assert [(item.chapter_uid, item.text) for item in report.placeholders] == [
        ("u2", "【待补充：项目经理姓名及证书】"),
        ("u2", "XXX"),
    ]

    stats = report.stats
    assert (stats.leaf_total, stats.done, stats.failed, stats.empty) == (8, 5, 1, 1)
    assert stats.total_chars == sum(count_chars(record.content) for record in chapters.values())
    assert stats.target_chars == 8000
    assert stats.placeholder_count == 2
    assert stats.issue_count == len(report.issues) == 12

    # 整份报告可以序列化
    assert json.loads(report.model_dump_json())["stats"]["leaf_total"] == 8


def test_run_local_review_ids_are_stable_and_unique() -> None:
    first = rc.run_local_review(*_scenario())
    second = rc.run_local_review(*_scenario())
    ids = [issue.id for issue in first.issues]
    assert ids == [issue.id for issue in second.issues]
    assert len(set(ids)) == len(ids)
    assert first.model_dump(exclude={"generated_at"}) == second.model_dump(exclude={"generated_at"})


def _fingerprint() -> str:
    """把一批审校结果压成一个指纹：综合场景的整份报告，加上几本随机小书的跨章重复。"""
    report = rc.run_local_review(*_scenario())
    parts = [json.dumps(report.model_dump(exclude={"generated_at"}), sort_keys=True, ensure_ascii=False)]
    for seed in range(8):
        texts = _random_book(seed)
        views = make_views({f"{index:02d}": done(f"{index:02d}", text) for index, text in enumerate(texts)})
        parts.extend(f"{issue.id}|{issue.title}|{issue.excerpt}" for issue in rc.check_cross_duplicates(views))
    return hashlib.sha1("\n".join(parts).encode("utf-8")).hexdigest()


def test_results_are_identical_across_processes() -> None:
    """换一个进程（字符串哈希的随机种子不同）结果也完全一样：ID 存进了审校记录，下次打开还要对得上。"""
    backend = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    code = (
        "import sys; sys.path[:0] = [sys.argv[1], sys.argv[2]]; "
        "import test_review_checks; print(test_review_checks._fingerprint())"
    )
    env = dict(os.environ, PYTHONHASHSEED="20240101", PYTHONDONTWRITEBYTECODE="1")
    result = subprocess.run(
        [sys.executable, "-c", code, backend, os.path.join(backend, "tests")],
        capture_output=True,
        text=True,
        env=env,
        cwd=backend,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    assert result.stdout.strip() == _fingerprint()


def test_issue_ids_survive_unrelated_edits() -> None:
    """改了别的地方，原来的问题还是原来的 ID（使用者标过「忽略」的不会又冒出来）。"""
    leaves, chapters, budget, requirements, blueprint = _scenario()
    before = {issue.id for issue in rc.run_local_review(leaves, chapters, budget, requirements, blueprint).issues}

    chapters["u8"] = done("u8", body("u8-rewritten", 1000))  # 篇幅超出的问题消失
    chapters["u1"] = done("u1", chapters["u1"].content + body("u1-more", 100))  # 与重复无关的改动
    after = {issue.id for issue in rc.run_local_review(leaves, chapters, budget, requirements, blueprint).issues}
    assert len(before - after) == 1
    assert after < before


def test_duplicate_id_changes_when_shared_sentences_change() -> None:
    s = [sentence(f"idchange-{i}", 22) for i in range(3)]
    first = rc.check_cross_duplicates(texts_view(a=s[0] + s[1], b=s[0] + s[1]))[0]
    same = rc.check_cross_duplicates(texts_view(a=s[0] + s[1] + body("x", 50), b=body("y", 50) + s[1] + s[0]))[0]
    changed = rc.check_cross_duplicates(texts_view(a=s[0] + s[2], b=s[0] + s[2]))[0]
    assert first.id == same.id
    assert first.id != changed.id


def test_run_local_review_empty_inputs() -> None:
    report = rc.run_local_review([], {}, {}, [], None)
    assert report.issues == [] and report.coverage == [] and report.placeholders == []
    assert report.stats.model_dump() == {
        "leaf_total": 0,
        "done": 0,
        "failed": 0,
        "empty": 0,
        "total_chars": 0,
        "target_chars": 0,
        "placeholder_count": 0,
        "issue_count": 0,
    }
    assert report.deep is False and report.generated_at


def test_run_local_review_warnings() -> None:
    leaves = [leaf("a")]
    chapters = {"a": done("a", body("a", 200))}
    assert any("评分" in text for text in rc.run_local_review(leaves, chapters, {}, []).warnings)
    report = rc.run_local_review(leaves, chapters, {}, [req("E1")], None)
    assert any("写作计划" in text for text in report.warnings)
    assert [issue.type for issue in report.issues] == ["coverage"]
    assert rc.run_local_review(leaves, chapters, {}, [req("E1")], plan(a=["E1"])).warnings == []


def test_run_local_review_all_clean() -> None:
    leaves = [leaf(f"u{i}") for i in range(5)]
    chapters = {f"u{i}": done(f"u{i}", body(f"clean-{i}", 1000)) for i in range(5)}
    budget = {f"u{i}": 1000 for i in range(5)}
    report = rc.run_local_review(leaves, chapters, budget, [req("E1")], plan(u0=["E1"]))
    assert report.issues == []
    assert report.placeholders == []
    assert report.stats.done == 5 and report.stats.issue_count == 0
    assert [item.status for item in report.coverage] == ["covered"]


def test_run_local_review_survives_a_broken_check(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("坏了")

    monkeypatch.setattr(rc, "check_markup", boom)
    leaves = [leaf("a"), leaf("b")]
    report = rc.run_local_review(leaves, {"a": done("a", body("a", 200))}, {}, [])
    assert [issue.type for issue in report.issues] == ["empty"]  # 其他检查照常
    assert any("标记残留" in text for text in report.warnings)


def test_run_local_review_makes_colliding_ids_unique() -> None:
    leaves = [leaf("a")]
    chapters = {"a": done("a", body("a", 200))}
    report = rc.run_local_review(leaves, chapters, {}, [req("E1"), req("E1")], None)
    ids = [issue.id for issue in report.issues]
    assert len(ids) == 2 and len(set(ids)) == 2


# ---------------------------------------------------------------------------
# 稳健性
# ---------------------------------------------------------------------------

_WEIRD_TEXTS = [
    "",
    "   \n\t\r\n  ",
    "。",
    "，，，。。。！！！？？？",
    "无" * 30000,  # 超长单句
    "a" * 20000,
    "【" * 3000,
    "【待补充" * 2000,
    "X" * 5000 + "×" * 5000 + "_" * 5000,
    "首先" * 3000,
    "首先其次" * 2000,
    "**" * 4001,
    "<" * 5000 + ">" * 5000,
    "<br" * 3000,
    "#" * 3000 + "\n# \n## \n",
    "```\n" * 500,
    "| 序号 | 名称 |\n|---|---|\n" + "| 1 | 服务器 |\n" * 400,  # 全是表格
    "|---|---|\n" * 300,
    "😀🎉👍" * 800 + "👨‍👩‍👧‍👦" * 200,
    "𠀀𠀁𠀂𪚥𫠠" * 600,  # 扩展区汉字
    ("\x00\x01\x02" + chr(0xFEFF) + chr(0x200B) + chr(0x202E)) * 500,  # 控制字符、BOM、零宽空格、方向控制符
    ("abc" + chr(0xD83D) + "xyz" + chr(0xDC00)) * 50,  # 孤立代理项
    "العربية עברית हिन्दी ไทย 한국어 日本語 Ελληνικά" * 100,
    "1.\n2.\n3.\n（一）\n①\n" * 300,
    "作为" * 3000 + "AI" * 3000,
    "某" * 6000,
    "\n".join(["同一句话反复出现在每一行里凑够十八个字以上。"] * 500),
    # 下面几条专门用来撞正则的回溯
    "aa/" * 7000,
    "GB/T " * 4000 + "22239",
    "《" * 3000 + "规范" * 3000,
    "如有需要" * 3000 + "请" * 3000,
    "【 " * 3000 + " " * 5000 + "待",
    "（" + " " * 20000 + "待定）",
    "<a " + "x" * 20000,
    "1." * 10000,
    "___ " * 5000,
    "很抱歉" * 5000,
    "x" * 9999 + "年" + "20XX年" * 2000,
]


@pytest.mark.parametrize("index", range(len(_WEIRD_TEXTS)))
def test_text_functions_never_raise(index: int) -> None:
    text = _WEIRD_TEXTS[index]
    start = time.perf_counter()
    rc.normalize_sentence(text)
    rc.split_for_compare(text)
    rc.shingle_set(text)
    rc.find_placeholders_in_text(text)
    rc.count_filler_phrases(text)
    rc.find_ai_voice(text)
    rc.find_markup_residue(text)
    rc._is_reference_entry(text)
    rc._is_mostly_placeholder(text)
    (view,) = texts_view(a=text)
    assert isinstance(view.long_sentences, list)
    assert len(view.sketch) <= rc.SKETCH_SIZE
    assert isinstance(view.folded, str)
    rc._inner_repeats(view)
    # 再怪的文本也该很快处理完（正常不到 0.1 秒；这里只为拦住正则回溯失控）
    assert time.perf_counter() - start < 3


def test_run_local_review_never_raises_on_weird_content() -> None:
    leaves = [leaf(f"w{i}", title=_WEIRD_TEXTS[i][:30]) for i in range(len(_WEIRD_TEXTS))]
    statuses = ["done", "failed", "cancelled", "writing", "empty", "DONE", "", "别的状态"]
    chapters = {
        f"w{i}": ChapterRecord(
            uid=f"w{i}", status=statuses[i % len(statuses)], content=text, error=text[:50] or None, truncated=i % 3 == 0
        )
        for i, text in enumerate(_WEIRD_TEXTS)
    }
    budget = {f"w{i}": value for i, value in enumerate([0, -1, 1, 10**9, 500])}
    requirements = [
        RequirementItem(
            id="E1",
            name=_WEIRD_TEXTS[21],
            keywords=["", " ", "a", "😀🎉", "abc" + chr(0xD83D), "无无"],
            detail="😀" * 500,
        ),
        RequirementItem(id="", name="", keywords=[]),
    ]
    blueprint = Blueprint(
        plans={
            "w4": ChapterPlan(uid="w4", requirement_ids=["E1", "", "不存在"]),
            "w18": ChapterPlan(uid="w18", requirement_ids=["e1"]),
            "gone": ChapterPlan(uid="gone", requirement_ids=["E1"]),
        }
    )
    start = time.perf_counter()
    report = rc.run_local_review(leaves, chapters, budget, requirements, blueprint)
    assert time.perf_counter() - start < 10
    assert report.warnings == []  # 没有哪项检查是靠兜底才过的
    assert report.stats.leaf_total == len(_WEIRD_TEXTS)
    assert len({issue.id for issue in report.issues}) == len(report.issues)
    # 孤立代理项不会让报告无法序列化
    json.loads(report.model_dump_json())


def test_run_local_review_tolerates_odd_records() -> None:
    odd = ChapterRecord.model_construct(
        uid="a", status=None, content=None, target_words="abc", error=None, truncated=None
    )
    chapters = {"a": odd, "zzz": done("zzz", "不在目录里")}
    report = rc.run_local_review([leaf("a"), leaf("b")], chapters, {"a": None}, [])  # type: ignore[dict-item]
    assert [issue.type for issue in report.issues] == ["empty", "empty"]
    assert report.stats.total_chars == 0
    assert report.warnings and "评分" in report.warnings[0]


# ---------------------------------------------------------------------------
# 性能
# ---------------------------------------------------------------------------


def _big_book(chapter_count: int = 150, chars: int = 1500):
    common = [sentence(f"common-{i}", 26) for i in range(6)]
    leaves = [leaf(f"u{i}", f"{i // 10 + 1}.{i % 10 + 1}", f"第{i}章") for i in range(chapter_count)]
    chapters = {}
    for i in range(chapter_count):
        text = body(f"big-{i}", chars)
        if i % 10 == 0:
            text += common[0] + common[1]  # 每十章有一章带两句通用的话
        if i % 25 == 0:
            text += "【待补充：企业资质】由XXX公司负责。综上所述，方案可行。"
        chapters[f"u{i}"] = done(f"u{i}", text)
    budget = {f"u{i}": chars for i in range(chapter_count)}
    requirements = [RequirementItem(id=f"E{i}", name=f"评分项{i}", keywords=["关键指标", "ABC-100"]) for i in range(30)]
    blueprint = Blueprint(
        plans={f"u{i}": ChapterPlan(uid=f"u{i}", requirement_ids=[f"E{i % 30}"]) for i in range(chapter_count)}
    )
    return leaves, chapters, budget, requirements, blueprint


def test_performance_150_chapters() -> None:
    args = _big_book()
    assert sum(count_chars(record.content) for record in args[1].values()) > 150 * 1500
    start = time.perf_counter()
    report = rc.run_local_review(*args)
    elapsed = time.perf_counter() - start
    # 目标是 3 秒内，阈值放宽到 5 秒以免机器偶发抖动
    assert elapsed < 5, f"本地审校用了 {elapsed:.2f} 秒"
    assert report.warnings == []
    assert report.stats.leaf_total == 150 and report.stats.done == 150
    assert len(only(report.issues, "duplicate")) == 14  # 15 章带通用句，后 14 章各报一次
    assert report.stats.placeholder_count == 12


def test_performance_worst_case_identical_chapters() -> None:
    """最坏情况：150 章全是同一篇正文（每一对章节都重复）。"""
    text = body("identical", 1500)
    leaves = [leaf(f"u{i}") for i in range(150)]
    chapters = {f"u{i}": done(f"u{i}", text) for i in range(150)}
    start = time.perf_counter()
    report = rc.run_local_review(leaves, chapters, {}, [])
    elapsed = time.perf_counter() - start
    assert elapsed < 5, f"本地审校用了 {elapsed:.2f} 秒"
    duplicates = only(report.issues, "duplicate")
    assert len(duplicates) == 149
    assert all(issue.chapter_uids[0] == "u0" for issue in duplicates)
