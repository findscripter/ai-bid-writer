/**
 * 表单项：标签 + 控件 + 说明 / 错误
 *
 * 用法：
 *   <Field label="项目名称" required error={errors.name}>
 *     <Input value={name} onChange={(e) => setName(e.target.value)} />
 *   </Field>
 *   <Field label="每章目标字数" hint="建议 2,000 – 5,000">
 *     <NumberInput value={n} onChange={setN} min={500} max={20000} step={500} suffix="字" />
 *   </Field>
 *
 * - 里面的 Input / Textarea / Select / NumberInput 会自动拿到 id（点标签即聚焦）、
 *   aria-describedby（关联说明文字），并在有 error 时显示成错误态，不用再手传 invalid
 * - error 存在时替换 hint 显示
 * - required 只负责显示红色星号并标注 aria-required，不做校验
 * - 一个 Field 里放多个控件时，自动 id 只适合第一个：请给 Field 传 htmlFor 指向主控件的 id，
 *   并给各控件自己写 id
 */
import { createContext, useContext, useId, useMemo } from 'react';
import type { ReactNode } from 'react';
import { cx, mergeClass } from './cx';

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  /** 手动指定标签指向的控件 id；传了之后不再给子控件自动分配 id */
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}

interface FieldContextValue {
  id?: string;
  describedBy?: string;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

interface ControlOwnProps {
  id?: string;
  invalid?: boolean;
  'aria-describedby'?: string;
  'aria-required'?: boolean | 'true' | 'false';
}

/** 表单控件内部用：把所在 Field 的 id / 错误态 / 说明关联合并进自己的属性（自身属性优先） */
export function useFieldControl(own: ControlOwnProps) {
  const ctx = useContext(FieldContext);
  return {
    id: own.id ?? ctx?.id,
    invalid: own.invalid ?? ctx?.invalid ?? false,
    describedBy: own['aria-describedby'] ?? ctx?.describedBy,
    required: own['aria-required'] ?? (ctx?.required ? true : undefined),
  };
}

/** 文本类控件（Input / Textarea / Select）共用的外观 */
export function controlClass(invalid: boolean): string {
  return cx(
    'block w-full rounded-md border bg-white text-sm text-ink-900 transition-colors placeholder:text-ink-400',
    'focus:outline-none focus:ring-2',
    'disabled:cursor-not-allowed disabled:border-line disabled:bg-subtle disabled:text-ink-400',
    invalid
      ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-500/20'
      : 'border-line-strong hover:border-ink-300 focus:border-primary-500 focus:ring-primary-500/20'
  );
}

export function Field({ label, hint, error, required = false, htmlFor, className, children }: FieldProps) {
  const autoId = useId();
  const hasError = error != null && error !== false && error !== '';
  const hasHint = hint != null && hint !== false && hint !== '';
  const messageId = hasError || hasHint ? `${autoId}-msg` : undefined;
  const controlId = htmlFor ?? autoId;

  const ctx = useMemo<FieldContextValue>(
    () => ({
      id: htmlFor ? undefined : autoId,
      describedBy: messageId,
      invalid: hasError,
      required,
    }),
    [htmlFor, autoId, messageId, hasError, required]
  );

  return (
    <div className={mergeClass('min-w-0', className)}>
      {label != null ? (
        <label htmlFor={controlId} className="mb-1.5 block text-[13px] font-medium leading-5 text-ink-700">
          {label}
          {required ? (
            <span className="ml-0.5 text-rose-500" aria-hidden="true">
              *
            </span>
          ) : null}
        </label>
      ) : null}
      <FieldContext.Provider value={ctx}>{children}</FieldContext.Provider>
      {hasError ? (
        <p id={messageId} role="alert" className="mt-1.5 text-xs leading-5 text-rose-600">
          {error}
        </p>
      ) : hasHint ? (
        <p id={messageId} className="mt-1.5 text-xs leading-5 text-ink-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
