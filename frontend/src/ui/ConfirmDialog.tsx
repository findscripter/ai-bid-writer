/**
 * 二次确认对话框（Promise 风格）
 *
 * 用法：
 *   // 1. 应用根部挂一次
 *   <ConfirmProvider><App /></ConfirmProvider>
 *
 *   // 2. 组件里
 *   const confirm = useConfirm();
 *   const ok = await confirm({
 *     title: '删除这一章？',
 *     description: '已生成的正文会一并删除，无法恢复。',
 *     confirmText: '删除',
 *     tone: 'danger',
 *   });
 *   if (!ok) return;
 *
 * - 点「取消」、点遮罩、按 Esc 都得到 false；点确认得到 true
 * - tone：primary（默认，初始焦点在确认按钮上，回车即确认）/
 *         danger（确认按钮为红色，初始焦点落在「取消」上防误触）
 * - 同时发起多个确认会排队逐个弹出
 * - 页面换了（例如对话框开着时按了浏览器后退并确认离开）：还没回应的确认按「取消」关掉，
 *   不会留在新页面上，点了也不会再去执行原来页面上的操作。离开前的确认被拒、留在原页面时不受影响
 * - useConfirm() 返回的函数引用稳定；没挂 ConfirmProvider 时退回浏览器原生 confirm
 */
import { Description } from '@headlessui/react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useHashRoute } from '../lib/router';
import { Button } from './Button';
import { Modal } from './Modal';

export interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  tone?: 'danger' | 'primary';
}

export type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

interface Pending {
  id: number;
  opts: ConfirmOptions;
  resolve: (ok: boolean) => void;
  /** 发起确认时界面所在的页面（路径 + 参数）：页面换了，这个确认就不作数了 */
  page: string;
}

const ConfirmContext = createContext<ConfirmFn | null>(null);

// 与 Modal 的关闭过渡对齐：等动画走完再换下一条，避免文字在淡出途中突变
const CLOSE_MS = 220;

const nativeConfirm: ConfirmFn = (opts) => {
  if (typeof window === 'undefined') return Promise.resolve(false);
  const detail = typeof opts.description === 'string' ? `\n\n${opts.description}` : '';
  return Promise.resolve(window.confirm(opts.title + detail));
};

export function ConfirmProvider({ children }: { children?: ReactNode }) {
  const [queue, setQueue] = useState<Pending[]>([]);
  const [closing, setClosing] = useState(false);
  // ref 里放同一份队列：confirm / settle 需要读到最新值，又不能因此变引用
  const queueRef = useRef<Pending[]>([]);
  const closingRef = useRef(false);
  const seq = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  // 界面当前显示的页面。以路由为准而不是直接读地址栏：前进后退被离开前的确认拦下时，
  // 地址栏会短暂停在被拒绝的地址上，界面并没有离开，确认框也不该关
  const route = useHashRoute();
  const page = `${route.path}?${route.query.toString()}`;
  const pageRef = useRef(page);
  pageRef.current = page;

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      seq.current += 1;
      queueRef.current = queueRef.current.concat({ id: seq.current, opts, resolve, page: pageRef.current });
      setQueue(queueRef.current);
    });
  }, []);

  // 只用到 ref 和 setState，引用保持稳定
  const settle = useCallback((ok: boolean) => {
    const current = queueRef.current[0];
    if (!current || closingRef.current) return;
    current.resolve(ok);
    closingRef.current = true;
    setClosing(true);
    timer.current = window.setTimeout(() => {
      closingRef.current = false;
      setClosing(false);
      queueRef.current = queueRef.current.slice(1);
      setQueue(queueRef.current);
    }, CLOSE_MS);
  }, []);

  // 页面换了（浏览器前进后退、站内跳转）：发起时的页面已经不在了，还没回应的确认一律按「取消」处理
  useEffect(() => {
    const pending = queueRef.current;
    if (pending.length === 0) return;
    const head = pending[0];
    // 排在后面、还没显示出来的：直接回应并移出队列
    const rest = pending.slice(1).filter((item) => {
      if (item.page === page) return true;
      item.resolve(false);
      return false;
    });
    if (rest.length !== pending.length - 1) {
      queueRef.current = [head].concat(rest);
      setQueue(queueRef.current);
    }
    // 正在显示的：走正常的关闭流程（已经在关了就不用管）
    if (head.page !== page) settle(false);
  }, [page, settle]);

  // 卸载时别让调用方的 await 永远挂着
  useEffect(() => {
    return () => {
      window.clearTimeout(timer.current);
      const rest = closingRef.current ? queueRef.current.slice(1) : queueRef.current;
      rest.forEach((p) => p.resolve(false));
      queueRef.current = [];
      closingRef.current = false;
    };
  }, []);

  const current = queue[0];
  const opts = current ? current.opts : null;
  const danger = opts != null && opts.tone === 'danger';

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={current != null && !closing}
        onClose={() => settle(false)}
        role="alertdialog"
        size="sm"
        hideClose
        title={opts ? opts.title : undefined}
        footer={
          <>
            <Button onClick={() => settle(false)} data-autofocus={danger ? true : undefined}>
              {(opts && opts.cancelText) || '取消'}
            </Button>
            <Button
              variant={danger ? 'danger' : 'primary'}
              onClick={() => settle(true)}
              data-autofocus={danger ? undefined : true}
            >
              {(opts && opts.confirmText) || '确定'}
            </Button>
          </>
        }
      >
        {opts && opts.description != null ? (
          <Description as="div" className="text-[13px] leading-6 text-ink-600">
            {opts.description}
          </Description>
        ) : null}
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  return ctx || nativeConfirm;
}
