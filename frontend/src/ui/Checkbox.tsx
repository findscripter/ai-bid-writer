/**
 * 复选框
 *
 * 用法：
 *   <Checkbox label="生成后自动审校" checked={on} onChange={(e) => setOn(e.target.checked)} />
 *   <Checkbox aria-label="全选" checked={all} indeterminate={some && !all} onChange={toggleAll} />
 *
 * - 透传全部原生 input 属性（type 固定为 checkbox），支持 ref
 * - label：点击文字同样切换；不传时只渲染方框本身（记得给 aria-label）
 * - indeterminate：半选态（如「部分章节被选中」）
 * - className 作用在最外层（有 label 时是 label 元素）
 */
import { forwardRef, useCallback, useEffect, useRef } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { cx, mergeClass } from './cx';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode;
  /** 半选态 */
  indeterminate?: boolean;
}

const BOX =
  'h-4 w-4 shrink-0 rounded border-line-strong text-primary-600 transition-colors ' +
  'focus:ring-0 focus:ring-offset-0 focus-visible:ring-2 focus-visible:ring-primary-500/40 focus-visible:ring-offset-1 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, indeterminate = false, className, disabled, ...rest },
  ref
) {
  const innerRef = useRef<HTMLInputElement | null>(null);
  const setRef = useCallback(
    (el: HTMLInputElement | null) => {
      innerRef.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [ref]
  );

  // indeterminate 只能通过 DOM 属性设置
  useEffect(() => {
    if (innerRef.current) innerRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  if (label == null) {
    return (
      <input
        ref={setRef}
        type="checkbox"
        disabled={disabled}
        data-autofocus={rest.autoFocus ? true : undefined}
        className={mergeClass(BOX, className)}
        {...rest}
      />
    );
  }
  return (
    <label
      className={mergeClass(
        cx('inline-flex items-start gap-2 text-sm leading-5', disabled ? 'cursor-not-allowed text-ink-400' : 'cursor-pointer text-ink-700'),
        className
      )}
    >
      <input
        ref={setRef}
        type="checkbox"
        disabled={disabled}
        data-autofocus={rest.autoFocus ? true : undefined}
        className={cx(BOX, 'mt-0.5')}
        {...rest}
      />
      <span className="min-w-0">{label}</span>
    </label>
  );
});
