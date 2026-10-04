"""对抗式审查发现的写作管线问题的回归测试。"""
from __future__ import annotations

import json
from typing import Any, List

import httpx
import openai
import pytest

from app.core.demo_llm import demo_responder
from app.core.fake_llm import FakeCall, FakeLLM, FakeReply
from app.core.store import ProjectStore
from app.utils.errors import LLMError, classify_llm_error
from app.utils.openai_util import OpenAIUtil
from app.writing import writer as writer_module
from app.writing.cleaner import clean_chapter_text, join_continuation, strip_preamble, strip_think
from app.writing.outline_tree import collect_leaves, normalize_outline, top_level_batches
from app.writing.planner import _canonical_id, _ids_in_text, build_blueprint
from app.writing.tender_analysis import stream_tender_analysis_events
from app.writing.textutil import count_chars
from app.writing.writer import build_writing_context, compute_budget, write_chapter
from app.utils.response_chapters import append_response_chapters

from .helpers import WritingResponder, body_text, leaf_ids, make_project


@pytest.fixture(autouse=True)
def _no_retry_delay(monkeypatch):
    monkeypatch.setattr(writer_module, "RETRY_DELAYS", (0.0, 0.0, 0.0))


@pytest.fixture()
def store(tmp_path):
    return ProjectStore(tmp_path / "projects")


# ---------------------------------------------------------------------------
# 清洗：只删对提问者说的话，正文一个字都不能少
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "系统提供 7×24 小时服务。\n\n如需进一步技术支持，我方将在 2 小时内响应。",
        "售后服务体系完善。\n\n如有任何问题，欢迎随时联系我方服务热线。",
        "以下为系统部署方案：\n\n- 应用服务器两台\n- 数据库服务器两台",
        "当然，系统也支持横向扩展。\n\n平台层采用微服务架构。",
        "数据字典约定了字段规范。\n\n每个字段说明约 20 字",
        "根据上述要求，本项目分三期实施。\n\n一期完成平台搭建。",
    ],
)
def test_real_content_is_never_removed(text):
    assert clean_chapter_text(text, title="总体方案") == text


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("好的，以下是本章正文：\n\n平台采用三层架构。", "平台采用三层架构。"),
        ("好的。\n\n平台采用三层架构。", "平台采用三层架构。"),
        ("平台采用三层架构。\n\n希望以上内容对您有帮助。", "平台采用三层架构。"),
        ("平台采用三层架构。\n\n如需调整，请告诉我。", "平台采用三层架构。"),
        ("平台采用三层架构。\n\n（全文约 800 字）", "平台采用三层架构。"),
        ("<think>先想想怎么写……</think>\n平台采用三层架构。", "平台采用三层架构。"),
    ],
)
def test_meta_text_is_removed(raw, expected):
    assert clean_chapter_text(raw, title="总体方案") == expected


def test_think_handling():
    assert strip_think("<think>还没想完") == ""
    assert strip_think("正文<think>中间的思考</think>继续") == "正文继续"
    assert strip_think("没有思考") == "没有思考"


def test_continuation_preamble_and_line_joins():
    assert strip_preamble("好的，接下来继续撰写。采集现场数据。") == "采集现场数据。"
    assert strip_preamble("的后半句，没有客套话。") == "的后半句，没有客套话。"
    table = join_continuation("| 指标 | 承诺 |\n| --- | --- |\n| 响应 | 3 秒 |", "| 可用性 | 99.9% |", truncated=True)
    assert table.endswith("| 响应 | 3 秒 |\n| 可用性 | 99.9% |")
    assert join_continuation("系统采用三层架构，感知层负责", "采集数据。", truncated=True) == "系统采用三层架构，感知层负责采集数据。"


# ---------------------------------------------------------------------------
# 写作
# ---------------------------------------------------------------------------


async def _context(store, project, responder):
    llm = FakeLLM(responder)
    ctx = build_writing_context(project, None, tender_text=store.load_tender_text(project.id))
    return llm, ctx


async def test_failed_expansion_keeps_the_written_chapter(store):
    project = make_project(store)
    responder = WritingResponder(
        {"continue": LLMError("模型调用失败: 400", kind="bad_request", hint="拒绝")}, length_ratio=0.3
    )
    llm, ctx = await _context(store, project, responder)
    leaf = ctx.leaf_by_uid[leaf_ids(project)["1.1.1"]]
    result = await write_chapter(llm, ctx, leaf)
    assert count_chars(result.content) > 0 and "continue" in responder.kinds


async def test_expansion_fatal_error_still_stops(store):
    project = make_project(store)
    responder = WritingResponder({"continue": LLMError("模型调用失败: 401", kind="auth")}, length_ratio=0.3)
    llm, ctx = await _context(store, project, responder)
    with pytest.raises(LLMError) as info:
        await write_chapter(llm, ctx, ctx.leaf_by_uid[leaf_ids(project)["1.1.1"]])
    assert info.value.kind == "auth"


async def test_abnormal_finish_reasons(store):
    project = make_project(store)
    uid = leaf_ids(project)["1.1.1"]

    filtered = WritingResponder({"chapter": FakeReply(text="写到一半", finish_reason="content_filter")})
    llm, ctx = await _context(store, project, filtered)
    with pytest.raises(LLMError) as info:
        await write_chapter(llm, ctx, ctx.leaf_by_uid[uid])
    assert info.value.kind == "content_filter" and filtered.kinds.count("chapter") == 1

    state = {"n": 0}

    def flaky(call, default):
        state["n"] += 1
        return FakeReply(text="半截", finish_reason="insufficient_system_resource") if state["n"] == 1 else default

    llm, ctx = await _context(store, project, WritingResponder({"chapter": flaky}))
    result = await write_chapter(llm, ctx, ctx.leaf_by_uid[uid])
    assert state["n"] == 2 and "半截" not in result.content


def _long_chapter_project(store):
    project = store.create_project("长章")
    project.outline = normalize_outline([{"title": "总体方案", "children": [{"title": "系统总体设计"}]}])
    project.settings.target_pages = 6
    project.settings.words_per_page = 500
    store.save_project(project)
    return project


async def test_empty_section_fails_the_chapter_instead_of_skipping(store):
    project = _long_chapter_project(store)
    responder = WritingResponder({"section": lambda call, default: "   " if "实现方案" in call.last_user.split("现在只撰写")[1] else default})
    llm, ctx = await _context(store, project, responder)
    with pytest.raises(LLMError) as info:
        await write_chapter(llm, ctx, ctx.leaves[0])
    assert info.value.kind == "empty" and "实现方案" in info.value.hint


async def test_section_expansion_headings_are_demoted(store):
    project = _long_chapter_project(store)
    responder = WritingResponder(
        {"continue": "### 补充的小标题\n\n" + body_text("补充", 400)}, length_ratio=0.3
    )
    llm, ctx = await _context(store, project, responder)
    result = await write_chapter(llm, ctx, ctx.leaves[0])
    lines = result.content.split("\n")
    assert "#### 补充的小标题" in lines and "### 补充的小标题" not in lines
    assert [line for line in lines if line.startswith("### ")] == ["### 设计思路", "### 实现方案"]


async def test_table_like_chapters_are_not_padded(store):
    project = make_project(store)
    project.outline = normalize_outline(append_response_chapters(project.outline))
    store.save_project(project)
    responder = WritingResponder({"chapter": "| 评审因素 | 响应 |\n| --- | --- |\n| E1 | 满足 |"})
    llm, ctx = await _context(store, project, responder)
    leaf = next(l for l in ctx.leaves if l.is_response_chapter and "评审" in l.title)
    result = await write_chapter(llm, ctx, leaf)
    assert result.content.endswith("| E1 | 满足 |") and "continue" not in responder.kinds
    prompt = llm.calls[0].last_user
    assert "一条不落地列全" in prompt and "篇幅以写全为准" in prompt


def test_response_chapters_get_budget_by_item_count(store):
    project = make_project(store, target_pages=40)
    project.requirements = "\n".join(
        f"【评审项ID】：E{i}\n【评审项名称】：评审项{i}\n【分值或权重】：5分" for i in range(1, 25)
    )
    project.outline = normalize_outline(append_response_chapters(project.outline))
    budget, _ = compute_budget(project, None)
    leaves = collect_leaves(project.outline)
    scoring_table = next(l for l in leaves if l.is_response_chapter and "评审" in l.title)
    normal = next(l for l in leaves if not l.is_response_chapter)
    assert budget[scoring_table.uid] >= 3.5 * budget[normal.uid]  # 24 条评审项 → 权重 4


# ---------------------------------------------------------------------------
# 规划
# ---------------------------------------------------------------------------


def test_requirement_ids_keep_dedup_suffix():
    assert _canonical_id("E1-2") == "E1-2"
    assert _canonical_id("e 1") == "E1"
    assert _canonical_id("E-3") == "E3"
    assert _ids_in_text("对应评审项: E1-2、E 3、E12", {"E1-2", "E3", "E12"}) == ["E1-2", "E3", "E12"]


async def test_only_missing_does_not_touch_existing_plans(store):
    project = make_project(store)
    first = await build_blueprint(FakeLLM(WritingResponder()), project)
    ids = leaf_ids(project)
    # 使用者把 R1 从“系统性能设计”里移走了
    performance = first.plans[ids["1.1.2"]]
    performance.requirement_ids = [rid for rid in performance.requirement_ids if rid != "R1"]
    performance.auto_assigned = []

    project.outline[1]["children"].append({"title": "运维服务", "children": [{"title": "运维体系", "description": "运维"}]})
    project.outline = normalize_outline(project.outline)
    second = await build_blueprint(FakeLLM(WritingResponder()), project, existing=first, only_missing=True)
    assert "R1" not in second.plans[ids["1.1.2"]].requirement_ids
    new_uid = next(l.uid for l in collect_leaves(project.outline) if l.title == "运维体系")
    assert "R1" in second.plans[new_uid].requirement_ids or "R1" in second.unassigned_requirements


async def test_only_missing_keeps_fact_sheet_warning(store):
    project = make_project(store)
    first = await build_blueprint(FakeLLM(WritingResponder({"facts": "坏", "repair": "坏"})), project)
    assert any("统一口径" in w for w in first.warnings)
    second = await build_blueprint(FakeLLM(WritingResponder()), project, existing=first, only_missing=True)
    assert any("统一口径" in w for w in second.warnings)


async def test_plans_matched_by_title_are_accepted(store):
    project = make_project(store)

    def titles_only(call, default):
        plans = json.loads(default)["plans"]
        leaves = {l.id: l.title for l in collect_leaves(project.outline)}
        return json.dumps({"plans": [{**{k: v for k, v in p.items() if k != "id"}, "title": leaves[p["id"]]} for p in plans]}, ensure_ascii=False)

    llm = FakeLLM(WritingResponder({"plans": titles_only}))
    blueprint = await build_blueprint(llm, project)
    assert not any("没有生成成功" in w for w in blueprint.warnings)
    assert blueprint.plans[leaf_ids(project)["1.1.1"]].key_points[0].startswith("1.1.1")


def test_flat_outline_is_batched_together():
    tree = normalize_outline([{"title": f"第{i}章"} for i in range(30)] + [{"title": "附录", "children": [{"title": "说明"}]}])
    batches = top_level_batches(tree, max_leaves=24)
    assert [len(b) for b in batches] == [24, 6, 1]


# ---------------------------------------------------------------------------
# 招标文件解析的截断
# ---------------------------------------------------------------------------


async def test_truncated_analysis_is_continued():
    state = {"n": 0}

    def responder(call):
        state["n"] += 1
        if state["n"] == 1:
            return FakeReply(text="【评审项ID】：E1\n【评审项名称】：总体", finish_reason="length")
        assert "因为单次输出的长度限制在中途断开" in call.last_user
        return "方案\n【评审项ID】：E2\n【评审项名称】：实施计划"

    llm = FakeLLM(responder)
    events = [event async for event in stream_tender_analysis_events(llm, "招标文件", "requirements")]
    text = "".join(v for k, v in events if k == "chunk")
    assert text.endswith("【评审项名称】：实施计划") and "总体方案" in text
    # 截断提示单独作为 warning：页面在解析结束后仍然保留它
    assert any(k == "warning" and "超出了模型单次输出的上限" in v for k, v in events)


# ---------------------------------------------------------------------------
# 错误分类与 JSON 提取
# ---------------------------------------------------------------------------


def _status_error(cls, status, message):
    request = httpx.Request("POST", "https://example.invalid/v1/chat/completions")
    return cls(message, response=httpx.Response(status, request=request), body=None)


def test_rate_limit_with_quota_link_is_still_retryable():
    error = classify_llm_error(
        _status_error(openai.RateLimitError, 429, "Rate limit reached. See https://platform.example/docs/quota and billing.")
    )
    assert (error.kind, error.retryable) == ("rate_limit", True)
    balance = classify_llm_error(_status_error(openai.RateLimitError, 429, "You exceeded your current quota (insufficient_quota)"))
    assert (balance.kind, balance.retryable) == ("balance", False)


@pytest.mark.parametrize(
    "content",
    [
        '<think>先想一想 {"x": 1}</think>\n{"items": [1]}',
        '好的，结果如下：\n```json\n{"items": [1]}\n```\n希望对你有帮助',
        '```json\n{"items": [1]}\n```',
        '{"items": [1]}',
    ],
)
def test_json_extraction_handles_thinking_and_prefaces(content):
    assert json.loads(OpenAIUtil._extract_json_content(content)) == {"items": [1]}


def test_demo_responder_accepts_titles_with_brackets():
    call = FakeCall(index=0, messages=[{"role": "user", "content": "【任务】\n请撰写「2.1 「智慧」平台建设」的正文。篇幅约 300 字。直接输出正文。"}])
    assert demo_responder(call) != "{}"


async def test_planning_stops_calling_a_hung_service(store):
    project = store.create_project("很多章")
    project.outline = normalize_outline(
        [{"title": f"第{i}部分", "children": [{"title": f"节{i}.{j}"} for j in range(3)]} for i in range(8)]
    )
    project.overview = "概述"
    store.save_project(project)

    def responder(call):
        if "投标技术方案的主笔" in call.system:
            return LLMError("模型调用失败: timed out", kind="timeout", retryable=True)
        return WritingResponder()(call)

    llm = FakeLLM(responder)
    blueprint = await build_blueprint(llm, project, concurrency=1)
    plan_calls = [c for c in llm.calls if "投标技术方案的主笔" in c.system]
    assert len(plan_calls) == 2  # 连续两批超时之后，其余六批不再请求
    assert len(blueprint.plans) == 24
    assert any("连续没有正常响应" in w and "其余 18 章" in w for w in blueprint.warnings)


# ---------------------------------------------------------------------------
# 插图：渲染不占事件循环、失败原因带回导出结果
# ---------------------------------------------------------------------------


async def test_diagram_render_runs_off_the_event_loop_and_errors_are_reported(monkeypatch):
    import threading

    from app.models.schemas import WordExportOutlineItem
    from app.services import diagram_service

    loop_thread = threading.get_ident()
    seen_threads: List[int] = []

    def fake_render(engine, code):
        seen_threads.append(threading.get_ident())
        return b"\x89PNG fake"

    monkeypatch.setattr(diagram_service.DiagramRenderer, "render", staticmethod(fake_render))

    def responder(call):
        if "失败的章节" in call.text:
            return LLMError("模型调用失败: 404 model not found", kind="bad_request", hint="模型名称不对")
        return json.dumps({"need": True, "engine": "mermaid", "code": "graph TD; A-->B", "title": "示意图"})

    items = [
        WordExportOutlineItem(id="1", title="正常的章节", content="正文"),
        WordExportOutlineItem(id="2", title="失败的章节", content="正文"),
    ]
    errors: List[str] = []
    count = await diagram_service.attach_diagrams_to_outline(items, ai=FakeLLM(responder), errors=errors)
    assert count == 1 and items[0].image_b64 and not items[1].image_b64
    assert seen_threads and all(t != loop_thread for t in seen_threads)
    assert len(errors) == 1 and "失败的章节" in errors[0] and "模型名称不对" in errors[0]


async def test_timeouts_before_any_output_are_not_retried_twice(store):
    project = make_project(store)
    uid = leaf_ids(project)["1.1.1"]

    early = WritingResponder({"chapter": LLMError("模型调用失败: timed out", kind="timeout", retryable=True)})
    llm, ctx = await _context(store, project, early)
    with pytest.raises(LLMError):
        await write_chapter(llm, ctx, ctx.leaf_by_uid[uid])
    assert early.kinds.count("chapter") == 1  # SDK 层已经重试过，这里不再重复

    state = {"n": 0}

    def stalled(call, default):
        state["n"] += 1
        if state["n"] == 1:
            return FakeReply(text="输出到一半", error=LLMError("模型调用失败: read timeout", kind="timeout", retryable=True, partial=True))
        return default

    llm, ctx = await _context(store, project, WritingResponder({"chapter": stalled}))
    result = await write_chapter(llm, ctx, ctx.leaf_by_uid[uid])
    assert state["n"] == 2 and "输出到一半" not in result.content
