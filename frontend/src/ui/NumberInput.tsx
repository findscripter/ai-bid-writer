/**
 * 数字输入
 *
 * 用法：
 *   <NumberInput value={words} onChange={setWords} min={500} max={20000} step={500} suffix="字" />
 *   <NumberInput value={temp} onChange={setTemp} min={0} max={2} step={0.1} className="w-24" />
 *
 * - 受控：value / onChange 都是 number，onChange 只会给出范围内、精度合规的值
 * - 输入过程中不打断：越界或没输完的内容先留在框里，失焦（或按回车）时才钳制到 [min, max]；
 *   清空或输入了非数字，失焦时恢复成原值
 * - 上下方向键按 step 增减（按住 Shift 为 10 倍）
 * - 小数位数默认取 step 的小数位（step=1 只收整数，step=0.1 保留 1 位），也可用 precision 指定
 * - suffix：显示在框内右侧的单位（如「字」「页」「%」）
 * - 放在带 error 的 <Field> 里会自动变成错误态，也可手传 invalid
 */
import { forwardRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, ReactNode } from 'react';
import { cx, mergeClass } from './cx';
import { useFieldControl } from './Field';

export interface NumberInputProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: ReactNode;
  disabled?: boolean;
  invalid?: boolean;
  /** 小数位数；默认取 step 的小数位 */
  precision?: number;
  id?: string;
  name?: string;
  placeholder?: string;
  autoFocus?: boolean;
  /** 作用在外框上，可用 w-* 调整宽度（默认撑满容器） */
  className?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
}

function decimalsOf(step: number): number {
  const s = String(step);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

// 中文输入法下容易打出全角数字和符号，统一转成半角再解析
function normalize(text: string): string {
  return text
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[．。]/g, '.')
    .replace(/[－—]/g, '-')
    .replace(/[,，\s]/g, '');
}

function parse(text: string): number | null {
  const t = normalize(text);
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  {
    value,
    onChange,
    min,
    max,
    step = 1,
    suffix,
    disabled = false,
    invalid,
    precision,
    id,
    name,
    placeholder,
    autoFocus,
    className,
    'aria-label': ariaLabel,
    'aria-describedby': describedBy,
  },
  ref
) {
  const field = useFieldControl({ id, invalid, 'aria-describedby': describedBy });
  const digits = precision != null ? Math.max(0, precision) : decimalsOf(step);

  const round = (n: number) => {
    const f = Math.pow(10, digits);
    return Math.round(n * f) / f;
  };
  const clamp = (n: number) => {
    let out = n;
    if (min != null && out < min) out = min;
    if (max != null && out > max) out = max;
    return out;
  };
  const format = (n: number) => (Number.isFinite(n) ? String(n) : '');

  const [text, setText] = useState(() => format(value));
  const [focused, setFocused] = useState(false);
  const [seen, setSeen] = useState(value);

  // 外部改了 value：没在输入时直接同步；正在输入时，只有和框里的数对不上才覆盖
  if (!Object.is(value, seen)) {
    setSeen(value);
    if (!focused || parse(text) !== value) setText(format(value));
  }

  const commit = () => {
    const parsed = parse(text);
    const next = clamp(round(parsed == null ? value : parsed));
    setText(format(next));
    if (next !== value) onChange(next);
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setText(raw);
    const n = parse(raw);
    // 合规的值立刻上报，方便调用方实时联动；不合规的等失焦时再处理
    if (n != null && n === clamp(round(n)) && n !== value) onChange(n);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commit();
      return;
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const parsed = parse(text);
    const base = parsed == null ? value : parsed;
    const delta = (e.key === 'ArrowUp' ? step : -step) * (e.shiftKey ? 10 : 1);
    const next = clamp(round(base + delta));
    setText(format(next));
    if (next !== value) onChange(next);
  };

  return (
    <div
      className={mergeClass(
        cx(
          'flex h-8 w-full items-center rounded-md border transition-colors focus-within:ring-2',
          disabled ? 'cursor-not-allowed border-line bg-subtle' : 'bg-white',
          field.invalid
            ? 'border-rose-400 focus-within:border-rose-500 focus-within:ring-rose-500/20'
            : cx(
                'focus-within:border-primary-500 focus-within:ring-primary-500/20',
                // 悬停色只在没聚焦时生效，聚焦时边框保持主色
                !disabled && 'border-line-strong [&:not(:focus-within):hover]:border-ink-300'
              )
        ),
        className
      )}
    >
      <input
        ref={ref}
        id={field.id}
        name={name}
        type="text"
        inputMode={digits > 0 ? 'decimal' : 'numeric'}
        autoComplete="off"
        role="spinbutton"
        aria-valuenow={Number.isFinite(value) ? value : undefined}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-label={ariaLabel}
        aria-invalid={field.invalid || undefined}
        aria-describedby={field.describedBy}
        aria-required={field.required}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        data-autofocus={autoFocus ? true : undefined}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        className="h-full w-full min-w-0 flex-1 rounded-md border-0 bg-transparent px-2.5 py-0 text-sm tabular-nums text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-0 disabled:cursor-not-allowed disabled:text-ink-400"
      />
      {suffix != null ? (
        <span className="pointer-events-none shrink-0 select-none pr-2.5 text-xs text-ink-500">{suffix}</span>
      ) : null}
    </div>
  );
});
