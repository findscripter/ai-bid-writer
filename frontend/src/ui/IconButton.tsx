/**
 * 图标按钮（只有图标、没有文字的方形按钮）
 *
 * 用法：
 *   <IconButton label="删除章节" icon={<TrashIcon />} variant="danger" onClick={remove} />
 *
 * - label 必填：同时作为 aria-label 与 title（鼠标悬停时的原生提示）
 * - size：sm 28px / md 32px；svg 会被统一成 16px
 * - variant：ghost 默认无边框 / secondary 带边框 / danger 悬停变红
 * - 其余原生 button 属性原样透传，支持 ref
 */
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx, mergeClass } from './cx';
import { Spinner } from './Spinner';

export type IconButtonSize = 'sm' | 'md';
export type IconButtonVariant = 'ghost' | 'secondary' | 'danger';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** 同时作为 aria-label 与 title */
  label: string;
  icon: ReactNode;
  size?: IconButtonSize;
  variant?: IconButtonVariant;
  /** 显示转圈并禁用 */
  loading?: boolean;
}

const VARIANT: Record<IconButtonVariant, string> = {
  ghost:
    'border-transparent text-ink-500 enabled:hover:bg-ink-900/[0.06] enabled:hover:text-ink-900 enabled:active:bg-ink-900/10',
  secondary:
    'border-line-strong bg-white text-ink-600 enabled:hover:border-ink-300 enabled:hover:bg-subtle enabled:hover:text-ink-900 enabled:active:bg-canvas',
  danger:
    'border-transparent text-ink-500 enabled:hover:bg-rose-50 enabled:hover:text-rose-600 enabled:active:bg-rose-100',
};

const SIZE: Record<IconButtonSize, string> = {
  sm: 'h-7 w-7',
  md: 'h-8 w-8',
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = 'md', variant = 'ghost', loading = false, disabled, className, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-autofocus={rest.autoFocus ? true : undefined}
      className={mergeClass(
        cx(
          'inline-flex shrink-0 items-center justify-center rounded-md border transition-colors [&>svg]:h-4 [&>svg]:w-4',
          SIZE[size],
          VARIANT[variant],
          loading ? 'cursor-wait' : 'disabled:cursor-not-allowed disabled:opacity-50'
        ),
        className
      )}
      {...rest}
    >
      {loading ? <Spinner size="sm" tone="current" /> : icon}
    </button>
  );
});
