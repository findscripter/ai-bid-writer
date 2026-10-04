/**
 * 下拉选择（原生 select，外观与 Input 一致）
 *
 * 用法：
 *   <Select value={v} onChange={(e) => setV(e.target.value)}>
 *     <option value="a">方案 A</option>
 *     <option value="b">方案 B</option>
 *   </Select>
 *   <Select value={v} onChange={...} placeholder="请选择模型"
 *           options={[{ value: 'x', label: '模型 X' }, { value: 'y', label: '模型 Y', disabled: true }]} />
 *
 * - 透传全部原生 select 属性，支持 ref；invalid 显示错误态（在带 error 的 <Field> 里自动生效）
 * - options：不想手写 <option> 时传数组；与 children 同时存在时 options 在前
 * - placeholder：value 为空串时显示的灰色提示项（不可选）
 */
import { forwardRef } from 'react';
import type { SelectHTMLAttributes } from 'react';
import { cx, mergeClass } from './cx';
import { controlClass, useFieldControl } from './Field';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
  options?: SelectOption[];
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    invalid,
    options,
    placeholder,
    className,
    id,
    children,
    'aria-describedby': describedBy,
    'aria-required': ariaRequired,
    ...rest
  },
  ref
) {
  const field = useFieldControl({ id, invalid, 'aria-describedby': describedBy, 'aria-required': ariaRequired });
  return (
    <select
      ref={ref}
      id={field.id}
      data-autofocus={rest.autoFocus ? true : undefined}
      aria-invalid={field.invalid || undefined}
      aria-describedby={field.describedBy}
      aria-required={field.required}
      className={mergeClass(cx(controlClass(field.invalid), 'h-8 py-0 pl-2.5 pr-8'), className)}
      {...rest}
    >
      {placeholder != null ? (
        <option value="" disabled hidden>
          {placeholder}
        </option>
      ) : null}
      {options
        ? options.map((opt) => (
            <option key={opt.value} value={opt.value} disabled={opt.disabled}>
              {opt.label}
            </option>
          ))
        : null}
      {children}
    </select>
  );
});
