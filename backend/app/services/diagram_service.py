"""插图渲染服务：把图表 DSL 渲染成 PNG，供 python-docx 插入标书。

两个引擎：
- mermaid（mmdc CLI，走本机 Chrome 无头渲染）：流程图 / 时序图 / 甘特图 / 状态图
- plantuml（java -jar，纯 Java 光栅化）：架构图 / 部署图 / 网络拓扑(nwdiag) / 组织架构 / C4

中文：mermaid 经 Chrome 用系统字体开箱即用；plantuml 自动注入
`skinparam defaultFontName "Microsoft YaHei"` + `-charset UTF-8`。
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Any, List, Optional

logger = logging.getLogger(__name__)

_BACKEND_DIR = Path(__file__).resolve().parents[2]
_TOOLS_DIR = _BACKEND_DIR / "tools"

# 渲染超时（秒）：mermaid 要冷启动 Chrome，给足时间
RENDER_TIMEOUT = 90

# 中文字体（Windows 自带）
CJK_FONT = "Microsoft YaHei"


class DiagramRenderError(Exception):
    """渲染失败，message 含引擎 stderr，便于回喂 LLM 纠错。"""


def _resolve_mmdc() -> Optional[str]:
    """定位 mermaid-cli 可执行文件。"""
    env = os.environ.get("DIAGRAM_MMDC_PATH")
    if env and Path(env).exists():
        return env
    for name in ("mmdc.cmd", "mmdc"):
        found = shutil.which(name)
        if found:
            return found
    # 回退：从 npm 全局前缀推断
    try:
        prefix = subprocess.run(
            ["npm", "prefix", "-g"], capture_output=True, text=True, timeout=15,
            shell=os.name == "nt",
        ).stdout.strip()
        cand = Path(prefix) / "mmdc.cmd"
        if cand.exists():
            return str(cand)
    except Exception:
        pass
    return None


def _resolve_java() -> Optional[str]:
    env = os.environ.get("DIAGRAM_JAVA_PATH")
    if env and Path(env).exists():
        return env
    return shutil.which("java")


def _plantuml_jar() -> Optional[str]:
    env = os.environ.get("DIAGRAM_PLANTUML_JAR")
    if env and Path(env).exists():
        return env
    cand = _TOOLS_DIR / "plantuml.jar"
    return str(cand) if cand.exists() else None


def _puppeteer_config() -> Optional[str]:
    cand = _TOOLS_DIR / "puppeteer-config.json"
    return str(cand) if cand.exists() else None


def _mermaid_config() -> Optional[str]:
    cand = _TOOLS_DIR / "mermaid-config.json"
    return str(cand) if cand.exists() else None


class DiagramRenderer:
    """无状态渲染器：DSL 文本 -> PNG bytes。"""

    SUPPORTED_ENGINES = ("mermaid", "plantuml", "layered", "blocks", "flow")

    @staticmethod
    def availability() -> dict:
        """报告各引擎依赖是否就绪（供健康检查/诊断）。"""
        return {
            "mermaid": {
                "mmdc": _resolve_mmdc(),
                "puppeteer_config": _puppeteer_config(),
            },
            "plantuml": {
                "java": _resolve_java(),
                "jar": _plantuml_jar(),
            },
        }

    @classmethod
    def render(cls, engine: str, code: str) -> bytes:
        engine = (engine or "").strip().lower()
        if engine == "mermaid":
            return cls.render_mermaid(code)
        if engine == "plantuml":
            return cls.render_plantuml(code)
        if engine == "layered":
            return cls.render_layered(code)
        if engine == "blocks":
            return cls.render_blocks(code)
        if engine == "flow":
            return cls.render_flow(code)
        raise DiagramRenderError(
            f"不支持的引擎 '{engine}'，仅支持 {cls.SUPPORTED_ENGINES}"
        )

    @staticmethod
    def render_layered(code: str) -> bytes:
        """分层架构全景图：code 为 spec 的 JSON 字符串。"""
        from .arch_layered import render_layered as _render

        try:
            return _render(code)
        except Exception as exc:
            raise DiagramRenderError(f"分层架构图渲染失败：{exc}") from exc

    @staticmethod
    def render_blocks(code: str) -> bytes:
        """区块架构图（部署/接入/存储框图）：code 为 spec 的 JSON 字符串。"""
        from .arch_blocks import render_blocks as _render

        try:
            return _render(code)
        except Exception as exc:
            raise DiagramRenderError(f"区块架构图渲染失败：{exc}") from exc

    @staticmethod
    def render_flow(code: str) -> bytes:
        """流程/进度卡片框图：code 为 spec 的 JSON 字符串。"""
        from .arch_flow import render_flow as _render

        try:
            return _render(code)
        except Exception as exc:
            raise DiagramRenderError(f"流程框图渲染失败：{exc}") from exc

    @staticmethod
    def render_mermaid(code: str) -> bytes:
        mmdc = _resolve_mmdc()
        if not mmdc:
            raise DiagramRenderError("未找到 mermaid-cli（mmdc），请先 npm i -g @mermaid-js/mermaid-cli")

        with tempfile.TemporaryDirectory(prefix="mmd_") as tmp:
            in_path = Path(tmp) / "in.mmd"
            out_path = Path(tmp) / "out.png"
            in_path.write_text(code, encoding="utf-8")

            args = [
                mmdc,
                "-i", str(in_path),
                "-o", str(out_path),
                "-b", "white",
                "-s", "2",  # 2x 缩放，Word 内清晰
            ]
            cfg = _puppeteer_config()
            if cfg:
                args += ["-p", cfg]
            mcfg = _mermaid_config()
            if mcfg:
                args += ["-c", mcfg]

            # Windows 下 mmdc 是 .cmd，需经 cmd /c 调用
            if os.name == "nt" and mmdc.lower().endswith(".cmd"):
                args = ["cmd", "/c"] + args

            proc = subprocess.run(
                args, capture_output=True, text=True, timeout=RENDER_TIMEOUT,
            )
            if proc.returncode != 0 or not out_path.exists():
                raise DiagramRenderError(
                    f"mermaid 渲染失败：\n{(proc.stderr or proc.stdout or '').strip()[:1500]}"
                )
            return out_path.read_bytes()

    @staticmethod
    def render_plantuml(code: str) -> bytes:
        java = _resolve_java()
        jar = _plantuml_jar()
        if not java:
            raise DiagramRenderError("未找到 java（PlantUML 需要 JRE 11+）")
        if not jar:
            raise DiagramRenderError("未找到 plantuml.jar（应放在 backend/tools/plantuml.jar）")

        code = DiagramRenderer._ensure_plantuml_style(code)

        with tempfile.TemporaryDirectory(prefix="puml_") as tmp:
            in_path = Path(tmp) / "in.puml"
            in_path.write_text(code, encoding="utf-8")

            args = [
                java,
                "-Djava.awt.headless=true",
                "-Dfile.encoding=UTF-8",
                "-jar", jar,
                "-charset", "UTF-8",
                "-tpng",
                str(in_path),
            ]
            proc = subprocess.run(
                args, capture_output=True, text=True, timeout=RENDER_TIMEOUT,
            )
            out_path = Path(tmp) / "in.png"
            if proc.returncode != 0 or not out_path.exists():
                raise DiagramRenderError(
                    f"plantuml 渲染失败：\n{(proc.stderr or proc.stdout or '').strip()[:1500]}"
                )
            return out_path.read_bytes()

    # 现代化主题（扁平 skinparam，避免块语法/换行的脆弱性）：
    # 与前端 slate 灰底 + 蓝强调呼应——圆角、淡蓝填充、灰边、去阴影
    _PUML_THEME = [
        f'skinparam defaultFontName "{CJK_FONT}"',
        "skinparam backgroundColor #FFFFFF",
        "skinparam shadowing false",
        "skinparam roundCorner 12",
        "skinparam defaultFontSize 14",
        "skinparam ArrowColor #475569",
        "skinparam ArrowFontColor #475569",
        "skinparam ArrowThickness 1.2",
        "skinparam componentBackgroundColor #EFF6FF",
        "skinparam componentBorderColor #2563EB",
        "skinparam componentFontColor #0F172A",
        "skinparam rectangleBackgroundColor #EFF6FF",
        "skinparam rectangleBorderColor #2563EB",
        "skinparam rectangleFontColor #0F172A",
        "skinparam packageBackgroundColor #F8FAFC",
        "skinparam packageBorderColor #94A3B8",
        "skinparam nodeBackgroundColor #EFF6FF",
        "skinparam nodeBorderColor #2563EB",
        "skinparam databaseBackgroundColor #EFF6FF",
        "skinparam databaseBorderColor #2563EB",
        "skinparam cloudBackgroundColor #F8FAFC",
        "skinparam cloudBorderColor #94A3B8",
        "skinparam usecaseBackgroundColor #EFF6FF",
        "skinparam usecaseBorderColor #2563EB",
        "skinparam actorBorderColor #2563EB",
    ]

    @staticmethod
    def _ensure_plantuml_style(code: str) -> str:
        """注入中文字体 + 现代化配色主题（用户未显式设样式时）。"""
        lines = code.splitlines()
        # 找到 @start 行
        start_idx = next(
            (i for i, l in enumerate(lines) if l.strip().startswith("@start")), None
        )
        if start_idx is None:
            return code  # 无 @start，交给 plantuml 报错回喂

        has_skin = "skinparam" in code
        if has_skin:
            # 模型自带样式，仅补字体（若缺）
            if "defaultFontName" not in code:
                lines.insert(start_idx + 1, f'skinparam defaultFontName "{CJK_FONT}"')
            return "\n".join(lines)

        lines.insert(start_idx + 1, "\n".join(DiagramRenderer._PUML_THEME))
        return "\n".join(lines)


def save_png(data: bytes, out_dir: str, name_hint: str = "") -> str:
    """把 PNG 落盘，返回路径（调试/导出用）。"""
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    safe = "".join(c for c in name_hint if c.isalnum() or c in "-_") or uuid.uuid4().hex[:8]
    path = str(Path(out_dir) / f"diagram_{safe}.png")
    Path(path).write_bytes(data)
    return path


# 渲染失败时最多回喂 LLM 纠错的次数
DIAGRAM_FIX_ROUNDS = 2


class DiagramService:
    """LLM 编排：判断章节是否配图 → 生成 DSL → 渲染 → 失败回喂纠错。"""

    def __init__(self, ai=None):
        # 延迟导入，避免渲染层强依赖 LLM 配置
        from ..utils.openai_util import OpenAIUtil

        self.ai = ai or OpenAIUtil()

    async def generate_for_chapter(
        self,
        chapter_title: str,
        chapter_description: str = "",
        chapter_content: str = "",
        project_overview: str = "",
    ) -> Optional[dict]:
        """为单个章节尝试生成一张插图。

        返回 {engine, diagram_type, title, code, png(bytes)}；
        不需要配图或多次渲染失败则返回 None（绝不抛错打断正文流程）。
        """
        import json as _json

        from ..utils.prompts.diagram_prompts import (
            build_blocks_spec_messages,
            build_diagram_decision_messages,
            build_diagram_fix_messages,
            build_flow_spec_messages,
            build_layered_spec_messages,
            strip_code_fence,
            validate_blocks_spec,
            validate_diagram_decision,
            validate_flow_spec,
            validate_layered_spec,
        )

        # 模板类引擎（LLM 出结构化 spec → HTML 模板渲染）：builder / validator / 默认图名
        spec_engines = {
            "layered": (build_layered_spec_messages, validate_layered_spec, "分层架构图"),
            "blocks": (build_blocks_spec_messages, validate_blocks_spec, "区块架构图"),
            "flow": (build_flow_spec_messages, validate_flow_spec, "流程图"),
        }

        try:
            decision = await self.ai.collect_json_response(
                messages=build_diagram_decision_messages(
                    chapter_title=chapter_title,
                    chapter_description=chapter_description,
                    chapter_content=chapter_content,
                    project_overview=project_overview,
                ),
                temperature=0.4,
                validator=validate_diagram_decision,
                progress_label="配图决策",
                failure_message="配图决策 JSON 无效",
            )
        except Exception as exc:
            logger.warning("配图决策失败（章节：%s）：%s", chapter_title, exc)
            return None

        if not decision.get("need"):
            return None

        engine = str(decision.get("engine") or "").strip().lower()
        title = decision.get("title") or f"{chapter_title}示意图"
        diagram_type = decision.get("diagram_type") or ""

        # 模板类引擎(layered/blocks/flow)：单独再发一次结构化 spec 生成请求
        if engine in spec_engines:
            spec_builder, spec_validator, default_type = spec_engines[engine]
            for attempt in range(2):
                try:
                    spec = await self.ai.collect_json_response(
                        messages=spec_builder(
                            chapter_title=chapter_title,
                            chapter_description=chapter_description,
                            chapter_content=chapter_content,
                            project_overview=project_overview,
                        ),
                        temperature=0.5,
                        validator=spec_validator,
                        progress_label=f"{default_type}数据",
                        failure_message=f"{default_type} spec 无效",
                    )
                    spec_json = _json.dumps(spec, ensure_ascii=False)
                    png = DiagramRenderer.render(engine, spec_json)
                    return {
                        "engine": engine,
                        "diagram_type": diagram_type or default_type,
                        "title": title,
                        "code": spec_json,
                        "png": png,
                    }
                except Exception as exc:
                    logger.info("%s生成失败(第%s次，章节：%s)：%s",
                                default_type, attempt + 1, chapter_title, str(exc)[:200])
            logger.warning("章节「%s」%s多次失败，已跳过", chapter_title, default_type)
            return None

        code = strip_code_fence(str(decision.get("code") or ""))

        last_err = ""
        for attempt in range(DIAGRAM_FIX_ROUNDS + 1):
            try:
                png = DiagramRenderer.render(engine, code)
                return {
                    "engine": engine,
                    "diagram_type": diagram_type,
                    "title": title,
                    "code": code,
                    "png": png,
                }
            except DiagramRenderError as exc:
                last_err = str(exc)
                logger.info("配图渲染失败(第%s次，章节：%s)：%s", attempt + 1, chapter_title, last_err[:200])
                if attempt == DIAGRAM_FIX_ROUNDS:
                    break
                try:
                    fixed = await self.ai.collect_chat_completion(
                        build_diagram_fix_messages(engine, code, last_err),
                        temperature=0.2,
                    )
                    code = strip_code_fence(fixed)
                except Exception as fix_exc:
                    logger.warning("配图纠错请求失败：%s", fix_exc)
                    break

        logger.warning("章节「%s」配图多次渲染失败，已跳过：%s", chapter_title, last_err[:200])
        return None


# 一次导出最多尝试配图的叶子章节数（控制 LLM 调用成本与导出时长）
MAX_DIAGRAMS_PER_DOC = 24
# 配图并发：mermaid/layered 都要起无头 Chrome，并发过高会争用导致偶发渲染超时丢图，取 2 更稳
DIAGRAM_CONCURRENCY = 2


async def attach_diagrams_to_outline(
    items: List[Any],
    project_overview: str = "",
    ai=None,
    max_diagrams: int = MAX_DIAGRAMS_PER_DOC,
    concurrency: int = DIAGRAM_CONCURRENCY,
) -> int:
    """为导出用 outline（WordExportOutlineItem 列表）的叶子章节生成并附加配图。

    直接在节点上写 image_b64 / image_title，返回成功配图数。
    失败/不配图的章节静默跳过，绝不打断导出。
    """
    svc = DiagramService(ai=ai)

    leaves: List[Any] = []

    def _walk(nodes: List[Any]) -> None:
        for n in nodes:
            kids = getattr(n, "children", None)
            if kids:
                _walk(kids)
            elif (getattr(n, "content", "") or "").strip():
                leaves.append(n)

    _walk(items)
    leaves = leaves[:max_diagrams]
    if not leaves:
        return 0

    sem = asyncio.Semaphore(max(1, concurrency))
    count = 0

    async def _one(node: Any) -> None:
        nonlocal count
        async with sem:
            try:
                res = await svc.generate_for_chapter(
                    chapter_title=getattr(node, "title", "") or "",
                    chapter_description=getattr(node, "description", "") or "",
                    chapter_content=getattr(node, "content", "") or "",
                    project_overview=project_overview,
                )
            except Exception as exc:
                logger.warning("章节配图异常，跳过：%s", exc)
                return
            if res and res.get("png"):
                node.image_b64 = base64.b64encode(res["png"]).decode("ascii")
                node.image_title = res.get("title") or ""
                count += 1

    await asyncio.gather(*[_one(l) for l in leaves], return_exceptions=True)
    return count
