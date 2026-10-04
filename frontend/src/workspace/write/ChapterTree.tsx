/**
 * 正文页左侧的章节树：按目录层级列出全部章节，叶子章节带状态点和字数。
 */
import React, { memo, useEffect, useMemo, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/20/solid';
import type { OutlineNode } from '../../api/types';
import { StatusDot, cx } from '../../ui';
import type { ChapterUiStatus } from '../WorkspaceContext';

export type TreeFilter = 'all' | 'todo' | 'issue';

interface ChapterTreeProps {
  outline: OutlineNode[];
  /** uid → 界面状态 */
  statusByUid: Record<string, ChapterUiStatus>;
  /** uid → 已写字数 */
  charsByUid: Record<string, number>;
  /** uid → 目标字数 */
  budget: Record<string, number>;
  /** 有未处理问题的章节 */
  issueUids: Record<string, number>;
  /** 重新生成没有成功、保留了原来正文的章节（仍算写完，但要标出来，“重试失败章节”会重写它们） */
  rewriteFailedUids?: Record<string, true>;
  selectedUid: string | null;
  filter: TreeFilter;
  onSelect: (uid: string) => void;
}

const NO_FLAGS: Record<string, true> = {};

function shortChars(value: number): string {
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function isLeaf(node: OutlineNode): boolean {
  return !node.children || node.children.length === 0;
}

function collectLeafUids(node: OutlineNode, into: string[]): void {
  if (isLeaf(node)) {
    into.push(node.uid);
    return;
  }
  (node.children || []).forEach((child) => collectLeafUids(child, into));
}

function ChapterTreeImpl({
  outline,
  statusByUid,
  charsByUid,
  budget,
  issueUids,
  rewriteFailedUids = NO_FLAGS,
  selectedUid,
  filter,
  onSelect,
}: ChapterTreeProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const visible = useMemo(() => {
    const keep: Record<string, boolean> = {};
    const visit = (node: OutlineNode): boolean => {
      if (isLeaf(node)) {
        const status = statusByUid[node.uid] || 'empty';
        const ok =
          filter === 'all' ||
          (filter === 'todo' && status !== 'done') ||
          (filter === 'issue' && Boolean(issueUids[node.uid]));
        keep[node.uid] = ok;
        return ok;
      }
      let any = false;
      (node.children || []).forEach((child) => {
        if (visit(child)) any = true;
      });
      keep[node.uid] = any;
      return any;
    };
    outline.forEach(visit);
    return keep;
  }, [outline, statusByUid, issueUids, filter]);

  useEffect(() => {
    if (!selectedUid) return;
    const element = document.getElementById(`leaf-${selectedUid}`);
    if (element) element.scrollIntoView({ block: 'nearest' });
  }, [selectedUid]);

  const renderNode = (node: OutlineNode, depth: number): React.ReactNode => {
    if (!visible[node.uid]) return null;
    const indent = { paddingLeft: 10 + depth * 14 };

    if (isLeaf(node)) {
      const status = statusByUid[node.uid] || 'empty';
      const chars = charsByUid[node.uid] || 0;
      const target = budget[node.uid] || 0;
      const selected = node.uid === selectedUid;
      const issues = issueUids[node.uid] || 0;
      // 排队、正在写时以那个状态为准，不再标上一次的失败
      const retryNeeded = status === 'done' && Boolean(rewriteFailedUids[node.uid]);
      return (
        <button
          key={node.uid}
          id={`leaf-${node.uid}`}
          type="button"
          onClick={() => onSelect(node.uid)}
          style={indent}
          aria-current={selected ? 'true' : undefined}
          title={`${node.id} ${node.title}${target ? `（目标约 ${target} 字）` : ''}${
            retryNeeded ? '\n重新生成没有成功，保留了原来的正文；可以点“重试失败章节”再写一次' : ''
          }`}
          className={cx(
            'flex w-full items-center gap-2 py-1.5 pr-3 text-left text-[13px] leading-5 transition-colors',
            selected ? 'bg-primary-50 text-primary-800' : 'text-ink-700 hover:bg-subtle'
          )}
        >
          <StatusDot status={status} pulse={status === 'writing'} />
          <span className="min-w-0 flex-1 truncate">
            <span className="mr-1 tabular-nums text-ink-400">{node.id}</span>
            {node.title}
          </span>
          {retryNeeded && (
            <span className="shrink-0 rounded bg-rose-50 px-1 text-[10px] font-medium leading-4 text-rose-600">重新生成失败</span>
          )}
          {issues > 0 && (
            <span className="shrink-0 rounded-full bg-amber-100 px-1.5 text-[10px] font-medium leading-4 text-amber-700" title={`${issues} 个待处理问题`}>
              {issues}
            </span>
          )}
          <span className={cx('shrink-0 text-[11px] tabular-nums', chars > 0 ? 'text-ink-500' : 'text-ink-300')}>
            {chars > 0 ? shortChars(chars) : '—'}
          </span>
        </button>
      );
    }

    const leafUids: string[] = [];
    collectLeafUids(node, leafUids);
    const done = leafUids.filter((uid) => statusByUid[uid] === 'done').length;
    const closed = Boolean(collapsed[node.uid]);
    return (
      <div key={node.uid}>
        <button
          type="button"
          style={indent}
          onClick={() => setCollapsed((prev) => ({ ...prev, [node.uid]: !prev[node.uid] }))}
          aria-expanded={!closed}
          className={cx(
            'flex w-full items-center gap-1 py-1.5 pr-3 text-left text-[13px] leading-5 hover:bg-subtle',
            depth === 0 ? 'font-semibold text-ink-900' : 'font-medium text-ink-700'
          )}
        >
          {closed ? (
            <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-400" />
          ) : (
            <ChevronDownIcon className="h-4 w-4 shrink-0 text-ink-400" />
          )}
          <span className="min-w-0 flex-1 truncate">
            <span className="mr-1 tabular-nums text-ink-400">{node.id}</span>
            {node.title}
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-ink-400">
            {done}/{leafUids.length}
          </span>
        </button>
        {!closed && (node.children || []).map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  const anyVisible = outline.some((node) => visible[node.uid]);
  return (
    <div className="py-1">
      {anyVisible ? (
        outline.map((node) => renderNode(node, 0))
      ) : (
        <p className="px-4 py-8 text-center text-xs text-ink-400">
          {filter === 'todo' ? '所有章节都写完了' : '没有待处理的问题'}
        </p>
      )}
    </div>
  );
}

export const ChapterTree = memo(ChapterTreeImpl);
