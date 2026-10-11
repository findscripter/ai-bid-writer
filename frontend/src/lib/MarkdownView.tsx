/**
 * Markdown 渲染：文稿正文、侧栏说明、招标解读共用
 *
 * 用法：
 *   <MarkdownView content={chapter.content} />                       // 文稿排版：15px、行高 1.9
 *   <MarkdownView content={plan} variant="compact" />                // 紧凑排版：13px，放侧栏
 *   <MarkdownView content={partial} streaming />                     // 流式输出中：文末带闪烁光标
 *
 * 支持：段落、标题、加粗 / 斜体 / 行内代码 / 删除线 / 链接、有序与无序列表（含嵌套）、
 *       GFM 表格（对齐标记、单元格内的行内格式和 <br>）、引用、代码围栏、分隔线。
 *
 * 行为说明（和标准 Markdown 不完全一样的地方，都是为大模型输出的中文文稿做的取舍）：
 * - 不渲染原始 HTML：除 <br> 当作换行外，其余标签按普通文字原样显示
 * - 「**小标题：**正文」这种紧贴中文标点的加粗，标准解析器认不出来，这里补上了
 * - 标题只认 # 写法：段落下面紧跟的 --- 一律当分隔线，单独一行的 - 或 === 当普通文字
 *   （标准语法会把上一段变成标题，而模型输出里出现这种行几乎都是被截断的列表符号）
 * - 顶层不认「缩进 4 格 = 代码块」（模型常用空格做首行缩进）；代码请用 ``` 围栏
 * - 图片不加载，只显示「图：说明文字」占位
 *
 * 性能：内容按块切开，每块单独 memo；流式追加时只有最后一块重新解析和渲染，
 *       前面的块（props 没变）直接跳过。所以 content 尽管每秒更新多次、整串传进来即可。
 * 流式：没写完的表格、代码围栏、加粗、行首标记都做了处理，不会先闪出一堆符号再变形。
 *
 * 另外导出 splitMarkdownBlocks 供测试和需要自行分块的场景使用。
 */
import { memo, useMemo } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import type { Components } from 'react-markdown';
import { cx, mergeClass } from '../ui/cx';

export type MarkdownVariant = 'doc' | 'compact';

export interface MarkdownViewProps {
  content: string;
  variant?: MarkdownVariant;
  /** 流式输出中：文末显示闪烁光标，并对没写完的语法做容错 */
  streaming?: boolean;
  className?: string;
}

export type MarkdownBlockKind = 'md' | 'table' | 'code' | 'hr';

export interface MarkdownBlock {
  kind: MarkdownBlockKind;
  /** md：Markdown 源文；table：表头行 + 分隔行 + 数据行的原始文本；code：围栏内的代码；hr：空串 */
  text: string;
  /** 仅 code：围栏上标注的语言 */
  lang?: string;
}

type Align = 'left' | 'center' | 'right' | null;

interface Fence {
  char: string;
  len: number;
  indent: number;
  info: string;
}

/* ------------------------------------------------------------------ */
/* 分块                                                                */
/* ------------------------------------------------------------------ */

const FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
const HR = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
// 能把上一段变成 Setext 标题的下划线行（可以带引用前缀；顶层三个以上的 - 已经先按分隔线处理了）
const SETEXT_UNDERLINE = /^([ \t]*(?:>[ \t]*)*)(-{1,2}|=+)[ \t]*$/;
// 表格行遇到这些开头就结束：标题、引用、围栏
const TABLE_BREAK = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|`{3,}|~{3,})/;
// 还没写完的分隔行：只由 | : - 和空白组成
const DELIMITER_PREFIX = /^[ \t]*[|:-][|:\-\s]*$/;
// 流式时文末只打出了行首标记（可以带引用前缀）、内容还没跟上的一行：
// 先不显示，免得上一段被误判成标题、或闪出孤零零的符号
const DANGLING_MARKER =
  /^[ \t]*(?:(?:>[ \t]*)+(?:[-+*=]|[-*_=]{2,}|#{1,6}|`{1,2}|~{1,2}|\d{1,9}[.)]?)?|[-+*=]|[-*_=]{2,}|#{1,6}|`{1,2}|~{1,2}|\d{1,9}[.)]?)[ \t]*$/;

function indentOf(line: string): number {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (ch === ' ') n += 1;
    else if (ch === '\t') n += 4;
    else break;
  }
  return n;
}

function matchFence(line: string): Fence | null {
  const m = FENCE_OPEN.exec(line);
  if (!m) return null;
  const info = m[3].trim();
  // 反引号围栏的说明里不能再有反引号，否则那是一段行内代码
  if (m[2].charAt(0) === '`' && info.indexOf('`') >= 0) return null;
  return { char: m[2].charAt(0), len: m[2].length, indent: indentOf(m[1]), info };
}

function isFenceClose(line: string, fence: Fence): boolean {
  const m = FENCE_CLOSE.exec(line);
  return !!m && m[1].charAt(0) === fence.char && m[1].length >= fence.len;
}

function stripIndent(line: string, max: number): string {
  let i = 0;
  while (i < max && i < line.length && line.charAt(i) === ' ') i++;
  return line.slice(i);
}

/** 把一行表格拆成单元格：按未转义的 | 切分，去掉首尾的竖线，\| 还原成 | */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.charAt(0) === '|') s = s.slice(1);
  if (s.charAt(s.length - 1) === '|' && s.charAt(s.length - 2) !== '\\') s = s.slice(0, -1);
  const cells: string[] = [];
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (ch === '\\' && s.charAt(i + 1) === '|') {
      buf += '|';
      i++;
    } else if (ch === '|') {
      cells.push(buf.trim());
      buf = '';
    } else {
      buf += ch;
    }
  }
  cells.push(buf.trim());
  return cells;
}

/** 解析分隔行（|---|:---:|---:|），不是分隔行返回 null */
function parseDelimiter(line: string): Align[] | null {
  if (line.indexOf('-') < 0) return null;
  const cells = splitRow(line);
  const out: Align[] = [];
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.charAt(0) === ':';
    const right = cell.charAt(cell.length - 1) === ':';
    out.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return out.length > 0 ? out : null;
}

function isTableStart(header: string, delimiter: string): boolean {
  const aligns = parseDelimiter(delimiter);
  if (!aligns) return false;
  if (aligns.length === splitRow(header).length) return true;
  // 模型偶尔把分隔行的列数写错；只要两行都明显是表格的样子就照表格渲染，总比露出一堆竖线强
  return header.trim().charAt(0) === '|' && delimiter.indexOf('|') >= 0 && aligns.length >= 2;
}

/**
 * 把流式文本最后一行里没闭合的加粗 / 行内代码先补上，
 * 这样「**重点」在写到一半时就按加粗显示，而不是先露出两个星号、闭合后再跳变。
 */
function balanceInline(line: string): string {
  let inCode = false;
  let codeTicks = 0;
  let codeStart = -1;
  let boldOpen = -1;
  let boldCount = 0;
  let i = 0;
  while (i < line.length) {
    const ch = line.charAt(i);
    if (ch === '\\') {
      i += 2;
    } else if (ch === '`') {
      let j = i;
      while (line.charAt(j) === '`') j++;
      if (!inCode) {
        inCode = true;
        codeTicks = j - i;
        codeStart = i;
      } else if (j - i === codeTicks) {
        inCode = false;
      }
      i = j;
    } else if (!inCode && ch === '*' && line.charAt(i + 1) === '*') {
      boldCount += 1;
      if (boldCount % 2 === 1) boldOpen = i;
      i += 2;
    } else {
      i += 1;
    }
  }
  if (inCode) {
    const body = line.slice(codeStart + codeTicks);
    if (body.trim() === '') return line.slice(0, codeStart);
    return line + new Array(codeTicks + 1).join('`');
  }
  if (boldCount % 2 === 1) {
    // 末尾零散的 * 多半是闭合标记刚打了一半，一并去掉再补全
    const body = line.slice(boldOpen + 2).replace(/[\s*]+$/, '');
    if (body === '') return line.slice(0, boldOpen);
    return line.slice(0, boldOpen + 2) + body + '**';
  }
  return line;
}

function lastUnescapedPipe(line: string): number {
  for (let i = line.length - 1; i >= 0; i--) {
    if (line.charAt(i) === '|' && line.charAt(i - 1) !== '\\') return i;
  }
  return -1;
}

/** 流式时对最后一块做容错处理；返回空串表示这一块暂时没有可显示的内容 */
function tidyStreamingTail(block: MarkdownBlock): string {
  const nl = block.text.lastIndexOf('\n');
  const head = block.text.slice(0, nl + 1);
  const last = block.text.slice(nl + 1);
  if (block.kind === 'table') {
    // 只处理最后一个单元格，前面的单元格已经写完了
    const pipe = lastUnescapedPipe(last);
    return head + last.slice(0, pipe + 1) + balanceInline(last.slice(pipe + 1));
  }
  // 补全之后可能只剩行首标记（如「- **」去掉悬空的星号后是「- 」），所以补完再判断一次
  const fixed = DANGLING_MARKER.test(last) ? last : balanceInline(last);
  if (DANGLING_MARKER.test(fixed)) return head.replace(/\n+$/, '');
  return head + fixed;
}

/**
 * 把 Markdown 源文切成可独立渲染的块。
 *
 * 往 source 末尾追加内容时，除最后一块外，前面各块的 kind / text 保持不变
 * （这是「流式时只重渲染最后一块」的前提）。唯一的例外是流式时一行以 | 开头、
 * 最后却没有成为表格：它会从「待定的表格」退回成前一段的文字，前一块跟着变一次。
 * streaming 为 true 时，还会对文末没写完的表格、行首标记、加粗等做容错。
 */
export function splitMarkdownBlocks(source: string, streaming: boolean = false): MarkdownBlock[] {
  const lines = (source || '').replace(/\r\n?/g, '\n').split('\n');
  let end = lines.length - 1;
  while (end >= 0 && lines[end].trim() === '') end--;

  const blocks: MarkdownBlock[] = [];
  let cur: string[] = [];
  let curHasList = false;
  let blanks = 0;
  let nested: Fence | null = null;
  // 最后一块是否停在没闭合的围栏里（列表里的围栏）；是的话文末那一行是代码，不能当 Markdown 去修补
  let openNested = false;

  const flush = () => {
    if (cur.length > 0) blocks.push({ kind: 'md', text: cur.join('\n') });
    cur = [];
    curHasList = false;
    blanks = 0;
  };

  let i = 0;
  while (i <= end) {
    const line = lines[i];

    // 列表项里的代码围栏：整段留在当前块里，围栏内的空行不能触发分块
    if (nested) {
      cur.push(line);
      if (isFenceClose(line, nested)) nested = null;
      i++;
      continue;
    }

    if (line.trim() === '') {
      if (cur.length > 0) blanks++;
      i++;
      continue;
    }

    const indent = indentOf(line);

    // 空行之后：只有「列表还在继续」（缩进的续行或下一个列表项）才留在同一块，其余一律另起一块。
    // 宁可少切也不能切错——把列表项的续行单独切出去会被解析成别的东西。
    if (blanks > 0) {
      if (curHasList && (indent >= 2 || LIST_ITEM.test(line))) {
        for (let b = 0; b < blanks; b++) cur.push('');
        blanks = 0;
      } else {
        flush();
      }
    }

    const fence = matchFence(line);
    if (fence) {
      if (cur.length > 0 && curHasList && indent >= 2) {
        cur.push(line);
        nested = fence;
        i++;
        continue;
      }
      // 其余情况都是顶层围栏（顶层不认缩进代码块，所以缩进再深也按围栏算）
      flush();
      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j++) {
        if (isFenceClose(lines[j], fence)) {
          closed = true;
          break;
        }
        body.push(stripIndent(lines[j], fence.indent));
      }
      // 没闭合的围栏一直延伸到文末（流式时代码逐行长出来，闭合后内容不变）
      if (!closed) {
        while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
      }
      blocks.push({ kind: 'code', text: body.join('\n'), lang: fence.info.split(/\s+/)[0] || '' });
      i = closed ? j + 1 : lines.length;
      continue;
    }

    if (indent <= 3 && HR.test(line)) {
      flush();
      blocks.push({ kind: 'hr', text: '' });
      i++;
      continue;
    }

    if (indent <= 3 && line.indexOf('|') >= 0) {
      if (i + 1 <= end && isTableStart(line, lines[i + 1])) {
        flush();
        let j = i + 2;
        while (j <= end) {
          const row = lines[j];
          if (row.trim() === '' || row.indexOf('|') < 0 || TABLE_BREAK.test(row)) break;
          j++;
        }
        blocks.push({ kind: 'table', text: lines.slice(i, j).join('\n') });
        i = j;
        continue;
      }
      // 流式：表头刚出现、分隔行还没到齐时先按「只有表头的表格」显示，不让竖线原样露出来
      if (streaming && line.trim().charAt(0) === '|') {
        if (i === end || (i + 1 === end && DELIMITER_PREFIX.test(lines[i + 1]))) {
          flush();
          blocks.push({ kind: 'table', text: line });
          i = end + 1;
          continue;
        }
      }
    }

    let text = line;
    if (cur.length === 0) {
      // 顶层的缩进行不当代码块：去掉缩进按普通段落处理
      if (indent >= 4) text = line.replace(/^[ \t]+/, '');
    } else if (!(streaming && i === end)) {
      // 段落下面一行只有 - 或 = 时，标准语法会把上一段变成标题。模型不会这样写标题，
      // 出现这种行基本都是输出被截断（列表符号刚打出来），所以转义成普通字符。
      // 例外：列表里顶格的 - 是一个新的空列表项，不会变标题，保持原样。
      // （流式时的最后一行不用管，稍后会整行先藏起来）
      const m = SETEXT_UNDERLINE.exec(line);
      if (m && (m[2].charAt(0) === '=' || !curHasList || indent >= 2 || m[1].indexOf('>') >= 0)) {
        text = m[1] + '\\' + line.slice(m[1].length);
      }
    }
    if (text === line || cur.length === 0) {
      if (LIST_ITEM.test(text)) curHasList = true;
    }
    cur.push(text);
    i++;
  }
  openNested = nested != null;
  flush();

  if (streaming && blocks.length > 0 && !openNested) {
    const last = blocks[blocks.length - 1];
    if (last.kind === 'md' || last.kind === 'table') {
      const text = tidyStreamingTail(last);
      if (text.trim() === '') blocks.pop();
      else if (text !== last.text) blocks[blocks.length - 1] = { kind: last.kind, text };
    }
  }
  return blocks;
}

/* ------------------------------------------------------------------ */
/* 行内格式（表格单元格用；段落等交给 react-markdown）                    */
/* ------------------------------------------------------------------ */

const ESCAPABLE = /[!-/:-@[-`{-~]/;
const WORD_CHAR = /[A-Za-z0-9]/;

function Cursor() {
  return <span className="doc-cursor" aria-hidden="true" />;
}

function findBackticks(src: string, from: number, count: number): number {
  let i = from;
  while (i < src.length) {
    if (src.charAt(i) === '`') {
      let j = i;
      while (src.charAt(j) === '`') j++;
      if (j - i === count) return i;
      i = j;
    } else {
      i++;
    }
  }
  return -1;
}

/** 找闭合定界符的位置：跳过转义字符和行内代码 */
function findDelimiter(src: string, from: number, delim: string): number {
  let i = from;
  while (i < src.length) {
    const ch = src.charAt(i);
    if (ch === '\\') {
      i += 2;
    } else if (ch === '`') {
      let j = i;
      while (src.charAt(j) === '`') j++;
      const close = findBackticks(src, j, j - i);
      i = close >= 0 ? close + (j - i) : j;
    } else if (src.slice(i, i + delim.length) === delim) {
      // 找单个 * 时别把 ** 的一半当成闭合
      if (delim.length === 1 && src.charAt(i + 1) === delim) i += 2;
      else return i;
    } else {
      i++;
    }
  }
  return -1;
}

interface Emphasis {
  tag: 'strong' | 'em' | 'del' | 'strong-em';
  inner: string;
  end: number;
}

function matchEmphasis(src: string, at: number): Emphasis | null {
  const ch = src.charAt(at);
  let run = 1;
  while (src.charAt(at + run) === ch) run++;
  // snake_case 这类词内下划线不是强调
  if (ch === '_' && at > 0 && WORD_CHAR.test(src.charAt(at - 1))) return null;

  const attempt = (delim: string, tag: Emphasis['tag']): Emphasis | null => {
    const start = at + delim.length;
    const close = findDelimiter(src, start, delim);
    if (close < 0) return null;
    const inner = src.slice(start, close);
    if (inner === '' || /^\s|\s$/.test(inner)) return null;
    const after = close + delim.length;
    if (ch === '_' && WORD_CHAR.test(src.charAt(after))) return null;
    return { tag, inner, end: after };
  };

  if (ch === '~') return run >= 2 ? attempt('~~', 'del') : null;
  if (run >= 3) {
    const both = attempt(ch + ch + ch, 'strong-em');
    if (both) return both;
  }
  if (run >= 2) {
    const strong = attempt(ch + ch, 'strong');
    if (strong) return strong;
  }
  return attempt(ch, 'em');
}

interface LinkMatch {
  label: string;
  url: string;
  end: number;
}

/** 匹配 [文字](地址) ；at 指向 [ */
function matchLink(src: string, at: number): LinkMatch | null {
  let depth = 0;
  let close = -1;
  for (let i = at; i < src.length; i++) {
    const ch = src.charAt(i);
    if (ch === '\\') i++;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0 || src.charAt(close + 1) !== '(') return null;
  let paren = 0;
  for (let i = close + 1; i < src.length; i++) {
    const ch = src.charAt(i);
    if (ch === '\\') i++;
    else if (ch === '(') paren++;
    else if (ch === ')') {
      paren--;
      if (paren === 0) {
        const target = src.slice(close + 2, i).trim();
        // 地址后面可以跟一个引号包着的标题，这里不需要
        const url = target.split(/\s+/)[0].replace(/^<|>$/g, '');
        return { label: src.slice(at + 1, close), url, end: i + 1 };
      }
    }
  }
  return null;
}

function linkProps(href: string | undefined) {
  return /^https?:/i.test(href || '') ? { target: '_blank', rel: 'noopener noreferrer' } : {};
}

// 表格里常见的几个字符引用；段落里的由 react-markdown 负责
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: String.fromCharCode(0xa0),
  ensp: String.fromCharCode(0x2002),
  emsp: String.fromCharCode(0x2003),
  middot: '·',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  times: '×',
  deg: '°',
  plusmn: '±',
  le: '≤',
  ge: '≥',
};

function decodeEntities(text: string): string {
  if (text.indexOf('&') < 0) return text;
  return text.replace(/&(#[xX][0-9a-fA-F]{1,4}|#\d{1,5}|[a-zA-Z]{2,8});/g, (whole: string, body: string) => {
    if (body.charAt(0) === '#') {
      const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // 控制字符、代理项、私用区一律不认，原样保留
      const usable = code > 31 && code < 0xffff && !(code >= 0xd800 && code <= 0xf8ff) && !(code >= 0x7f && code <= 0x9f);
      return usable ? String.fromCharCode(code) : whole;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : whole;
  });
}

/** 把一段行内 Markdown 转成 React 节点（不产生任何原始 HTML） */
function renderInline(src: string): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = '';
  let key = 0;
  let i = 0;
  const flush = () => {
    if (buf !== '') {
      out.push(decodeEntities(buf));
      buf = '';
    }
  };

  while (i < src.length) {
    const ch = src.charAt(i);

    if (ch === '\\' && i + 1 < src.length && ESCAPABLE.test(src.charAt(i + 1))) {
      buf += src.charAt(i + 1);
      i += 2;
      continue;
    }

    if (ch === '`') {
      let j = i;
      while (src.charAt(j) === '`') j++;
      const close = findBackticks(src, j, j - i);
      if (close >= 0) {
        let code = src.slice(j, close);
        if (code.length > 2 && code.charAt(0) === ' ' && code.charAt(code.length - 1) === ' ') {
          code = code.slice(1, -1);
        }
        flush();
        out.push(<code key={key++}>{code}</code>);
        i = close + (j - i);
      } else {
        buf += src.slice(i, j);
        i = j;
      }
      continue;
    }

    if (ch === '<') {
      const br = /^<br\s*\/?>/i.exec(src.slice(i, i + 8));
      if (br) {
        flush();
        out.push(<br key={key++} />);
        i += br[0].length;
        continue;
      }
    }

    if (ch === '!' && src.charAt(i + 1) === '[') {
      const image = matchLink(src, i + 1);
      if (image) {
        flush();
        out.push(
          <span key={key++} className="doc-image">
            图：{image.label || '未命名'}
          </span>
        );
        i = image.end;
        continue;
      }
    }

    if (ch === '[') {
      const link = matchLink(src, i);
      if (link) {
        // 危险协议（javascript: 等）会被过滤成空串：这时只保留文字，不生成链接
        const href = defaultUrlTransform(link.url);
        const label = renderInline(link.label);
        flush();
        if (href) {
          out.push(
            <a key={key++} href={href} {...linkProps(href)}>
              {label}
            </a>
          );
        } else {
          out.push(<span key={key++}>{label}</span>);
        }
        i = link.end;
        continue;
      }
    }

    if (ch === '*' || ch === '_' || ch === '~') {
      const hit = matchEmphasis(src, i);
      if (hit) {
        const inner = renderInline(hit.inner);
        flush();
        if (hit.tag === 'strong-em') {
          out.push(
            <strong key={key++}>
              <em>{inner}</em>
            </strong>
          );
        } else if (hit.tag === 'strong') {
          out.push(<strong key={key++}>{inner}</strong>);
        } else if (hit.tag === 'em') {
          out.push(<em key={key++}>{inner}</em>);
        } else {
          out.push(<del key={key++}>{inner}</del>);
        }
        i = hit.end;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

/* ------------------------------------------------------------------ */
/* react-markdown 的插件（都是本文件内的小函数，不引入额外依赖）          */
/* ------------------------------------------------------------------ */

interface TreeNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  alt?: string | null;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: TreeNode[];
}

/*
 * 加粗、删除线的处理方式：
 * 标准规则下，闭合的 ** 后面必须是空白或标点才算数。中文文稿里最常见的写法
 * 「**小标题：**正文」恰好不满足——解析器要么原样露出星号，要么和后面的 ** 错配、把不该加粗的字加粗。
 * 所以加粗不交给解析器判断：先在源文里把成对的 ** 换成一对私用区字符（解析器当普通文字原样带过），
 * 解析完再在语法树里把这对标记之间的内容包成 strong。配对规则很朴素：同一行内从左到右，
 * 开标记后面紧跟非空白、闭标记前面紧跟非空白。
 * 删除线 ~~…~~ 标准语法里本来就没有（属于 GFM 扩展），用同一套办法顺带支持。
 */
interface PairMark {
  open: string;
  close: string;
  literal: string;
  node: 'strong' | 'delete';
}

// 内部标记用四个私用区字符；写成码点是为了让它们在源码里看得见
const MARK = {
  strongOpen: String.fromCharCode(0xe000),
  strongClose: String.fromCharCode(0xe001),
  deleteOpen: String.fromCharCode(0xe002),
  deleteClose: String.fromCharCode(0xe003),
};
const MARK_CHARS = MARK.strongOpen + MARK.strongClose + MARK.deleteOpen + MARK.deleteClose;

const PAIR_MARKS: Record<string, PairMark> = {
  '*': { open: MARK.strongOpen, close: MARK.strongClose, literal: '**', node: 'strong' },
  '~': { open: MARK.deleteOpen, close: MARK.deleteClose, literal: '~~', node: 'delete' },
};
const MARK_BY_CHAR: Record<string, { mark: PairMark; opening: boolean }> = {};
MARK_BY_CHAR[MARK.strongOpen] = { mark: PAIR_MARKS['*'], opening: true };
MARK_BY_CHAR[MARK.strongClose] = { mark: PAIR_MARKS['*'], opening: false };
MARK_BY_CHAR[MARK.deleteOpen] = { mark: PAIR_MARKS['~'], opening: true };
MARK_BY_CHAR[MARK.deleteClose] = { mark: PAIR_MARKS['~'], opening: false };
const HAS_MARK = new RegExp('[' + MARK_CHARS + ']');
const ALL_MARKS = new RegExp('[' + MARK_CHARS + ']', 'g');
const SPLIT_MARKS = new RegExp('([' + MARK_CHARS + '])');

function markPairsInLine(line: string): string {
  // 先找出所有「恰好两个」的 ** 和 ~~：跳过转义、行内代码；三个以上连写的留给解析器
  const found: Array<{ pos: number; ch: string }> = [];
  let i = 0;
  while (i < line.length) {
    const ch = line.charAt(i);
    if (ch === '\\') {
      i += 2;
    } else if (ch === '`') {
      let j = i;
      while (line.charAt(j) === '`') j++;
      const close = findBackticks(line, j, j - i);
      i = close >= 0 ? close + (j - i) : j;
    } else if (ch === '*' || ch === '~') {
      let j = i;
      while (line.charAt(j) === ch) j++;
      if (j - i === 2) found.push({ pos: i, ch });
      i = j;
    } else {
      i++;
    }
  }
  if (found.length < 2) return line;

  const swap: Record<number, string> = {};
  const opened: Record<string, number> = { '*': -1, '~': -1 };
  let paired = false;
  for (let k = 0; k < found.length; k++) {
    const { pos, ch } = found[k];
    const before = pos > 0 ? line.charAt(pos - 1) : ' ';
    const after = pos + 2 < line.length ? line.charAt(pos + 2) : ' ';
    const start = opened[ch];
    if (start >= 0 && !/\s/.test(before) && pos > start + 2) {
      swap[start] = PAIR_MARKS[ch].open;
      swap[pos] = PAIR_MARKS[ch].close;
      opened[ch] = -1;
      paired = true;
    } else if (!/\s/.test(after)) {
      opened[ch] = pos;
    }
  }
  if (!paired) return line;

  let out = '';
  let from = 0;
  for (let k = 0; k < found.length; k++) {
    const pos = found[k].pos;
    if (swap[pos]) {
      out += line.slice(from, pos) + swap[pos];
      from = pos + 2;
    }
  }
  return out + line.slice(from);
}

/** 把源文里成对的 ** 、~~ 换成内部标记（围栏代码里的不动） */
function markPairs(text: string): string {
  const source = HAS_MARK.test(text) ? text.replace(ALL_MARKS, '') : text;
  if (source.indexOf('**') < 0 && source.indexOf('~~') < 0) return source;
  const lines = source.split('\n');
  let fence: Fence | null = null;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
    } else {
      const opened = matchFence(line);
      if (opened) fence = opened;
      else if (line.indexOf('**') >= 0 || line.indexOf('~~') >= 0) lines[n] = markPairsInLine(line);
    }
  }
  return lines.join('\n');
}

function unmark(value: string): string {
  return value.replace(ALL_MARKS, (ch) => MARK_BY_CHAR[ch].mark.literal);
}

const BR_TAG = /^<br\s*\/?>$/i;

interface PairFrame {
  mark: PairMark;
  nodes: TreeNode[];
}

function fixMdast(node: TreeNode) {
  const children = node.children;
  if (!children) return;
  const out: TreeNode[] = [];
  // 遇到开标记就压一层，后续兄弟节点先收在这一层里，等闭标记出现再整体包成 strong / delete
  const stack: PairFrame[] = [];
  const emit = (n: TreeNode) => {
    (stack.length > 0 ? stack[stack.length - 1].nodes : out).push(n);
  };

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === 'html' && typeof child.value === 'string' && BR_TAG.test(child.value.trim())) {
      emit({ type: 'break' });
      continue;
    }
    if (child.type === 'text' && typeof child.value === 'string') {
      if (!HAS_MARK.test(child.value)) {
        emit(child);
        continue;
      }
      const pieces = child.value.split(SPLIT_MARKS);
      for (let k = 0; k < pieces.length; k++) {
        const piece = pieces[k];
        const hit = piece.length === 1 ? MARK_BY_CHAR[piece] : undefined;
        if (!hit) {
          if (piece !== '') emit({ type: 'text', value: piece });
        } else if (hit.opening) {
          stack.push({ mark: hit.mark, nodes: [] });
        } else if (stack.length > 0 && stack[stack.length - 1].mark === hit.mark) {
          const frame = stack.pop() as PairFrame;
          emit({ type: frame.mark.node, children: frame.nodes });
        } else {
          emit({ type: 'text', value: hit.mark.literal });
        }
      }
      continue;
    }
    // 标记万一落进了代码、链接地址这类不解析行内格式的地方，原样还原成符号
    if (typeof child.value === 'string' && HAS_MARK.test(child.value)) child.value = unmark(child.value);
    if (typeof child.url === 'string' && HAS_MARK.test(child.url)) child.url = unmark(child.url);
    if (typeof child.title === 'string' && HAS_MARK.test(child.title)) child.title = unmark(child.title);
    if (typeof child.alt === 'string' && HAS_MARK.test(child.alt)) child.alt = unmark(child.alt);
    fixMdast(child);
    emit(child);
  }

  // 开闭标记被别的行内结构隔开、或互相交叉（极少见）：放弃这一对，还原成符号
  while (stack.length > 0) {
    const frame = stack.pop() as PairFrame;
    emit({ type: 'text', value: frame.mark.literal });
    for (let k = 0; k < frame.nodes.length; k++) emit(frame.nodes[k]);
  }
  node.children = out;
}

/**
 * remark 插件：
 * 1. <br> 当作换行（其余 HTML 仍按普通文字显示）
 * 2. 把 markPairs 留下的成对标记还原成加粗 / 删除线节点
 */
function remarkDocFixes() {
  return (tree: TreeNode) => {
    fixMdast(tree);
  };
}

// 光标要跟在最后一个字后面，所以沿着这些容器一路走到最里层
const CURSOR_HOSTS: Record<string, true> = {
  p: true,
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  ul: true,
  ol: true,
  li: true,
  blockquote: true,
  pre: true,
  code: true,
};

/** rehype 插件：在文末最后一个字后面插入光标 */
function rehypeCursor() {
  return (tree: TreeNode) => {
    let host = tree;
    for (;;) {
      const children = host.children || [];
      let last: TreeNode | null = null;
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i];
        if (child.type === 'text' && (child.value || '').trim() === '') continue;
        last = child;
        break;
      }
      if (!last || last.type !== 'element' || !last.tagName || !CURSOR_HOSTS[last.tagName]) break;
      // code 只有作为代码块（pre 的子节点）时才进去；行内代码后面的光标留在外面
      if (last.tagName === 'code' && host.tagName !== 'pre') break;
      host = last;
    }
    if (!host.children) host.children = [];
    host.children.push({
      type: 'element',
      tagName: 'span',
      properties: { className: ['doc-cursor'], ariaHidden: 'true' },
      children: [],
    });
  };
}

const REMARK_PLUGINS = [remarkDocFixes];
const REHYPE_WITH_CURSOR = [rehypeCursor];
const NO_PLUGINS: [] = [];

const COMPONENTS: Components = {
  a({ node, children, href, ...rest }) {
    return (
      <a href={href} {...linkProps(href)} {...rest}>
        {children}
      </a>
    );
  },
  img({ alt }) {
    return <span className="doc-image">图：{alt || '未命名'}</span>;
  },
};

/* ------------------------------------------------------------------ */
/* 各类块的渲染                                                         */
/* ------------------------------------------------------------------ */

interface BlockProps {
  text: string;
  cursor: boolean;
}

const MdBlock = memo(function MdBlock({ text, cursor }: BlockProps) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={cursor ? REHYPE_WITH_CURSOR : NO_PLUGINS}
      components={COMPONENTS}
    >
      {markPairs(text)}
    </ReactMarkdown>
  );
});

const CodeBlock = memo(function CodeBlock({ text, cursor, lang }: BlockProps & { lang?: string }) {
  return (
    <pre data-lang={lang || undefined}>
      <code>
        {text}
        {cursor ? <Cursor /> : null}
      </code>
    </pre>
  );
});

function alignStyle(align: Align): CSSProperties | undefined {
  return align ? { textAlign: align } : undefined;
}

interface RowProps {
  line: string;
  /** 各列对齐，用逗号连成字符串以便 memo 比较 */
  aligns: string;
  columns: number;
  cursor: boolean;
}

const TableRow = memo(function TableRow({ line, aligns, columns, cursor }: RowProps) {
  const cells = splitRow(line);
  const alignList = aligns.split(',') as Array<'left' | 'center' | 'right' | ''>;
  // 光标跟在最后一个有内容的单元格后面
  let cursorAt = -1;
  if (cursor) {
    for (let c = Math.min(cells.length, columns) - 1; c >= 0; c--) {
      if (cells[c] !== '') {
        cursorAt = c;
        break;
      }
    }
    if (cursorAt < 0) cursorAt = 0;
  }
  const out: ReactNode[] = [];
  for (let c = 0; c < columns; c++) {
    out.push(
      <td key={c} style={alignStyle(alignList[c] || null)}>
        {c < cells.length ? renderInline(cells[c]) : null}
        {c === cursorAt ? <Cursor /> : null}
      </td>
    );
  }
  return <tr>{out}</tr>;
});

const TableBlock = memo(function TableBlock({ text, cursor }: BlockProps) {
  const lines = text.split('\n');
  const header = splitRow(lines[0]);
  const columns = header.length;
  const parsed = lines.length > 1 ? parseDelimiter(lines[1]) : null;
  const aligns: Align[] = [];
  for (let c = 0; c < columns; c++) aligns.push(parsed && c < parsed.length ? parsed[c] : null);
  const alignKey = aligns.map((a) => a || '').join(',');

  const rows: string[] = [];
  for (let r = parsed ? 2 : 1; r < lines.length; r++) {
    // 流式时最后一行可能只打出了一个竖线，先不占一行
    if (splitRow(lines[r]).some((cell) => cell !== '')) rows.push(lines[r]);
  }

  return (
    <div className="doc-table">
      <table>
        <thead>
          <tr>
            {header.map((cell, c) => (
              <th key={c} style={alignStyle(aligns[c])}>
                {renderInline(cell)}
                {cursor && rows.length === 0 && c === columns - 1 ? <Cursor /> : null}
              </th>
            ))}
          </tr>
        </thead>
        {rows.length > 0 ? (
          <tbody>
            {rows.map((line, r) => (
              <TableRow
                key={r}
                line={line}
                aligns={alignKey}
                columns={columns}
                cursor={cursor && r === rows.length - 1}
              />
            ))}
          </tbody>
        ) : null}
      </table>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* 组件                                                                */
/* ------------------------------------------------------------------ */

export function MarkdownView({ content, variant = 'doc', streaming = false, className }: MarkdownViewProps) {
  const blocks = useMemo(() => splitMarkdownBlocks(content, streaming), [content, streaming]);
  const lastIndex = blocks.length - 1;
  // 最后一块是分隔线（或还没有任何内容）时，光标没有文字可以跟，单独放在末尾
  const looseCursor = streaming && (blocks.length === 0 || blocks[lastIndex].kind === 'hr');

  return (
    <div
      className={mergeClass(cx('doc-prose', variant === 'compact' && 'doc-prose-compact'), className)}
      aria-busy={streaming || undefined}
    >
      {blocks.map((block, index) => {
        const cursor = streaming && index === lastIndex;
        // 用下标做 key：流式追加时前面的块位置不变，正好复用
        if (block.kind === 'md') return <MdBlock key={index} text={block.text} cursor={cursor} />;
        if (block.kind === 'table') return <TableBlock key={index} text={block.text} cursor={cursor} />;
        if (block.kind === 'code') return <CodeBlock key={index} text={block.text} lang={block.lang} cursor={cursor} />;
        return <hr key={index} />;
      })}
      {looseCursor ? <Cursor /> : null}
    </div>
  );
}

export default MarkdownView;
