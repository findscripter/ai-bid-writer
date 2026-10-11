/**
 * 徽标：状态标签、计数
 *
 * 用法：
 *   <Badge tone="success" dot>已完成</Badge>
 *   <Badge tone="warning" size="sm">3 个问题</Badge>
 *
 * - tone：neutral 默认灰 / primary / success 绿 / warning 琥珀 / danger 红
 * - size：sm 18px 高 / md 22px 高
 * - dot：文字前加一个同色小圆点
 */
import type { HTMLAttributes, ReactNode } from 'react';
import { cx, mergeClass } from './cx';

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';
export type BadgeSize = 'sm' | 'md';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: BadgeSize;
  dot?: boolean;
  children?: ReactNode;
}

const TONE: Record<BadgeTone, string> = {
  neutral: 'bg-ink-900/[0.06] text-ink-600',
  primary: 'bg-primary-50 text-primary-700',
  success: 'bg-emerald-50 text-emerald-700',
  warning: 'bg-amber-50 text-amber-800',
  danger: 'bg-rose-50 text-rose-700',
};

const DOT: Record<BadgeTone, string> = {
  neutral: 'bg-ink-400',
  primary: 'bg-primary-500',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-rose-500',
};

const SIZE: Record<BadgeSize, string> = {
  sm: 'h-[18px] gap-1 px-1.5 text-2xs',
  md: 'h-[22px] gap-1.5 px-2 text-xs',
};

export function Badge({ tone = 'neutral', size = 'md', dot = false, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={mergeClass(
        cx('inline-flex shrink-0 items-center whitespace-nowrap rounded-full font-medium', SIZE[size], TONE[tone]),
        className
      )}
      {...rest}
    >
      {dot ? <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', DOT[tone])} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
