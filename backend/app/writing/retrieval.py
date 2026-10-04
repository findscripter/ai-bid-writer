"""本地检索：切块 + BM25，纯 Python、无额外依赖。

用在三处：
- 写某一章时，从招标原文里找出与这一章最相关的几段，模型才能引用到具体的
  指标、型号、期限，而不是只凭一段概述发挥；
- 从投标人上传的参考资料（旧方案、企业介绍）里找可复用的素材；
- 写作规划时，把没有章节认领的评分项分配给最贴切的章节。

中文不分词，直接用相邻两字的 bigram；数字、英文按词。
"""
from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass
from typing import Dict, List, Sequence

_CJK_RUN_RE = re.compile(r"[一-鿿]+")
_WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9_\-\.]*|\d+(?:\.\d+)?%?")
_HEADING_RE = re.compile(
    r"^\s*(?:第[一二三四五六七八九十百零〇\d]+[章节条部分篇]|[一二三四五六七八九十]+[、．.]|"
    r"[（(][一二三四五六七八九十\d]+[)）]|\d+(?:\.\d+){0,3}[\s、．.])"
)

_K1 = 1.5
_B = 0.75


def tokenize(text: str) -> List[str]:
    """把文本切成检索用的词项。"""
    tokens: List[str] = [m.group().lower() for m in _WORD_RE.finditer(text or "")]
    for run in _CJK_RUN_RE.findall(text or ""):
        if len(run) == 1:
            tokens.append(run)
        else:
            tokens.extend(run[i:i + 2] for i in range(len(run) - 1))
    return tokens


class BM25Index:
    """对一组文档建立的 BM25 索引。"""

    def __init__(self, docs: Sequence[str]):
        self._term_freqs: List[Counter] = []
        self._lengths: List[int] = []
        doc_freq: Counter = Counter()
        for doc in docs:
            freqs = Counter(tokenize(doc))
            self._term_freqs.append(freqs)
            self._lengths.append(sum(freqs.values()))
            doc_freq.update(freqs.keys())
        total = len(self._term_freqs)
        self._avg_len = (sum(self._lengths) / total) if total else 0.0
        self._idf: Dict[str, float] = {
            term: math.log(1.0 + (total - df + 0.5) / (df + 0.5)) for term, df in doc_freq.items()
        }

    def __len__(self) -> int:
        return len(self._term_freqs)

    def scores(self, query: str) -> List[float]:
        """返回每篇文档对 query 的得分（与建索引时的文档顺序一致）。"""
        query_terms = set(tokenize(query))
        result: List[float] = []
        for freqs, length in zip(self._term_freqs, self._lengths):
            score = 0.0
            if query_terms and length:
                norm = _K1 * (1 - _B + _B * (length / self._avg_len if self._avg_len else 1.0))
                for term in query_terms:
                    tf = freqs.get(term)
                    if tf:
                        score += self._idf.get(term, 0.0) * (tf * (_K1 + 1)) / (tf + norm)
            result.append(score)
        return result


def _is_heading(line: str) -> bool:
    stripped = line.strip()
    return 0 < len(stripped) <= 40 and bool(_HEADING_RE.match(stripped))


@dataclass
class Chunk:
    """原文的一个片段。"""

    index: int
    heading: str
    text: str
    source: str = ""


def split_chunks(text: str, chunk_chars: int = 600, max_chars: int = 900, source: str = "") -> List[Chunk]:
    """按行累积成约 chunk_chars 的片段，尽量在标题行处断开，并记下所在的标题。"""
    chunks: List[Chunk] = []
    buffer: List[str] = []
    size = 0
    heading = ""
    buffer_heading = ""

    def _flush() -> None:
        nonlocal buffer, size, buffer_heading
        body = "\n".join(buffer).strip()
        if body:
            chunks.append(Chunk(index=len(chunks), heading=buffer_heading, text=body, source=source))
        buffer = []
        size = 0
        buffer_heading = heading

    for raw_line in (text or "").splitlines():
        line = raw_line.rstrip()
        if not line.strip():
            continue
        if _is_heading(line):
            if size >= 200:
                _flush()
            heading = line.strip()
            if not buffer:
                buffer_heading = heading
        # 超长的单行（如整段表格被抽成一行）硬切，避免单个片段过大
        while len(line) > max_chars:
            if buffer:
                _flush()
            buffer.append(line[:max_chars])
            size = max_chars
            _flush()
            line = line[max_chars:]
        if not line:
            continue
        buffer.append(line)
        size += len(line)
        if size >= chunk_chars:
            _flush()
    _flush()
    return chunks


class TextIndex:
    """对一份或多份长文本的片段建立的检索索引。"""

    def __init__(self, chunks: Sequence[Chunk]):
        self.chunks: List[Chunk] = [
            Chunk(index=i, heading=c.heading, text=c.text, source=c.source) for i, c in enumerate(chunks)
        ]
        self._bm25 = BM25Index([f"{c.heading}\n{c.text}" for c in self.chunks])

    @classmethod
    def from_text(cls, text: str, chunk_chars: int = 600, source: str = "") -> "TextIndex":
        return cls(split_chunks(text, chunk_chars=chunk_chars, source=source))

    @classmethod
    def from_documents(cls, documents: Sequence[tuple], chunk_chars: int = 600) -> "TextIndex":
        """documents: [(来源名称, 全文), ...]"""
        chunks: List[Chunk] = []
        for source, text in documents:
            chunks.extend(split_chunks(text, chunk_chars=chunk_chars, source=source))
        return cls(chunks)

    def __len__(self) -> int:
        return len(self.chunks)

    def search(
        self,
        query: str,
        top_k: int = 4,
        max_chars: int = 1800,
        min_ratio: float = 0.35,
    ) -> List[Chunk]:
        """返回与 query 最相关的片段（按原文顺序），总长不超过 max_chars。

        min_ratio：得分低于最高分该比例的片段不要——宁缺毋滥，不相关的原文只会干扰写作。
        """
        if not self.chunks or not (query or "").strip():
            return []
        scores = self._bm25.scores(query)
        order = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)
        best = scores[order[0]] if order else 0.0
        if best <= 0:
            return []

        picked: List[Chunk] = []
        used = 0
        for i in order[: top_k * 2]:
            if len(picked) >= top_k or scores[i] < best * min_ratio:
                break
            chunk = self.chunks[i]
            remaining = max_chars - used
            if remaining < 150:
                break
            body = chunk.text if len(chunk.text) <= remaining else chunk.text[:remaining].rstrip() + "…"
            picked.append(Chunk(index=chunk.index, heading=chunk.heading, text=body, source=chunk.source))
            used += len(body)
        picked.sort(key=lambda c: c.index)
        return picked


# 兼容早先的命名
TenderIndex = TextIndex
