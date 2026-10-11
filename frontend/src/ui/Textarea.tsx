/**
 * 多行文本输入
 *
 * 用法：
 *   <Textarea rows={4} value={v} onChange={(e) => setV(e.target.value)} />
 *   <Textarea autoResize className="max-h-80" ... />   // 高度随内容增长，到 max-h 后出现滚动条
 *
 * - 透传全部原生 textarea 属性，支持 ref；invalid 显示错误态（在带 error 的 <Field> 里自动生效）
 * - autoResize：高度跟随内容，最小高度由 rows 决定（默认 3 行），关闭手动拖拽
 */
import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { FormEvent, TextareaHTMLAttributes } from 'react';
import { cx, mergeClass } from './cx';
import { controlClass, useFieldControl } from './Field';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  /** 高度随内容自动增长 */
  autoResize?: boolean;
}

type ScrollRecord = Array<{ node: Element; top: number }>;

/**
 * 记下各个祖先（含页面本身）的滚动位置：已经滚过的、以及内容超出可以滚动的。
 * - 量高度时要先把高度临时设成 auto，内容会瞬间变短，外层滚动容器的位置会被浏览器夹回去，
 *   量完必须原样还原，否则在长文后半部分输入（尤其是输入法上屏）时视图会跳回顶部；
 * - 换行让内容比文本框高出一截时，浏览器在派发 input 之前就会为了“露出光标”去滚外层容器，
 *   常常一下把当前行甩到可视区最上沿。所以要在输入之前（beforeinput、回车的 keydown、输入法开始组字）就记下位置，
 *   量完高度后按这份记录还原；真需要露出光标时，浏览器随后还会再做一次正常的滚动。
 */
function rememberScroll(el: HTMLElement): ScrollRecord {
  const saved: ScrollRecord = [];
  let node: Element | null = el.parentElement;
  while (node) {
    if (node.scrollTop > 0 || node.scrollHeight > node.clientHeight) saved.push({ node, top: node.scrollTop });
    node = node.parentElement;
  }
  return saved;
}

function restoreScroll(saved: ScrollRecord): void {
  saved.forEach((item) => {
    if (item.node.scrollTop !== item.top) item.node.scrollTop = item.top;
  });
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    invalid,
    autoResize = false,
    className,
    id,
    rows = 3,
    onInput,
    'aria-describedby': describedBy,
    'aria-required': ariaRequired,
    ...rest
  },
  ref
) {
  const field = useFieldControl({ id, invalid, 'aria-describedby': describedBy, 'aria-required': ariaRequired });
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  // 这一次输入之前记下的滚动位置（浏览器可能在 input 事件之前就滚过了外层），只给紧接着的那次量高度用
  const beforeInputRef = useRef<ScrollRecord | null>(null);

  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      innerRef.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [ref]
  );

  const resize = useCallback(() => {
    const el = innerRef.current;
    if (!el) return;
    const scrolled = beforeInputRef.current || rememberScroll(el);
    beforeInputRef.current = null;
    el.style.height = 'auto';
    if (el.scrollHeight === 0) {
      // 不可见（或测试环境）时量不出高度，保持 auto
      restoreScroll(scrolled);
      return;
    }
    // border-box 下 scrollHeight 不含边框，要补上，否则会多出一条滚动条
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = `${el.scrollHeight + border}px`;
    // 被 max-height 截住时放开滚动
    el.style.overflowY = el.scrollHeight > el.clientHeight + 1 ? 'auto' : 'hidden';
    restoreScroll(scrolled);
  }, []);

  const value = rest.value;
  useLayoutEffect(() => {
    if (autoResize) resize();
  }, [autoResize, resize, value]);

  // 输入之前记下外层的滚动位置：beforeinput 覆盖打字、回车、粘贴、删除、撤销和输入法组字；
  // 回车的 keydown、输入法的 compositionstart / compositionupdate 是给不派发 beforeinput 的浏览器兜底。
  // 记录只在当前这一轮事件里有效：没有输入跟上（被取消、只是按了键）就作废，免得以后拿旧位置去还原
  useEffect(() => {
    const el = innerRef.current;
    if (!autoResize || !el) return undefined;
    let timer: number | undefined;
    const remember = () => {
      beforeInputRef.current = rememberScroll(el);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        beforeInputRef.current = null;
      }, 0);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && !event.isComposing) remember();
    };
    el.addEventListener('beforeinput', remember);
    el.addEventListener('keydown', onKeyDown);
    el.addEventListener('compositionstart', remember);
    el.addEventListener('compositionupdate', remember);
    return () => {
      el.removeEventListener('beforeinput', remember);
      el.removeEventListener('keydown', onKeyDown);
      el.removeEventListener('compositionstart', remember);
      el.removeEventListener('compositionupdate', remember);
      window.clearTimeout(timer);
      beforeInputRef.current = null;
    };
  }, [autoResize]);

  // 宽度变化（窗口缩放、侧栏展开）会改变折行，需要重新量高
  useEffect(() => {
    const el = innerRef.current;
    if (!autoResize || !el || typeof ResizeObserver === 'undefined') return;
    let width = el.offsetWidth;
    const observer = new ResizeObserver(() => {
      if (el.offsetWidth !== width) {
        width = el.offsetWidth;
        resize();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [autoResize, resize]);

  const handleInput = (e: FormEvent<HTMLTextAreaElement>) => {
    if (autoResize) resize(); // 非受控用法下 value 不变，靠 input 事件触发
    if (onInput) onInput(e);
  };

  return (
    <textarea
      ref={setRef}
      id={field.id}
      data-autofocus={rest.autoFocus ? true : undefined}
      rows={rows}
      aria-invalid={field.invalid || undefined}
      aria-describedby={field.describedBy}
      aria-required={field.required}
      onInput={handleInput}
      className={mergeClass(
        cx(controlClass(field.invalid), 'px-2.5 py-1.5 leading-6', autoResize ? 'resize-none overflow-hidden' : 'resize-y'),
        className
      )}
      {...rest}
    />
  );
});
