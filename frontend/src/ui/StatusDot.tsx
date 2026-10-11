/**
 * 状态点：章节树、任务列表里表示单个条目的状态
 *
 * 用法：
 *   <StatusDot status="writing" />                 // 主色 + 呼吸动画
 *   <StatusDot status="done" title="已完成 · 3,120 字" />
 *
 * 颜色约定：
 *   empty 浅灰空心（未开始） / queued 灰（排队中） / writing 主色并呼吸（写作中） /
 *   done 绿（已完成） / failed 红（失败） / cancelled 灰圈带斜线（已取消） / review 琥珀（待审校）
 *
 * - pulse：是否带呼吸动画；不传时只有 writing 会动
 * - title：悬停提示与读屏文案；不传用 STATUS_LABEL 里的默认中文名
 */
import { cx, mergeClass } from './cx';

export type DotStatus = 'empty' | 'queued' | 'writing' | 'done' | 'failed' | 'cancelled' | 'review';

export interface StatusDotProps {
  status: DotStatus;
  pulse?: boolean;
  title?: string;
  className?: string;
}

/** 各状态的默认中文名，页面上需要文字时可直接复用 */
export const STATUS_LABEL: Record<DotStatus, string> = {
  empty: '未开始',
  queued: '排队中',
  writing: '写作中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  review: '待审校',
};

const COLOR: Record<DotStatus, string> = {
  empty: 'border border-ink-300 bg-transparent text-ink-300',
  queued: 'bg-ink-300 text-ink-300',
  writing: 'bg-primary-500 text-primary-500',
  done: 'bg-emerald-500 text-emerald-500',
  failed: 'bg-rose-500 text-rose-500',
  cancelled: 'border border-ink-400 bg-transparent text-ink-400',
  review: 'bg-amber-500 text-amber-500',
};

export function StatusDot({ status, pulse, title, className }: StatusDotProps) {
  const label = title ?? STATUS_LABEL[status];
  const animated = pulse ?? status === 'writing';
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={mergeClass(cx('relative inline-flex h-2 w-2 shrink-0 rounded-full', COLOR[status]), className)}
    >
      {animated ? (
        <span className="absolute inset-0 animate-breathe rounded-full bg-current" aria-hidden="true" />
      ) : null}
      {status === 'cancelled' ? (
        <span
          className="absolute left-1/2 top-1/2 h-px w-[9px] -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-current"
          aria-hidden="true"
        />
      ) : null}
    </span>
  );
}
