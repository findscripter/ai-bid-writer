"""长招标文件的分段解析，以及演示模式应答器的自检。"""
from __future__ import annotations

import json
from typing import List

import pytest

from app.core.demo_llm import create_demo_llm, demo_body, demo_responder
from app.core.fake_llm import FakeLLM
from app.core.jobs import JobManager
from app.core.llm import create_llm, demo_enabled
from app.core.store import ProjectStore
from app.models.schemas import OutlineMode
from app.services.outline_service import OutlineService
from app.utils.errors import LLMError
from app.writing.outline_tree import collect_leaves, normalize_outline
from app.writing.pipeline import run_deep_review_job, run_plan_job, run_write_job
from app.writing.requirements import parse_requirements
from app.writing.tender_analysis import NO_CONTENT, split_segments, stream_tender_analysis
from app.writing.textutil import count_chars


async def _collect(generator) -> str:
    return "".join([chunk async for chunk in generator])


# ---------------------------------------------------------------------------
# 分段解析
# ---------------------------------------------------------------------------


def test_split_segments_keeps_everything():
    text = "\n".join(f"第{i}行" + "内容" * 40 for i in range(200)) + "\n" + "超长行" * 5000
    segments = split_segments(text, 3000)
    assert all(len(s) <= 3000 for s in segments)
    assert "".join(segments).replace("\n", "") == text.replace("\n", "")
    assert split_segments("", 3000) == []


async def test_short_tender_is_analyzed_in_one_call():
    llm = FakeLLM(lambda call: "概述结果")
    progress: List[str] = []
    result = await _collect(stream_tender_analysis(llm, "招标文件正文", "overview", on_progress=progress.append, max_chars=1000))
    assert result == "概述结果" and len(llm.calls) == 1 and progress == []
    assert "招标文件正文" in llm.calls[0].text


async def test_long_tender_is_split_then_merged():
    text = "\n".join(f"第{i}条 技术要求内容" + "说明" * 30 for i in range(300))

    def responder(call):
        last = call.last_user
        if "合并成一份完整的结果" in last:
            return "合并后的结果"
        if "第 2/" in call.text:
            return NO_CONTENT
        return "【评审项ID】：E1\n【评审项名称】：某一段的提取"

    llm = FakeLLM(responder)
    progress: List[str] = []
    result = await _collect(
        stream_tender_analysis(llm, text, "requirements", on_progress=progress.append, max_chars=5000, segment_chars=6000)
    )
    segment_calls = [c for c in llm.calls if "分段阅读。以下是第" in c.text]
    merge_calls = [c for c in llm.calls if "合并成一份完整的结果" in c.last_user]
    assert result == "合并后的结果"
    assert len(segment_calls) == len(split_segments(text, 6000)) >= 3 and len(merge_calls) == 1
    assert NO_CONTENT not in merge_calls[0].text.split("各部分的提取结果如下")[1].split("请把以上")[0]
    assert progress[0].startswith("招标文件共") and progress[-1] == "正在合并各段的解析结果。"
    assert llm.max_active <= 2


async def test_context_length_error_falls_back_to_segments():
    text = "招标内容。" * 4000
    state = {"first": True}

    def responder(call):
        if state["first"]:
            state["first"] = False
            return LLMError("模型调用失败: maximum context length", kind="context_length")
        return "合并结果" if "合并成一份" in call.last_user else "分段结果"

    llm = FakeLLM(responder)
    progress: List[str] = []
    result = await _collect(stream_tender_analysis(llm, text, "overview", on_progress=progress.append, max_chars=10**6))
    assert result == "合并结果" and "改为分段解析" in progress[0]

    # 其他错误照常抛出
    failing = FakeLLM(lambda call: LLMError("模型调用失败: 401", kind="auth"))
    with pytest.raises(LLMError):
        await _collect(stream_tender_analysis(failing, "短文本", "overview"))


async def test_single_useful_segment_skips_merge():
    text = "\n".join("一行内容" * 20 for _ in range(100))
    calls = {"n": 0}

    def responder(call):
        calls["n"] += 1
        return "唯一有内容的一段" if calls["n"] == 1 else NO_CONTENT

    llm = FakeLLM(responder)
    result = await _collect(stream_tender_analysis(llm, text, "overview", max_chars=100, segment_chars=3000))
    assert result == "唯一有内容的一段"
    assert not any("合并成一份" in c.last_user for c in llm.calls)


async def test_truncated_segment_extraction_is_continued_and_reported():
    from app.core.fake_llm import FakeReply

    text = "\n".join(f"第{i}条 技术要求内容" + "说明" * 30 for i in range(300))
    continued = {"n": 0}

    def responder(call):
        if "合并成一份完整的结果" in call.last_user:
            return "合并后的结果"
        if "第 1/" in call.text:
            # 第 1 段第一次被输出上限截断，续写一次就写完
            if "中途断开了" in call.last_user:
                continued["n"] += 1
                return "（续写的后半部分）"
            return FakeReply(text="【评审项ID】：E1 前半部分", finish_reason="length")
        if "第 2/" in call.text:
            # 第 2 段怎么续写都写不完
            return FakeReply(text="一直写不完", finish_reason="length")
        return "【评审项ID】：E9\n【评审项名称】：其他段落"

    llm = FakeLLM(responder)
    progress: List[str] = []
    result = await _collect(
        stream_tender_analysis(llm, text, "requirements", on_progress=progress.append, max_chars=5000, segment_chars=6000)
    )
    assert result == "合并后的结果"
    assert continued["n"] == 1
    merge = [c for c in llm.calls if "合并成一份完整的结果" in c.last_user][0]
    assert "前半部分（续写的后半部分）" in merge.text
    second = [c for c in llm.calls if "第 2/" in c.text and "合并成一份完整的结果" not in c.last_user]
    assert len(second) == 4  # 首次 + 最多续写 3 次
    assert any("第 2 段的提取结果太长" in message for message in progress)
    assert not any("第 1 段" in message and "太长" in message for message in progress)


# ---------------------------------------------------------------------------
# 演示模式
# ---------------------------------------------------------------------------


def test_demo_switch(monkeypatch):
    monkeypatch.delenv("AI_BID_DEMO", raising=False)
    assert demo_enabled() is False
    monkeypatch.setenv("AI_BID_DEMO", "1")
    assert demo_enabled() is True
    llm = create_llm("my-model")
    assert isinstance(llm, FakeLLM) and llm.model_name == "my-model"


def test_demo_body_is_deterministic_and_sized():
    first = demo_body("总体架构设计", 800)
    assert first == demo_body("总体架构设计", 800)
    assert 800 <= count_chars(first) <= 900
    assert "【待补充：" in demo_body("x", 300, with_placeholder=True)
    assert "| 阶段 |" in demo_body("x", 600, with_table=True)


@pytest.mark.parametrize("mode", [OutlineMode.FREE, OutlineMode.ALIGNED])
async def test_demo_responder_supports_the_whole_flow(tmp_path, monkeypatch, mode):
    monkeypatch.setenv("AI_BID_DEMO_DELAY", "0")
    llm = create_demo_llm()
    store = ProjectStore(tmp_path / "projects")
    project = store.create_project("演示")

    overview = await _collect(stream_tender_analysis(llm, "招标文件", "overview"))
    requirements = await _collect(stream_tender_analysis(llm, "招标文件", "requirements"))
    assert "项目名称" in overview
    assert [item.id for item in parse_requirements(requirements)] == ["E1", "E2", "E3", "R1", "R2"]

    outline = await OutlineService(ai=llm).generate_outline(overview=overview, requirements=requirements, mode=mode)
    project.overview, project.requirements = overview, requirements
    project.outline = normalize_outline(outline["outline"])
    project.settings.target_pages = 12
    store.save_project(project)
    leaves = collect_leaves(project.outline)
    assert len(leaves) >= 8

    manager = JobManager(store)
    factory = lambda model: llm
    for kind, runner in (("plan", run_plan_job), ("write", run_write_job), ("review", run_deep_review_job)):
        job = manager.start(project.id, kind, {}, lambda ctx, runner=runner: runner(ctx, store, factory))
        await job.task
        assert job.record.status == "done", (kind, job.record.error)

    blueprint = store.load_blueprint(project.id)
    # 规划的每一步都成功了（“某条要求找不到章节承接”是如实的提示，不算失败）
    assert not any("没有生成成功" in warning for warning in blueprint.warnings)
    assert len(blueprint.plans) == len(leaves)
    chapters = store.load_chapters(project.id)
    assert all(chapters[leaf.uid].status == "done" for leaf in leaves)
    report = store.load_review(project.id)
    assert report.stats.done == len(leaves) and report.deep is True
    # 演示文本里故意带了待补充占位，审校应当把它们列出来
    assert report.stats.placeholder_count > 0


def test_demo_responder_unknown_prompt_is_harmless():
    from app.core.fake_llm import FakeCall

    assert demo_responder(FakeCall(index=0, messages=[{"role": "user", "content": "随便问点什么"}])) == "{}"
    assert json.loads(demo_responder(FakeCall(index=0, messages=[{"role": "system", "content": "你是一个严格的 JSON 修复助手"}]))) == {}


async def test_segment_progress_is_streamed_before_the_result():
    """分段解析时，进度要随着各段完成陆续送出，而不是等到合并结果出来才一起出现。"""
    from app.writing.tender_analysis import stream_tender_analysis_events

    text = "\n".join("技术要求内容" * 20 for _ in range(120))
    llm = FakeLLM(lambda call: "合并结果" if "合并成一份" in call.last_user else "某段的提取结果", delay=0.005)
    kinds = [kind async for kind, _ in stream_tender_analysis_events(llm, text, "requirements", max_chars=100, segment_chars=3000)]
    first_chunk = kinds.index("chunk")
    assert kinds[:first_chunk].count("progress") >= 4  # 开始 + 每段一条 + 合并
    assert set(kinds[first_chunk:]) == {"chunk"}


async def test_truncation_notices_are_sent_as_warnings():
    from app.core.fake_llm import FakeReply
    from app.writing.tender_analysis import stream_tender_analysis_events

    llm = FakeLLM(lambda call: FakeReply(text="写不完的解析结果", finish_reason="length"))
    events = [(kind, value) async for kind, value in stream_tender_analysis_events(llm, "短文本", "overview")]
    warnings = [value for kind, value in events if kind == "warning"]
    # 第一次被截断时说明已经接着续写；续写几轮仍然没写完时再提醒一次。两条都要让页面在解析结束后仍然看得到
    assert any("接着续写" in warning for warning in warnings)
    assert any("仍然没有写完" in warning for warning in warnings)
    assert not any(kind == "progress" and "续写" in value for kind, value in events)
