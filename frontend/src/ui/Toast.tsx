/**
 * 轻提示（右下角堆叠）
 *
 * 用法：
 *   // 1. 应用根部挂一次
 *   <ToastProvider><App /></ToastProvider>
 *
 *   // 2. 组件里
 *   const toast = useToast();
 *   toast.success('已保存');
 *   toast.error('生成失败：模型超时', { title: '第 3 章' });
 *   const id = toast.info('正在导出…', { duration: 0 });   // duration: 0 不自动消失
 *   toast.dismiss(id);
 *
 *   // 3. 非组件代码（请求封装、工具函数）里直接用单例
 *   import { toast } from '../ui';
 *
 * - 默认 4 秒后自动消失，error 为 8 秒；鼠标悬停时暂停计时；右侧可手动关闭
 * - 最多同时显示 5 条，超出时最早的先被挤掉
 * - useToast() 返回的对象引用稳定，可以放心写进 useEffect / useCallback 的依赖
 * - 没挂 ToastProvider 时调用不会报错，只是不显示（开发环境会在控制台提醒一次）
 */
import { CheckCircleIcon, ExclamationCircleIcon, InformationCircleIcon, XMarkIcon } from '@heroicons/react/20/solid';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './cx';

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastOptions {
  /** 自动消失的毫秒数；0 表示不自动消失。默认 4000，error 为 8000 */
  duration?: number;
  title?: ReactNode;
}

export interface ToastApi {
  success(message: ReactNode, opts?: ToastOptions): string;
  error(message: ReactNode, opts?: ToastOptions): string;
  info(message: ReactNode, opts?: ToastOptions): string;
  /** 关闭指定提示；不传 id 关闭全部 */
  dismiss(id?: string): void;
}

interface ToastItem {
  id: string;
  kind: ToastKind;
  message: ReactNode;
  title?: ReactNode;
  duration: number;
}

const MAX_VISIBLE = 5;
const DEFAULT_DURATION: Record<ToastKind, number> = { success: 4000, info: 4000, error: 8000 };

// 模块级的小仓库：让非组件代码也能发提示，且 useToast 的返回值天然稳定
let items: ToastItem[] = [];
let seq = 0;
let mounted = 0;
let warned = false;
const listeners: Array<() => void> = [];

function emit() {
  listeners.slice().forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

function getSnapshot() {
  return items;
}

function push(kind: ToastKind, message: ReactNode, opts?: ToastOptions): string {
  if (mounted === 0 && !warned && process.env.NODE_ENV !== 'production') {
    warned = true;
    // eslint-disable-next-line no-console
    console.warn('[Toast] 还没有挂载 <ToastProvider>，提示不会显示。');
  }
  seq += 1;
  const id = `toast-${seq}`;
  const duration = opts && opts.duration != null ? opts.duration : DEFAULT_DURATION[kind];
  const next = items.concat({ id, kind, message, title: opts ? opts.title : undefined, duration });
  items = next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
  emit();
  return id;
}

function dismiss(id?: string) {
  const next = id == null ? [] : items.filter((t) => t.id !== id);
  if (next.length === items.length) return;
  items = next;
  emit();
}

/** 单例：组件外也能直接调用 */
export const toast: ToastApi = {
  success: (message, opts) => push('success', message, opts),
  error: (message, opts) => push('error', message, opts),
  info: (message, opts) => push('info', message, opts),
  dismiss,
};

export function useToast(): ToastApi {
  return toast;
}

const ICON: Record<ToastKind, ReactNode> = {
  success: <CheckCircleIcon className="h-5 w-5 text-emerald-500" />,
  error: <ExclamationCircleIcon className="h-5 w-5 text-rose-500" />,
  info: <InformationCircleIcon className="h-5 w-5 text-primary-500" />,
};

const LEAVE_MS = 150;

function ToastCard({ item }: { item: ToastItem }) {
  const [paused, setPaused] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const remaining = useRef(item.duration);

  const close = useCallback(() => setLeaving(true), []);

  // 自动消失；悬停时暂停，移开后用剩余时间继续（至少再留 1 秒，免得鼠标一走就没了）
  useEffect(() => {
    if (paused || leaving) return;
    if (!(item.duration > 0) || !Number.isFinite(item.duration)) return;
    const startedAt = Date.now();
    const timer = window.setTimeout(close, remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(1000, remaining.current - (Date.now() - startedAt));
    };
  }, [paused, leaving, item.duration, close]);

  // 先淡出再真正移除
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => dismiss(item.id), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, item.id]);

  return (
    <div
      role={item.kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className={cx(
        'pointer-events-auto flex items-start gap-2.5 rounded-lg border border-line bg-white py-3 pl-3 pr-2 shadow-pop',
        'transition-opacity duration-150',
        leaving ? 'opacity-0' : 'animate-toast-in'
      )}
    >
      <span className="mt-px shrink-0" aria-hidden="true">
        {ICON[item.kind]}
      </span>
      <div className="min-w-0 flex-1 break-words text-[13px] leading-5">
        {item.title != null ? <div className="font-medium text-ink-900">{item.title}</div> : null}
        <div className={item.title != null ? 'mt-0.5 text-ink-600' : 'text-ink-900'}>{item.message}</div>
      </div>
      <button
        type="button"
        aria-label="关闭"
        onClick={close}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-400 transition-colors hover:bg-ink-900/[0.06] hover:text-ink-900"
      >
        <XMarkIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

function ToastViewport() {
  const list = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    mounted += 1;
    return () => {
      mounted -= 1;
    };
  }, []);

  if (list.length === 0 || typeof document === 'undefined') return null;
  // 挂到 body 下：不受祖先 transform / overflow 影响；Headless UI 的对话框打开时
  // 也只会把应用根节点设为 inert，这里的提示仍然可以点
  return createPortal(
    <div
      role="region"
      aria-label="通知"
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {list.map((item) => (
        <ToastCard key={item.id} item={item} />
      ))}
    </div>,
    document.body
  );
}

export function ToastProvider({ children }: { children?: ReactNode }) {
  return (
    <>
      {children}
      <ToastViewport />
    </>
  );
}
