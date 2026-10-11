"""后台任务：让一次可能持续几十分钟的生成与浏览器连接解耦。

- 任务在服务端的事件循环里独立运行；页面刷新、断线、关掉标签页都不影响它。
- 任务过程以“带序号的事件”形式广播；浏览器重连时带上已收到的最后一个序号，
  服务端从那之后补发，补不上（太久远）就让它重新拉一次快照。
- 同一个项目同一时间只允许一个任务，避免两个任务同时改同一批章节。
- 取消是协作式的：取消任务 → 正在进行的模型请求立刻断开 → 已写出的部分照常保存。
"""
from __future__ import annotations

import asyncio
import logging
from collections import deque
from typing import Any, AsyncGenerator, Awaitable, Callable, Deque, Dict, List, Optional, Set, Tuple

from ..utils.errors import AppError, LLMError
from ..writing.models import JobRecord
from ..writing.textutil import new_id, now_iso
from .store import ProjectStore

logger = logging.getLogger(__name__)

EVENT_BUFFER = 4000
"""每个任务在内存里保留的最近事件数（用于断线补发）。"""

HEARTBEAT_SECONDS = 15.0
FINISHED_KEEP = 3
"""每个项目在内存里保留最近几个已结束的任务（供晚到的订阅者补看结尾）。"""

INTERRUPTED_MESSAGE = "服务在任务运行期间被关闭"

BUSY_CODE = "project_busy"
"""项目被别的任务或操作占住时，409 响应带的错误码（响应头 X-Error-Code，流式错误事件的 code）。"""

Event = Tuple[int, Optional[Dict[str, Any]]]
"""(序号, 事件)；事件为 None 表示心跳。"""


class Job:
    """一个正在运行或刚结束的任务。"""

    def __init__(self, record: JobRecord):
        self.record = record
        self.task: Optional["asyncio.Task[None]"] = None
        self.events: Deque[Tuple[int, Dict[str, Any]]] = deque(maxlen=EVENT_BUFFER)
        self.seq = 0
        self.subscribers: Set["asyncio.Queue[Optional[Tuple[int, Dict[str, Any]]]]"] = set()
        self.live: Dict[str, str] = {}
        """正在写作的章节当前已写出的文本（uid → 文本），只存在于内存，给重连的页面做快照。"""
        self.queued: List[str] = []
        """已排进本次任务、还没开始写的章节（按写作顺序）。"""
        self.finished = False
        self.stopped_by_shutdown = False
        """因为服务关闭而被取消：记成“中断”而不是“已取消”，重新打开页面时提示做到了哪一步。"""

    def snapshot(self) -> Dict[str, Any]:
        return {
            "job": self.record.model_dump(),
            "last_seq": self.seq,
            "live": dict(self.live),
            "queued": list(self.queued),
        }


class JobContext:
    """任务执行体拿到的上下文：发事件、报进度。"""

    def __init__(self, manager: "JobManager", job: Job):
        self._manager = manager
        self._job = job

    @property
    def job_id(self) -> str:
        return self._job.record.id

    @property
    def project_id(self) -> str:
        return self._job.record.project_id

    @property
    def params(self) -> Dict[str, Any]:
        return self._job.record.params

    def emit(self, type: str, **payload: Any) -> None:
        self._manager._emit(self._job, {"type": type, **payload})

    def stage(self, stage: str, message: str = "") -> None:
        record = self._job.record
        record.stage = stage
        record.message = message
        self.emit("job_stage", stage=stage, message=message)

    def set_total(self, total: int) -> None:
        self._job.record.progress.total = max(int(total), 0)
        self._emit_progress()

    def set_progress(self, done: int, total: int) -> None:
        progress = self._job.record.progress
        progress.done = max(int(done), 0)
        progress.total = max(int(total), 0)
        self._emit_progress()

    def advance(self, done: int = 0, failed: int = 0, chars: int = 0) -> None:
        progress = self._job.record.progress
        progress.done += done
        progress.failed += failed
        progress.chars += chars
        self._emit_progress()

    def _emit_progress(self) -> None:
        self.emit("job_progress", progress=self._job.record.progress.model_dump())

    def note_call(self, prompt_tokens: int = 0, completion_tokens: int = 0, cached_tokens: int = 0) -> None:
        usage = self._job.record.usage
        usage["calls"] = usage.get("calls", 0) + 1
        usage["prompt_tokens"] = usage.get("prompt_tokens", 0) + int(prompt_tokens or 0)
        usage["completion_tokens"] = usage.get("completion_tokens", 0) + int(completion_tokens or 0)
        usage["cached_tokens"] = usage.get("cached_tokens", 0) + int(cached_tokens or 0)

    def set_result(self, **values: Any) -> None:
        """记下任务的结果摘要，随任务记录一起保存和推送（例如深度审校是否真的核对了一致性）。"""
        self._job.record.result.update(values)

    def live_update(self, uid: str, text: str) -> None:
        self._job.live[uid] = text

    def set_queued(self, uids: List[str]) -> None:
        self._job.queued = list(uids)

    def dequeue(self, uid: str) -> None:
        if uid in self._job.queued:
            self._job.queued.remove(uid)

    def live_clear(self, uid: str) -> None:
        self._job.live.pop(uid, None)


Runner = Callable[[JobContext], Awaitable[None]]


class JobManager:
    """管理全部后台任务。"""

    def __init__(self, store: ProjectStore):
        self._store = store
        self._jobs: Dict[str, Job] = {}
        self._by_project: Dict[str, List[str]] = {}
        self._reserved: Dict[str, str] = {}
        """不走后台任务、但同样会大改项目的操作（例如生成目录）：项目 id → 操作名称。"""
        self.closing = False
        """服务正在关闭：流式请求（生成目录、解析招标文件）见到它就尽快收尾。"""

    # ------------------------------------------------------------------
    # 查询
    # ------------------------------------------------------------------

    def get(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def active_job(self, project_id: str) -> Optional[Job]:
        for job_id in reversed(self._by_project.get(project_id, [])):
            job = self._jobs.get(job_id)
            if job is not None and not job.finished:
                return job
        return None

    def latest_job(self, project_id: str) -> Optional[Job]:
        ids = self._by_project.get(project_id, [])
        return self._jobs.get(ids[-1]) if ids else None

    def busy_reason(self, project_id: str) -> Optional[str]:
        """项目当前不能被大改的原因；空闲时返回 None。"""
        if self.active_job(project_id) is not None:
            return "有任务正在运行"
        label = self._reserved.get(project_id)
        return f"正在{label}" if label else None

    def reserve(self, project_id: str, label: str) -> None:
        """占住项目：期间不能启动后台任务、也不能再被别的操作占住。用完必须 release。"""
        reason = self.busy_reason(project_id)
        if reason:
            raise AppError(f"{reason}，请等它结束后再试", status_code=409, code=BUSY_CODE)
        self._reserved[project_id] = label

    def release(self, project_id: str) -> None:
        self._reserved.pop(project_id, None)

    def forget(self, project_id: str) -> None:
        """项目被删除后，丢掉它在内存里的任务（连同事件与实时文本）。"""
        for job_id in self._by_project.pop(project_id, []):
            job = self._jobs.pop(job_id, None)
            if job is not None:
                job.events.clear()
                job.live.clear()
        self._reserved.pop(project_id, None)

    # ------------------------------------------------------------------
    # 启动 / 取消
    # ------------------------------------------------------------------

    def start(self, project_id: str, kind: str, params: Dict[str, Any], runner: Runner) -> Job:
        if self.active_job(project_id) is not None:
            raise AppError("该项目已有任务在运行，请等它结束或先取消", status_code=409, code=BUSY_CODE)
        label = self._reserved.get(project_id)
        if label:
            raise AppError(f"正在{label}，请等它结束后再试", status_code=409, code=BUSY_CODE)

        record = JobRecord(
            id=new_id(6),
            project_id=project_id,
            kind=kind,
            status="pending",
            params=params,
            created_at=now_iso(),
        )
        job = Job(record)
        self._jobs[record.id] = job
        self._by_project.setdefault(project_id, []).append(record.id)
        self._save(record)
        job.task = asyncio.get_running_loop().create_task(self._run(job, runner))
        return job

    async def cancel(self, job_id: str, wait: float = 15.0) -> bool:
        """取消任务，并等它收尾（保存已写出的部分）后再返回。"""
        job = self._jobs.get(job_id)
        if job is None or job.finished or job.task is None:
            return False
        job.task.cancel()
        await asyncio.wait({job.task}, timeout=wait)
        return True

    async def shutdown(self) -> None:
        """应用退出时取消所有任务；它们会被记成“中断”，而不是使用者自己停下的“已取消”。"""
        self.closing = True
        tasks = []
        for job in self._jobs.values():
            if job.task is not None and not job.finished:
                job.stopped_by_shutdown = True
                job.task.cancel()
                tasks.append(job.task)
        if tasks:
            await asyncio.wait(tasks, timeout=10)

    def recover_interrupted(self) -> int:
        """服务重启后，把上次没跑完的任务记录标成“中断”。返回处理的条数。"""
        count = 0
        for project_id in self._store.list_project_ids():
            for record in self._store.load_jobs(project_id, limit=50):
                if record.status in ("pending", "running") and record.id not in self._jobs:
                    record.status = "interrupted"
                    record.error = INTERRUPTED_MESSAGE
                    record.finished_at = record.finished_at or now_iso()
                    self._save(record)
                    count += 1
        return count

    # ------------------------------------------------------------------
    # 运行
    # ------------------------------------------------------------------

    async def _run(self, job: Job, runner: Runner) -> None:
        record = job.record
        record.status = "running"
        record.started_at = now_iso()
        self._save(record)
        self._emit(job, {"type": "job_start", "job": record.model_dump()})

        status = "done"
        error: Optional[str] = None
        try:
            await runner(JobContext(self, job))
        except asyncio.CancelledError:
            if job.stopped_by_shutdown:
                status, error = "interrupted", INTERRUPTED_MESSAGE
            else:
                status = "cancelled"
        except LLMError as exc:
            status, error = "failed", exc.friendly
        except AppError as exc:
            status, error = "failed", exc.message
        except Exception as exc:  # noqa: BLE001 - 任务不能把异常抛到事件循环里
            logger.exception("后台任务 %s（%s）异常结束", record.id, record.kind)
            status, error = "failed", f"{type(exc).__name__}: {exc}"

        record.status = status
        record.error = error
        record.finished_at = now_iso()
        job.live.clear()
        job.queued = []
        self._save(record)
        job.finished = True
        self._emit(job, {"type": "job_end", "job": record.model_dump()})
        for queue in list(job.subscribers):
            queue.put_nowait(None)
        self._prune(record.project_id)

    def _save(self, record: JobRecord) -> None:
        try:
            self._store.save_job(record)
        except Exception:  # noqa: BLE001 - 任务记录写不了不应该中断任务本身
            logger.warning("保存任务记录 %s 失败", record.id, exc_info=True)

    def _emit(self, job: Job, event: Dict[str, Any]) -> int:
        job.seq += 1
        item = (job.seq, event)
        job.events.append(item)
        for queue in list(job.subscribers):
            queue.put_nowait(item)
        return job.seq

    def _prune(self, project_id: str) -> None:
        ids = self._by_project.get(project_id, [])
        finished = [job_id for job_id in ids if self._jobs.get(job_id) and self._jobs[job_id].finished]
        for job_id in finished[:-FINISHED_KEEP]:
            ids.remove(job_id)
            self._jobs.pop(job_id, None)
        try:
            self._store.prune_jobs(project_id)
        except Exception:  # noqa: BLE001
            logger.debug("清理旧任务记录失败", exc_info=True)

    # ------------------------------------------------------------------
    # 订阅
    # ------------------------------------------------------------------

    async def subscribe(
        self,
        job_id: str,
        after_seq: int = 0,
        heartbeat: float = HEARTBEAT_SECONDS,
    ) -> AsyncGenerator[Event, None]:
        """订阅任务事件：先补发 after_seq 之后的，再跟随实时事件，直到任务结束。

        产出 (序号, 事件)。事件为 None 是心跳；事件类型为 resync 表示补发不上，
        订阅方应当重新拉取快照后再订阅。
        """
        job = self._jobs.get(job_id)
        if job is None:
            return

        oldest = job.events[0][0] if job.events else job.seq + 1
        if after_seq + 1 < oldest:
            yield after_seq, {"type": "resync"}
            return

        queue: "asyncio.Queue[Optional[Tuple[int, Dict[str, Any]]]]" = asyncio.Queue()
        backlog = [item for item in job.events if item[0] > after_seq]
        # 取补发列表与登记订阅之间没有 await，不会漏事件也不会重复
        job.subscribers.add(queue)
        try:
            for item in backlog:
                yield item
            while True:
                if job.finished and queue.empty():
                    return
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=heartbeat)
                except asyncio.TimeoutError:
                    yield 0, None
                    continue
                if item is None:
                    return
                yield item
        finally:
            job.subscribers.discard(queue)


store = ProjectStore()
job_manager = JobManager(store)
