"""通用『区块架构图』渲染：行(row) × 分区(zone) × 分组(group) × 网格块(cell)。

用于标书里常见的蓝色商务框图——系统部署架构、数据接入架构、数据存储架构等
（左右分区/上下分行/带容器分组的"框图"，非节点箭头图）。
结构化 spec(JSON) -> HTML/CSS -> Chrome 无头截图 PNG。
"""
from __future__ import annotations

import html as _html
import json
import logging
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from .arch_layered import _resolve_chrome, _trim_white

logger = logging.getLogger(__name__)

RENDER_TIMEOUT = 90

# 分区配色：(背景, 边框, 标题色)
_THEME = {
    "blue":   ("#e8f1fb", "#9cc1ea", "#1f5fa8"),
    "orange": ("#fdf1e3", "#e6c08a", "#b06a1e"),
    "green":  ("#e7f3e9", "#a8d0ad", "#3a7a45"),
    "gray":   ("#eef1f4", "#cdd6de", "#4a5a68"),
    "purple": ("#f0ecfb", "#c3b4e8", "#5b3fa8"),
}

_CSS = """
* { box-sizing:border-box; margin:0; padding:0; }
body { background:#fff; font-family:"Microsoft YaHei",sans-serif; padding:24px; }
.fig { width:1180px; }
.title { text-align:center; font-size:20px; font-weight:700; color:#1f2d3a; margin-bottom:16px; }
.row { display:flex; align-items:stretch; gap:8px; margin-bottom:10px; }
.rowlabel { width:120px; flex:0 0 120px; display:flex; align-items:center; justify-content:center;
            text-align:center; font-size:15px; font-weight:700; color:#33414d; background:#f4f6f8;
            border:1px solid #e2e8ee; border-radius:6px; padding:6px; }
.zones { flex:1; display:flex; gap:10px; min-width:0; }
.zone { flex:1; border-radius:8px; padding:10px; border:1.5px solid; min-width:0; }
.ztitle { text-align:center; font-weight:700; font-size:15px; margin-bottom:8px; }
.group { border:1px dashed rgba(0,0,0,.18); border-radius:6px; padding:6px 8px 8px; margin-bottom:8px; background:rgba(255,255,255,.55); }
.group:last-child { margin-bottom:0; }
.gname { text-align:center; font-size:12px; font-weight:600; color:#3a4a55; margin-bottom:6px; }
.grid { display:grid; gap:6px; }
.cell { background:#fff; border:1px solid #cdd9e6; border-radius:4px; color:#1f2d3a;
        font-size:13px; text-align:center; padding:9px 6px; line-height:1.3; }
.cell.full { background:#2f6fb3; color:#fff; font-weight:700; }
"""


def _esc(s: Any) -> str:
    return _html.escape(str(s))


def _grid(cells: List[Any], cols: Optional[int], full: bool = False) -> str:
    cells = [c for c in (cells or []) if str(c).strip()]
    if not cells:
        return ""
    if full:
        inner = "".join(f'<div class="cell full">{_esc(c)}</div>' for c in cells)
        return f'<div class="grid" style="grid-template-columns:1fr">{inner}</div>'
    c = cols or min(len(cells), 4)
    c = max(1, min(int(c), 8))
    inner = "".join(f'<div class="cell">{_esc(x)}</div>' for x in cells)
    return f'<div class="grid" style="grid-template-columns:repeat({c},1fr)">{inner}</div>'


def _render_zone(z: Dict[str, Any]) -> str:
    bg, bd, tc = _THEME.get(str(z.get("color", "blue")).lower(), _THEME["blue"])
    parts = []
    if z.get("title"):
        parts.append(f'<div class="ztitle" style="color:{tc}">{_esc(z["title"])}</div>')
    if z.get("groups"):
        for g in z["groups"]:
            gname = f'<div class="gname">{_esc(g["name"])}</div>' if g.get("name") else ""
            parts.append(f'<div class="group">{gname}{_grid(g.get("cells", []), g.get("columns"), g.get("full"))}</div>')
    else:
        parts.append(_grid(z.get("cells", []), z.get("columns"), z.get("full")))
    return f'<div class="zone" style="background:{bg};border-color:{bd}">{"".join(parts)}</div>'


def spec_to_html(spec: Dict[str, Any]) -> str:
    rows_html = ""
    for r in spec.get("rows") or []:
        zones = "".join(_render_zone(z) for z in (r.get("zones") or []))
        label = r.get("left", "")
        labelhtml = f'<div class="rowlabel">{_esc(label)}</div>' if label else '<div class="rowlabel"></div>'
        rows_html += f'<div class="row">{labelhtml}<div class="zones">{zones}</div></div>'
    title = f'<div class="title">{_esc(spec["title"])}</div>' if spec.get("title") else ""
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<style>{_CSS}</style></head><body>"
        f"<div class='fig'>{title}{rows_html}</div></body></html>"
    )


def render_blocks_spec(spec: Dict[str, Any]) -> bytes:
    chrome = _resolve_chrome()
    if not chrome:
        raise RuntimeError("未找到 Chrome/Edge，无法渲染区块架构图")
    rows = spec.get("rows")
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("区块架构 spec 缺少 rows")

    # 估算高度：服务端这类行可能很高，给足后由 trim 裁白边
    n_groups = sum(
        len(z.get("groups") or [1]) for r in rows for z in (r.get("zones") or [])
    )
    height = max(700, min(4200, 200 + n_groups * 90))

    html_str = spec_to_html(spec)
    with tempfile.TemporaryDirectory(prefix="blk_") as tmp:
        hp = Path(tmp) / "a.html"
        hp.write_text(html_str, encoding="utf-8")
        op = Path(tmp) / "a.png"
        args = [
            chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars",
            "--force-device-scale-factor=2", "--default-background-color=FFFFFFFF",
            f"--window-size=1240,{height}", f"--screenshot={op}", hp.as_uri(),
        ]
        proc = subprocess.run(args, capture_output=True, text=True, timeout=RENDER_TIMEOUT)
        if not op.exists():
            raise RuntimeError(
                f"区块架构图截图失败：{(proc.stderr or proc.stdout or '').strip()[:800]}"
            )
        return _trim_white(op.read_bytes())


def render_blocks(code_json: str) -> bytes:
    return render_blocks_spec(json.loads(code_json))
