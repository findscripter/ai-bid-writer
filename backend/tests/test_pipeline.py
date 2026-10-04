"""写作管线的测试：清洗、摘记、规划、写作、任务编排。全部用假模型驱动。"""
from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, List, Tuple

import pytest

from app.core.fake_llm import FakeLLM, FakeReply
from app.core.jobs import Job, JobManager
from app.core.store import ProjectStore
from app.utils.errors import AppError, LLMError
from app.writing import writer as writer_module
from app.writing.cleaner import clean_chapter_text, join_continuation, strip_overlap, strip_preamble
from app.writing.digest import build_digest
from app.writing.models import ChapterRecord
from app.writing.outline_tree import collect_leaves, normalize_outline
from app.writing.pipeline import run_deep_review_job, run_plan_job, run_revise_job, run_write_job
from app.writing.planner import build_blueprint
from app.writing.textutil import count_chars
from app.writing.writer import LiveText, build_writing_context, write_chapter

from .helpers import WritingResponder, body_text, leaf_ids, make_project, truncated_once


@pytest.fixture(autouse=True)
def _no_retry_delay(monkeypatch):
    monkeypatch.setattr(writer_module, "RETRY_DELAYS", (0.0, 0.0, 0.0))


@pytest.fixture()
def store(tmp_path):
    return ProjectStore(tmp_path / "projects")


async def run_job(manager: JobManager, project_id: str, kind: str, params: Dict[str, Any], runner) -> Tuple[Job, List[Dict[str, Any]]]:
    job = manager.start(project_id, kind, params, runner)
    events: List[Dict[str, Any]] = []
    async for _seq, event in manager.subscribe(job.record.id, heartbeat=0.05):
        if event is not None:
            events.append(event)
    return job, events


def replay_live(events: List[Dict[str, Any]], uid: str) -> str:
    """按事件重放某一章的实时文本（验证前端拿到的增量与回滚是自洽的）。"""
    text = ""
    for event in events:
        if event.get("uid") != uid:
            continue
        if event["type"] == "chapter_start":
            text = ""
        elif event["type"] == "chapter_delta":
            text += event["text"]
        elif event["type"] == "chapter_reset":
            text = event["text"]
    return text


# ---------------------------------------------------------------------------
# 清洗与摘记
# ---------------------------------------------------------------------------


def test_clean_removes_title_preamble_closing_and_wordcount():
    raw = (
        "## 2.1 系统架构设计\n\n"
        "以下是本章节的正文内容：\n\n"
        "系统采用三层架构。\n\n"
        "# 分层说明\n感知层负责采集。\n\n"
        "以上是本章节的全部内容，如需调整请告知。\n"
        "（全文约 800 字）\n"
    )
    cleaned = clean_chapter_text(raw, title="系统架构设计", chapter_id="2.1")
    assert cleaned == "系统采用三层架构。\n\n### 分层说明\n感知层负责采集。"


def test_clean_keeps_real_content_that_looks_similar():
    text = "根据招标文件第五章的要求，系统响应时间不超过 3 秒。\n\n以上指标均通过压力测试验证。"
    assert clean_chapter_text(text, title="性能设计") == text
    assert clean_chapter_text("**（1）总体思路**：分层解耦。", title="总体思路说明") == "**（1）总体思路**：分层解耦。"


def test_clean_unwraps_fence_only_when_whole_text_is_wrapped():
    assert clean_chapter_text("```markdown\n正文一段。\n```") == "正文一段。"
    inner = "说明如下：\n\n```\nkey=value\n```\n\n后续说明。"
    assert "```" in clean_chapter_text(inner)
    assert clean_chapter_text("") == ""


def test_overlap_and_join():
    previous = "系统采用三层架构，各层之间通过标准接口通信。"
    more = "各层之间通过标准接口通信。平台层提供统一的数据服务。"
    assert strip_overlap(previous, more) == "平台层提供统一的数据服务。"
    assert join_continuation("上文在这里断", "开了的后半句。", truncated=True) == "上文在这里断开了的后半句。"
    assert join_continuation("第一段。", "第二段。", truncated=False) == "第一段。\n\n第二段。"
    assert join_continuation("第一段。", "   ", truncated=False) == "第一段。"
    assert strip_preamble("好的，以下是续写内容：\n接着写的正文。") == "接着写的正文。"
    assert strip_preamble("的后半句，没有开场白。") == "的后半句，没有开场白。"


def test_digest_extracts_summary_and_numeric_claims():
    content = (
        "### 性能指标\n\n系统采用分布式架构，支持横向扩展。设备在线率不低于 90%。"
        "系统响应时间不超过 3 秒。平台界面简洁。\n\n"
        "| 指标 | 承诺值 |\n| --- | --- |\n| 可用性 | 不低于 99.9% |\n"
    )
    digest = build_digest(content, ["性能指标"])
    assert digest.summary.startswith("系统采用分布式架构")
    assert "小节：性能指标" in digest.summary
    assert any("90%" in claim for claim in digest.claims)
    assert any("3 秒" in claim for claim in digest.claims)
    assert any("99.9%" in claim for claim in digest.claims)
    assert all("界面简洁" not in claim for claim in digest.claims)
    assert build_digest("").summary == "" and build_digest("").claims == []


# ---------------------------------------------------------------------------
# 规划
# ---------------------------------------------------------------------------


async def test_blueprint_has_facts_plans_and_weights(store):
    project = make_project(store)
    llm = FakeLLM(WritingResponder())
    stages: List[str] = []
    blueprint = await build_blueprint(
        llm, project, tender_text=store.load_tender_text(project.id), on_stage=lambda s, m: stages.append(s)
    )
    ids = leaf_ids(project)
    assert stages == ["facts", "chapters", "coverage"]
    assert blueprint.fact_sheet.project_name == "智慧园区管理平台"
    assert [f.key for f in blueprint.fact_sheet.facts] == ["服务期", "设备在线率"]
    assert set(blueprint.plans) == set(ids.values())
    assert blueprint.plans[ids["1.1.1"]].weight == 2.0
    assert blueprint.plans[ids["2.1.1"]].requirement_ids == ["E2"]
    # R1 没有任何章节认领：按相似度补给“系统性能设计”
    performance = blueprint.plans[ids["1.1.2"]]
    assert "R1" in performance.requirement_ids and performance.auto_assigned == ["R1"]
    assert blueprint.unassigned_requirements == []
    assert blueprint.outline_fingerprint

    facts_call = next(c for c in llm.calls if "总体设计负责人" in c.system)
    assert "180 日历天" in facts_call.text  # 招标原文摘录进了提示词


async def test_blueprint_survives_fact_and_plan_failures(store):
    project = make_project(store)
    llm = FakeLLM(WritingResponder({"facts": "不是 JSON", "plans": "也不是 JSON", "repair": "还是不行"}))
    blueprint = await build_blueprint(llm, project)
    ids = leaf_ids(project)
    assert blueprint.fact_sheet.project_name == project.name and blueprint.fact_sheet.facts == []
    assert set(blueprint.plans) == set(ids.values())
    assert len(blueprint.warnings) >= 2 and "统一口径" in blueprint.warnings[0]
    # 兜底计划仍然让每条要求都有章节承接
    owned = {rid for plan in blueprint.plans.values() for rid in plan.requirement_ids}
    assert owned == {"E1", "E2", "R1"}


async def test_blueprint_accepts_sloppy_model_output(store):
    project = make_project(store)

    def sloppy_plans(call, default):
        plans = json.loads(default)["plans"]
        return json.dumps(
            {p["id"]: {"key_points": "要点甲；要点乙", "requirement_ids": "E1、E9", "weight": "1.5", "form": "表格"} for p in plans},
            ensure_ascii=False,
        )

    def sloppy_facts(call, default):
        return "```json\n" + json.dumps(
            {"project_name": "X 项目", "facts": {"工期": "180 天"}, "decisions": ["架构：三层架构"], "terminology": ["控制平台"], "placeholders": "业绩；资质"},
            ensure_ascii=False,
        ) + "\n```"

    llm = FakeLLM(WritingResponder({"plans": sloppy_plans, "facts": sloppy_facts}))
    blueprint = await build_blueprint(llm, project)
    plan = blueprint.plans[leaf_ids(project)["1.1.1"]]
    assert plan.key_points == ["要点甲", "要点乙"] and plan.form == "table" and plan.weight == 1.5
    assert plan.requirement_ids == ["E1"]  # 不存在的 E9 被丢弃
    sheet = blueprint.fact_sheet
    assert (sheet.facts[0].key, sheet.facts[0].value) == ("工期", "180 天")
    assert (sheet.decisions[0].key, sheet.decisions[0].value) == ("架构", "三层架构")
    assert sheet.terminology[0].term == "控制平台" and sheet.placeholders == ["业绩", "资质"]


async def test_blueprint_only_missing_keeps_existing_plans(store):
    project = make_project(store)
    first = await build_blueprint(FakeLLM(WritingResponder()), project)
    ids = leaf_ids(project)
    first.plans[ids["1.1.1"]].key_points = ["手工改过的要点"]

    project.outline[1]["children"].append({"title": "运维服务", "children": [{"title": "运维体系", "description": "运维"}]})
    project.outline = normalize_outline(project.outline)
    llm = FakeLLM(WritingResponder())
    second = await build_blueprint(llm, project, existing=first, only_missing=True)

    assert second.plans[ids["1.1.1"]].key_points == ["手工改过的要点"]
    new_uid = [l.uid for l in collect_leaves(project.outline) if l.title == "运维体系"][0]
    assert new_uid in second.plans
    assert second.version == first.version + 1
    assert not any("总体设计负责人" in c.system for c in llm.calls)  # 统一口径没有重做
    assert sum(1 for c in llm.calls if "主笔" in c.system) == 1  # 只为新增章节规划了一批


async def test_blueprint_aborts_on_auth_error(store):
    project = make_project(store)
    llm = FakeLLM(lambda call: LLMError("模型调用失败: 401", kind="auth", hint="API Key 无效"))
    with pytest.raises(LLMError):
        await build_blueprint(llm, project)
    assert len(llm.calls) == 1  # 没有继续白白重试

    with pytest.raises(AppError):
        empty = store.create_project("空")
        await build_blueprint(FakeLLM(), empty)


# ---------------------------------------------------------------------------
# 写作（单章）
# ---------------------------------------------------------------------------


async def _context(store, project, with_blueprint=True, responder=None):
    llm = FakeLLM(responder or WritingResponder())
    blueprint = await build_blueprint(llm, project, tender_text=store.load_tender_text(project.id)) if with_blueprint else None
    ctx = build_writing_context(project, blueprint, tender_text=store.load_tender_text(project.id))
    llm.calls.clear()
    if hasattr(llm.responder, "kinds"):
        llm.responder.kinds.clear()  # 只统计写作阶段的调用
    return llm, ctx


async def test_short_chapter_prompt_carries_global_context(store):
    project = make_project(store)
    llm, ctx = await _context(store, project)
    leaf = ctx.leaf_by_uid[leaf_ids(project)["1.1.2"]]
    result = await write_chapter(llm, ctx, leaf)

    assert len(llm.calls) == 1
    prompt = llm.calls[0].text
    for expected in (
        "【统一口径】", "服务期：180 日历天", "【全书目录】", "1.2.1 控制算法",
        "【写作计划】", "1.1.2 的要点一", "R1 系统性能指标", "必含关键词：90%、3 秒",
        "【招标文件相关原文】", "设备在线率不低于 90%", "【待补充：",
    ):
        assert expected in prompt, expected
    target = ctx.budget[leaf.uid]
    assert f"篇幅约 {target} 字" in prompt
    assert abs(count_chars(result.content) - target) <= 2
    assert result.section_titles == [] and result.truncated is False


async def test_shared_prefix_is_identical_across_chapters(store):
    project = make_project(store)
    llm, ctx = await _context(store, project)
    for uid in list(leaf_ids(project).values())[:3]:
        await write_chapter(llm, ctx, ctx.leaf_by_uid[uid])
    prefixes = {json.dumps(call.messages[:2], ensure_ascii=False) for call in llm.calls}
    assert len(prefixes) == 1  # 前两条消息逐字相同，服务商的前缀缓存才能命中


async def test_short_output_is_expanded_until_enough(store):
    project = make_project(store)
    llm, ctx = await _context(store, project, responder=WritingResponder(length_ratio=0.4))
    leaf = ctx.leaf_by_uid[leaf_ids(project)["1.1.1"]]
    result = await write_chapter(llm, ctx, leaf)
    target = ctx.budget[leaf.uid]
    kinds = llm.responder.kinds
    assert kinds[0] == "chapter" and set(kinds[1:]) == {"continue"}
    assert count_chars(result.content) >= int(target * 0.85)
    follow_up = llm.calls[1]
    assert follow_up.messages[-2]["role"] == "assistant"
    assert "还差约" in follow_up.last_user and "不要重复已经写过的内容" in follow_up.last_user


async def test_expansion_stops_when_model_adds_nothing(store):
    project = make_project(store)
    responder = WritingResponder({"continue": "嗯。"}, length_ratio=0.3)
    llm, ctx = await _context(store, project, responder=responder)
    result = await write_chapter(llm, ctx, ctx.leaf_by_uid[leaf_ids(project)["1.1.1"]])
    assert responder.kinds.count("continue") == 1  # 第一轮没有新增就不再空转
    assert count_chars(result.content) > 0


async def test_truncated_output_is_continued(store):
    project = make_project(store)
    cut = "系统采用三层架构，感知层负责"
    responder = WritingResponder({"chapter": truncated_once(cut), "truncated": "采集现场数据并上送平台。" + body_text("后续", 600)})
    llm, ctx = await _context(store, project, responder=responder)
    result = await write_chapter(llm, ctx, ctx.leaf_by_uid[leaf_ids(project)["1.1.1"]])
    assert result.content.startswith("系统采用三层架构，感知层负责采集现场数据并上送平台。")
    assert responder.kinds[:2] == ["chapter", "truncated"]
    assert result.truncated is False


async def test_still_truncated_after_max_rounds_is_flagged(store):
    project = make_project(store)
    always_cut = lambda call, default: FakeReply(text="又被截断的一段内容，" * 5, finish_reason="length")
    responder = WritingResponder({"chapter": always_cut, "truncated": always_cut})
    llm, ctx = await _context(store, project, responder=responder)
    result = await write_chapter(llm, ctx, ctx.leaf_by_uid[leaf_ids(project)["1.1.1"]])
    assert result.truncated is True
    assert responder.kinds.count("truncated") == writer_module.MAX_TRUNCATION_ROUNDS
    assert "continue" not in responder.kinds  # 仍被截断时不再做“篇幅不足”的补写


async def test_long_chapter_is_written_section_by_section(store):
    project = store.create_project("长章")
    project.outline = normalize_outline([{"title": "总体方案", "children": [{"title": "系统总体设计", "description": "整体设计"}]}])
    project.settings.target_pages = 6
    project.settings.words_per_page = 500
    store.save_project(project)
    llm, ctx = await _context(store, project, with_blueprint=False)
    leaf = ctx.leaves[0]
    assert ctx.budget[leaf.uid] == 3000

    live_events: List[str] = []
    live = LiveText(on_delta=live_events.append)
    result = await write_chapter(llm, ctx, leaf, live=live)

    assert result.section_titles == ["设计思路", "实现方案"]
    assert result.content.startswith("### 设计思路\n\n") and "\n\n### 实现方案\n\n" in result.content
    assert abs(count_chars(result.content) - 3000) < 120
    assert llm.responder.kinds == ["sections", "section", "section"]
    second = llm.calls[2].last_user
    assert "【已经写完的小节】" in second and "- 设计思路：" in second and "【上一小节的结尾】" in second
    assert "现在只撰写「1.1 系统总体设计」的第 2 个小节「实现方案」" in second
    assert "".join(live_events) == live.text and "### 设计思路" in live.text


async def test_section_planning_failure_falls_back_to_whole_chapter(store):
    project = store.create_project("长章")
    project.outline = normalize_outline([{"title": "总体方案", "children": [{"title": "系统总体设计"}]}])
    project.settings.target_pages = 6
    project.settings.words_per_page = 500
    store.save_project(project)
    responder = WritingResponder({"sections": "不是 JSON", "repair": "仍然不是"})
    llm, ctx = await _context(store, project, with_blueprint=False, responder=responder)
    result = await write_chapter(llm, ctx, ctx.leaves[0])
    assert result.section_titles == []
    assert "chapter" in responder.kinds and count_chars(result.content) >= 2500


async def test_retryable_error_resets_live_text_and_retries(store):
    project = make_project(store)
    state = {"n": 0}

    def flaky(call, default):
        state["n"] += 1
        if state["n"] == 1:
            return FakeReply(text="写到一半就", error=LLMError("模型调用失败: timeout", kind="timeout", retryable=True))
        return default

    llm, ctx = await _context(store, project, responder=WritingResponder({"chapter": flaky}))
    resets: List[str] = []
    live = LiveText(on_reset=resets.append)
    result = await write_chapter(llm, ctx, ctx.leaf_by_uid[leaf_ids(project)["1.1.1"]], live=live)
    assert state["n"] == 2 and resets == [""]
    assert "写到一半就" not in result.content


async def test_non_retryable_and_empty_outputs_raise(store):
    project = make_project(store)
    leaf_uid = leaf_ids(project)["1.1.1"]

    bad = WritingResponder({"chapter": LLMError("模型调用失败: 400", kind="bad_request")})
    llm, ctx = await _context(store, project, responder=bad)
    with pytest.raises(LLMError) as info:
        await write_chapter(llm, ctx, ctx.leaf_by_uid[leaf_uid])
    assert info.value.kind == "bad_request" and bad.kinds.count("chapter") == 1

    empty = WritingResponder({"chapter": "   "})
    llm, ctx = await _context(store, project, responder=empty)
    with pytest.raises(LLMError) as info:
        await write_chapter(llm, ctx, ctx.leaf_by_uid[leaf_uid])
    assert info.value.kind == "empty"


# ---------------------------------------------------------------------------
# 任务编排
# ---------------------------------------------------------------------------


async def test_write_job_writes_everything_and_reviews(store):
    project = make_project(store)
    responder = WritingResponder()
    llm = FakeLLM(responder, delay=0.001)
    manager = JobManager(store)
    factory = lambda model: llm

    await run_job(manager, project.id, "plan", {}, lambda ctx: run_plan_job(ctx, store, factory))
    assert store.load_blueprint(project.id) is not None
    llm.calls.clear()

    job, events = await run_job(manager, project.id, "write", {}, lambda ctx: run_write_job(ctx, store, factory))
    ids = leaf_ids(project)
    chapters = store.load_chapters(project.id)

    assert job.record.status == "done"
    assert (job.record.progress.done, job.record.progress.failed, job.record.progress.total) == (5, 0, 5)
    assert set(chapters) == set(ids.values())
    assert all(c.status == "done" and c.chars > 0 and c.digest for c in chapters.values())
    assert llm.max_active <= project.settings.concurrency and llm.max_active >= 2
    assert job.record.usage["calls"] >= 5

    types = [e["type"] for e in events]
    assert types.count("chapter_start") == 5 and types.count("chapter_done") == 5
    assert "write_plan" in types and types[-2:] == ["review_ready", "job_end"] or "review_ready" in types
    assert store.load_review(project.id) is not None

    # 事件重放出的实时文本，清洗后与落盘的正文一致
    for uid, record in chapters.items():
        assert clean_chapter_text(replay_live(events, uid)) == record.content
    assert job.snapshot()["live"] == {}

    # 同一父节点下后写的章节，能看到先写完的兄弟章节的摘记
    second = next(c for c in llm.calls if "请撰写「1.1.2 系统性能设计」" in c.last_user)
    assert "【已完成的相邻章节】" in second.text and "- 1.1.1 总体架构：" in second.text
    first = next(c for c in llm.calls if "请撰写「1.1.1 总体架构」" in c.last_user)
    assert "【已完成的相邻章节】" not in first.text


async def test_write_job_missing_mode_skips_done_and_uids_force_rewrite(store):
    project = make_project(store)
    llm = FakeLLM(WritingResponder())
    manager = JobManager(store)
    factory = lambda model: llm
    runner = lambda ctx: run_write_job(ctx, store, factory)
    ids = leaf_ids(project)

    await run_job(manager, project.id, "write", {}, runner)
    llm.calls.clear()

    job, events = await run_job(manager, project.id, "write", {"mode": "missing"}, runner)
    assert llm.calls == [] and job.record.message == "没有需要撰写的章节"

    uid = ids["2.1.1"]
    before = store.load_chapter(project.id, uid).content
    llm.responder = WritingResponder({"chapter": lambda call, default: "重写后的新内容。" + default})
    job, events = await run_job(manager, project.id, "write", {"uids": [uid]}, runner)
    record = store.load_chapter(project.id, uid)
    assert job.record.progress.total == 1 and record.content.startswith("重写后的新内容。")
    assert record.versions[0].content == before and len(record.versions) == 1

    job, _ = await run_job(manager, project.id, "write", {"mode": "all"}, runner)
    assert job.record.progress.total == 5


async def test_one_failed_chapter_does_not_block_the_rest(store):
    project = make_project(store)
    ids = leaf_ids(project)

    def fail_one(call, default):
        if "请撰写「1.2.1 控制算法」" in call.last_user:
            return LLMError("模型调用失败: 400 content filter", kind="bad_request", hint="模型服务拒绝了请求")
        return default

    llm = FakeLLM(WritingResponder({"chapter": fail_one}))
    manager = JobManager(store)
    runner = lambda ctx: run_write_job(ctx, store, lambda model: llm)
    job, events = await run_job(manager, project.id, "write", {}, runner)

    assert job.record.status == "done"
    assert (job.record.progress.done, job.record.progress.failed) == (4, 1)
    failed = store.load_chapter(project.id, ids["1.2.1"])
    assert failed.status == "failed" and failed.content == "" and "模型服务拒绝了请求" in failed.error
    assert "生成失败" not in failed.content  # 错误信息不再混进正文
    failed_event = next(e for e in events if e["type"] == "chapter_failed")
    assert failed_event["uid"] == ids["1.2.1"]

    # “只写未完成的”会重试失败的那一章
    llm.responder = WritingResponder()
    job, _ = await run_job(manager, project.id, "write", {}, runner)
    assert job.record.progress.total == 1
    assert store.load_chapter(project.id, ids["1.2.1"]).status == "done"


async def test_auth_error_aborts_the_whole_job(store):
    project = make_project(store)
    llm = FakeLLM(lambda call: LLMError("模型调用失败: 401 invalid key", kind="auth", hint="API Key 无效"))
    manager = JobManager(store)
    job, events = await run_job(manager, project.id, "write", {}, lambda ctx: run_write_job(ctx, store, lambda m: llm))
    assert job.record.status == "failed" and "API Key 无效" in job.record.error
    assert len(llm.calls) <= project.settings.concurrency  # 没有把全部章节都试一遍
    assert job.record.progress.done == 0


async def test_job_stops_after_a_streak_of_failures(store):
    project = store.create_project("很多章")
    project.outline = normalize_outline(
        [{"title": f"第{i}章", "children": [{"title": f"节{i}.{j}"} for j in range(4)]} for i in range(5)]
    )
    project.settings.concurrency = 1
    store.save_project(project)
    llm = FakeLLM(lambda call: LLMError("模型调用失败: 404 model not found", kind="bad_request", hint="模型服务拒绝了请求"))
    manager = JobManager(store)
    job, events = await run_job(manager, project.id, "write", {}, lambda ctx: run_write_job(ctx, store, lambda m: llm))
    assert job.record.status == "failed" and "连续 5 章没有写成" in job.record.error
    # 熔断的那一刻可能有另一章已经拿到了执行权，允许多出并发数那么多；剩下的十几章没有再去试
    assert 5 <= job.record.progress.failed <= 6 and len(llm.calls) <= 6


async def test_cancel_keeps_partial_text_of_first_draft(store):
    project = make_project(store)
    llm = FakeLLM(WritingResponder(), delay=0.01, chunk_size=20)
    manager = JobManager(store)
    job = manager.start(project.id, "write", {}, lambda ctx: run_write_job(ctx, store, lambda m: llm))
    await asyncio.sleep(0.15)
    snapshot = job.snapshot()
    assert snapshot["live"] and any(text for text in snapshot["live"].values())
    assert await manager.cancel(job.record.id) is True

    assert job.record.status == "cancelled"
    chapters = store.load_chapters(project.id)
    cancelled = [c for c in chapters.values() if c.status == "cancelled"]
    assert cancelled and all(c.chars > 0 and c.content for c in cancelled)
    assert job.snapshot()["live"] == {}
    calls_at_cancel = len(llm.calls)
    await asyncio.sleep(0.1)
    assert len(llm.calls) == calls_at_cancel and llm.active == 0  # 取消后不再有任何模型调用

    # 继续：只补没写完的
    llm.delay = 0
    job2, _ = await run_job(manager, project.id, "write", {}, lambda ctx: run_write_job(ctx, store, lambda m: llm))
    assert job2.record.status == "done"
    assert all(c.status == "done" for c in store.load_chapters(project.id).values())


async def test_failed_or_cancelled_rewrite_keeps_existing_content(store):
    project = make_project(store)
    ids = leaf_ids(project)
    uid = ids["1.1.1"]
    store.save_chapter(project.id, ChapterRecord(uid=uid, status="done", content="原来的完整正文。", chars=8))
    manager = JobManager(store)

    failing = FakeLLM(WritingResponder({"chapter": FakeReply(text="新写了一点", error=LLMError("模型调用失败: 400", kind="bad_request"))}))
    job, events = await run_job(manager, project.id, "write", {"uids": [uid]}, lambda ctx: run_write_job(ctx, store, lambda m: failing))
    record = store.load_chapter(project.id, uid)
    assert record.status == "done" and record.content == "原来的完整正文。"
    assert "已保留原来的正文" in record.error and job.record.progress.failed == 1

    slow = FakeLLM(WritingResponder(), delay=0.02, chunk_size=10)
    job = manager.start(project.id, "write", {"uids": [uid]}, lambda ctx: run_write_job(ctx, store, lambda m: slow))
    await asyncio.sleep(0.1)
    await manager.cancel(job.record.id)
    assert store.load_chapter(project.id, uid).content == "原来的完整正文。"


async def test_revise_job_replaces_content_and_keeps_version(store):
    project = make_project(store)
    uid = leaf_ids(project)["1.1.2"]
    llm = FakeLLM(WritingResponder())
    manager = JobManager(store)
    factory = lambda model: llm
    await run_job(manager, project.id, "write", {"uids": [uid]}, lambda ctx: run_write_job(ctx, store, factory))
    original = store.load_chapter(project.id, uid).content
    llm.calls.clear()

    job, events = await run_job(
        manager, project.id, "revise", {"uid": uid, "instruction": "补充响应时间不超过 3 秒的达成措施"},
        lambda ctx: run_revise_job(ctx, store, factory),
    )
    record = store.load_chapter(project.id, uid)
    assert job.record.status == "done" and record.source == "revised"
    assert record.content != original and record.versions[0].content == original
    assert "补充响应时间" in record.versions[0].note
    prompt = llm.calls[0].last_user
    assert "【当前正文】" in prompt and original[:20] in prompt and "【修改要求】" in prompt
    assert llm.calls[0].temperature <= 0.4

    job, _ = await run_job(manager, project.id, "revise", {"uid": uid, "instruction": ""}, lambda ctx: run_revise_job(ctx, store, factory))
    assert job.record.status == "failed" and "修改要求" in job.record.error
    job, _ = await run_job(
        manager, project.id, "revise", {"uid": leaf_ids(project)["2.1.2"], "instruction": "改"},
        lambda ctx: run_revise_job(ctx, store, factory),
    )
    assert job.record.status == "failed" and "还没有正文" in job.record.error


async def test_deep_review_reports_contradictions(store):
    project = make_project(store)
    ids = leaf_ids(project)

    def numbers(call, default):
        if "1.1.2" in call.last_user:
            return "系统响应时间不超过 3 秒，设备在线率不低于 90%。" + default
        if "2.1.1" in call.last_user:
            return "项目工期为 200 日历天，分三个阶段实施。" + default
        return "本章共配置 5 名工程师。" + default

    consistency = json.dumps(
        {"issues": [{"chapter_ids": ["2.1.1"], "problem": "2.1.1 写工期 200 日历天，统一口径为 180 日历天", "suggestion": "统一为 180 日历天"}, {"chapter_ids": ["9.9"], "problem": "不存在的章节"}]},
        ensure_ascii=False,
    )
    llm = FakeLLM(WritingResponder({"chapter": numbers, "consistency": consistency}))
    manager = JobManager(store)
    factory = lambda model: llm
    await run_job(manager, project.id, "plan", {}, lambda ctx: run_plan_job(ctx, store, factory))
    await run_job(manager, project.id, "write", {}, lambda ctx: run_write_job(ctx, store, factory))

    job, events = await run_job(manager, project.id, "review", {}, lambda ctx: run_deep_review_job(ctx, store, factory))
    report = store.load_review(project.id)
    assert job.record.status == "done" and report.deep is True
    found = [i for i in report.issues if i.type == "consistency"]
    assert len(found) == 1 and found[0].chapter_uids == [ids["2.1.1"]]
    assert found[0].fixable and "180 日历天" in found[0].fix_instruction
    claims_call = next(c for c in llm.calls if "终审人" in c.system)
    assert "〔2.1.1 进度安排〕" in claims_call.text and "200 日历天" in claims_call.text
    assert report.stats.issue_count == len(report.issues)
