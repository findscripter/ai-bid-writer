"""分层架构全景图渲染：结构化 spec(JSON) -> HTML/CSS -> Chrome 无头截图 PNG。

用于标书「系统总体架构/技术架构/平台能力全景」这类章节——这种"左右分层标签 +
中间分组网格块 + 底部基础设施"的版式不是 mermaid/plantuml 节点箭头图能表达的，
改用固定 HTML/CSS 模板渲染，LLM 只负责产出层级数据，样式完全可控。
"""
from __future__ import annotations

import html as _html
import io
import json
import logging
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_BACKEND_DIR = Path(__file__).resolve().parents[2]
_TOOLS_DIR = _BACKEND_DIR / "tools"

RENDER_TIMEOUT = 90

_CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]


def _resolve_chrome() -> Optional[str]:
    env = os.environ.get("DIAGRAM_CHROME_PATH")
    if env and Path(env).exists():
        return env
    # 复用 mermaid 的 puppeteer 配置里的 executablePath
    cfg = _TOOLS_DIR / "puppeteer-config.json"
    if cfg.exists():
        try:
            ep = json.loads(cfg.read_text(encoding="utf-8")).get("executablePath")
            if ep and Path(ep).exists():
                return ep
        except Exception:
            pass
    for c in _CHROME_CANDIDATES:
        if Path(c).exists():
            return c
    return None


_CSS = """
* { box-sizing: border-box; margin:0; padding:0; }
body { background:#fff; font-family:"Microsoft YaHei","微软雅黑",sans-serif; padding:24px; }
.arch { width:1240px; }
.title { text-align:center; font-size:20px; font-weight:700; color:#1f2d3a; margin-bottom:16px; }
.layer { display:flex; align-items:stretch; margin-bottom:10px; gap:8px; }
.tier { width:96px; flex:0 0 96px; background:#4f9e89; color:#fff; border-radius:6px;
        display:flex; align-items:center; justify-content:center; text-align:center;
        font-size:16px; font-weight:700; letter-spacing:1px; padding:6px; }
.body { flex:1; display:flex; flex-direction:column; gap:8px; min-width:0; }
.group { border:1px dashed #b9ccc4; border-radius:6px; padding:8px 10px 10px; background:#fff; }
.group > .gtitle { text-align:center; font-size:14px; font-weight:700; color:#3a4a44; margin-bottom:8px; }
.subrow { display:flex; gap:10px; }
.subgroup { flex:1; border:1px dashed #cdd8e2; border-radius:6px; padding:6px 8px 8px; }
.subgroup > .stitle { text-align:center; font-size:13px; font-weight:700; color:#2563eb; margin-bottom:6px; }
.grid { display:grid; gap:6px; }
.cell { background:#eef2f5; border:1px solid #e2e8ee; border-radius:4px; color:#1f2d3a;
        font-size:13px; text-align:center; padding:9px 6px; line-height:1.3; }
.infra .cell { font-weight:600; }
"""


def _esc(s: Any) -> str:
    return _html.escape(str(s))


def _render_grid(cells: List[Any], columns: Optional[int]) -> str:
    cells = [c for c in (cells or []) if str(c).strip()]
    if not cells:
        return ""
    cols = columns or min(len(cells), 4)
    cols = max(1, min(int(cols), 8))
    inner = "".join(f'<div class="cell">{_esc(c)}</div>' for c in cells)
    return f'<div class="grid" style="grid-template-columns:repeat({cols},1fr)">{inner}</div>'


def _render_group(g: Dict[str, Any]) -> str:
    title = f'<div class="gtitle">{_esc(g["name"])}</div>' if g.get("name") else ""
    if g.get("subgroups"):
        subs = ""
        for sg in g["subgroups"]:
            subs += (
                f'<div class="subgroup"><div class="stitle">{_esc(sg.get("name",""))}</div>'
                f'{_render_grid(sg.get("cells", []), sg.get("columns"))}</div>'
            )
        body = f'<div class="subrow">{subs}</div>'
    else:
        body = _render_grid(g.get("cells", []), g.get("columns"))
    return f'<div class="group">{title}{body}</div>'


def spec_to_html(spec: Dict[str, Any]) -> str:
    layers = spec.get("layers") or []
    parts = []
    title = spec.get("title")
    if title:
        parts.append(f'<div class="title">{_esc(title)}</div>')
    for ly in layers:
        groups = "".join(_render_group(g) for g in (ly.get("groups") or []))
        parts.append(
            f'<div class="layer"><div class="tier">{_esc(ly.get("left",""))}</div>'
            f'<div class="body">{groups}</div>'
            f'<div class="tier">{_esc(ly.get("right",""))}</div></div>'
        )
    infra = spec.get("infra")
    if infra and infra.get("items"):
        cells = "".join(f'<div class="cell">{_esc(i)}</div>' for i in infra["items"])
        n = len(infra["items"])
        grid = f'<div class="grid" style="grid-template-columns:repeat({n},1fr)">{cells}</div>'
        parts.append(
            f'<div class="layer infra"><div class="tier">{_esc(infra.get("left",""))}</div>'
            f'<div class="body"><div class="group">{grid}</div></div>'
            f'<div class="tier">{_esc(infra.get("right",""))}</div></div>'
        )
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<style>{_CSS}</style></head><body>"
        f"<div class='arch'>{''.join(parts)}</div></body></html>"
    )


def _trim_white(raw: bytes) -> bytes:
    try:
        from PIL import Image, ImageChops

        im = Image.open(io.BytesIO(raw)).convert("RGB")
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bbox = ImageChops.difference(im, bg).getbbox()
        if bbox:
            pad = 20
            bbox = (
                max(0, bbox[0] - pad), max(0, bbox[1] - pad),
                min(im.width, bbox[2] + pad), min(im.height, bbox[3] + pad),
            )
            im = im.crop(bbox)
        out = io.BytesIO()
        im.save(out, format="PNG")
        return out.getvalue()
    except Exception as exc:
        logger.info("分层架构图白边裁剪跳过：%s", exc)
        return raw


def render_layered_spec(spec: Dict[str, Any]) -> bytes:
    """spec(dict) -> PNG bytes。失败抛 RuntimeError。"""
    chrome = _resolve_chrome()
    if not chrome:
        raise RuntimeError("未找到 Chrome/Edge，无法渲染分层架构图")
    if not (spec.get("layers")):
        raise RuntimeError("分层架构 spec 缺少 layers")

    # 估算高度：每个 group 行约 90px，层标题+边距
    n_groups = sum(len(ly.get("groups") or []) for ly in spec["layers"]) + 2
    height = max(700, min(4000, 140 + n_groups * 120))

    html_str = spec_to_html(spec)
    with tempfile.TemporaryDirectory(prefix="arch_") as tmp:
        hp = Path(tmp) / "a.html"
        hp.write_text(html_str, encoding="utf-8")
        op = Path(tmp) / "a.png"
        args = [
            chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars",
            "--force-device-scale-factor=2", "--default-background-color=FFFFFFFF",
            f"--window-size=1300,{height}", f"--screenshot={op}", hp.as_uri(),
        ]
        proc = subprocess.run(args, capture_output=True, text=True, timeout=RENDER_TIMEOUT)
        if not op.exists():
            raise RuntimeError(
                f"分层架构图截图失败：{(proc.stderr or proc.stdout or '').strip()[:800]}"
            )
        return _trim_white(op.read_bytes())


def render_layered(code_json: str) -> bytes:
    """code_json: spec 的 JSON 字符串 -> PNG bytes。"""
    spec = json.loads(code_json)
    return render_layered_spec(spec)
