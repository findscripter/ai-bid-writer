/**
 * 骨架屏：内容加载前的灰色占位块
 *
 * 用法：
 *   <Skeleton className="h-4 w-40" />
 *   <Skeleton className="h-24 rounded-lg" />
 *
 * - 尺寸、圆角全由 className 决定；没写时默认 h-4 w-full
 */
import { mergeClass } from './cx';

export interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return <div aria-hidden="true" className={mergeClass('h-4 w-full animate-pulse rounded bg-ink-900/[0.07]', className)} />;
}
