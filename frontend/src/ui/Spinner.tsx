/**
 * 加载转圈
 *
 * 用法：
 *   <Spinner />                       // 20px，主色
 *   <Spinner size="sm" tone="current" />  // 14px，跟随文字颜色（放在按钮、标签里）
 *
 * - size：sm 14px / md 20px / lg 28px
 * - tone：primary（默认）/ muted 灰 / current 跟随当前文字色
 * - label：读屏文案，默认「加载中」
 */
import { cx, mergeClass } from './cx';

export type SpinnerSize = 'sm' | 'md' | 'lg';
export type SpinnerTone = 'primary' | 'muted' | 'current';

export interface SpinnerProps {
  size?: SpinnerSize;
  tone?: SpinnerTone;
  label?: string;
  className?: string;
}

const SIZE: Record<SpinnerSize, string> = {
  sm: 'h-3.5 w-3.5',
  md: 'h-5 w-5',
  lg: 'h-7 w-7',
};

const TONE: Record<SpinnerTone, string> = {
  primary: 'text-primary-600',
  muted: 'text-ink-400',
  current: '',
};

export function Spinner({ size = 'md', tone = 'primary', label = '加载中', className }: SpinnerProps) {
  return (
    <svg
      className={mergeClass(cx('shrink-0 animate-spin', SIZE[size], TONE[tone]), className)}
      viewBox="0 0 24 24"
      fill="none"
      role="status"
      aria-label={label}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
