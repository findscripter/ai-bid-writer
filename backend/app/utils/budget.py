"""字数预算工具：把"目标页数"分配到每个叶子章节。

经验值：A4 / 小四宋体 / 1.5 倍行距，约 750 字/页。
按"叶子章节均摊"策略，每个叶子章节拿到一份等权预算，
最低保底 300 字，最高单章封顶 8000 字。
"""
from __future__ import annotations

from typing import Any, Dict, List


MIN_WORDS_PER_CHAPTER = 200
MAX_WORDS_PER_CHAPTER = 8000


def collect_leaf_chapters(outline: Dict[str, Any] | List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """递归收集所有叶子章节（无 children 或 children 为空）。"""
    items: List[Dict[str, Any]]
    if isinstance(outline, dict):
        items = outline.get("outline") or outline.get("children") or []
        if not items and outline.get("id"):
            items = [outline]
    else:
        items = outline or []

    leaves: List[Dict[str, Any]] = []

    def _walk(node: Dict[str, Any]) -> None:
        children = node.get("children") or []
        if not children:
            leaves.append(node)
            return
        for c in children:
            _walk(c)

    for item in items:
        _walk(item)

    return leaves


def allocate_word_budget(
    outline: Dict[str, Any] | List[Dict[str, Any]],
    target_pages: int,
    words_per_page: int = 750,
) -> Dict[str, int]:
    """根据目标页数分配每个叶子章节的字数预算。

    返回 {chapter_id: target_words}。
    采用等权均摊，单章受 [MIN, MAX] 钳制。
    """
    leaves = collect_leaf_chapters(outline)
    if not leaves:
        return {}

    total_words = max(target_pages, 1) * max(words_per_page, 1)
    per_leaf = total_words // len(leaves)
    per_leaf = max(MIN_WORDS_PER_CHAPTER, min(MAX_WORDS_PER_CHAPTER, per_leaf))

    return {leaf.get("id", f"leaf_{idx}"): per_leaf for idx, leaf in enumerate(leaves)}
