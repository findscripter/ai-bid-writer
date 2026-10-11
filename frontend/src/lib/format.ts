/**
 * 展示用的格式化函数（纯函数，无副作用）
 *
 *   formatChars(12345)                 → "12,345 字"
 *   estimatePages(3000)                → 4        （默认每页 750 字，与后端 words_per_page 默认值一致）
 *   estimatePages(3000, 600)           → 5
 *   formatRelativeTime(isoString)      → "刚刚" / "5 分钟前" / "3 小时前" / "昨天 14:05" / "2026-09-28"
 *   formatDuration(192000)             → "3 分 12 秒"
 */

/** 后端默认的「每页字数」换算系数 */
export const DEFAULT_WORDS_PER_PAGE = 750;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function thousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 字数：千分位 + 「字」。非法值或负数按 0 处理 */
export function formatChars(n: number): string {
  const safe = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  return `${thousands(safe)} 字`;
}

/**
 * 按字数估算页数，保留 1 位小数（3000 字 / 750 → 4；1000 字 → 1.3）。
 * 要汇总多章时请先把字数相加再估算，不要把各章页数相加。
 */
export function estimatePages(chars: number, wordsPerPage: number = DEFAULT_WORDS_PER_PAGE): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  const per = Number.isFinite(wordsPerPage) && wordsPerPage > 0 ? wordsPerPage : DEFAULT_WORDS_PER_PAGE;
  return Math.round((chars / per) * 10) / 10;
}

/**
 * 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 HH:mm / YYYY-MM-DD。
 * - 1 小时内按分钟；当天按小时；日历上的昨天显示「昨天 HH:mm」；更早显示日期
 * - 入参是 ISO 时间串（带不带时区都行，不带时区按本地时间），也接受时间戳或 Date
 * - 解析不了时返回空串；时间在未来（两端时钟有偏差）按「刚刚」处理
 * - now 仅用于测试时固定「现在」
 */
export function formatRelativeTime(iso: string | number | Date, now: Date = new Date()): string {
  if (iso == null || iso === '') return '';
  const date = iso instanceof Date ? iso : new Date(iso);
  const time = date.getTime();
  if (Number.isNaN(time)) return '';

  const diff = now.getTime() - time;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (time >= startOfToday) return `${Math.floor(diff / hour)} 小时前`;

  const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  if (time >= startOfYesterday) return `昨天 ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;

  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * 时长：不到 1 秒 / N 秒 / N 分 S 秒 / N 小时 M 分。
 * 整分、整小时时省略零头（120000 → "2 分钟"，3600000 → "1 小时"）。
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return '不到 1 秒';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return seconds === 0 ? `${totalMinutes} 分钟` : `${totalMinutes} 分 ${seconds} 秒`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分`;
}
