/**
 * 卡片：白色的面 + 细边框
 *
 * 用法：
 *   <Card title="评分标准" description="来自招标文件第三章" actions={<Button size="sm">重新解析</Button>}>
 *     ...内容
 *   </Card>
 *   <Card padded={false}> <table .../> </Card>     // 表格、列表等需要贴边的内容
 *
 * - title / description / actions 任一存在时渲染头部（有内容时头部带下边框）
 * - padded：内容区是否留内边距，默认 true
 * - className 作用在最外层；其余原生 div 属性透传
 */
import type { HTMLAttributes, ReactNode } from 'react';
import { cx, mergeClass } from './cx';

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode;
  description?: ReactNode;
  /** 头部右侧的操作区 */
  actions?: ReactNode;
  padded?: boolean;
  className?: string;
  children?: ReactNode;
}

export function Card({ title, description, actions, padded = true, className, children, ...rest }: CardProps) {
  const hasHeader = title != null || description != null || actions != null;
  const hasBody = children != null && children !== false;
  return (
    <div className={mergeClass('rounded-lg border border-line bg-white shadow-card', className)} {...rest}>
      {hasHeader ? (
        <div className={cx('flex items-start justify-between gap-3 px-4 py-3', hasBody && 'border-b border-line')}>
          <div className="min-w-0 flex-1">
            {title != null ? <h3 className="text-sm font-semibold leading-6 text-ink-900">{title}</h3> : null}
            {description != null ? <p className="mt-0.5 text-xs leading-5 text-ink-500">{description}</p> : null}
          </div>
          {actions != null ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {hasBody ? <div className={padded ? 'p-4' : undefined}>{children}</div> : null}
    </div>
  );
}
