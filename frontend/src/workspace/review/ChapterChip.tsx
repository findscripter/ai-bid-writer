/**
 * 章节标签：显示「编号 标题」，点击跳到正文页的这一章。
 */
import React from 'react';
import type { LeafInfo } from '../../api/types';
import { cx } from '../../ui';
import { goChapter } from '../ProjectWorkspace';

interface ChapterChipProps {
  projectId: string;
  uid: string;
  /** 目录里已经没有这一章时为 undefined */
  leaf: LeafInfo | undefined;
  className?: string;
}

export function ChapterChip({ projectId, uid, leaf, className }: ChapterChipProps) {
  if (!leaf) {
    return (
      <span
        className={cx('inline-flex items-center rounded-md border border-dashed border-line px-1.5 py-0.5 text-xs text-ink-400', className)}
        title="目录调整后这一章已经不存在了，重新检查一次即可更新"
      >
        已不在目录里的章节
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => goChapter(projectId, uid)}
      title={`打开「${leaf.id} ${leaf.title}」`}
      className={cx(
        'inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-white px-1.5 py-0.5 text-left text-xs leading-5 text-ink-700 transition-colors',
        'hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700',
        className
      )}
    >
      <span className="shrink-0 tabular-nums text-ink-400">{leaf.id}</span>
      <span className="min-w-0 truncate">{leaf.title}</span>
    </button>
  );
}
