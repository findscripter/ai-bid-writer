/**
 * 空状态：列表为空、尚未生成、没有搜索结果时的占位
 *
 * 用法：
 *   <EmptyState
 *     icon={<DocumentTextIcon />}
 *     title="还没有项目"
 *     description="上传一份招标文件，开始第一份标书"
 *     action={<Button variant="primary">新建项目</Button>}
 *   />
 *
 * - icon 里的 svg 会被统一成 20px，放在一个浅底圆里
 * - 自身水平居中；留白用 className 调整（默认 px-6 py-10，如 className="py-16"）
 */
import type { ReactNode } from 'react';
import { mergeClass } from './cx';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={mergeClass('flex flex-col items-center justify-center px-6 py-10 text-center', className)}>
      {icon != null ? (
        <div
          className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-canvas text-ink-400 [&>svg]:h-5 [&>svg]:w-5"
          aria-hidden="true"
        >
          {icon}
        </div>
      ) : null}
      <div className="text-sm font-medium text-ink-900">{title}</div>
      {description != null ? (
        <div className="mt-1 max-w-sm text-[13px] leading-5 text-ink-500">{description}</div>
      ) : null}
      {action != null ? <div className="mt-4 flex items-center gap-2">{action}</div> : null}
    </div>
  );
}
