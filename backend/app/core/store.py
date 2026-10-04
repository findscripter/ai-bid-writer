"""项目工作区：把一个投标项目的全部数据落在本机磁盘上。

目录结构（位于 data_home()/projects/ 下）：

    <project_id>/
        project.json        项目本体（概述、评分要求、目录、设置；不含招标原文）
        tender.txt          招标文件全文
        blueprint.json      写作蓝图
        review.json         最近一次审校结果
        chapters/<uid>.json 各叶子章节的正文与状态
        materials/<id>.json 参考资料（旧方案、企业介绍等）的全文
        jobs/<job_id>.json  后台任务记录

所有写入都是“先写临时文件再替换”，进程中途被杀也不会留下半个文件。
"""
from __future__ import annotations

import logging
import os
import re
import secrets
import shutil
import time
from pathlib import Path
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Type, TypeVar

from pydantic import BaseModel, ValidationError

from ..utils.errors import AppError
from ..writing.models import (
    Blueprint,
    ChapterRecord,
    JobRecord,
    Material,
    Project,
    ProjectSummary,
    ReviewReport,
)
from ..writing.outline_tree import UID_RE, collect_leaves, normalize_outline
from ..writing.textutil import new_id, now_iso
from .paths import projects_root

logger = logging.getLogger(__name__)

_PROJECT_ID_RE = re.compile(r"^[a-f0-9]{8,32}$")
_T = TypeVar("_T", bound=BaseModel)

MAX_VERSIONS = 5


def _atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    tmp.write_text(text, encoding="utf-8")
    try:
        for attempt in range(6):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                # Windows 上目标文件被杀毒/索引服务短暂占用时会失败，稍等重试
                if attempt == 5:
                    raise
                time.sleep(0.03 * (attempt + 1))
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def _write_model(path: Path, model: BaseModel) -> None:
    _atomic_write_text(path, model.model_dump_json(indent=2))


def _read_text(path: Path) -> Optional[str]:
    """读文本；文件不存在返回 None。

    Windows 上另一处正好在替换这个文件时，读取会短暂地“拒绝访问”，稍等重试几次。
    """
    for attempt in range(5):
        try:
            return path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(0.02 * (attempt + 1))
    return None


_ISO_STAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T")


def _parse_stamp(stamp: Optional[str]) -> Optional[datetime]:
    """解析 now_iso 这样带时区的时间戳；不像时间戳的值返回 None（原样保留）。"""
    if not stamp or not _ISO_STAMP_RE.match(stamp):
        return None
    try:
        value = datetime.fromisoformat(stamp)
    except ValueError:
        return None
    return value if value.tzinfo is not None else None


def _future_shift(stamps: Iterable[Optional[str]], now: str) -> Optional[timedelta]:
    """其中最晚的时间戳比 now 晚多少；不晚于 now（或者没有时间戳）时返回 None。"""
    current = _parse_stamp(now)
    parsed = [value for value in (_parse_stamp(stamp) for stamp in stamps) if value is not None]
    if current is None or not parsed:
        return None
    latest = max(parsed)
    return latest - current if latest > current else None


def _shift_stamp(stamp: Optional[str], shift: Optional[timedelta]) -> Optional[str]:
    if shift is None:
        return stamp
    value = _parse_stamp(stamp)
    if value is None:
        return stamp
    return (value - shift).isoformat(timespec="milliseconds")


def _read_model(path: Path, model_cls: Type[_T]) -> Optional[_T]:
    """读取并校验；文件不存在返回 None，内容损坏时记日志并返回 None。"""
    try:
        raw = _read_text(path)
    except OSError as exc:
        logger.warning("读取 %s 失败: %s", path, exc)
        return None
    if raw is None:
        return None
    try:
        return model_cls.model_validate_json(raw)
    except (ValidationError, ValueError) as exc:
        logger.warning("文件 %s 内容无效，已忽略: %s", path, exc)
        return None


class ProjectStore:
    """项目工作区的读写入口。"""

    def __init__(self, root: Optional[Path] = None):
        self._root = Path(root) if root else None

    @property
    def root(self) -> Path:
        return self._root or projects_root()

    # ------------------------------------------------------------------
    # 路径
    # ------------------------------------------------------------------

    def project_dir(self, project_id: str) -> Path:
        if not _PROJECT_ID_RE.match(project_id or ""):
            raise AppError("项目不存在", status_code=404)
        return self.root / project_id

    @staticmethod
    def _check_uid(uid: str) -> str:
        if not UID_RE.match(uid or ""):
            raise AppError("章节不存在", status_code=404)
        return uid

    def _chapter_path(self, project_id: str, uid: str) -> Path:
        return self.project_dir(project_id) / "chapters" / f"{self._check_uid(uid)}.json"

    # ------------------------------------------------------------------
    # 项目
    # ------------------------------------------------------------------

    def create_project(self, name: str = "") -> Project:
        project_id = new_id(6)
        while (self.root / project_id).exists():
            project_id = new_id(6)
        now = now_iso()
        project = Project(
            id=project_id,
            name=(name or "").strip() or "未命名项目",
            created_at=now,
            updated_at=now,
        )
        _write_model(self.project_dir(project_id) / "project.json", project)
        return project

    def load_project(self, project_id: str) -> Project:
        path = self.project_dir(project_id) / "project.json"
        if not path.exists():
            raise AppError("项目不存在", status_code=404)
        project = _read_model(path, Project)
        if project is None:
            raise AppError("项目数据已损坏，无法读取", status_code=500)
        return project

    def save_project(self, project: Project, touch: bool = True) -> Project:
        if touch:
            project.updated_at = now_iso()
        _write_model(self.project_dir(project.id) / "project.json", project)
        return project

    def delete_project(self, project_id: str) -> None:
        directory = self.project_dir(project_id)
        if not directory.exists():
            raise AppError("项目不存在", status_code=404)

        def _retry_writable(func: Any, path: str, _exc: Any) -> None:
            # 只读文件先去掉只读属性再删；仍然失败就留给下面统一报告
            try:
                os.chmod(path, 0o600)
                func(path)
            except OSError:
                pass

        for attempt in range(3):
            shutil.rmtree(directory, onerror=_retry_writable)
            if not directory.exists():
                return
            time.sleep(0.1 * (attempt + 1))
        if (directory / "project.json").exists():
            raise AppError("项目有文件正被其他程序占用，没能删除。请关闭占用的程序后重试。", status_code=500)
        # 项目文件已经删掉，只剩个别残留文件：项目实际上已经不存在了
        logger.warning("删除项目 %s 后有残留文件没能删掉", project_id)

    def project_exists(self, project_id: str) -> bool:
        try:
            return (self.project_dir(project_id) / "project.json").exists()
        except AppError:
            return False

    def list_project_ids(self) -> List[str]:
        root = self.root
        if not root.exists():
            return []
        return sorted(
            entry.name
            for entry in root.iterdir()
            if entry.is_dir() and _PROJECT_ID_RE.match(entry.name) and (entry / "project.json").exists()
        )

    def summarize(self, project: Project) -> ProjectSummary:
        leaves = collect_leaves(project.outline)
        chapters = self.load_chapters(project.id)
        done = 0
        truncated = 0
        total_chars = 0
        for leaf in leaves:
            record = chapters.get(leaf.uid)
            if record is None:
                continue
            total_chars += record.chars
            if record.status == "done" and record.chars > 0:
                done += 1
                if record.truncated:
                    truncated += 1
        return ProjectSummary(
            id=project.id,
            name=project.name,
            created_at=project.created_at,
            updated_at=project.updated_at,
            tender_filename=project.tender.filename,
            leaf_total=len(leaves),
            leaf_done=done,
            leaf_truncated=truncated,
            total_chars=total_chars,
            has_blueprint=(self.project_dir(project.id) / "blueprint.json").exists(),
            has_analysis=bool(project.overview.strip() and project.requirements.strip()),
        )

    def list_projects(self) -> List[ProjectSummary]:
        summaries: List[ProjectSummary] = []
        for project_id in self.list_project_ids():
            try:
                summaries.append(self.summarize(self.load_project(project_id)))
            except AppError as exc:
                logger.warning("跳过无法读取的项目 %s: %s", project_id, exc.message)
            except Exception:  # noqa: BLE001 - 一个坏项目不能让整个列表打不开
                logger.warning("跳过无法读取的项目 %s", project_id, exc_info=True)
        summaries.sort(key=lambda s: s.updated_at, reverse=True)
        return summaries

    # ------------------------------------------------------------------
    # 招标原文
    # ------------------------------------------------------------------

    def save_tender_text(self, project_id: str, text: str) -> None:
        _atomic_write_text(self.project_dir(project_id) / "tender.txt", text or "")

    def load_tender_text(self, project_id: str) -> str:
        return _read_text(self.project_dir(project_id) / "tender.txt") or ""

    # ------------------------------------------------------------------
    # 参考资料
    # ------------------------------------------------------------------

    def save_material(self, project_id: str, material: Material) -> None:
        if not UID_RE.match(material.id):
            raise AppError("资料编号无效", status_code=400)
        _write_model(self.project_dir(project_id) / "materials" / f"{material.id}.json", material)

    def load_materials(self, project_id: str) -> List[Material]:
        directory = self.project_dir(project_id) / "materials"
        if not directory.exists():
            return []
        items: List[Material] = []
        for path in sorted(directory.glob("*.json")):
            material = _read_model(path, Material)
            if material is not None:
                items.append(material)
        items.sort(key=lambda m: m.uploaded_at)
        return items

    def load_material(self, project_id: str, material_id: str) -> Optional[Material]:
        if not UID_RE.match(material_id or ""):
            return None
        return _read_model(self.project_dir(project_id) / "materials" / f"{material_id}.json", Material)

    def delete_material(self, project_id: str, material_id: str) -> bool:
        if not UID_RE.match(material_id or ""):
            return False
        path = self.project_dir(project_id) / "materials" / f"{material_id}.json"
        try:
            path.unlink()
            return True
        except FileNotFoundError:
            return False

    # ------------------------------------------------------------------
    # 蓝图 / 审校
    # ------------------------------------------------------------------

    def load_blueprint(self, project_id: str) -> Optional[Blueprint]:
        return _read_model(self.project_dir(project_id) / "blueprint.json", Blueprint)

    def save_blueprint(self, project_id: str, blueprint: Blueprint) -> None:
        _write_model(self.project_dir(project_id) / "blueprint.json", blueprint)

    def delete_blueprint(self, project_id: str) -> None:
        try:
            (self.project_dir(project_id) / "blueprint.json").unlink()
        except FileNotFoundError:
            pass

    def load_review(self, project_id: str) -> Optional[ReviewReport]:
        return _read_model(self.project_dir(project_id) / "review.json", ReviewReport)

    def save_review(self, project_id: str, report: ReviewReport) -> None:
        _write_model(self.project_dir(project_id) / "review.json", report)

    # ------------------------------------------------------------------
    # 章节
    # ------------------------------------------------------------------

    def load_chapter(self, project_id: str, uid: str) -> Optional[ChapterRecord]:
        return _read_model(self._chapter_path(project_id, uid), ChapterRecord)

    def load_chapters(self, project_id: str) -> Dict[str, ChapterRecord]:
        directory = self.project_dir(project_id) / "chapters"
        if not directory.exists():
            return {}
        records: Dict[str, ChapterRecord] = {}
        for path in directory.glob("*.json"):
            record = _read_model(path, ChapterRecord)
            if record is not None:
                records[record.uid] = record
        return records

    def save_chapter(self, project_id: str, record: ChapterRecord, touch: bool = True) -> ChapterRecord:
        if touch or not record.updated_at:
            record.updated_at = now_iso()
        if len(record.versions) > MAX_VERSIONS:
            record.versions = record.versions[:MAX_VERSIONS]
        _write_model(self._chapter_path(project_id, record.uid), record)
        return record

    def delete_chapter(self, project_id: str, uid: str) -> None:
        try:
            self._chapter_path(project_id, uid).unlink()
        except FileNotFoundError:
            pass

    # ------------------------------------------------------------------
    # 任务记录
    # ------------------------------------------------------------------

    def save_job(self, record: JobRecord) -> None:
        if not UID_RE.match(record.id):
            return
        _write_model(self.project_dir(record.project_id) / "jobs" / f"{record.id}.json", record)

    def load_jobs(self, project_id: str, limit: int = 20) -> List[JobRecord]:
        directory = self.project_dir(project_id) / "jobs"
        if not directory.exists():
            return []
        records: List[JobRecord] = []
        for path in directory.glob("*.json"):
            record = _read_model(path, JobRecord)
            if record is not None:
                records.append(record)
        records.sort(key=lambda r: r.created_at, reverse=True)
        return records[:limit]

    def prune_jobs(self, project_id: str, keep: int = 20) -> None:
        """只保留最近的若干条任务记录。"""
        directory = self.project_dir(project_id) / "jobs"
        if not directory.exists():
            return
        paths = sorted(directory.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        for path in paths[keep:]:
            try:
                path.unlink()
            except OSError:
                pass

    # ------------------------------------------------------------------
    # 归档（导出 / 导入整个项目）
    # ------------------------------------------------------------------

    def export_archive(self, project_id: str) -> Dict[str, Any]:
        project = self.load_project(project_id)
        blueprint = self.load_blueprint(project_id)
        review = self.load_review(project_id)
        return {
            "format": "ai-bid-writer-project",
            "version": 1,
            "exported_at": now_iso(),
            "project": project.model_dump(),
            "tender_text": self.load_tender_text(project_id),
            "blueprint": blueprint.model_dump() if blueprint else None,
            "review": review.model_dump() if review else None,
            "chapters": [record.model_dump() for record in self.load_chapters(project_id).values()],
            "materials": [material.model_dump() for material in self.load_materials(project_id)],
        }

    def import_archive(self, archive: Dict[str, Any]) -> Project:
        if not isinstance(archive, dict) or archive.get("format") != "ai-bid-writer-project":
            raise AppError("不是有效的项目归档文件", status_code=400)
        try:
            source = Project.model_validate(archive.get("project") or {})
        except ValidationError as exc:
            raise AppError(f"项目归档内容无效: {exc.errors()[0].get('msg', '')}", status_code=400) from exc

        project = self.create_project(source.name)
        # 目录要按本应用的规则重新规范化：畸形的节点（不是对象、children 不是列表、缺 uid）
        # 会在之后的每个页面上出错，必须在入口挡住
        imported = source.model_copy(
            update={
                "id": project.id,
                "created_at": project.created_at,
                "outline": normalize_outline(source.outline),
            }
        )

        def _each(key: str, model_cls: Type[_T]) -> List[_T]:
            items: List[_T] = []
            for raw in archive.get(key) or []:
                try:
                    items.append(model_cls.model_validate(raw))
                except ValidationError:
                    logger.warning("导入项目时跳过一条无效的 %s 记录", key)
            return items

        chapters = [record for record in _each("chapters", ChapterRecord) if UID_RE.match(record.uid)]
        materials = [material for material in _each("materials", Material) if UID_RE.match(material.id)]
        blueprint: Optional[Blueprint] = None
        review: Optional[ReviewReport] = None
        try:
            blueprint = Blueprint.model_validate(archive["blueprint"]) if archive.get("blueprint") else None
        except ValidationError:
            logger.warning("导入项目时跳过无效的 blueprint")
        try:
            review = ReviewReport.model_validate(archive["review"]) if archive.get("review") else None
        except ValidationError:
            logger.warning("导入项目时跳过无效的 review")

        # 原机器的时钟可能比本机快：把备份里的时间整体往前平移，让最晚的那个不晚于现在。
        # 整体平移而不是逐个收回，先后关系（例如“审校之后又改过的章节”）保持不变
        shift = _future_shift(
            [record.updated_at for record in chapters]
            + [version.saved_at for record in chapters for version in record.versions]
            + [material.uploaded_at for material in materials]
            + [imported.tender.uploaded_at]
            + [model.generated_at for model in (blueprint, review) if model is not None],
            now_iso(),
        )
        imported.tender.uploaded_at = _shift_stamp(imported.tender.uploaded_at, shift) or ""
        self.save_project(imported)
        self.save_tender_text(project.id, str(archive.get("tender_text") or ""))

        for record in chapters:
            # 保留原来的修改时间：否则审校会把全部章节误判成“检查之后又改过”
            record.updated_at = _shift_stamp(record.updated_at, shift)
            for version in record.versions:
                version.saved_at = _shift_stamp(version.saved_at, shift) or version.saved_at
            self.save_chapter(project.id, record, touch=False)
        for material in materials:
            material.uploaded_at = _shift_stamp(material.uploaded_at, shift) or ""
            self.save_material(project.id, material)
        if blueprint is not None:
            blueprint.generated_at = _shift_stamp(blueprint.generated_at, shift) or ""
            self.save_blueprint(project.id, blueprint)
        if review is not None:
            review.generated_at = _shift_stamp(review.generated_at, shift) or ""
            self.save_review(project.id, review)
        return self.load_project(project.id)
