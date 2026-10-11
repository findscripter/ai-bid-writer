/**
 * 基于 location.hash 的极简路由（无依赖；地址形如 http://host/#/projects/abc/write?tab=plan）
 *
 * 用法：
 *   const route = useHashRoute();
 *   // route.path      "/projects/abc/write"（空 hash 视为 "/"；不含 query，末尾不带斜杠）
 *   // route.segments  ["projects", "abc", "write"]（已做 URL 解码）
 *   // route.query     URLSearchParams，route.query.get('tab') → "plan"
 *
 *   const m = matchPath('/projects/:id/:stage?', route.path);
 *   if (m) return <ProjectPage id={m.id} stage={m.stage ?? 'tender'} />;   // 缺省的可选段不会出现在结果里
 *
 *   navigate('/projects/abc/outline');                  // 追加一条历史记录
 *   navigate('/projects/abc/write?tab=plan', { replace: true });   // 替换当前记录（重定向、切换页签时用）
 *
 *   <Link to="/projects/abc" className="text-primary-600">打开项目</Link>
 *
 *   // 有未保存的修改时拦住离开（站内跳转、浏览器前进后退、刷新或关闭页面都会先确认）
 *   useUnsavedChangesGuard(dirty, '正文有修改还没有保存，确定要离开吗？');
 *   // 前进后退被拒绝时，靠 history.state 里记的序号把历史位置移回去：别处不要整体替换 history.state，
 *   // 也不要绕过 navigate 直接改 location.hash
 *
 * matchPath 的规则：
 * - 按「/」逐段比较，段数必须对得上；字面量段区分大小写
 * - :name 匹配任意一个非空段；:name? 是可选段，只应写在结尾（可以连续多个）
 * - 结尾写 * 匹配剩余全部（含零段），结果放在键 "*" 里
 * - 返回的参数值已做 URL 解码；不匹配返回 null
 */
import { createElement, forwardRef, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { AnchorHTMLAttributes, MouseEvent } from 'react';

export interface NavigateOptions {
  /** 替换当前历史记录而不是新增一条 */
  replace?: boolean;
  /** 跳过离开前的确认（调用方已经用自己的对话框确认过了） */
  force?: boolean;
}

export interface HashRoute {
  path: string;
  segments: string[];
  query: URLSearchParams;
  navigate: (to: string, opts?: NavigateOptions) => void;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function splitPath(raw: string): string[] {
  return raw.split('/').filter((part) => part !== '');
}

/** 拆出规范化的路径与 query 串：容忍开头的 #、缺失的 /、多余的 / */
function splitTarget(raw: string): { path: string; search: string } {
  let text = raw.trim();
  if (text.charAt(0) === '#') text = text.slice(1);
  const q = text.indexOf('?');
  const search = q >= 0 ? text.slice(q + 1) : '';
  if (q >= 0) text = text.slice(0, q);
  return { path: '/' + splitPath(text).join('/'), search };
}

/** 把站内路径转成 a 标签可用的 href："/projects/abc" → "#/projects/abc" */
export function toHref(to: string): string {
  const { path, search } = splitTarget(to);
  return '#' + path + (search ? '?' + search : '');
}

const listeners: Array<() => void> = [];

function notify() {
  listeners.slice().forEach((fn) => fn());
}

// ---- 离开前确认 ----
// 守卫返回 true 表示允许离开。站内跳转时依次询问，任何一个不同意就留在原地。
type NavigationGuard = () => boolean;
const guards: NavigationGuard[] = [];
/** 已经被允许的那一次跳转：浏览器随后派发的 hashchange 不必再问一遍 */
let approvedHash: string | null = null;
/**
 * 界面当前显示的地址。路由以它为准而不是直接读 location.hash：
 * 前进后退被拒绝后，浏览器要过一会儿才回到原来那条记录，这期间地址栏里是被拒绝的地址，界面不能跟着变
 */
let lastHash = typeof window === 'undefined' ? '' : window.location.hash;

// ---- 历史记录的序号 ----
// 本路由经手的每条历史记录都在 history.state 里记一个递增的序号（新跳转一条加一，替换沿用）。
// 浏览器的前进后退被拒绝时，按序号差用 history.go 把位置移回原来那条记录；
// 不能改写目标记录的地址，否则历史里会多出一条重复的记录，下一次后退没反应、再后退又跳过了上一页
const INDEX_KEY = '__aiBidRouterIndex';
/** 当前所在那条历史记录的序号 */
let currentIndex = 0;
/** 被拒绝后正在用 history.go 回去的那条记录的序号：这次回跳引发的 hashchange 不再询问 */
let returningTo: number | null = null;

function historyState(): Record<string, unknown> | null {
  const state: unknown = window.history.state;
  return state && typeof state === 'object' ? (state as Record<string, unknown>) : null;
}

function readIndex(): number | null {
  const state = historyState();
  const value = state ? state[INDEX_KEY] : undefined;
  return typeof value === 'number' && isFinite(value) ? value : null;
}

/** 给当前这条历史记录记上序号（保留 history.state 里别的内容） */
function markCurrent(index: number): void {
  currentIndex = index;
  try {
    window.history.replaceState({ ...historyState(), [INDEX_KEY]: index }, '');
  } catch {
    // 记不上序号（极少见）：被拒绝时退回到改写地址的做法
  }
}

if (typeof window !== 'undefined') {
  const index = readIndex();
  // 刷新页面时 history.state 还在，沿用原来的序号；新打开的从 0 开始
  if (index === null) markCurrent(0);
  else currentIndex = index;
}

function allowNavigation(): boolean {
  for (let i = 0; i < guards.length; i++) {
    if (!guards[i]()) return false;
  }
  return true;
}

/** 注册一个离开前的守卫，返回注销函数 */
export function addNavigationGuard(guard: NavigationGuard): () => void {
  guards.push(guard);
  return () => {
    const i = guards.indexOf(guard);
    if (i >= 0) guards.splice(i, 1);
  };
}

function onHashChange() {
  const hash = window.location.hash;
  const index = readIndex();
  if (returningTo !== null) {
    // 前进后退被拒绝后回到原来那条记录：只是回到原处，不再询问，界面也不用变
    const target = returningTo;
    returningTo = null;
    if (index === target) currentIndex = target;
    if (hash === lastHash) return;
    // 回到的不是原来那条（期间又有别的跳转）：按普通的跳转处理
  }
  if (approvedHash !== null && hash === approvedHash) {
    approvedHash = null;
  } else if (hash !== lastHash && !allowNavigation()) {
    // 浏览器的前进后退没法取消，只能再走回去
    if (index !== null && index !== currentIndex) {
      returningTo = currentIndex;
      window.history.go(currentIndex - index);
    } else {
      // 不知道这条记录在前还是在后（例如在地址栏里直接改的）：只能把它的地址改回当前页
      const { pathname, search } = window.location;
      window.history.replaceState(window.history.state, '', pathname + search + lastHash);
    }
    return;
  }
  // 没有序号的记录（在地址栏里直接改的地址）当作新的一条
  if (index === null) markCurrent(currentIndex + 1);
  else currentIndex = index;
  lastHash = hash;
  notify();
}

/**
 * 前进后退到地址相同的另一条记录（不派发 hashchange，界面也不用变）：只记下现在在哪一条，
 * 之后被拒绝时才能按正确的序号差走回来。地址变了的交给 hashchange（要先过离开前的确认）
 */
function onPopState() {
  if (returningTo !== null || window.location.hash !== lastHash) return;
  const index = readIndex();
  if (index !== null) currentIndex = index;
}

function subscribe(fn: () => void) {
  listeners.push(fn);
  if (listeners.length === 1) {
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('popstate', onPopState);
    // 没人订阅期间地址变过（几乎不会）：以地址栏为准
    if (returningTo === null && window.location.hash !== lastHash) {
      lastHash = window.location.hash;
      const index = readIndex();
      if (index !== null) currentIndex = index;
    }
  }
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
    if (listeners.length === 0) {
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('popstate', onPopState);
    }
  };
}

function readHash(): string {
  return lastHash;
}

function emptyHash(): string {
  return '';
}

/** 跳转到站内路径。to 形如 "/projects/abc/write?tab=plan"（开头带不带 # 都行） */
export function navigate(to: string, opts?: NavigateOptions): void {
  if (typeof window === 'undefined') return;
  const href = toHref(to);
  if (href === lastHash) return;
  if (!(opts && opts.force) && !allowNavigation()) return;
  if (opts && opts.replace) {
    // 替换当前记录：沿用它的序号（history.state 原样保留）
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, '', pathname + search + href);
  } else if (window.location.hash !== href) {
    approvedHash = href;
    // 赋值后新记录立刻生成（hashchange 稍后才派发），马上给它记上序号
    window.location.hash = href;
    markCurrent(currentIndex + 1);
  }
  lastHash = href;
  // hashchange 是异步派发的，replaceState 则根本不派发；这里同步通知一次，让界面立刻跟上
  notify();
}

/**
 * dirty 为 true 期间：站内跳转、浏览器前进后退前先确认；刷新、关闭页面时浏览器弹出“离开此网站？”。
 * message 只用于站内跳转的确认框（浏览器自己的提示文案不能自定义）。
 */
export function useUnsavedChangesGuard(dirty: boolean, message = '有修改还没有保存，确定要离开吗？'): void {
  const messageRef = useRef(message);
  messageRef.current = message;
  useEffect(() => {
    if (!dirty) return undefined;
    const removeGuard = addNavigationGuard(() => window.confirm(messageRef.current));
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // 旧版浏览器需要给 returnValue 赋值才会提示
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      removeGuard();
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [dirty]);
}

/** 订阅当前 hash 路由；hash 变化（含浏览器前进后退）时所在组件重新渲染 */
export function useHashRoute(): HashRoute {
  const hash = useSyncExternalStore(subscribe, readHash, emptyHash);
  return useMemo(() => {
    const { path, search } = splitTarget(hash);
    return {
      path,
      segments: splitPath(path).map(safeDecode),
      query: new URLSearchParams(search),
      navigate,
    };
  }, [hash]);
}

/** 路径匹配，规则见文件头说明 */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const patternParts = splitPath(pattern.trim());
  const parts = splitPath(splitTarget(path).path).map(safeDecode);
  const params: Record<string, string> = {};

  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];
    if (p === '*' && i === patternParts.length - 1) {
      params['*'] = parts.slice(i).join('/');
      return params;
    }
    if (p.charAt(0) === ':') {
      const optional = p.charAt(p.length - 1) === '?';
      const name = optional ? p.slice(1, -1) : p.slice(1);
      if (i < parts.length) params[name] = parts[i];
      else if (!optional) return null;
    } else if (i >= parts.length || parts[i] !== safeDecode(p)) {
      return null;
    }
  }
  return parts.length > patternParts.length ? null : params;
}

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** 站内路径，如 "/projects/abc/write" */
  to: string;
  /** 点击时替换当前历史记录 */
  replace?: boolean;
}

/**
 * 站内链接：渲染成 <a href="#/...">，其余 a 标签属性原样透传。
 * 普通点击交给浏览器处理（所以 Ctrl/中键点击新开标签页、右键复制链接都正常）。
 */
export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { to, replace = false, onClick, target, ...rest },
  ref
) {
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (onClick) onClick(e);
    if (e.defaultPrevented) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (target && target !== '_self') return;
    // 统一走 navigate：先过离开前的确认，不同意就留在原地
    e.preventDefault();
    navigate(to, { replace });
  };
  return createElement('a', { ...rest, ref, target, href: toHref(to), onClick: handleClick });
});
