/**
 * 标签条（受控；只负责切换，内容由调用方按 value 自行渲染）
 *
 * 用法：
 *   const [tab, setTab] = useState('plan');
 *   <Tabs
 *     value={tab}
 *     onChange={setTab}
 *     tabs={[
 *       { key: 'plan', label: '写作计划' },
 *       { key: 'issues', label: '问题', badge: 3 },
 *       { key: 'refs', label: '引用', disabled: true },
 *     ]}
 *   />
 *   {tab === 'plan' && <PlanPanel />}
 *
 * - variant：line 下划线（默认，用于页面/面板内的分区）/ pill 分段控件（用于小范围视图切换）
 * - size：sm / md
 * - badge：字符串或数字会渲染成计数小圆标，其他节点原样渲染
 * - 键盘：左右方向键、Home、End 在标签间移动并切换
 * - fill：标签等分整行宽度（窄侧栏里常用）
 */
import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { cx, mergeClass } from './cx';

export interface TabItem {
  key: string;
  label: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
}

export type TabsVariant = 'line' | 'pill';
export type TabsSize = 'sm' | 'md';

export interface TabsProps {
  tabs: TabItem[];
  value: string;
  onChange: (key: string) => void;
  variant?: TabsVariant;
  size?: TabsSize;
  /** 标签等分整行宽度 */
  fill?: boolean;
  className?: string;
  'aria-label'?: string;
}

const LIST: Record<TabsVariant, string> = {
  line: 'flex items-stretch gap-5 border-b border-line',
  pill: 'inline-flex items-center gap-0.5 rounded-lg border border-line bg-canvas p-0.5',
};

const TAB_BASE: Record<TabsVariant, Record<TabsSize, string>> = {
  line: {
    sm: '-mb-px h-8 border-b-2 text-[13px]',
    md: '-mb-px h-10 border-b-2 text-sm',
  },
  pill: {
    sm: 'h-6 rounded-md px-2.5 text-xs',
    md: 'h-7 rounded-md px-3 text-[13px]',
  },
};

const TAB_STATE: Record<TabsVariant, { on: string; off: string }> = {
  line: {
    on: 'border-primary-600 text-ink-900',
    off: 'border-transparent text-ink-500 enabled:hover:text-ink-900',
  },
  pill: {
    on: 'bg-white text-ink-900 shadow-card ring-1 ring-line',
    off: 'text-ink-500 enabled:hover:text-ink-900',
  },
};

export function Tabs({
  tabs,
  value,
  onChange,
  variant = 'line',
  size = 'md',
  fill = false,
  className,
  'aria-label': ariaLabel,
}: TabsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const hasSelection = tabs.some((t) => t.key === value && !t.disabled);
  const firstEnabled = tabs.find((t) => !t.disabled);

  const move = (from: number, dir: 1 | -1 | 'first' | 'last') => {
    const n = tabs.length;
    let idx = -1;
    if (dir === 'first' || dir === 'last') {
      const order = tabs.map((_, i) => (dir === 'first' ? i : n - 1 - i));
      for (let k = 0; k < order.length; k++) {
        if (!tabs[order[k]].disabled) {
          idx = order[k];
          break;
        }
      }
    } else {
      for (let step = 1; step <= n; step++) {
        const i = (from + dir * step + n * step) % n;
        if (!tabs[i].disabled) {
          idx = i;
          break;
        }
      }
    }
    if (idx < 0 || idx === from) return;
    onChange(tabs[idx].key);
    const buttons = listRef.current ? listRef.current.querySelectorAll<HTMLButtonElement>('[role="tab"]') : null;
    if (buttons && buttons[idx]) buttons[idx].focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      move(index, 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      move(index, -1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      move(index, 'first');
    } else if (e.key === 'End') {
      e.preventDefault();
      move(index, 'last');
    }
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      className={mergeClass(cx(LIST[variant], fill && (variant === 'pill' ? 'flex w-full' : 'w-full')), className)}
    >
      {tabs.map((tab, index) => {
        const selected = tab.key === value;
        // 没有任何选中项时，让第一个可用标签能被 Tab 键聚焦到
        const tabbable = selected || (!hasSelection && firstEnabled != null && firstEnabled.key === tab.key);
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={tabbable ? 0 : -1}
            disabled={tab.disabled}
            onClick={() => {
              if (!selected) onChange(tab.key);
            }}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={cx(
              'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-40',
              TAB_BASE[variant][size],
              selected ? TAB_STATE[variant].on : TAB_STATE[variant].off,
              fill && 'flex-1'
            )}
          >
            {tab.label}
            {tab.badge != null && tab.badge !== false ? (
              typeof tab.badge === 'string' || typeof tab.badge === 'number' ? (
                <span
                  className={cx(
                    'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-2xs font-medium tabular-nums',
                    selected ? 'bg-primary-50 text-primary-700' : 'bg-ink-900/[0.06] text-ink-500'
                  )}
                >
                  {tab.badge}
                </span>
              ) : (
                tab.badge
              )
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
