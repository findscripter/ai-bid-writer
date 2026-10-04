"""字数预算：把目标总字数按权重分到每个叶子章节。

与旧的等权均摊（utils/budget.py）相比：
- 支持权重（来自写作计划，核心章节多写、说明性章节少写）；
- 钳制到 [min, max] 之后，把多出来或不够的部分在其余章节间重新分配，
  总和在可行范围内精确等于目标总字数。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List

MIN_WORDS_PER_CHAPTER = 200
MAX_WORDS_PER_CHAPTER = 8000
MIN_WEIGHT = 0.2
MAX_WEIGHT = 5.0


@dataclass
class BudgetResult:
    """预算分配结果。"""

    words: Dict[str, int] = field(default_factory=dict)
    total_target: int = 0
    total_allocated: int = 0
    clamped_low: List[str] = field(default_factory=list)
    clamped_high: List[str] = field(default_factory=list)
    note: str = ""


def allocate_budget(
    leaf_uids: List[str],
    weights: Dict[str, float] | None,
    total_words: int,
    min_words: int = MIN_WORDS_PER_CHAPTER,
    max_words: int = MAX_WORDS_PER_CHAPTER,
) -> BudgetResult:
    """按权重分配字数。

    做法是“注水”：先按权重比例分；低于下限的固定为下限、高于上限的固定为上限，
    再把剩余字数在未固定的章节间按权重重分，直到没有越界为止；最后用最大余数法取整。
    """
    result = BudgetResult(total_target=max(int(total_words), 0))
    uids = [u for u in leaf_uids if u]
    if not uids:
        return result
    min_words = max(int(min_words), 1)
    max_words = max(int(max_words), min_words)
    weights = weights or {}

    def _weight(uid: str) -> float:
        try:
            value = float(weights.get(uid, 1.0))
        except (TypeError, ValueError):
            value = 1.0
        if value != value or value <= 0:  # NaN 或非正数
            value = 1.0
        return min(max(value, MIN_WEIGHT), MAX_WEIGHT)

    w = {uid: _weight(uid) for uid in uids}
    total = result.total_target
    count = len(uids)

    if total <= count * min_words:
        result.words = {uid: min_words for uid in uids}
        result.clamped_low = list(uids)
        result.total_allocated = count * min_words
        if total < count * min_words:
            result.note = (
                f"目录有 {count} 个叶子章节，按每章最少 {min_words} 字计已超出目标总字数；"
                "建议提高目标页数或精简目录。"
            )
        return result
    if total >= count * max_words:
        result.words = {uid: max_words for uid in uids}
        result.clamped_high = list(uids)
        result.total_allocated = count * max_words
        if total > count * max_words:
            result.note = (
                f"目录只有 {count} 个叶子章节，按每章最多 {max_words} 字计达不到目标总字数；"
                "建议细化目录或降低目标页数。"
            )
        return result

    fixed: Dict[str, int] = {}
    free = list(uids)
    remaining = float(total)
    shares: Dict[str, float] = {}
    while free:
        weight_sum = sum(w[u] for u in free)
        shares = {u: remaining * w[u] / weight_sum for u in free}
        low = [u for u in free if shares[u] < min_words]
        if low:
            for u in low:
                fixed[u] = min_words
                remaining -= min_words
            free = [u for u in free if u not in fixed]
            result.clamped_low.extend(low)
            continue
        high = [u for u in free if shares[u] > max_words]
        if high:
            for u in high:
                fixed[u] = max_words
                remaining -= max_words
            free = [u for u in free if u not in fixed]
            result.clamped_high.extend(high)
            continue
        break

    words: Dict[str, int] = dict(fixed)
    if free:
        floors = {u: int(shares[u]) for u in free}
        leftover = int(round(remaining)) - sum(floors.values())
        by_remainder = sorted(free, key=lambda u: shares[u] - floors[u], reverse=True)
        for u in by_remainder:
            if leftover <= 0:
                break
            if floors[u] < max_words:
                floors[u] += 1
                leftover -= 1
        words.update(floors)

    result.words = {uid: words[uid] for uid in uids}
    result.total_allocated = sum(result.words.values())
    return result
