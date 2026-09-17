"""叶子章节合并器：当目录叶子数远超"理想叶子数"时，自动归并到合理粒度。

理想叶子数 = 总目标字数 / IDEAL_WORDS_PER_LEAF
当实际叶子数 > 理想 × OVERSHOOT_FACTOR 时，触发合并：
  - 从最深层开始扫描"父节点的所有子节点都是叶子"的群组
  - 把这些子叶子合并成"父节点本身"作为新叶子
  - 父节点 description 拼接所有子节点的标题+描述（喂给 LLM 写）
  - 重复直到叶子数 ≤ 理想 × OVERSHOOT_FACTOR

合并不修改原 outline，返回新对象。
"""
from __future__ import annotations

import copy
from typing import Any, Dict, List


IDEAL_WORDS_PER_LEAF = 800
"""每个叶子章节理想字数：默认 800，控制篇幅，减少冗长。"""

OVERSHOOT_FACTOR = 1.3
"""叶子数允许超过理想的倍数；超过后触发合并。"""


def _collect_leaves(roots: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """收集所有叶子节点（无 children 或 children 为空）。"""
    leaves: List[Dict[str, Any]] = []

    def walk(node: Dict[str, Any]) -> None:
        ch = node.get("children") or []
        if not ch:
            leaves.append(node)
        else:
            for c in ch:
                walk(c)

    for r in roots:
        walk(r)
    return leaves


def _depth_of(node: Dict[str, Any]) -> int:
    """计算节点深度（叶子=0，父=子最大深度+1）。"""
    ch = node.get("children") or []
    if not ch:
        return 0
    return 1 + max(_depth_of(c) for c in ch)


def _merge_children_into_parent(parent: Dict[str, Any]) -> None:
    """把 parent 的所有 children 合并进 parent 自己，使 parent 变成叶子。

    children 的 id/title/description 拼接到 parent.description 末尾，
    作为 LLM 生成时的"本章应包含以下小节要点"提示。
    """
    children = parent.get("children") or []
    if not children:
        return

    base_desc = (parent.get("description") or "").strip()
    sub_lines: List[str] = []
    if base_desc:
        sub_lines.append(base_desc)
    sub_lines.append("\n本章节应当涵盖以下若干部分（请在正文中按顺序展开，不必列出小节标题，连贯成段即可）：")
    for c in children:
        cid = c.get("id", "")
        ctitle = c.get("title", "")
        cdesc = (c.get("description") or "").strip()
        sub_lines.append(f"  · {cid} {ctitle}：{cdesc}" if cdesc else f"  · {cid} {ctitle}")

    parent["description"] = "\n".join(sub_lines)
    parent["children"] = []


def _all_children_are_leaves(node: Dict[str, Any]) -> bool:
    ch = node.get("children") or []
    if not ch:
        return False
    return all(not (c.get("children") or []) for c in ch)


def _find_groups_to_merge(roots: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """找出所有"子节点全是叶子"的父节点（这些父节点是合并候选）。"""
    candidates: List[Dict[str, Any]] = []

    def walk(node: Dict[str, Any]) -> None:
        if _all_children_are_leaves(node):
            candidates.append(node)
            return  # 已是合并候选，不再下钻
        for c in node.get("children") or []:
            walk(c)

    for r in roots:
        walk(r)
    return candidates


def consolidate_outline(
    outline: List[Dict[str, Any]] | Dict[str, Any],
    target_pages: int,
    words_per_page: int = 750,
    ideal_words_per_leaf: int = IDEAL_WORDS_PER_LEAF,
    overshoot_factor: float = OVERSHOOT_FACTOR,
) -> tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """合并粒度过细的目录，返回 (新 outline 顶层列表, 统计信息)。

    Args:
        outline: 原 outline，可以是 list 或 dict（含 outline/children 字段）
        target_pages: 短版目标页数（用于估算理想叶子数）
        words_per_page: 字数每页
        ideal_words_per_leaf: 每章理想字数
        overshoot_factor: 触发合并的叶子数倍数阈值

    Returns:
        (合并后的 outline 列表, 统计信息字典)
    """
    if isinstance(outline, dict):
        roots = outline.get("outline") or outline.get("children") or []
        if not roots and outline.get("id"):
            roots = [outline]
    else:
        roots = list(outline) if outline else []

    new_roots = copy.deepcopy(roots)

    total_target_words = max(target_pages, 1) * max(words_per_page, 1)
    ideal_leaves = max(1, total_target_words // ideal_words_per_leaf)
    threshold = int(ideal_leaves * overshoot_factor)

    initial_leaves = len(_collect_leaves(new_roots))
    rounds = 0
    max_rounds = 10  # 安全上限，防死循环

    while rounds < max_rounds:
        cur_leaves = _collect_leaves(new_roots)
        if len(cur_leaves) <= threshold:
            break

        candidates = _find_groups_to_merge(new_roots)
        if not candidates:
            break  # 没有可合并的群组（已经是顶层）

        # 优先合并子节点最少的（保留更细粒度的大群组）
        candidates.sort(key=lambda n: len(n.get("children") or []))

        merged_this_round = 0
        for cand in candidates:
            _merge_children_into_parent(cand)
            merged_this_round += 1
            if len(_collect_leaves(new_roots)) <= threshold:
                break

        if merged_this_round == 0:
            break
        rounds += 1

    final_leaves = len(_collect_leaves(new_roots))
    stats = {
        "initial_leaves": initial_leaves,
        "final_leaves": final_leaves,
        "ideal_leaves": ideal_leaves,
        "threshold": threshold,
        "rounds": rounds,
        "merged": initial_leaves - final_leaves,
    }
    return new_roots, stats
