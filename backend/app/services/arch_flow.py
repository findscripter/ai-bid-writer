"""流程/进度『卡片框图』渲染：阶段(phase) × 步骤卡片(step) + 流向箭头。

把流程图、实施流程、进度计划等也画成与 layered/blocks 统一的蓝色商务卡片框图
（保留流向），替代 mermaid 那种细线节点图。spec(JSON) -> HTML/CSS -> Chrome 截图 PNG。

mode:
- process : 阶段横向排列，阶段间 ▶ 箭头，卡片内竖排步骤（流程图/方法步骤/生命周期）
- timeline: 同上，但每个阶段卡片顶部带时间标签（实施进度/工期计划）
"""
from __future__ import annotations

import html as _html
import json
import logging
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List

from .arch_layered import _resolve_chrome, _trim_white

logger = logging.getLogger(__name__)

RENDER_TIMEOUT = 90

_CSS = """
* { box-sizing:border-box; margin:0; padding:0; }
body { background:#fff; font-family:"Microsoft YaHei",sans-serif; padding:24px; }
.fig { width:1180px; }
.title { text-align:center; font-size:20px; font-weight:700; color:#1f2d3a; margin-bottom:18px; }
.flow { display:flex; align-items:stretch; justify-content:center; }
.flow.vertical { flex-direction:column; align-items:center; }
.phase { flex:1; min-width:0; border:1.5px solid #2563eb; border-radius:8px; overflow:hidden;
         background:#fff; display:flex; flex-direction:column; }
.flow.vertical .phase { width:60%; flex:none; }
.timetag { text-align:center; font-size:13px; color:#1f5fa8; font-weight:700; padding:5px; background:#e8f1fb; }
.ptitle { background:#2563eb; color:#fff; font-weight:700; text-align:center; padding:9px 8px; font-size:15px; }
.steps { padding:9px; display:flex; flex-direction:column; gap:7px; flex:1; }
.step { background:#eff6ff; border:1px solid #cdd9e6; border-left:3px solid #2563eb; border-radius:4px;
        padding:8px 9px; font-size:13px; color:#1f2d3a; line-height:1.35; }
.arrow { flex:0 0 40px; display:flex; align-items:center; justify-content:center;
         color:#2563eb; font-size:30px; font-weight:700; }
.flow.vertical .arrow { flex:0 0 36px; height:36px; }
"""


def _esc(s: Any) -> str:
    return _html.escape(str(s))


def spec_to_html(spec: Dict[str, Any]) -> str:
    phases = spec.get("phases") or []
    mode = spec.get("mode", "process")
    vertical = spec.get("direction") == "vertical"
    arrow = "▼" if vertical else "▶"

    cards = []
    for ph in phases:
        time_html = ""
        if mode == "timeline" and ph.get("time"):
            time_html = f'<div class="timetag">{_esc(ph["time"])}</div>'
        steps = "".join(
            f'<div class="step">{_esc(s)}</div>'
            for s in (ph.get("steps") or []) if str(s).strip()
        )
        cards.append(
            f'<div class="phase">{time_html}'
            f'<div class="ptitle">{_esc(ph.get("name",""))}</div>'
            f'<div class="steps">{steps}</div></div>'
        )

    joined = f'<div class="arrow">{arrow}</div>'.join(cards)
    cls = "flow vertical" if vertical else "flow"
    title = f'<div class="title">{_esc(spec["title"])}</div>' if spec.get("title") else ""
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<style>{_CSS}</style></head><body>"
        f"<div class='fig'>{title}<div class='{cls}'>{joined}</div></div></body></html>"
    )


def render_flow_spec(spec: Dict[str, Any]) -> bytes:
    chrome = _resolve_chrome()
    if not chrome:
        raise RuntimeError("未找到 Chrome/Edge，无法渲染流程框图")
    phases = spec.get("phases")
    if not isinstance(phases, list) or not phases:
        raise RuntimeError("流程 spec 缺少 phases")

    vertical = spec.get("direction") == "vertical"
    if vertical:
        n_steps = sum(len(p.get("steps") or []) for p in phases)
        height = max(700, min(4000, 160 + len(phases) * 80 + n_steps * 44))
    else:
        max_steps = max((len(p.get("steps") or []) for p in phases), default=1)
        height = max(500, min(2400, 220 + max_steps * 52))

    html_str = spec_to_html(spec)
    with tempfile.TemporaryDirectory(prefix="flow_") as tmp:
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
                f"流程框图截图失败：{(proc.stderr or proc.stdout or '').strip()[:800]}"
            )
        return _trim_white(op.read_bytes())


def render_flow(code_json: str) -> bytes:
    return render_flow_spec(json.loads(code_json))
