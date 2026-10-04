"""基础设施的测试：项目存储、后台任务、假模型与 JSON 链路、错误分类。"""
from __future__ import annotations

import asyncio
import json

import httpx
import openai
import pytest
from pydantic import BaseModel

from app.core.fake_llm import FakeLLM, FakeReply, ScriptedResponder
from app.core.jobs import JobManager
from app.core.store import ProjectStore
from app.utils.errors import AppError, LLMError, classify_llm_error
from app.utils.openai_util import StreamInfo
from app.writing.models import Blueprint, ChapterRecord, ChapterVersion, Material, ReviewReport
from app.writing.outline_tree import collect_leaves, normalize_outline


# ---------------------------------------------------------------------------
# ProjectStore
# ---------------------------------------------------------------------------


@pytest.fixture()
def store(tmp_path):
    return ProjectStore(tmp_path / "projects")


def test_project_roundtrip_and_listing(store):
    assert store.list_projects() == []
    project = store.create_project("  智慧园区项目  ")
    assert project.name == "智慧园区项目"
    project.overview = "概述"
    project.outline = normalize_outline([{"title": "A", "children": [{"title": "A1"}, {"title": "A2"}]}])
    store.save_project(project)

    loaded = store.load_project(project.id)
    assert loaded.overview == "概述" and loaded.outline[0]["children"][1]["id"] == "1.2"

    leaves = collect_leaves(loaded.outline)
    store.save_chapter(project.id, ChapterRecord(uid=leaves[0].uid, status="done", content="正文", chars=2))
    summary = store.list_projects()[0]
    assert (summary.leaf_total, summary.leaf_done, summary.total_chars) == (2, 1, 2)
    assert summary.leaf_truncated == 0
    assert summary.has_blueprint is False

    # 结尾被截断的章节照样算写完（与正文页一致），但单独计数，项目卡片据此提醒
    store.save_chapter(
        project.id, ChapterRecord(uid=leaves[1].uid, status="done", content="正文正文", chars=4, truncated=True)
    )
    summary = store.list_projects()[0]
    assert (summary.leaf_done, summary.leaf_truncated) == (2, 1)

    store.save_blueprint(project.id, Blueprint())
    assert store.list_projects()[0].has_blueprint is True


def test_unknown_or_malicious_ids_are_rejected(store):
    for bad in ("", "nope", "../../x", "ABCDEF123456", "a" * 40):
        with pytest.raises(AppError) as info:
            store.load_project(bad)
        assert info.value.status_code == 404
    project = store.create_project("p")
    with pytest.raises(AppError):
        store.load_chapter(project.id, "../project")
    assert store.load_chapter(project.id, "abcd1234") is None


def test_tender_text_materials_review_and_delete(store):
    project = store.create_project("p")
    assert store.load_tender_text(project.id) == ""
    store.save_tender_text(project.id, "招标全文")
    assert store.load_tender_text(project.id) == "招标全文"

    store.save_material(project.id, Material(id="m0001", name="旧方案.docx", text="内容", char_count=2, uploaded_at="1"))
    assert [m.name for m in store.load_materials(project.id)] == ["旧方案.docx"]
    assert store.delete_material(project.id, "m0001") is True
    assert store.delete_material(project.id, "m0001") is False

    assert store.load_review(project.id) is None
    store.save_review(project.id, ReviewReport(generated_at="t"))
    assert store.load_review(project.id).generated_at == "t"

    store.delete_project(project.id)
    assert not store.project_exists(project.id)
    with pytest.raises(AppError):
        store.delete_project(project.id)


def test_corrupt_files_do_not_break_loading(store):
    project = store.create_project("p")
    chapters = store.project_dir(project.id) / "chapters"
    chapters.mkdir(parents=True)
    (chapters / "broken00.json").write_text("{not json", encoding="utf-8")
    store.save_chapter(project.id, ChapterRecord(uid="good0001", content="x", chars=1, status="done"))
    assert list(store.load_chapters(project.id)) == ["good0001"]

    (store.project_dir(project.id) / "blueprint.json").write_text("[]", encoding="utf-8")
    assert store.load_blueprint(project.id) is None

    (store.project_dir(project.id) / "project.json").write_text("garbage", encoding="utf-8")
    with pytest.raises(AppError) as info:
        store.load_project(project.id)
    assert info.value.status_code == 500
    assert store.list_projects() == []  # 损坏的项目被跳过而不是让列表整体失败


def test_chapter_versions_are_capped_and_no_temp_files_left(store):
    project = store.create_project("p")
    record = ChapterRecord(uid="chap0001", content="v", versions=[ChapterVersion(content=str(i)) for i in range(9)])
    store.save_chapter(project.id, record)
    assert len(store.load_chapter(project.id, "chap0001").versions) == 5
    leftovers = [p.name for p in store.project_dir(project.id).rglob("*.tmp")]
    assert leftovers == []


def test_archive_export_import_roundtrip(store):
    project = store.create_project("原项目")
    project.outline = normalize_outline([{"title": "A"}])
    store.save_project(project)
    uid = project.outline[0]["uid"]
    store.save_tender_text(project.id, "全文")
    store.save_chapter(project.id, ChapterRecord(uid=uid, content="正文", chars=2, status="done"))
    store.save_blueprint(project.id, Blueprint(generated_at="g"))

    archive = json.loads(json.dumps(store.export_archive(project.id)))
    copy = store.import_archive(archive)
    assert copy.id != project.id and copy.name == "原项目"
    assert store.load_tender_text(copy.id) == "全文"
    assert store.load_chapter(copy.id, uid).content == "正文"
    assert store.load_blueprint(copy.id).generated_at == "g"

    with pytest.raises(AppError):
        store.import_archive({"format": "other"})


# ---------------------------------------------------------------------------
# JobManager
# ---------------------------------------------------------------------------


async def _collect(manager, job_id, after=0):
    events = []
    async for seq, event in manager.subscribe(job_id, after_seq=after, heartbeat=0.05):
        if event is not None:
            events.append((seq, event))
    return events


async def test_job_runs_and_events_are_ordered(store):
    project = store.create_project("p")
    manager = JobManager(store)

    async def runner(ctx):
        ctx.stage("write", "写作中")
        ctx.set_total(2)
        ctx.emit("chapter_done", uid="a")
        ctx.advance(done=1, chars=10)
        await asyncio.sleep(0)
        ctx.advance(done=1, chars=5)

    job = manager.start(project.id, "write", {"x": 1}, runner)
    events = await _collect(manager, job.record.id)
    types = [e["type"] for _, e in events]
    assert types[0] == "job_start" and types[-1] == "job_end"
    assert [seq for seq, _ in events] == list(range(1, len(events) + 1))
    assert job.record.status == "done" and job.record.progress.done == 2 and job.record.progress.chars == 15
    assert manager.active_job(project.id) is None
    assert store.load_jobs(project.id)[0].status == "done"


async def test_only_one_active_job_per_project(store):
    project = store.create_project("p")
    manager = JobManager(store)
    gate = asyncio.Event()

    async def runner(ctx):
        await gate.wait()

    job = manager.start(project.id, "write", {}, runner)
    with pytest.raises(AppError) as info:
        manager.start(project.id, "plan", {}, runner)
    assert info.value.status_code == 409
    gate.set()
    await job.task
    manager.start(project.id, "plan", {}, runner)  # 结束后可以再启动


async def test_cancel_marks_job_cancelled_and_runs_cleanup(store):
    project = store.create_project("p")
    manager = JobManager(store)
    cleaned = []

    async def runner(ctx):
        ctx.live_update("u1", "写到一半")
        try:
            await asyncio.sleep(30)
        finally:
            cleaned.append(True)

    job = manager.start(project.id, "write", {}, runner)
    await asyncio.sleep(0.01)
    assert job.snapshot()["live"] == {"u1": "写到一半"}
    assert await manager.cancel(job.record.id) is True
    assert job.record.status == "cancelled" and cleaned == [True]
    assert job.snapshot()["live"] == {}
    assert await manager.cancel(job.record.id) is False


async def test_failed_job_reports_error(store):
    project = store.create_project("p")
    manager = JobManager(store)

    async def boom(ctx):
        raise AppError("请先配置OpenAI API密钥", status_code=400)

    async def crash(ctx):
        raise RuntimeError("意外")

    job = manager.start(project.id, "write", {}, boom)
    await job.task
    assert job.record.status == "failed" and "API" in job.record.error
    job2 = manager.start(project.id, "write", {}, crash)
    await job2.task
    assert job2.record.status == "failed" and "RuntimeError" in job2.record.error


async def test_subscribe_replays_after_seq_and_late_subscriber_gets_tail(store):
    project = store.create_project("p")
    manager = JobManager(store)
    gate = asyncio.Event()

    async def runner(ctx):
        for i in range(5):
            ctx.emit("tick", n=i)
        await gate.wait()
        ctx.emit("tick", n=99)

    job = manager.start(project.id, "write", {}, runner)
    await asyncio.sleep(0.01)
    task = asyncio.ensure_future(_collect(manager, job.record.id, after=3))
    await asyncio.sleep(0.01)
    gate.set()
    events = await task
    assert [seq for seq, _ in events][0] == 4
    assert events[-1][1]["type"] == "job_end"
    assert any(e.get("n") == 99 for _, e in events)

    # 任务结束后再来订阅：补发全部并正常结束
    late = await _collect(manager, job.record.id, after=0)
    assert late[0][1]["type"] == "job_start" and late[-1][1]["type"] == "job_end"
    assert await _collect(manager, "missing", after=0) == []


async def test_subscribe_asks_for_resync_when_backlog_is_gone(store, monkeypatch):
    import app.core.jobs as jobs_module

    monkeypatch.setattr(jobs_module, "EVENT_BUFFER", 10)
    project = store.create_project("p")
    manager = JobManager(store)

    async def runner(ctx):
        for i in range(50):
            ctx.emit("tick", n=i)

    job = manager.start(project.id, "write", {}, runner)
    await job.task
    events = await _collect(manager, job.record.id, after=5)
    assert events == [(5, {"type": "resync"})]
    tail = await _collect(manager, job.record.id, after=job.seq - 3)
    assert len(tail) == 3


async def test_heartbeat_is_emitted_while_idle(store):
    project = store.create_project("p")
    manager = JobManager(store)
    gate = asyncio.Event()

    async def runner(ctx):
        await gate.wait()

    job = manager.start(project.id, "write", {}, runner)
    beats = 0
    async for seq, event in manager.subscribe(job.record.id, heartbeat=0.01):
        if event is None:
            beats += 1
            if beats == 3:
                gate.set()
    assert beats >= 3


async def test_recover_marks_stale_jobs_interrupted(store):
    project = store.create_project("p")
    manager = JobManager(store)
    gate = asyncio.Event()

    async def runner(ctx):
        await gate.wait()

    job = manager.start(project.id, "write", {}, runner)
    await asyncio.sleep(0.01)
    # 模拟进程重启：新的管理器不认识这个任务
    fresh = JobManager(store)
    assert fresh.recover_interrupted() == 1
    assert store.load_jobs(project.id)[0].status == "interrupted"
    gate.set()
    await job.task


# ---------------------------------------------------------------------------
# FakeLLM 与 JSON 链路
# ---------------------------------------------------------------------------


class _Payload(BaseModel):
    items: list


async def test_fake_llm_streams_and_reports_finish_reason():
    llm = FakeLLM(lambda call: FakeReply(text="一二三四五六七", finish_reason="length"), chunk_size=3)
    info = StreamInfo()
    chunks = [c async for c in llm.stream_chat_completion([{"role": "user", "content": "x"}], info=info)]
    assert chunks == ["一二三", "四五六", "七"]
    assert info.finish_reason == "length" and info.chars == 7
    assert llm.calls[0].last_user == "x"


async def test_fake_llm_error_after_partial_output():
    llm = FakeLLM(lambda call: FakeReply(text="半截", error=LLMError("断了", kind="connection", retryable=True)))
    got = []
    with pytest.raises(LLMError):
        async for chunk in llm.stream_chat_completion([{"role": "user", "content": "x"}]):
            got.append(chunk)
    assert "".join(got) == "半截"


async def test_json_pipeline_repairs_fenced_and_invalid_output():
    responder = ScriptedResponder(
        rules=[
            ("JSON 修复助手", '{"items": [1, 2]}'),
            ("给我数据", "```json\n{\"items\": \"oops\"}\n```"),
        ]
    )
    llm = FakeLLM(responder)
    result = await llm.collect_json_response(
        [{"role": "user", "content": "给我数据"}], schema=_Payload, progress_label="测试"
    )
    assert result == {"items": [1, 2]}
    assert len(llm.calls) == 2  # 首次 + 一次修复


async def test_json_pipeline_gives_up_with_app_error():
    llm = FakeLLM(lambda call: "完全不是 JSON")
    with pytest.raises(AppError) as info:
        await llm.collect_json_response([{"role": "user", "content": "x"}], failure_message="格式无效")
    assert info.value.message == "格式无效"
    assert len(llm.calls) == 6  # 3 轮 ×（生成 + 修复）


def test_scripted_responder_sequences_same_keyword():
    responder = ScriptedResponder(rules=[("甲", "第一次"), ("甲", "第二次")], default="默认")
    llm = FakeLLM(responder)

    async def ask(text):
        return await llm.collect_chat_completion([{"role": "user", "content": text}])

    async def run():
        return [await ask("甲"), await ask("甲"), await ask("甲"), await ask("乙")]

    assert asyncio.run(run()) == ["第一次", "第二次", "第二次", "默认"]


# ---------------------------------------------------------------------------
# 错误分类
# ---------------------------------------------------------------------------


def _status_error(cls, status, message):
    request = httpx.Request("POST", "https://example.invalid/v1/chat/completions")
    response = httpx.Response(status, request=request)
    return cls(message, response=response, body=None)


@pytest.mark.parametrize(
    "exc, kind, retryable",
    [
        (_status_error(openai.AuthenticationError, 401, "invalid api key"), "auth", False),
        (_status_error(openai.RateLimitError, 429, "Too Many Requests"), "rate_limit", True),
        (_status_error(openai.RateLimitError, 429, "insufficient_quota: 余额不足"), "balance", False),
        (_status_error(openai.BadRequestError, 400, "This model's maximum context length is 65536 tokens"), "context_length", False),
        (_status_error(openai.BadRequestError, 400, "unknown model"), "bad_request", False),
        (_status_error(openai.InternalServerError, 503, "upstream unavailable"), "server", True),
        (openai.APITimeoutError(httpx.Request("POST", "https://example.invalid")), "timeout", True),
        (openai.APIConnectionError(request=httpx.Request("POST", "https://example.invalid")), "connection", True),
        (httpx.ReadError("connection reset"), "connection", True),
        (ValueError("奇怪的错误"), "unknown", False),
    ],
)
def test_classify_llm_error(exc, kind, retryable):
    error = classify_llm_error(exc)
    assert (error.kind, error.retryable) == (kind, retryable)
    assert error.message.startswith("模型调用失败: ")
    assert isinstance(error, AppError) and error.status_code == 502
    if kind != "unknown":
        assert error.hint and error.hint in error.friendly


def test_classify_keeps_existing_llm_error():
    original = LLMError("x", kind="empty")
    assert classify_llm_error(original) is original
