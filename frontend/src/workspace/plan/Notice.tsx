/**
 * 页内提示条：需要使用者知道或处理的情况（目录改过、有评分项没人负责、上次生成失败……）。
 *
 *   <Notice tone="warning" title="目录在制定计划之后改过" actions={<Button size="sm">补全计划</Button>}>
 *     有 3 个章节还没有写作计划。
 *   </Notice>
 *
 * - tone：info 中性白底（只是告知）/ warning 琥珀（需要处理）/ danger 红（失败）
 * - actions：正文下面的一排操作按钮
 * - onClose：传了就在右上角显示关闭按钮
 */
import React from 'react';
import { ExclamationCircleIcon, ExclamationTriangleIcon, InformationCircleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { IconButton, cx } from '../../ui';

export type NoticeTone = 'info' | 'warning' | 'danger';

interface NoticeProps {
  tone?: NoticeTone;
  title?: React.ReactNode;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  onClose?: () => void;
  className?: string;
}

const BOX: Record<NoticeTone, string> = {
  info: 'border-line bg-white',
  warning: 'border-amber-200 bg-amber-50',
  danger: 'border-rose-200 bg-rose-50',
};

const ICON: Record<NoticeTone, string> = {
  info: 'text-amber-500',
  warning: 'text-amber-600',
  danger: 'text-rose-600',
};

export function Notice({ tone = 'info', title, children, actions, onClose, className }: NoticeProps) {
  const Icon = tone === 'danger' ? ExclamationCircleIcon : tone === 'warning' ? ExclamationTriangleIcon : InformationCircleIcon;
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cx('flex gap-3 rounded-lg border px-4 py-3', BOX[tone], className)}>
      <Icon className={cx('mt-0.5 h-5 w-5 shrink-0', ICON[tone])} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {title != null && <p className="text-sm font-medium leading-6 text-ink-900">{title}</p>}
        {children != null && (
          <div className={cx('break-words text-[13px] leading-6 text-ink-700', title != null && 'mt-0.5')}>{children}</div>
        )}
        {actions != null && <div className="mt-2.5 flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {onClose && <IconButton label="关闭这条提示" size="sm" icon={<XMarkIcon />} className="-mr-1.5 -mt-0.5" onClick={onClose} />}
    </div>
  );
}
