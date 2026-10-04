/**
 * 悬浮提示（纯 CSS，悬停或键盘聚焦到子元素时出现）
 *
 * 用法：
 *   <Tooltip content="重新生成本章"><IconButton label="重新生成" icon={<ArrowPathIcon />} /></Tooltip>
 *   <Tooltip content="目标 3,000 字" side="right"><span>62%</span></Tooltip>
 *
 * - side：top 默认 / bottom / left / right
 * - 提示默认不换行；内容较长时传 className="w-56 whitespace-normal" 之类自行限宽
 * - 纯 CSS 实现，会被带 overflow: hidden / auto 的祖先裁掉；
 *   贴着滚动容器边缘的元素请换个 side，或直接用原生 title
 */
import type { ReactNode } from 'react';
import { cx, mergeClass } from './cx';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: TooltipSide;
  /** 作用在提示气泡上 */
  className?: string;
}

const SIDE: Record<TooltipSide, string> = {
  top: 'bottom-full left-1/2 mb-1.5 -translate-x-1/2',
  bottom: 'left-1/2 top-full mt-1.5 -translate-x-1/2',
  left: 'right-full top-1/2 mr-1.5 -translate-y-1/2',
  right: 'left-full top-1/2 ml-1.5 -translate-y-1/2',
};

export function Tooltip({ content, children, side = 'top', className }: TooltipProps) {
  if (content == null || content === false || content === '') {
    return <>{children}</>;
  }
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={mergeClass(
          cx(
            'pointer-events-none absolute z-40 whitespace-nowrap rounded-md bg-ink-900 px-2 py-1 text-xs font-normal leading-5 text-white opacity-0 shadow-pop transition-opacity duration-100',
            'group-hover/tip:opacity-100 group-hover/tip:delay-300 group-focus-within/tip:opacity-100',
            SIDE[side]
          ),
          className
        )}
      >
        {content}
      </span>
    </span>
  );
}
