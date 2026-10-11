/**
 * 单行文本输入
 *
 * 用法：
 *   <Input value={v} onChange={(e) => setV(e.target.value)} placeholder="请输入" />
 *   <Input invalid />                 // 错误态；放在带 error 的 <Field> 里会自动变成错误态
 *
 * - 透传全部原生 input 属性，支持 ref；高 32px，宽度撑满容器（className="w-40" 可改宽度）
 * - 只适合文本类 type（text / search / password / email / url / tel 等）；数字请用 NumberInput
 */
import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { cx, mergeClass } from './cx';
import { controlClass, useFieldControl } from './Field';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, className, id, 'aria-describedby': describedBy, 'aria-required': ariaRequired, ...rest },
  ref
) {
  const field = useFieldControl({ id, invalid, 'aria-describedby': describedBy, 'aria-required': ariaRequired });
  return (
    <input
      ref={ref}
      id={field.id}
      // 对话框的内容是先渲染、后挂进文档的，原生 autoFocus 在里面不生效；
      // Headless UI 认 data-autofocus，这里一并带上，调用方只写 autoFocus 即可
      data-autofocus={rest.autoFocus ? true : undefined}
      aria-invalid={field.invalid || undefined}
      aria-describedby={field.describedBy}
      aria-required={field.required}
      className={mergeClass(cx(controlClass(field.invalid), 'h-8 px-2.5 py-0'), className)}
      {...rest}
    />
  );
});
