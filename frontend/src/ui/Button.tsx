/**
 * 按钮
 *
 * 用法：
 *   <Button variant="primary" icon={<PlusIcon />} onClick={create}>新建项目</Button>
 *   <Button loading={saving} onClick={save}>保存</Button>     // loading：显示转圈并禁用
 *   <Button variant="danger" size="sm">删除</Button>
 *   <Button type="submit" block>提交</Button>               // 默认 type="button"，提交表单要显式传
 *
 * - variant：primary 主操作（一屏尽量只有一个）/ secondary 默认 / ghost 无边框 /
 *            subtle 淡主色底 / danger 危险操作
 * - size：sm 28px / md 32px / lg 40px
 * - icon / iconRight：任意节点；里面的 svg 会被统一成 16px（sm 为 14px），不用自己写尺寸
 * - className 里的宽、高、内边距类会替换默认值（如 className="w-32"）
 * - 其余原生 button 属性原样透传，支持 ref
 */
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx, mergeClass } from './cx';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 显示转圈并禁用 */
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
  /** 撑满父容器宽度 */
  block?: boolean;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'border-transparent bg-primary-600 text-white enabled:hover:bg-primary-700 enabled:active:bg-primary-800',
  secondary:
    'border-line-strong bg-white text-ink-700 enabled:hover:border-ink-300 enabled:hover:bg-subtle enabled:hover:text-ink-900 enabled:active:bg-canvas',
  ghost:
    'border-transparent bg-transparent text-ink-600 enabled:hover:bg-ink-900/[0.06] enabled:hover:text-ink-900 enabled:active:bg-ink-900/10',
  subtle:
    'border-transparent bg-primary-50 text-primary-700 enabled:hover:bg-primary-100 enabled:active:bg-primary-200',
  danger:
    'border-transparent bg-rose-600 text-white enabled:hover:bg-rose-700 enabled:active:bg-rose-800',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1 px-2.5 text-xs',
  md: 'h-8 gap-1.5 px-3 text-sm',
  lg: 'h-10 gap-2 px-4 text-[15px]',
};

const ICON_SIZE: Record<ButtonSize, string> = {
  sm: '[&>svg]:h-3.5 [&>svg]:w-3.5',
  md: '[&>svg]:h-4 [&>svg]:w-4',
  lg: '[&>svg]:h-4 [&>svg]:w-4',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    icon,
    iconRight,
    block = false,
    disabled,
    className,
    children,
    type = 'button',
    ...rest
  },
  ref
) {
  const iconClass = cx('inline-flex shrink-0 items-center', ICON_SIZE[size]);
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      // 对话框里原生 autoFocus 不生效，Headless UI 认 data-autofocus（见 Modal 的说明）
      data-autofocus={rest.autoFocus ? true : undefined}
      className={mergeClass(
        cx(
          'inline-flex select-none items-center justify-center whitespace-nowrap rounded-md border font-medium transition-colors',
          SIZE[size],
          VARIANT[variant],
          block && 'w-full',
          // 加载中保持较高的不透明度，和普通禁用区分开
          loading ? 'cursor-wait opacity-80' : 'disabled:cursor-not-allowed disabled:opacity-50'
        ),
        className
      )}
      {...rest}
    >
      {loading ? (
        <Spinner size="sm" tone="current" />
      ) : icon ? (
        <span className={iconClass}>{icon}</span>
      ) : null}
      {children}
      {iconRight ? <span className={iconClass}>{iconRight}</span> : null}
    </button>
  );
});
