"""对抗式审查发现的问题的回归测试：并发修改、互斥、过时判断、取消后的数据保留。"""
from __future__ import annotations

import asyncio
import io
import json
import threading
import time
from typing import Any, Dict, List

import docx
import pytest
from fastapi.testclient import TestClient

import app.core.jobs as jobs_module
import app.routers.projects as projects_router
from app.core.fake_llm import FakeLLM
from app.core.store import ProjectStore
from app.writing import writer as writer_module
from app.writing.models import ChapterRecord, ReviewReport
from app.writing.pipeline import run_deep_review_job, run_revise_job, run_write_job

from .helpers import OUTLINE, REQUIREMENTS_TEXT, WritingResponder, leaf_ids, make_project
from .test_api import _AnalysisResponder, _prepare_project, _wait_job


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("AI_BID_HOME", str(tmp_path / "home"))
    monkeypatch.setattr(writer_module, "RETRY_DELAYS", (0.0, 0.0, 0.0))
    store = ProjectStore(tmp_path / "home" / "projects")
    manager = jobs_module.JobManager(store)
    llm = FakeLLM(_AnalysisResponder())
    monkeypatch.setattr(projects_router, "store", store)
    monkeypatch.setattr(projects_router, "job_manager", manager)
    monkeypatch.setattr(projects_router, "create_llm", lambda model=None: llm)

    from app.main import app

    with TestClient(app) as client:
        client.llm = llm  # type: ignore[attr-defined]
        client.store = store  # type: ignore[attr-defined]
        client.manager = manager  # type: ignore[attr-defined]
        yield client


# ---------------------------------------------------------------------------
# 章节：编辑冲突与历史版本
# ---------------------------------------------------------------------------


def test_chapter_save_detects_concurrent_update(api):
    state = _prepare_project(api)
    pid = state["project"]["id"]
    uid = state["leaves"][0]["uid"]
    first = api.put(f"/api/projects/{pid}/chapters/{uid}", json={"content": "第一版。"}).json()
    base = first["updated_at"]

    # 期间被别处改过（例如重写或修订）。紧接着发生，与上一次在同一秒、甚至同一毫秒内也要认得出来
    api.put(f"/api/projects/{pid}/chapters/{uid}", json={"content": "别处写的新版。"})
    stale = api.put(f"/api/projects/{pid}/chapters/{uid}", json={"content": "我的编辑。", "base_updated_at": base})
    assert stale.status_code == 409 and "编辑期间被更新过" in stale.json()["detail"]
    # 前端靠固定的错误码区分“被更新过”与“正在生成”，不靠文案
    assert stale.headers.get("x-error-code") == "chapter_changed"
    assert api.get(f"/api/projects/{pid}/chapters/{uid}").json()["content"] == "别处写的新版。"

    current = api.get(f"/api/projects/{pid}/chapters/{uid}").json()["updated_at"]
    ok = api.put(f"/api/projects/{pid}/chapters/{uid}", json={"content": "我的编辑。", "base_updated_at": current})
    assert ok.status_code == 200
    # 不带 base 时照常覆盖（“仍然保存”）
    assert api.put(f"/api/projects/{pid}/chapters/{uid}", json={"content": "强制保存。"}).status_code == 200


def test_restore_checks_the_version_identity(api):
    state = _prepare_project(api)
    pid = state["project"]["id"]
    uid = state["leaves"][0]["uid"]
    # 连续保存（同一秒内），每个历史版本的保存时间也各不相同
    for text in ("版本一。", "版本二。", "版本三。"):
        api.put(f"/api/projects/{pid}/chapters/{uid}", json={"content": text})
    detail = api.get(f"/api/projects/{pid}/chapters/{uid}").json()
    versions = detail["versions"]
    assert [v["content"] for v in versions] == ["版本二。", "版本一。"]
    assert versions[0]["saved_at"] != versions[1]["saved_at"]

    wrong = api.post(f"/api/projects/{pid}/chapters/{uid}/restore", json={"index": 0, "saved_at": versions[1]["saved_at"]})
    assert wrong.status_code == 409 and wrong.headers.get("x-error-code") == "versions_changed"
    right = api.post(f"/api/projects/{pid}/chapters/{uid}/restore", json={"index": 1, "saved_at": versions[1]["saved_at"]})
    assert right.status_code == 200 and right.json()["content"] == "版本一。"


def test_chapter_being_written_is_refused_with_error_code(api, monkeypatch):
    state = _prepare_project(api)
    pid = state["project"]["id"]
    uid = state["leaves"][0]["uid"]
    api.put(f"/api/projects/{pid}/chapters/{uid}", json={"content": "版本一。"})
    api.put(f"/api/projects/{pid}/chapters/{uid}", json={"content": "版本二。"})

    class _Writing:
        live = {uid: "正在写的内容"}

    monkeypatch.setattr(api.manager, "active_job", lambda project_id: _Writing())
    saved = api.put(f"/api/projects/{pid}/chapters/{uid}", json={"content": "我的编辑。"})
    assert saved.status_code == 409 and saved.headers.get("x-error-code") == "chapter_busy"
    restored = api.post(f"/api/projects/{pid}/chapters/{uid}/restore", json={"index": 0})
    assert restored.status_code == 409 and restored.headers.get("x-error-code") == "chapter_busy"


# ---------------------------------------------------------------------------
# 互斥
# ---------------------------------------------------------------------------


def test_blueprint_edits_are_refused_while_planning(api):
    state = _prepare_project(api)
    pid = state["project"]["id"]
    api.llm.delay = 0.05
    snapshot = api.post(f"/api/projects/{pid}/jobs", json={"kind": "plan"}).json()
    put = api.put(f"/api/projects/{pid}/blueprint", json={"fact_sheet": {"project_name": "x"}})
    assert put.status_code == 409 and "写作计划正在生成" in put.json()["detail"]
    assert api.delete(f"/api/projects/{pid}/blueprint").status_code == 409
    api.llm.delay = 0
    _wait_job(api, pid, snapshot["job"]["id"])
    assert api.put(f"/api/projects/{pid}/blueprint", json={"fact_sheet": {"project_name": "x"}}).status_code == 200


def test_outline_generation_reserves_the_project(api):
    from app.utils.errors import AppError

    state = _prepare_project(api)
    pid = state["project"]["id"]
    seen: Dict[str, Any] = {}
    original = api.llm.responder

    def observing(call):
        # 生成目录进行到一半（这里运行在服务端的事件循环里，直接检查任务管理器）
        if "标书编写专家" in call.system and "busy" not in seen:
            seen["busy"] = api.manager.busy_reason(pid)
            try:
                api.manager.start(pid, "write", {}, lambda ctx: asyncio.sleep(0))
                seen["start"] = "allowed"
            except AppError as exc:
                seen["start"] = exc.status_code
            try:
                api.manager.reserve(pid, "生成目录")
                seen["reserve"] = "allowed"
            except AppError as exc:
                seen["reserve"] = exc.status_code
        return original(call)

    api.llm.responder = observing
    response = api.post(f"/api/projects/{pid}/outline/generate", json={"mode": "free"})
    assert '"type": "result"' in response.text
    assert seen == {"busy": "正在生成目录", "start": 409, "reserve": 409}
    # 结束后占用解除：可以改目录、可以启动任务
    assert api.manager.busy_reason(pid) is None
    outline = api.get(f"/api/projects/{pid}").json()["project"]["outline"]
    assert api.put(f"/api/projects/{pid}/outline", json={"outline": outline}).status_code == 200
    snapshot = api.post(f"/api/projects/{pid}/jobs", json={"kind": "write"}).json()
    _wait_job(api, pid, snapshot["job"]["id"])


def test_outline_routes_refuse_while_reserved(api):
    state = _prepare_project(api)
    pid = state["project"]["id"]
    api.manager.reserve(pid, "生成目录")
    try:
        outline = state["project"]["outline"]
        for response in (
            api.put(f"/api/projects/{pid}/outline", json={"outline": outline}),
            api.post(f"/api/projects/{pid}/outline/response-chapters"),
            api.post(f"/api/projects/{pid}/outline/generate", json={"mode": "free"}),
            api.post(f"/api/projects/{pid}/jobs", json={"kind": "write"}),
        ):
            assert response.status_code == 409 and "正在生成目录" in response.json()["detail"]
    finally:
        api.manager.release(pid)


def test_write_job_snapshot_reports_queued_chapters(api):
    state = _prepare_project(api)
    pid = state["project"]["id"]
    api.patch(f"/api/projects/{pid}", json={"settings": {**state["project"]["settings"], "concurrency": 1}})
    api.llm.delay = 0.03
    snapshot = api.post(f"/api/projects/{pid}/jobs", json={"kind": "write"}).json()
    seen_queued = []
    for _ in range(100):
        current = api.get(f"/api/projects/{pid}/jobs/current").json()["job"]
        if current["live"] and current["queued"]:
            seen_queued = current["queued"]
            assert not set(current["queued"]) & set(current["live"])
            break
        time.sleep(0.05)
    assert seen_queued, "撰写进行中时快照里应该能看到排队的章节"
    api.llm.delay = 0
    _wait_job(api, pid, snapshot["job"]["id"])
    assert api.get(f"/api/projects/{pid}/jobs/current").json()["job"]["queued"] == []


# ---------------------------------------------------------------------------
# 并发修改不被覆盖
# ---------------------------------------------------------------------------


def test_tender_upload_keeps_changes_made_while_parsing(api, monkeypatch):
    from app.services.file_service import ExtractedDocument, FileService

    state = api.post("/api/projects", json={"name": "原名"}).json()
    pid = state["project"]["id"]

    async def slow_extract(file):
        # 解析期间，使用者在另一处保存了企业资料
        project = api.store.load_project(pid)
        project.company_profile = "解析期间保存的企业资料"
        api.store.save_project(project)
        return ExtractedDocument(filename="招标文件.docx", text="招标正文 内容", char_count=7, warnings=[])

    monkeypatch.setattr(FileService, "extract_document", staticmethod(slow_extract))
    state = api.post(f"/api/projects/{pid}/tender", files={"file": ("招标文件.docx", b"PK", "application/octet-stream")}).json()
    assert state["project"]["company_profile"] == "解析期间保存的企业资料"
    assert state["project"]["tender"]["char_count"] == 6  # 不计空白

    async def deleted_meanwhile(file):
        api.store.delete_project(pid)
        return ExtractedDocument(filename="x.docx", text="正文", char_count=2, warnings=[])

    monkeypatch.setattr(FileService, "extract_document", staticmethod(deleted_meanwhile))
    response = api.post(f"/api/projects/{pid}/tender", files={"file": ("x.docx", b"PK", "application/octet-stream")})
    assert response.status_code == 404
    assert not api.store.project_exists(pid)  # 删掉的项目不会“复活”


# ---------------------------------------------------------------------------
# 畸形归档
# ---------------------------------------------------------------------------


def test_malformed_archive_is_normalized_and_cannot_break_the_list(api):
    state = _prepare_project(api)
    archive = api.get(f"/api/projects/{state['project']['id']}/archive").json()
    archive["project"]["outline"] = [
        {"title": "正常章节", "children": [{"title": "子章节"}]},
        {"title": "children 不是列表", "children": 5},
        {"title": "children 是字符串", "children": "abc"},
        {"title": "带非法 uid", "uid": "../../x", "children": [{"title": "叶子"}, "不是对象"]},
    ]
    imported = api.post("/api/projects/import", json=archive)
    assert imported.status_code == 200
    leaves = imported.json()["leaves"]
    assert [leaf["title"] for leaf in leaves] == ["子章节", "children 不是列表", "children 是字符串", "叶子"]
    assert all(len(leaf["uid"]) >= 4 and "/" not in leaf["uid"] for leaf in leaves)
    listing = api.get("/api/projects")
    assert listing.status_code == 200 and len(listing.json()["projects"]) == 2


def test_listing_survives_a_project_that_cannot_be_summarized(api, monkeypatch):
    _prepare_project(api)
    second = api.post("/api/projects", json={"name": "另一个"}).json()["project"]["id"]
    original = api.store.summarize

    def flaky(project):
        if project.id == second:
            raise RuntimeError("坏掉的项目")
        return original(project)

    monkeypatch.setattr(api.store, "summarize", flaky)
    listing = api.get("/api/projects")
    assert listing.status_code == 200 and len(listing.json()["projects"]) == 1


def test_deleting_a_project_releases_its_jobs(api):
    state = _prepare_project(api)
    pid = state["project"]["id"]
    snapshot = api.post(f"/api/projects/{pid}/jobs", json={"kind": "write"}).json()
    _wait_job(api, pid, snapshot["job"]["id"])
    assert api.manager.latest_job(pid) is not None
    assert api.delete(f"/api/projects/{pid}").status_code == 200
    assert api.manager.latest_job(pid) is None and api.manager.get(snapshot["job"]["id"]) is None


# ---------------------------------------------------------------------------
# 过时判断
# ---------------------------------------------------------------------------


def test_stale_flags_ignore_reordering_but_catch_new_chapters(api):
    state = _prepare_project(api)
    pid = state["project"]["id"]
    snapshot = api.post(f"/api/projects/{pid}/jobs", json={"kind": "plan"}).json()
    _wait_job(api, pid, snapshot["job"]["id"])
    api.post(f"/api/projects/{pid}/review/run")
    state = api.get(f"/api/projects/{pid}").json()
    assert state["blueprint_stale"] is False and state["review_outline_changed"] is False

    outline = state["project"]["outline"]
    outline.reverse()
    state = api.put(f"/api/projects/{pid}/outline", json={"outline": outline}).json()
    assert state["blueprint_stale"] is False and state["review_outline_changed"] is False

    outline = state["project"]["outline"]
    outline.append({"title": "新章节", "description": ""})
    state = api.put(f"/api/projects/{pid}/outline", json={"outline": outline}).json()
    assert state["blueprint_stale"] is True and state["review_outline_changed"] is True

    # 删掉一章、再加一章（叶子数不变）也要判为过时
    api.post(f"/api/projects/{pid}/review/run")
    outline = api.get(f"/api/projects/{pid}").json()["project"]["outline"]
    outline.pop(0)
    outline.append({"title": "又一个新章节", "children": [{"title": "a"}, {"title": "b"}, {"title": "c"}, {"title": "d"}, {"title": "e"}]})
    state = api.put(f"/api/projects/{pid}/outline", json={"outline": outline}).json()
    assert state["review_outline_changed"] is True


# ---------------------------------------------------------------------------
# 审校结果的保存
# ---------------------------------------------------------------------------


async def _run(manager, project_id, kind, params, runner):
    job = manager.start(project_id, kind, params, runner)
    await job.task
    return job


async def test_cancelled_deep_review_keeps_previous_results(tmp_path):
    store = ProjectStore(tmp_path / "projects")
    project = make_project(store)
    manager = jobs_module.JobManager(store)
    llm = FakeLLM(WritingResponder({"chapter": lambda call, default: "工期为 180 日历天，响应时间不超过 3 秒。" + default}))
    factory = lambda model: llm  # noqa: E731
    await _run(manager, project.id, "write", {}, lambda ctx: run_write_job(ctx, store, factory))

    previous = store.load_review(project.id)
    previous.deep = True
    previous.issues = list(previous.issues)
    marker = previous.model_copy(update={"warnings": ["上一次深度检查的结论"]})
    store.save_review(project.id, marker)

    llm.delay = 0.2  # 一致性检查慢一点，好在中途取消
    job = manager.start(project.id, "review", {}, lambda ctx: run_deep_review_job(ctx, store, factory))
    await asyncio.sleep(0.05)
    await manager.cancel(job.record.id)
    assert job.record.status == "cancelled"
    assert store.load_review(project.id).warnings == ["上一次深度检查的结论"]


async def test_deep_review_marks_deep_only_when_consistency_ran(tmp_path):
    store = ProjectStore(tmp_path / "projects")
    project = make_project(store)
    manager = jobs_module.JobManager(store)
    # 正文里一个数字都没有：摘记里没有可核对的表述，一致性检查无从做起
    plain = FakeLLM(WritingResponder({"chapter": "本章说明实施步骤与责任分工，并给出验收方式。" * 30}))
    await _run(manager, project.id, "write", {}, lambda ctx: run_write_job(ctx, store, lambda m: plain))
    job = await _run(manager, project.id, "review", {}, lambda ctx: run_deep_review_job(ctx, store, lambda m: plain))
    report = store.load_review(project.id)
    assert report.deep is False and any("未做一致性检查" in w for w in report.warnings)
    # 任务记录里带着结果摘要，页面据此不把“没做成”说成“已完成”
    assert job.record.status == "done"
    assert job.record.result == {"deep": False, "batches": 0, "failed_batches": 0}
    saved = next(r for r in store.load_jobs(project.id, limit=10) if r.id == job.record.id)
    assert saved.result == job.record.result

    numeric = FakeLLM(WritingResponder({"chapter": lambda call, default: "工期为 180 日历天，响应时间不超过 3 秒。" + default}))
    await _run(manager, project.id, "write", {"mode": "all"}, lambda ctx: run_write_job(ctx, store, lambda m: numeric))
    job = await _run(manager, project.id, "review", {}, lambda ctx: run_deep_review_job(ctx, store, lambda m: numeric))
    assert store.load_review(project.id).deep is True
    assert job.record.result == {"deep": True, "batches": 1, "failed_batches": 0}


async def test_revise_job_refreshes_the_review(tmp_path):
    store = ProjectStore(tmp_path / "projects")
    project = make_project(store)
    manager = jobs_module.JobManager(store)
    llm = FakeLLM(WritingResponder())
    factory = lambda model: llm  # noqa: E731
    await _run(manager, project.id, "write", {}, lambda ctx: run_write_job(ctx, store, factory))
    before = store.load_review(project.id).generated_at
    uid = leaf_ids(project)["1.1.1"]
    job = await _run(manager, project.id, "revise", {"uid": uid, "instruction": "补充验收方式"}, lambda ctx: run_revise_job(ctx, store, factory))
    assert job.record.status == "done"
    assert store.load_review(project.id).generated_at > before


async def test_failed_rewrite_does_not_wipe_an_earlier_partial_draft(tmp_path):
    from app.core.fake_llm import FakeReply
    from app.utils.errors import LLMError

    store = ProjectStore(tmp_path / "projects")
    project = make_project(store)
    uid = leaf_ids(project)["1.1.1"]
    store.save_chapter(project.id, ChapterRecord(uid=uid, status="cancelled", content="上次写到一半的较长内容。" * 5, chars=60))
    manager = jobs_module.JobManager(store)
    failing = FakeLLM(WritingResponder({"chapter": FakeReply(text="短", error=LLMError("模型调用失败: 400", kind="bad_request"))}))
    await _run(manager, project.id, "write", {"uids": [uid]}, lambda ctx: run_write_job(ctx, store, lambda m: failing))
    record = store.load_chapter(project.id, uid)
    assert record.status == "failed" and record.content.startswith("上次写到一半的较长内容")

    longer = FakeLLM(WritingResponder({"chapter": FakeReply(text="这一次写得更多的内容。" * 20, error=LLMError("模型调用失败: 400", kind="bad_request"))}))
    await _run(manager, project.id, "write", {"uids": [uid]}, lambda ctx: run_write_job(ctx, store, lambda m: longer))
    record = store.load_chapter(project.id, uid)
    assert record.content.startswith("这一次写得更多的内容") and record.versions[0].content.startswith("上次写到一半")
