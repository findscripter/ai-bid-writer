/**
 * 进度条
 *
 * 用法：
 *   <ProgressBar value={62} label="正文生成" />          // 带标题行，右侧显示 62%
 *   <ProgressBar value={null} />                        // 不确定进度（来回滑动）
 *   <ProgressBar value={100} tone="success" size="sm" />
 *
 * - value：0-100，超出会被钳制；null 表示不确定进度
 * - tone：primary 默认 / success / warning / danger
 * - size：sm 4px / md 6px
 * - label：进度条上方的说明；有 label 且进度确定时右侧显示百分比（showValue={false} 可关）
 */
import type { ReactNode } from 'react';
import { cx, mergeClass } from './cx';

export type ProgressTone = 'primary' | 'success' | 'warning' | 'danger';
export type ProgressSize = 'sm' | 'md';

export interface ProgressBarProps {
  value: number | null;
  tone?: ProgressTone;
  size?: ProgressSize;
  label?: ReactNode;
  /** 有 label 时是否在右侧显示百分比，默认 true */
  showValue?: boolean;
  className?: string;
}

const TONE: Record<ProgressTone, string> = {
  primary: 'bg-primary-500',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-rose-500',
};

const SIZE: Record<ProgressSize, string> = {
  sm: 'h-1',
  md: 'h-1.5',
};

export function ProgressBar({
  value,
  tone = 'primary',
  size = 'md',
  label,
  showValue = true,
  className,
}: ProgressBarProps) {
  const determinate = value != null && !Number.isNaN(value);
  const pct = determinate ? Math.min(100, Math.max(0, value as number)) : 0;
  return (
    <div className={mergeClass('w-full', className)}>
      {label != null ? (
        <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
          <span className="min-w-0 truncate text-ink-600">{label}</span>
          {determinate && showValue ? (
            <span className="shrink-0 tabular-nums text-ink-500">{Math.round(pct)}%</span>
          ) : null}
        </div>
      ) : null}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? Math.round(pct) : undefined}
        className={cx('w-full overflow-hidden rounded-full bg-ink-900/[0.08]', SIZE[size])}
      >
        {determinate ? (
          <div
            className={cx('h-full rounded-full transition-[width] duration-300 ease-out', TONE[tone])}
            style={{ width: `${pct}%` }}
          />
        ) : (
          <div className={cx('h-full w-[30%] animate-indeterminate rounded-full', TONE[tone])} />
        )}
      </div>
    </div>
  );
}
