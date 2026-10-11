"""第三轮回归审查发现的问题：后端部分的回归测试。

- 只改了状态、没改正文的保存不刷新 updated_at（否则正在编辑这一章的页面会误以为有了新内容）；
- 服务关闭时取消的任务记成“中断”，与使用者自己停下的“已取消”区分开；
- 深度审校分批时，任务结果里分别记总批数与没完成的批数；
- 本地审校的 generated_at 取开始检查的时刻；
- 整份项目状态带快照时刻 state_at，同一进程内严格递增；
- 只改“补充要求”的写作计划保存，不会用页面上的旧计划覆盖别处的修改；
- 解析招标文件期间占住项目；服务关闭时流式请求尽快收尾；
- 审校接口返回结果与当前目录是否对不上（outline_changed）。
"""
from __future__ import annotations

import asyncio

import app.core.jobs as jobs_module
from app.core.fake_llm import FakeLLM
from app.core.store import ProjectStore
from app.utils.errors import LLMError
from app.writing import reviewer as reviewer_module
from app.writing import review_checks
from app.writing.models import ChapterRecord
from app.writing.pipeline import run_deep_review_job, run_revise_job, run_write_job
from app.writing.reviewer import build_local_report
from app.writing.textutil import now_iso

from .helpers import WritingResponder, leaf_ids, make_project
from .test_api import _docx_bytes, _prepare_project, _sse_events
from .test_concurrency_rules import api  # noqa: F401 - pytest 夹具

ORIGINAL = "原来的正文，写得很完整。" * 20


async def _run(manager, project_id, kind, params, runner):
    job = manager.start(project_id, kind, params, runner)
    await job.task
    return job


# ---------------------------------------------------------------------------
# 只改状态的保存
# ---------------------------------------------------------------------------


async def test_failed_rewrite_and_revise_keep_updated_at_when_content_is_unchanged(tmp_path):
    store = ProjectStore(tmp_path / "projects")
    project = make_project(store)
    manager = jobs_module.JobManager(store)
    uid = leaf_ids(project)["1.1.1"]
    store.save_chapter(project.id, ChapterRecord(uid=uid, status="done", content=ORIGINAL, chars=len(ORIGINAL)))
    before = store.load_chapter(project.id, uid).updated_at

    failing = FakeLLM(
        WritingResponder(
            {
                "chapter": LLMError("模型调用失败: 400", kind="bad_request"),
                "revise": LLMError("模型调用失败: 400", kind="bad_request"),
            }
        )
    )
    job = await _run(manager, project.id, "write", {"uids": [uid]}, lambda ctx: run_write_job(ctx, store, lambda m: failing))
    assert job.record.progress.failed == 1
    after = store.load_chapter(project.id, uid)
    assert after.content == ORIGINAL and "已保留原来的正文" in (after.error or "")
    assert after.updated_at == before
    # 失败的类型是结构化字段，页面不必按提示文字区分“重新生成失败”和“修订失败”
    assert after.error_kind == "rewrite"

    job = await _run(
        manager,
        project.id,
        "revise",
        {"uid": uid, "instruction": "补充验收方式"},
        lambda ctx: run_revise_job(ctx, store, lambda m: failing),
    )
    assert job.record.status == "failed"
    after = store.load_chapter(project.id, uid)
    assert after.content == ORIGINAL and "修订没有成功" in (after.error or "")
    assert after.updated_at == before
    assert after.error_kind == "revise"

    # 首次撰写失败记为 write；重新写成功后清掉
    other = leaf_ids(project)["1.1.2"]
    await _run(manager, project.id, "write", {"uids": [other]}, lambda ctx: run_write_job(ctx, store, lambda m: failing))
    assert store.load_chapter(project.id, other).error_kind == "write"
    working = FakeLLM(WritingResponder())
    await _run(manager, project.id, "write", {"uids": [uid, other]}, lambda ctx: run_write_job(ctx, store, lambda m: working))
    assert store.load_chapter(project.id, uid).error_kind is None
    assert store.load_chapter(project.id, other).error_kind is None


# ---------------------------------------------------------------------------
# 服务关闭时的任务状态
# ---------------------------------------------------------------------------


async def test_shutdown_marks_running_jobs_interrupted_but_user_stop_stays_cancelled(tmp_path):
    store = ProjectStore(tmp_path / "projects")
    project = make_project(store)

    manager = jobs_module.JobManager(store)
    slow = FakeLLM(WritingResponder(), delay=0.05)
    job = manager.start(project.id, "write", {}, lambda ctx: run_write_job(ctx, store, lambda m: slow))
    await asyncio.sleep(0.2)
    await manager.shutdown()
    assert manager.closing is True
    assert job.record.status == "interrupted" and job.record.error == jobs_module.INTERRUPTED_MESSAGE
    saved = next(r for r in store.load_jobs(project.id, limit=10) if r.id == job.record.id)
    assert saved.status == "interrupted"
    assert job.events[-1][1]["type"] == "job_end" and job.events[-1][1]["job"]["status"] == "interrupted"

    other = jobs_module.JobManager(store)
    job = other.start(project.id, "write", {"mode": "all"}, lambda ctx: run_write_job(ctx, store, lambda m: slow))
    await asyncio.sleep(0.2)
    await other.cancel(job.record.id)
    assert job.record.status == "cancelled" and job.record.error is None


# ---------------------------------------------------------------------------
# 深度审校的批次
# ---------------------------------------------------------------------------


async def test_deep_review_result_counts_failed_batches(tmp_path, monkeypatch):
    store = ProjectStore(tmp_path / "projects")
    project = make_project(store)
    manager = jobs_module.JobManager(store)
    numeric = FakeLLM(WritingResponder({"chapter": lambda call, default: "工期为 180 日历天，响应时间不超过 3 秒。" + default}))
    await _run(manager, project.id, "write", {}, lambda ctx: run_write_job(ctx, store, lambda m: numeric))
    # 每章的表述各成一批
    monkeypatch.setattr(reviewer_module, "CLAIMS_BATCH_CHARS", 10)

    job = await _run(manager, project.id, "review", {}, lambda ctx: run_deep_review_job(ctx, store, lambda m: numeric))
    result = job.record.result
    assert result["deep"] is True and result["batches"] > 1 and result["failed_batches"] == 0
    # 分批本身会附一条说明，但没有批次失败
    assert any("分" in w and "批进行" in w for w in store.load_review(project.id).warnings)

    # 只让 1.1.1 所在的那一批失败（各章表述块以“〔编号 标题〕”开头）
    flaky = FakeLLM(
        WritingResponder(
            {
                "consistency": lambda call, default: (
                    LLMError("模型调用失败: 400", kind="bad_request") if "〔1.1.1 " in call.text else default
                )
            }
        )
    )
    job = await _run(manager, project.id, "review", {}, lambda ctx: run_deep_review_job(ctx, store, lambda m: flaky))
    result = job.record.result
    assert result["deep"] is True and result["failed_batches"] == 1 and result["batches"] > 1


# ---------------------------------------------------------------------------
# 本地审校的时间
# ---------------------------------------------------------------------------


def test_local_review_generated_at_is_taken_before_reading(tmp_path, monkeypatch):
    store = ProjectStore(tmp_path / "projects")
    project = make_project(store)
    seen = {}
    original = review_checks.run_local_review

    def wrapped(*args, **kwargs):
        seen["inside"] = now_iso()
        return original(*args, **kwargs)

    monkeypatch.setattr(review_checks, "run_local_review", wrapped)
    report = build_local_report(store, project.id)
    assert report.generated_at < seen["inside"]


# ---------------------------------------------------------------------------
# 接口层
# ---------------------------------------------------------------------------


def test_project_state_carries_an_increasing_snapshot_time(api):
    pid = api.post("/api/projects", json={"name": "快照时刻"}).json()["project"]["id"]
    first = api.get(f"/api/projects/{pid}").json()["state_at"]
    patched = api.patch(f"/api/projects/{pid}", json={"name": "快照时刻二"}).json()["state_at"]
    second = api.get(f"/api/projects/{pid}").json()["state_at"]
    assert first < patched < second


def test_saving_a_note_does_not_overwrite_the_rest_of_the_plan(api):
    state = _prepare_project(api)
    pid = state["project"]["id"]
    uid, other = state["leaves"][0]["uid"], state["leaves"][1]["uid"]
    plan = {"uid": uid, "key_points": ["要点甲"], "weight": 1.0, "note": ""}
    api.put(f"/api/projects/{pid}/blueprint", json={"plans": {uid: plan}})
    # 另一个标签页改了要点与权重
    api.put(f"/api/projects/{pid}/blueprint", json={"plans": {uid: {**plan, "key_points": ["要点乙"], "weight": 2.0}}})

    # 本页只保存补充要求
    state = api.put(f"/api/projects/{pid}/blueprint", json={"notes": {uid: "  重点写与现有系统的对接方式  "}}).json()
    saved = state["blueprint"]["plans"][uid]
    assert saved["key_points"] == ["要点乙"] and saved["weight"] == 2.0
    assert saved["note"] == "重点写与现有系统的对接方式"

    refused = api.put(f"/api/projects/{pid}/blueprint", json={"notes": {other: "这一章还没有计划"}})
    assert refused.status_code == 400 and "还没有写作计划" in refused.json()["detail"]


def test_analysis_holds_the_project_while_streaming(api, monkeypatch):
    state = _prepare_project(api)
    pid = state["project"]["id"]
    seen = []
    original = api.llm.responder

    def responder(call):
        if "招标文件分析助手" in call.system:
            seen.append(api.manager.busy_reason(pid))
        return original(call)

    api.llm.responder = responder
    response = api.post(f"/api/projects/{pid}/analyze", json={"analysis_type": "overview"})
    assert _sse_events(response)[-1]["type"] == "result"
    assert seen and all(reason == "正在解析招标文件" for reason in seen)
    assert api.manager.busy_reason(pid) is None

    class _Running:
        live = {}

    monkeypatch.setattr(api.manager, "active_job", lambda project_id: _Running())
    refused = api.post(f"/api/projects/{pid}/analyze", json={"analysis_type": "overview"})
    assert refused.status_code == 409 and "有任务正在运行" in refused.json()["detail"]


def test_streams_stop_early_when_the_server_is_closing(api):
    state = _prepare_project(api)
    pid = state["project"]["id"]
    overview = state["project"]["overview"]
    outline = state["project"]["outline"]
    api.manager.closing = True
    try:
        events = _sse_events(api.post(f"/api/projects/{pid}/analyze", json={"analysis_type": "overview"}))
        assert any(e.get("error") and "服务正在关闭" in e.get("message", "") for e in events)
        assert not any(e.get("type") == "result" for e in events)

        api.llm.delay = 0.2  # 目录生成慢一点，好让等待进度时看到“正在关闭”
        events = _sse_events(api.post(f"/api/projects/{pid}/outline/generate", json={"mode": "free"}))
        assert any(e.get("error") and "服务正在关闭" in e.get("message", "") for e in events)
    finally:
        api.manager.closing = False
        api.llm.delay = 0.0
    after = api.get(f"/api/projects/{pid}").json()["project"]
    assert after["overview"] == overview and after["outline"] == outline
    assert api.manager.busy_reason(pid) is None


def test_review_endpoints_report_whether_the_outline_changed(api):
    state = _prepare_project(api)
    pid = state["project"]["id"]
    assert api.post(f"/api/projects/{pid}/review/run").json()["outline_changed"] is False

    outline = state["project"]["outline"] + [{"title": "新增的一章", "children": [{"title": "新增的小节"}]}]
    api.put(f"/api/projects/{pid}/outline", json={"outline": outline})
    dismissed = api.post(f"/api/projects/{pid}/review/dismiss", json={"issue_id": "不存在的问题", "dismissed": True}).json()
    assert dismissed["outline_changed"] is True
    assert api.get(f"/api/projects/{pid}").json()["review_outline_changed"] is True

    rerun = api.post(f"/api/projects/{pid}/review/run").json()
    assert rerun["outline_changed"] is False
    assert api.get(f"/api/projects/{pid}").json()["review_outline_changed"] is False


# ---------------------------------------------------------------------------
# 结构化的错误码与时间（代替按提示文字判断）
# ---------------------------------------------------------------------------


def test_busy_project_responses_carry_an_error_code(api, monkeypatch):
    state = _prepare_project(api)
    pid = state["project"]["id"]
    api.manager.reserve(pid, "生成目录")
    try:
        started = api.post(f"/api/projects/{pid}/jobs", json={"kind": "write", "params": {}})
        assert started.status_code == 409 and started.headers.get("x-error-code") == "project_busy"
        analyzed = api.post(f"/api/projects/{pid}/analyze", json={"analysis_type": "overview"})
        assert analyzed.status_code == 409 and analyzed.headers.get("x-error-code") == "project_busy"
        outline = api.put(f"/api/projects/{pid}/outline", json={"outline": state["project"]["outline"]})
        assert outline.status_code == 409 and outline.headers.get("x-error-code") == "project_busy"
        # 被占着时也不能换招标文件：正在用它的解析或任务会和新文件对不上
        files = {"file": ("新的招标文件.docx", _docx_bytes(["新的招标文件正文。"] * 5), "application/octet-stream")}
        replaced = api.post(f"/api/projects/{pid}/tender", files=files)
        assert replaced.status_code == 409 and replaced.headers.get("x-error-code") == "project_busy"
        assert api.get(f"/api/projects/{pid}").json()["project"]["tender"]["filename"] == state["project"]["tender"]["filename"]
    finally:
        api.manager.release(pid)

    # 入口检查之后才被占住：流里的错误事件同样带错误码
    from app.utils.errors import AppError

    def reserve(project_id, label):
        raise AppError("正在生成目录，请等它结束后再试", status_code=409, code="project_busy")

    monkeypatch.setattr(api.manager, "reserve", reserve)
    events = _sse_events(api.post(f"/api/projects/{pid}/analyze", json={"analysis_type": "overview"}))
    errors = [event for event in events if event.get("error")]
    assert errors and errors[0].get("code") == "project_busy"


def test_review_payload_carries_a_snapshot_time(api):
    state = _prepare_project(api)
    pid = state["project"]["id"]
    before = api.get(f"/api/projects/{pid}").json()["state_at"]
    report = api.post(f"/api/projects/{pid}/review/run").json()
    assert report["state_at"] > before
    dismissed = api.post(f"/api/projects/{pid}/review/dismiss", json={"issue_id": "x", "dismissed": True}).json()
    assert dismissed["state_at"] > report["state_at"]


def test_import_shifts_future_timestamps_back_keeping_their_order(tmp_path):
    from app.writing.models import Blueprint, ChapterVersion, Material

    store = ProjectStore(tmp_path / "projects")
    project = make_project(store)
    uid = leaf_ids(project)["1.1.1"]
    # 原机器的时钟快了很多：审校在 0 点，之后 1 点又改过这一章，历史版本是前一天存的
    store.save_chapter(
        project.id,
        ChapterRecord(
            uid=uid,
            status="done",
            content="正文",
            chars=2,
            updated_at="2999-01-01T01:00:00.000+00:00",
            versions=[ChapterVersion(content="旧稿", saved_at="2998-12-31T23:00:00.000+00:00", source="ai")],
        ),
        touch=False,
    )
    report = build_local_report(store, project.id)
    report.generated_at = "2999-01-01T00:00:00.000+00:00"
    store.save_review(project.id, report)
    store.save_blueprint(project.id, Blueprint(generated_at="2999-01-01T00:00:00.000+00:00"))
    loaded = store.load_project(project.id)
    loaded.tender.uploaded_at = "2998-12-31T20:00:00.000+00:00"
    store.save_project(loaded)
    store.save_material(project.id, Material(id="a1b2c3d4e5f6", name="参考资料", text="内容", uploaded_at="2998-12-31T21:00:00.000+00:00"))

    imported = store.import_archive(store.export_archive(project.id))
    later = now_iso()
    record = store.load_chapter(imported.id, uid)
    review = store.load_review(imported.id)
    blueprint = store.load_blueprint(imported.id)
    material = store.load_material(imported.id, "a1b2c3d4e5f6")
    stamps = [
        record.updated_at,
        record.versions[0].saved_at,
        review.generated_at,
        blueprint.generated_at,
        imported.tender.uploaded_at,
        material.uploaded_at,
    ]
    assert all(stamp <= later for stamp in stamps)
    # 整体平移：最晚的那个落到导入时刻，先后与间隔都不变（审校之后又改过的章节仍然算“检查之后改过”）
    from datetime import datetime

    parse = datetime.fromisoformat
    assert (parse(record.updated_at) - parse(review.generated_at)).total_seconds() == 3600
    assert (parse(review.generated_at) - parse(record.versions[0].saved_at)).total_seconds() == 3600
    assert (parse(review.generated_at) - parse(imported.tender.uploaded_at)).total_seconds() == 4 * 3600
    assert review.generated_at == blueprint.generated_at
    assert material.uploaded_at < review.generated_at


def test_import_keeps_timestamps_that_are_not_in_the_future(tmp_path):
    store = ProjectStore(tmp_path / "projects")
    project = make_project(store)
    uid = leaf_ids(project)["1.1.1"]
    store.save_chapter(project.id, ChapterRecord(uid=uid, status="done", content="正文", chars=2))
    before = store.load_chapter(project.id, uid).updated_at
    imported = store.import_archive(store.export_archive(project.id))
    assert store.load_chapter(imported.id, uid).updated_at == before


def test_analysis_warnings_reach_the_page(api):
    from app.core.fake_llm import FakeReply

    state = _prepare_project(api)
    pid = state["project"]["id"]
    original = api.llm.responder

    def responder(call):
        if "招标文件分析助手" in call.system:
            return FakeReply(text="项目概述：一直写不完的结果。", finish_reason="length")
        return original(call)

    api.llm.responder = responder
    events = _sse_events(api.post(f"/api/projects/{pid}/analyze", json={"analysis_type": "overview"}))
    warnings = [event for event in events if event.get("type") == "warning"]
    assert warnings and "仍然没有写完" in warnings[-1]["message"]
    # 结果照常保存，提示单独给出
    assert events[-1]["type"] == "result"
