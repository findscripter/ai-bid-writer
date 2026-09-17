"""正文生成服务。"""
from __future__ import annotations

import asyncio
import copy
from typing import Any, AsyncGenerator, Dict, List, Optional

from ..utils.budget import allocate_word_budget, collect_leaf_chapters
from ..utils.consolidate import consolidate_outline
from ..utils.openai_util import OpenAIUtil
from ..utils.personas import default_persona_rotation
from ..utils.prompts.content_prompts import build_chapter_content_messages
from ..utils.response_chapters import append_response_chapters
from .outline_service import OutlineService


SUMMARY_HEAD_CHARS = 220
"""跨份去重时，从前序份的章节正文截取的字符数（足够给出方向，不至于撑爆 prompt）。"""

DEFAULT_PARALLEL_CONCURRENCY = 3
"""同一份内章节并行生成的最大并发数（受 LLM 服务并发限制约束，建议 2-3）。"""

CONTINUATION_MAX_ROUNDS = 4
"""字数不达标时，最多追加的续写轮数（防止无限循环）。"""

CONTINUATION_MIN_GAIN = 30
"""单轮续写新增字数低于该阈值则停止（模型已写不动，避免空转）。"""

WORD_TARGET_LOWER_RATIO = 0.85
"""实际字数达到 目标字数 × 该比例 即视为达标（与 prompt 中的下限保持一致）。"""


def _summarize_for_dedup(text: str, head_chars: int = SUMMARY_HEAD_CHARS) -> str:
    """生成跨份去重用的章节摘要：取正文开头 head_chars 字符并压缩空白。"""
    if not text:
        return ""
    cleaned = " ".join(text.split())
    if len(cleaned) <= head_chars:
        return cleaned
    return cleaned[:head_chars] + "…"


def _siblings_for(node_id: str, parent: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not parent:
        return []
    return [c for c in (parent.get("children") or []) if c.get("id") != node_id]


def _index_outline(
    outline: Dict[str, Any] | List[Dict[str, Any]],
) -> Dict[str, Dict[str, Any]]:
    """构建 chapter_id → {parents:[...], parent: ...} 的索引，方便单章节定位。"""
    if isinstance(outline, dict):
        roots = outline.get("outline") or outline.get("children") or []
        if not roots and outline.get("id"):
            roots = [outline]
    else:
        roots = outline or []

    index: Dict[str, Dict[str, Any]] = {}

    def _walk(node: Dict[str, Any], parents: List[Dict[str, Any]]) -> None:
        nid = node.get("id")
        if nid:
            index[nid] = {"node": node, "parents": list(parents), "parent": parents[-1] if parents else None}
        for c in node.get("children") or []:
            _walk(c, parents + [node])

    for r in roots:
        _walk(r, [])
    return index


def _fallback_chapter_text(chapter: Dict[str, Any]) -> str:
    """当模型返回空文本或失败时，给出最小可用兜底正文，确保不出现空章节。"""
    cid = chapter.get("id", "")
    title = chapter.get("title", "")
    desc = (chapter.get("description") or "").strip()
    desc_line = desc if desc else "本章节按照招标文件要求进行响应。"
    return (
        f"{title}章节响应如下：\n"
        f"1) 章节定位：针对{cid} {title}开展实施。\n"
        f"2) 响应要点：{desc_line}\n"
        f"3) 实施方式：通过需求梳理、方案设计、实施验证与交付保障四步执行。\n"
        f"4) 交付结果：形成可验收的章节成果，并纳入总体实施与运维体系。"
    )


class ContentService:
    """负责目录叶子章节的正文生成。"""

    def __init__(self, ai: OpenAIUtil | None = None):
        self.ai = ai or OpenAIUtil()

    async def stream_chapter_content(
        self,
        chapter: dict[str, Any],
        parent_chapters: list[dict[str, Any]] | None = None,
        sibling_chapters: list[dict[str, Any]] | None = None,
        project_overview: str = "",
        target_words: Optional[int] = None,
        persona: Optional[str] = None,
        prior_summaries: Optional[List[Dict[str, str]]] = None,
    ) -> AsyncGenerator[str, None]:
        """流式生成单章节内容。

        若设置了 target_words，则在首轮生成后做"未达标续写"：实际字数不足
        目标下限时，带上已写内容让模型继续补足，直到达标或触达轮数/产出下限。
        续写产生的文本同样以流式 chunk 形式输出，前端无需感知分轮。
        """
        messages = build_chapter_content_messages(
            chapter=chapter,
            parent_chapters=parent_chapters,
            sibling_chapters=sibling_chapters,
            project_overview=project_overview,
            target_words=target_words,
            persona=persona,
            prior_summaries=prior_summaries,
        )

        accumulated: List[str] = []
        async for chunk in self.ai.stream_chat_completion(messages, temperature=0.7):
            accumulated.append(chunk)
            yield chunk

        if not target_words or target_words <= 0:
            return

        lower = max(int(target_words * WORD_TARGET_LOWER_RATIO), 100)
        rounds = 0
        while rounds < CONTINUATION_MAX_ROUNDS:
            current = len("".join(accumulated).strip())
            if current >= lower:
                break
            rounds += 1
            gap = max(target_words - current, 100)
            continuation_messages = messages + [
                {"role": "assistant", "content": "".join(accumulated).strip()},
                {
                    "role": "user",
                    "content": (
                        f"以上正文目前约 {current} 字，未达到目标 {target_words} 字，还差约 {gap} 字。"
                        "请紧接着上文继续撰写后续内容：保持同一章节主题、术语与写作风格，"
                        "补充新的技术细节、实施步骤、关键参数或案例，"
                        "不要重复或改写已写内容，不要重新开头，不要写结束语或总结，"
                        "不要任何说明文字，直接输出续写的正文。"
                    ),
                },
            ]
            before = current
            async for chunk in self.ai.stream_chat_completion(
                continuation_messages, temperature=0.7
            ):
                accumulated.append(chunk)
                yield chunk
            after = len("".join(accumulated).strip())
            if after - before < CONTINUATION_MIN_GAIN:
                # 模型已写不动，停止续写以免空转
                break

    async def generate_chapter_content(
        self,
        chapter: dict[str, Any],
        parent_chapters: list[dict[str, Any]] | None = None,
        sibling_chapters: list[dict[str, Any]] | None = None,
        project_overview: str = "",
        target_words: Optional[int] = None,
        persona: Optional[str] = None,
        prior_summaries: Optional[List[Dict[str, str]]] = None,
    ) -> str:
        """生成单章节完整正文（复用流式路径，同样带未达标续写）。"""
        parts: List[str] = []
        async for chunk in self.stream_chapter_content(
            chapter=chapter,
            parent_chapters=parent_chapters,
            sibling_chapters=sibling_chapters,
            project_overview=project_overview,
            target_words=target_words,
            persona=persona,
            prior_summaries=prior_summaries,
        ):
            parts.append(chunk)
        return "".join(parts)

    async def stream_multi_copies(
        self,
        outline: Dict[str, Any] | List[Dict[str, Any]],
        project_overview: str,
        target_pages: int,
        words_per_page: int,
        copies: int,
        personas: Optional[List[Dict[str, str]]] = None,
        extended_target_pages: Optional[int] = None,
        inject_response_chapters: bool = True,
        parallel_concurrency: int = DEFAULT_PARALLEL_CONCURRENCY,
        models: Optional[List[str]] = None,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """逐份生成多份不雷同正文。同份内"普通章节"并行、"响应章节"串行去重。

        参数：
        - extended_target_pages: 若提供，则最后一份用此页数（长版/完整版）
        - inject_response_chapters: 若 True，目录末尾自动追加 5 个强制响应章节
        - parallel_concurrency: 同一份内普通章节的并发上限（响应章节始终串行）
        - models: 每份使用的模型ID，按份轮转（该份的目录变体和正文都用此模型）；
                  空则全部用全局配置模型
        """
        # ---------- 解析用户基准目录（不含响应章节）----------
        if isinstance(outline, dict):
            base_roots = outline.get("outline") or outline.get("children") or []
            if not base_roots and outline.get("id"):
                base_roots = [outline]
        else:
            base_roots = list(outline) if outline else []

        if not personas or len(personas) < copies:
            personas = default_persona_rotation(copies)

        # 每份模型轮转：models[i % len] -> 该份的目录变体 + 正文都用此模型
        model_pool = [m.strip() for m in (models or []) if m and m.strip()]
        # 用"较大"的页数估算理想叶子数（避免短版过度合并影响长版）
        consolidation_pages = max(target_pages, extended_target_pages or 0)

        def _top_titles(roots: List[Dict[str, Any]]) -> List[str]:
            return [str(r.get("title") or "") for r in roots]

        # ---------- 1) 逐份规划目录：第 1 份用原目录，其余份生成"结构变体" ----------
        plans: List[Dict[str, Any]] = []
        avoid_top_titles: List[List[str]] = []

        for copy_index in range(copies):
            is_last_copy = (copy_index == copies - 1) and extended_target_pages is not None
            current_pages = extended_target_pages if is_last_copy else target_pages
            persona_obj = personas[copy_index] if copy_index < len(personas) else None
            persona_text = (persona_obj or {}).get("description", "")

            # 该份绑定的模型（目录变体 + 正文共用）
            copy_model = (
                model_pool[copy_index % len(model_pool)] if model_pool else None
            )
            copy_ai = OpenAIUtil(model_name=copy_model) if copy_model else self.ai

            variant_failed = False
            if copy_index == 0:
                # 第 1 份保留用户在"目录编辑"里确认的原目录
                variant_roots = copy.deepcopy(base_roots)
            else:
                try:
                    variant = await OutlineService(ai=copy_ai).generate_structure_variant(
                        base_outline=base_roots,
                        overview=project_overview,
                        avoid_top_titles=avoid_top_titles,
                        variant_index=copy_index,
                        persona_desc=persona_text,
                    )
                    variant_roots = variant.get("outline") or copy.deepcopy(base_roots)
                except Exception:
                    # 变体生成失败则回退到原目录，保证该份仍可正常出正文
                    variant_roots = copy.deepcopy(base_roots)
                    variant_failed = True

            avoid_top_titles.append(_top_titles(variant_roots))

            # 注入固定响应章节（按用户要求：响应章节结构跨份保持一致）
            roots_with_resp = (
                append_response_chapters(variant_roots)
                if inject_response_chapters
                else variant_roots
            )
            roots_cons, consolidation_stats = consolidate_outline(
                roots_with_resp,
                target_pages=consolidation_pages,
                words_per_page=words_per_page,
            )
            effective_outline = {"outline": roots_cons}
            leaves = collect_leaf_chapters(effective_outline)
            response_leaves = [l for l in leaves if l.get("is_response_chapter")]
            normal_leaves = [l for l in leaves if not l.get("is_response_chapter")]
            budget = allocate_word_budget(effective_outline, current_pages, words_per_page)
            outline_index = _index_outline(effective_outline)

            plans.append({
                "copy_index": copy_index,
                "persona_obj": persona_obj,
                "persona_text": persona_text,
                "is_extended": is_last_copy,
                "target_pages": current_pages,
                "outline": roots_cons,
                "leaves": leaves,
                "normal_leaves": normal_leaves,
                "response_leaves": response_leaves,
                "budget": budget,
                "index": outline_index,
                "leaf_count": len(leaves),
                "variant_failed": variant_failed,
                "consolidation": consolidation_stats,
                "model": copy_ai.model_name,
                "ai": copy_ai,
            })

        total_leaf_count = sum(p["leaf_count"] for p in plans)

        # ---------- 2) meta：下发每份目录树与总进度 ----------
        yield {
            "type": "meta",
            "copies": copies,
            "total_leaf_count": total_leaf_count,
            "leaf_count": total_leaf_count,  # 兼容旧前端字段（进度分母）
            "target_pages": target_pages,
            "extended_target_pages": extended_target_pages,
            "words_per_page": words_per_page,
            "personas": personas,
            "injected_response_chapters": inject_response_chapters,
            "parallel_concurrency": parallel_concurrency,
            "copies_plan": [
                {
                    "copy_index": p["copy_index"],
                    "leaf_count": p["leaf_count"],
                    "is_extended": p["is_extended"],
                    "target_pages": p["target_pages"],
                    "persona": p["persona_obj"],
                    "variant_failed": p["variant_failed"],
                    "model": p["model"],
                }
                for p in plans
            ],
        }

        # 跨份去重摘要：仅响应章节（结构跨份一致），按"标题"为 key（不依赖会变的编号）
        prior_by_chapter: Dict[str, List[Dict[str, str]]] = {}

        # ---------- 3) 逐份生成正文（每份用自己绑定的模型） ----------
        for p in plans:
            copy_index = p["copy_index"]
            yield {
                "type": "copy_start",
                "copy_index": copy_index,
                "persona": p["persona_obj"],
                "is_extended": p["is_extended"],
                "target_pages": p["target_pages"],
                "leaf_count": p["leaf_count"],
                "outline": p["outline"],
                "variant_failed": p["variant_failed"],
                "model": p["model"],
            }

            copy_service = (
                self if p["ai"] is self.ai else ContentService(ai=p["ai"])
            )

            # ===== 1) 普通章节并行生成 =====
            async for ev in copy_service._run_parallel_chapters(
                leaves=p["normal_leaves"],
                copy_index=copy_index,
                persona_obj=p["persona_obj"],
                persona_text=p["persona_text"],
                project_overview=project_overview,
                budget=p["budget"],
                outline_index=p["index"],
                concurrency=parallel_concurrency,
            ):
                yield ev

            # ===== 2) 响应章节串行生成（保留跨份去重）=====
            for leaf in p["response_leaves"]:
                async for ev in copy_service._run_serial_chapter(
                    leaf=leaf,
                    copy_index=copy_index,
                    persona_obj=p["persona_obj"],
                    persona_text=p["persona_text"],
                    project_overview=project_overview,
                    budget=p["budget"],
                    outline_index=p["index"],
                    prior_by_chapter=prior_by_chapter,
                ):
                    yield ev

            yield {"type": "copy_end", "copy_index": copy_index}

        yield {"type": "all_done"}

    async def _run_serial_chapter(
        self,
        leaf: Dict[str, Any],
        copy_index: int,
        persona_obj: Optional[Dict[str, str]],
        persona_text: str,
        project_overview: str,
        budget: Dict[str, int],
        outline_index: Dict[str, Dict[str, Any]],
        prior_by_chapter: Dict[str, List[Dict[str, str]]],
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """串行生成单个章节（带跨份摘要去重，发流式 chunk 事件）。"""
        chapter_id = leaf.get("id", "")
        # 响应章节跨份结构一致，但各份编号可能不同；用标题作为去重 key 才能跨份对齐
        dedup_key = (leaf.get("title") or "").strip() or chapter_id
        target_words = budget.get(chapter_id)
        idx_entry = outline_index.get(chapter_id, {})
        parent = idx_entry.get("parent")
        parents_chain = idx_entry.get("parents") or []
        siblings = _siblings_for(chapter_id, parent)
        priors = prior_by_chapter.get(dedup_key, [])

        yield {
            "type": "chapter_start",
            "copy_index": copy_index,
            "chapter_id": chapter_id,
            "title": leaf.get("title", ""),
            "target_words": target_words,
            "persona_id": (persona_obj or {}).get("id"),
            "is_response_chapter": True,
        }

        buffer: List[str] = []
        async for chunk in self.stream_chapter_content(
            chapter=leaf,
            parent_chapters=parents_chain,
            sibling_chapters=siblings,
            project_overview=project_overview,
            target_words=target_words,
            persona=persona_text,
            prior_summaries=priors or None,
        ):
            buffer.append(chunk)
            yield {
                "type": "chapter_chunk",
                "copy_index": copy_index,
                "chapter_id": chapter_id,
                "delta": chunk,
            }

        full_text = "".join(buffer).strip()
        if not full_text:
            full_text = _fallback_chapter_text(leaf)
        yield {
            "type": "chapter_end",
            "copy_index": copy_index,
            "chapter_id": chapter_id,
            "content": full_text,
            "char_count": len(full_text),
        }

        prior_by_chapter.setdefault(dedup_key, []).append(
            {
                "copy_index": str(copy_index + 1),
                "summary": _summarize_for_dedup(full_text),
            }
        )

    async def _run_parallel_chapters(
        self,
        leaves: List[Dict[str, Any]],
        copy_index: int,
        persona_obj: Optional[Dict[str, str]],
        persona_text: str,
        project_overview: str,
        budget: Dict[str, int],
        outline_index: Dict[str, Dict[str, Any]],
        concurrency: int,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """并行生成一组章节（用 Queue 把多任务事件汇集到主流）。"""
        if not leaves:
            return

        queue: asyncio.Queue = asyncio.Queue()
        sem = asyncio.Semaphore(max(1, concurrency))

        async def worker(leaf: Dict[str, Any]) -> None:
            async with sem:
                chapter_id = leaf.get("id", "")
                target_words = budget.get(chapter_id)
                idx_entry = outline_index.get(chapter_id, {})
                parent = idx_entry.get("parent")
                parents_chain = idx_entry.get("parents") or []
                siblings = _siblings_for(chapter_id, parent)

                await queue.put({
                    "type": "chapter_start",
                    "copy_index": copy_index,
                    "chapter_id": chapter_id,
                    "title": leaf.get("title", ""),
                    "target_words": target_words,
                    "persona_id": (persona_obj or {}).get("id"),
                    "is_response_chapter": False,
                })

                buffer: List[str] = []
                last_exc: Exception | None = None
                max_attempts = 3
                for attempt in range(max_attempts):
                    buffer = []
                    try:
                        async for chunk in self.stream_chapter_content(
                            chapter=leaf,
                            parent_chapters=parents_chain,
                            sibling_chapters=siblings,
                            project_overview=project_overview,
                            target_words=target_words,
                            persona=persona_text,
                            prior_summaries=None,  # 并行模式无跨份摘要
                        ):
                            buffer.append(chunk)
                            await queue.put({
                                "type": "chapter_chunk",
                                "copy_index": copy_index,
                                "chapter_id": chapter_id,
                                "delta": chunk,
                            })
                        last_exc = None
                        break
                    except Exception as exc:
                        last_exc = exc
                        msg = str(exc).lower()
                        is_retryable = (
                            "concurrency" in msg or "rate" in msg or "429" in msg
                            or "too many" in msg or "timeout" in msg
                        )
                        if not is_retryable or attempt == max_attempts - 1:
                            break
                        # 指数退避 + 章节 id 抖动避免雷群
                        backoff = 2 ** attempt + (abs(hash(chapter_id)) % 4)
                        await asyncio.sleep(backoff)

                if last_exc is None:
                    full_text = "".join(buffer).strip()
                    if not full_text:
                        full_text = _fallback_chapter_text(leaf)
                    await queue.put({
                        "type": "chapter_end",
                        "copy_index": copy_index,
                        "chapter_id": chapter_id,
                        "content": full_text,
                        "char_count": len(full_text),
                    })
                else:
                    await queue.put({
                        "type": "chapter_end",
                        "copy_index": copy_index,
                        "chapter_id": chapter_id,
                        "content": f"[生成失败，已重试 {max_attempts} 次] {last_exc}",
                        "char_count": 0,
                        "error": True,
                    })

        # 启动所有 worker
        tasks = [asyncio.create_task(worker(l)) for l in leaves]
        completed_count = 0
        finished_marker = object()

        async def watcher() -> None:
            await asyncio.gather(*tasks, return_exceptions=True)
            await queue.put(finished_marker)

        watcher_task = asyncio.create_task(watcher())

        while True:
            ev = await queue.get()
            if ev is finished_marker:
                break
            yield ev

        await watcher_task
