"""目录树工具：规范化、遍历、分组、生成给模型看的目录概览。

目录节点是普通字典，字段：
- id：显示用的位置编号（"2.1.3"），每次规范化都会按位置重排；
- uid：稳定标识，正文与写作计划按它关联；
- title / description；children（可缺省）；
- 其余字段（is_response_chapter、source_requirement_id 等）原样保留。
"""
from __future__ import annotations

import hashlib
import re
from typing import Any, Dict, Iterator, List, Optional, Tuple

from .models import LeafInfo
from .textutil import clip, new_id

Node = Dict[str, Any]

# uid 会被用作文件名，只接受这一种形态；其余一律重新生成
UID_RE = re.compile(r"^[A-Za-z0-9_-]{4,64}$")


def _roots(outline: Any) -> List[Node]:
    """兼容几种传入形态：列表、{"outline": [...]}、单个节点。"""
    if isinstance(outline, dict):
        roots = outline.get("outline") or outline.get("children") or []
        if not roots and outline.get("title"):
            roots = [outline]
        return [n for n in roots if isinstance(n, dict)]
    if isinstance(outline, list):
        return [n for n in outline if isinstance(n, dict)]
    return []


def normalize_outline(outline: Any) -> List[Node]:
    """返回规范化后的新目录树（不修改入参）。

    - 没有 uid 的节点补一个；重复的 uid 只保留第一次出现，其余重新生成；
    - id 按位置重排为 1 / 1.1 / 1.1.1；
    - 去掉空的 children；去掉节点上的 content（正文单独存放）。
    """
    seen: set = set()

    def _walk(items: List[Node], prefix: str) -> List[Node]:
        result: List[Node] = []
        for index, item in enumerate(items, start=1):
            node_id = f"{prefix}.{index}" if prefix else str(index)
            node: Node = {k: v for k, v in item.items() if k not in ("children", "content")}
            uid = str(node.get("uid") or "").strip()
            if not UID_RE.match(uid) or uid in seen:
                uid = new_id()
                while uid in seen:
                    uid = new_id()
            seen.add(uid)
            node["uid"] = uid
            node["id"] = node_id
            node["title"] = str(node.get("title") or "").strip() or "未命名章节"
            node["description"] = str(node.get("description") or "").strip()
            raw_children = item.get("children")
            children = [c for c in raw_children if isinstance(c, dict)] if isinstance(raw_children, list) else []
            if children:
                node["children"] = _walk(children, node_id)
            result.append(node)
        return result

    return _walk(_roots(outline), "")


def _children(node: Node) -> List[Node]:
    raw = node.get("children")
    return [c for c in raw if isinstance(c, dict)] if isinstance(raw, list) else []


def inherit_uids(new_outline: Any, old_outline: Any) -> List[Node]:
    """重新生成目录后，让“标题路径”相同的节点沿用旧的 uid。

    这样已经写好的正文和写作计划还能对上，不会因为重新生成目录而全部失效。
    返回规范化后的新目录。
    """
    old_by_path: Dict[Tuple[str, ...], str] = {}
    for node, ancestors in iter_nodes(old_outline):
        uid = str(node.get("uid") or "")
        path = tuple(str(a.get("title") or "").strip() for a in ancestors) + (str(node.get("title") or "").strip(),)
        if uid and path not in old_by_path:
            old_by_path[path] = uid

    def _walk(items: List[Node], prefix: Tuple[str, ...]) -> List[Node]:
        result: List[Node] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            node = dict(item)
            path = prefix + (str(node.get("title") or "").strip(),)
            if not node.get("uid") and path in old_by_path:
                node["uid"] = old_by_path[path]
            children = node.get("children") or []
            if children:
                node["children"] = _walk(children, path)
            result.append(node)
        return result

    return normalize_outline(_walk(_roots(new_outline), ()))


def iter_nodes(outline: Any) -> Iterator[Tuple[Node, List[Node]]]:
    """按文档顺序遍历全部节点，产出 (节点, 祖先链)。"""

    def _walk(items: List[Node], ancestors: List[Node]) -> Iterator[Tuple[Node, List[Node]]]:
        for item in items:
            yield item, ancestors
            children = _children(item)
            if children:
                yield from _walk(children, ancestors + [item])

    yield from _walk(_roots(outline), [])


def collect_leaves(outline: Any) -> List[LeafInfo]:
    """按文档顺序收集全部叶子章节。"""
    leaves: List[LeafInfo] = []
    for node, ancestors in iter_nodes(outline):
        if _children(node):
            continue
        leaves.append(
            LeafInfo(
                uid=str(node.get("uid") or node.get("id") or ""),
                id=str(node.get("id") or ""),
                title=str(node.get("title") or ""),
                description=str(node.get("description") or ""),
                path_titles=[str(a.get("title") or "") for a in ancestors],
                parent_uid=str(ancestors[-1].get("uid") or "") if ancestors else None,
                level=len(ancestors) + 1,
                is_response_chapter=bool(node.get("is_response_chapter")),
            )
        )
    return leaves


def leaf_groups(leaves: List[LeafInfo]) -> List[List[LeafInfo]]:
    """把叶子按父节点分组（保持文档顺序）。

    同组内的章节顺序写作，后写的能参考前面兄弟章节的摘记；不同组之间并行。
    没有父节点的顶层叶子各自成组。
    """
    groups: List[List[LeafInfo]] = []
    index: Dict[str, int] = {}
    for leaf in leaves:
        key = leaf.parent_uid
        if not key:
            groups.append([leaf])
            continue
        if key not in index:
            index[key] = len(groups)
            groups.append([])
        groups[index[key]].append(leaf)
    return groups


def top_level_batches(outline: Any, max_leaves: int = 24) -> List[List[LeafInfo]]:
    """按一级章节把叶子切成批（给章节规划用）；单批过大时按父节点再拆。"""
    batches: List[List[LeafInfo]] = []
    loose: List[LeafInfo] = []

    def _flush_loose() -> None:
        while loose:
            batches.append(loose[:max_leaves])
            del loose[:max_leaves]

    for root in _roots(outline):
        leaves = collect_leaves([root])
        if not leaves:
            continue
        if not _children(root):
            loose.extend(leaves)
            continue
        _flush_loose()
        if len(leaves) <= max_leaves:
            batches.append(leaves)
            continue
        current: List[LeafInfo] = []
        for group in leaf_groups(leaves):
            if current and len(current) + len(group) > max_leaves:
                batches.append(current)
                current = []
            # 单个父节点下的叶子本身就超限时，硬切
            while len(group) > max_leaves:
                batches.append(group[:max_leaves])
                group = group[max_leaves:]
            current.extend(group)
        if current:
            batches.append(current)
    _flush_loose()
    return batches


def find_node(outline: Any, uid: str) -> Optional[Node]:
    """按 uid 查找节点。"""
    for node, _ in iter_nodes(outline):
        if node.get("uid") == uid:
            return node
    return None


def outline_fingerprint(outline: Any) -> str:
    """叶子章节 uid 序列的指纹：目录增删章节或调整顺序后会变。"""
    joined = "|".join(leaf.uid for leaf in collect_leaves(outline))
    return hashlib.sha1(joined.encode("utf-8")).hexdigest()[:16]


def leaf_set_fingerprint(outline: Any) -> str:
    """叶子章节 uid 集合的指纹：只看有哪些章节，不看顺序（只调整顺序不算变化）。"""
    joined = "|".join(sorted(leaf.uid for leaf in collect_leaves(outline)))
    return hashlib.sha1(joined.encode("utf-8")).hexdigest()[:16]


def outline_overview(outline: Any, max_depth: int = 3, max_chars: int = 6000) -> str:
    """生成给模型看的目录概览（只有编号与标题，按层级缩进）。"""
    lines: List[str] = []
    for node, ancestors in iter_nodes(outline):
        depth = len(ancestors) + 1
        if depth > max_depth:
            continue
        lines.append(f"{'  ' * (depth - 1)}{node.get('id', '')} {node.get('title', '')}")
    return clip("\n".join(lines), max_chars, suffix="\n…（目录过长，后略）")


def leaf_path(leaf: LeafInfo) -> str:
    """叶子章节的位置说明，如「第 2 章 总体方案 › 2.1 架构设计」里的标题链。"""
    return " › ".join(t for t in leaf.path_titles if t) or "（一级章节）"
