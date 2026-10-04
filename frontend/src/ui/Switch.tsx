/**
 * 开关
 *
 * 用法：
 *   <Switch checked={on} onChange={setOn} label="联网检索" />
 *   <Switch checked={on} onChange={setOn} aria-label="启用" size="sm" />
 *
 * - onChange 直接给出新的布尔值
 * - label：显示在开关右侧，点击文字同样切换；不传时记得给 aria-label
 * - size：sm 16px 高 / md 20px 高（默认）
 */
import type { ReactNode } from 'react';
import { cx, mergeClass } from './cx';

export type SwitchSize = 'sm' | 'md';

export interface SwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  size?: SwitchSize;
  id?: string;
  className?: string;
  'aria-label'?: string;
}

const TRACK: Record<SwitchSize, string> = {
  sm: 'h-4 w-7',
  md: 'h-5 w-9',
};

const THUMB: Record<SwitchSize, { base: string; on: string }> = {
  sm: { base: 'h-3 w-3', on: 'translate-x-3' },
  md: { base: 'h-4 w-4', on: 'translate-x-4' },
};

export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  size = 'md',
  id,
  className,
  'aria-label': ariaLabel,
}: SwitchProps) {
  const button = (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex shrink-0 items-center rounded-full p-0.5 transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        TRACK[size],
        checked ? 'bg-primary-600' : 'bg-ink-300',
        label == null && className
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          'inline-block rounded-full bg-white shadow-sm transition-transform duration-150',
          THUMB[size].base,
          checked ? THUMB[size].on : 'translate-x-0'
        )}
      />
    </button>
  );

  if (label == null) return button;
  return (
    <label
      className={mergeClass(
        cx('inline-flex items-center gap-2 text-sm leading-5', disabled ? 'cursor-not-allowed text-ink-400' : 'cursor-pointer text-ink-700'),
        className
      )}
    >
      {button}
      <span className="min-w-0">{label}</span>
    </label>
  );
}
