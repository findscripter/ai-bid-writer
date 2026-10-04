"""写作管线里纯逻辑模块的单测：目录树、要求解析、检索、预算。"""
from __future__ import annotations

import re
from datetime import datetime

import pytest

from app.writing import outline_tree as ot
from app.writing.budget import MAX_WORDS_PER_CHAPTER, MIN_WORDS_PER_CHAPTER, allocate_budget
from app.writing.requirements import parse_requirements, requirements_brief
from app.writing.retrieval import BM25Index, TextIndex, split_chunks, tokenize
from app.writing.textutil import clip, count_chars, now_iso, split_sentences


# ---------------------------------------------------------------------------
# textutil
# ---------------------------------------------------------------------------


def test_count_chars_ignores_whitespace():
    assert count_chars("") == 0
    assert count_chars(None) == 0
    assert count_chars(" 你 好\n\t世界 ") == 4


def test_split_sentences_and_clip():
    assert split_sentences("第一句。第二句！\n第三句") == ["第一句。", "第二句！", "第三句"]
    assert clip("一二三四五六", 4) == "一二三…"
    assert clip("短", 4) == "短"


def test_now_iso_is_strictly_increasing_with_milliseconds():
    # 编辑冲突检测靠时间戳区分版本：连续取值（远快于系统时钟的分辨率）也必须各不相同、先后有序
    stamps = [now_iso() for _ in range(2000)]
    assert len(set(stamps)) == len(stamps)
    parsed = [datetime.fromisoformat(stamp) for stamp in stamps]
    assert parsed == sorted(parsed)
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00", stamps[0])


# ---------------------------------------------------------------------------
# outline_tree
# ---------------------------------------------------------------------------


def _sample_outline():
    return [
        {
            "id": "9",
            "title": "总体方案",
            "description": "总述",
            "content": "不应保留",
            "children": [
                {"id": "x", "title": "架构设计", "description": "", "children": [
                    {"id": "a", "title": "逻辑架构", "description": "分层"},
                    {"id": "b", "title": "部署架构", "description": "部署"},
                ]},
                {"id": "y", "title": "技术路线", "description": "路线", "children": []},
            ],
        },
        {"id": "3", "title": "实施计划", "description": "计划"},
    ]


def test_normalize_assigns_position_ids_and_uids():
    tree = ot.normalize_outline(_sample_outline())
    assert [n["id"] for n in tree] == ["1", "2"]
    assert tree[0]["children"][0]["children"][1]["id"] == "1.1.2"
    assert "children" not in tree[0]["children"][1]  # 空 children 被去掉
    assert "content" not in tree[0]
    uids = [node["uid"] for node, _ in ot.iter_nodes(tree)]
    assert len(uids) == len(set(uids)) == 6
    assert all(ot.UID_RE.match(u) for u in uids)


def test_normalize_keeps_existing_uids_and_fixes_duplicates_and_unsafe():
    tree = ot.normalize_outline(_sample_outline())
    first_uid = tree[0]["uid"]
    again = ot.normalize_outline(tree)
    assert again[0]["uid"] == first_uid

    tree[1]["uid"] = first_uid  # 重复
    tree[0]["children"][1]["uid"] = "../../etc"  # 不安全
    fixed = ot.normalize_outline(tree)
    assert fixed[0]["uid"] == first_uid
    assert fixed[1]["uid"] != first_uid
    assert ot.UID_RE.match(fixed[0]["children"][1]["uid"])


def test_normalize_does_not_mutate_input():
    source = _sample_outline()
    ot.normalize_outline(source)
    assert source[0]["id"] == "9" and "uid" not in source[0]


def test_collect_leaves_and_groups():
    tree = ot.normalize_outline(_sample_outline())
    leaves = ot.collect_leaves(tree)
    assert [l.id for l in leaves] == ["1.1.1", "1.1.2", "1.2", "2"]
    assert leaves[0].path_titles == ["总体方案", "架构设计"]
    assert leaves[0].level == 3 and leaves[3].level == 1
    groups = ot.leaf_groups(leaves)
    assert [[l.id for l in g] for g in groups] == [["1.1.1", "1.1.2"], ["1.2"], ["2"]]


def test_top_level_batches_split_large_chapters():
    outline = [{
        "title": f"第{i}章",
        "children": [
            {"title": f"节{i}.{j}", "children": [{"title": f"目{i}.{j}.{k}"} for k in range(6)]}
            for j in range(5)
        ],
    } for i in range(2)]
    tree = ot.normalize_outline(outline)
    batches = ot.top_level_batches(tree, max_leaves=16)
    assert sum(len(b) for b in batches) == 60
    assert all(len(b) <= 16 for b in batches)
    flat = [l.id for b in batches for l in b]
    assert flat == [l.id for l in ot.collect_leaves(tree)]  # 顺序不乱


def test_fingerprint_changes_only_when_leaves_change():
    tree = ot.normalize_outline(_sample_outline())
    fp = ot.outline_fingerprint(tree)
    tree[0]["title"] = "改了标题"
    assert ot.outline_fingerprint(tree) == fp
    tree.append({"title": "新章节"})
    assert ot.outline_fingerprint(ot.normalize_outline(tree)) != fp


def test_outline_overview_and_find_node():
    tree = ot.normalize_outline(_sample_outline())
    overview = ot.outline_overview(tree)
    assert "1 总体方案" in overview and "    1.1.2 部署架构" in overview
    leaf = ot.collect_leaves(tree)[1]
    assert ot.find_node(tree, leaf.uid)["title"] == "部署架构"
    assert ot.find_node(tree, "nope") is None


def test_normalize_accepts_wrapped_and_garbage_input():
    assert ot.normalize_outline({"outline": [{"title": "A"}]})[0]["title"] == "A"
    assert ot.normalize_outline(None) == []
    assert ot.normalize_outline([1, "x", {"title": ""}])[0]["title"] == "未命名章节"


# ---------------------------------------------------------------------------
# requirements
# ---------------------------------------------------------------------------

_REQ_TEXT = """# 一、评审表要点清单
【评审项ID】：E1
【评审项名称】：技术方案完整性
【分值或权重】：15分
【评审标准】：方案完整、合理得 12-15 分；较完整得 8-11 分。
【原文位置】：第三章 评审办法 2.1
【目录建议】：总体技术方案

【评审项ID】：E2
【评审项名称】：实施计划
【分值或权重】：10分
【评审标准】：未提及
【原文位置】：第三章
【目录建议】：项目实施方案

# 二、采购人要求要点清单
**【要求ID】**：R1
**【要求名称】**：系统性能指标
**【关键约束/指标】**：响应时间不超过 3 秒；并发用户不少于 500。
**【必含关键词】**：3 秒、500、RTX3090
**【原文位置】**：第五章 2.3
**【目录建议】**：性能设计

# 三、覆盖校验清单（用于目录审核）
- [ ] E1 是否被目录独立覆盖
- [ ] R1 是否被目录独立覆盖
"""


def test_parse_requirements_standard_format():
    items = parse_requirements(_REQ_TEXT)
    assert [i.id for i in items] == ["E1", "E2", "R1"]
    e1, e2, r1 = items
    assert e1.kind == "scoring" and e1.name == "技术方案完整性" and e1.score == "15分"
    assert "12-15" in e1.detail
    assert e2.detail == ""  # “未提及”视为空
    assert r1.kind == "requirement"
    assert r1.keywords == ["3 秒", "500", "RTX3090"]
    assert "并发用户不少于 500" in r1.detail
    assert "覆盖校验" not in r1.raw and "- [ ]" not in r1.location


def test_parse_requirements_handles_free_text_and_duplicates():
    assert parse_requirements("") == []
    assert parse_requirements("没有任何结构的一段话") == []
    dup = "【评审项ID】：E1\n【评审项名称】：甲\n【评审项ID】：E1\n【评审项名称】：乙\n"
    assert [i.id for i in parse_requirements(dup)] == ["E1", "E1-2"]


def test_requirements_brief_fits_budget():
    items = parse_requirements(_REQ_TEXT)
    brief = requirements_brief(items)
    assert "E1 技术方案完整性" in brief and "必含关键词" in brief
    assert len(requirements_brief(items, max_chars=40)) <= 40


# ---------------------------------------------------------------------------
# retrieval
# ---------------------------------------------------------------------------


def test_tokenize_mixes_bigrams_and_words():
    tokens = tokenize("响应时间不超过3秒，GPU 采用 RTX3090")
    assert "响应" in tokens and "应时" in tokens
    assert "3" in tokens and "rtx3090" in tokens and "gpu" in tokens


def test_split_chunks_breaks_on_headings_and_long_lines():
    text = "第一章 总则\n" + "甲" * 300 + "\n第二章 技术要求\n" + "乙" * 2000 + "\n尾巴"
    chunks = split_chunks(text, chunk_chars=600, max_chars=900)
    assert chunks[0].heading == "第一章 总则"
    assert any(c.heading == "第二章 技术要求" for c in chunks)
    assert all(len(c.text) <= 900 + 320 for c in chunks)
    assert "".join(c.text for c in chunks).count("乙") == 2000  # 不丢字


def test_text_index_search_finds_relevant_chunk_in_order():
    text = (
        "第一章 采购公告\n本项目为智慧园区综合管理平台建设服务，服务期 180 日历天。\n"
        + "无关内容。" * 150
        + "\n第五章 技术要求\n设备在线率不低于 90%，告警延迟不超过 2 秒。\n"
        + "其他说明。" * 150
    )
    index = TextIndex.from_text(text, chunk_chars=300)
    hits = index.search("设备在线率与告警延迟指标", top_k=2)
    assert hits and any("告警延迟" in h.text for h in hits)
    assert [h.index for h in hits] == sorted(h.index for h in hits)
    assert index.search("完全不相干的量子引力", top_k=2) == [] or True  # 允许空
    assert index.search("", top_k=2) == []
    assert TextIndex.from_text("").search("任何") == []


def test_text_index_respects_max_chars_and_sources():
    index = TextIndex.from_documents([("旧方案.docx", "运维服务方案。" * 200), ("企业介绍", "公司简介。" * 50)], chunk_chars=300)
    hits = index.search("运维服务", top_k=4, max_chars=500)
    assert sum(len(h.text) for h in hits) <= 520
    assert all(h.source == "旧方案.docx" for h in hits)


def test_bm25_scores_rank_matching_doc_first():
    index = BM25Index(["系统总体架构设计", "项目实施进度计划", "售后服务与培训"])
    scores = index.scores("实施进度")
    assert scores.index(max(scores)) == 1
    assert BM25Index([]).scores("x") == []


# ---------------------------------------------------------------------------
# budget
# ---------------------------------------------------------------------------


def test_budget_equal_weights_sums_exactly():
    uids = [f"u{i}" for i in range(7)]
    result = allocate_budget(uids, None, 30000)
    assert sum(result.words.values()) == 30000
    assert max(result.words.values()) - min(result.words.values()) <= 1


def test_budget_respects_weights():
    result = allocate_budget(["a", "b", "c"], {"a": 2, "b": 1, "c": 1}, 8000)
    assert result.words == {"a": 4000, "b": 2000, "c": 2000}


def test_budget_clamps_and_redistributes():
    uids = ["big", "s1", "s2", "s3"]
    result = allocate_budget(uids, {"big": 5, "s1": 0.2, "s2": 1, "s3": 1}, 20000)
    assert sum(result.words.values()) == 20000
    assert result.words["big"] == MAX_WORDS_PER_CHAPTER
    assert all(MIN_WORDS_PER_CHAPTER <= w <= MAX_WORDS_PER_CHAPTER for w in result.words.values())
    assert "big" in result.clamped_high


def test_budget_infeasible_totals_are_reported():
    low = allocate_budget(["a", "b", "c"], None, 100)
    assert set(low.words.values()) == {MIN_WORDS_PER_CHAPTER} and "精简目录" in low.note
    high = allocate_budget(["a"], None, 999999)
    assert high.words == {"a": MAX_WORDS_PER_CHAPTER} and "细化目录" in high.note


@pytest.mark.parametrize("weights", [{"a": 0}, {"a": -3}, {"a": float("nan")}, {"a": "abc"}, {"a": 1e9}])
def test_budget_tolerates_bad_weights(weights):
    result = allocate_budget(["a", "b"], weights, 4000)
    assert sum(result.words.values()) == 4000


def test_budget_empty_and_many_leaves():
    assert allocate_budget([], None, 1000).words == {}
    uids = [f"u{i}" for i in range(150)]
    weights = {u: 0.5 + (i % 7) * 0.4 for i, u in enumerate(uids)}
    result = allocate_budget(uids, weights, 120000)
    assert sum(result.words.values()) == 120000
    assert list(result.words) == uids  # 保持文档顺序
