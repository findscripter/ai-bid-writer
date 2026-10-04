/**
 * 审校页的「待补充信息」页签：按章节列出正文里的【待补充】占位和它的上下文。
 */
import React, { useMemo } from 'react';
import { CheckCircleIcon, ExclamationTriangleIcon, PencilSquareIcon } from '@heroicons/react/24/outline';
import type { LeafInfo, PlaceholderItem, ReviewReport } from '../../api/types';
import { Button, EmptyState } from '../../ui';
import { goChapter } from '../ProjectWorkspace';
import { useWorkspace } from '../WorkspaceContext';

interface Entry {
  text: string;
  context: string;
  /** 同一章里一模一样的占位出现了几次 */
  times: number;
}

interface Group {
  uid: string;
  leaf: LeafInfo | undefined;
  entries: Entry[];
  total: number;
}

function groupByChapter(items: PlaceholderItem[], leaves: LeafInfo[]): Group[] {
  const byUid: Record<string, Group> = {};
  const order: string[] = [];
  items.forEach((item) => {
    let group = byUid[item.chapter_uid];
    if (!group) {
      group = { uid: item.chapter_uid, leaf: undefined, entries: [], total: 0 };
      byUid[item.chapter_uid] = group;
      order.push(item.chapter_uid);
    }
    group.total += 1;
    const same = group.entries.find((entry) => entry.text === item.text && entry.context === item.context);
    if (same) same.times += 1;
    else group.entries.push({ text: item.text, context: item.context, times: 1 });
  });

  // 按目录顺序排；目录里已经没有的章节放到最后
  const result: Group[] = [];
  leaves.forEach((leaf) => {
    const group = byUid[leaf.uid];
    if (group) {
      group.leaf = leaf;
      result.push(group);
    }
  });
  order.forEach((uid) => {
    if (!byUid[uid].leaf) result.push(byUid[uid]);
  });
  return result;
}

/** 上下文里把占位本身标出来 */
function Context({ entry }: { entry: Entry }) {
  const at = entry.context.indexOf(entry.text);
  if (at < 0) {
    return (
      <>
        <mark className="rounded bg-amber-100 px-1 py-0.5 text-amber-900">{entry.text}</mark>
        {entry.context && <span className="ml-2 text-ink-500">{entry.context}</span>}
      </>
    );
  }
  const before = entry.context.slice(0, at);
  const after = entry.context.slice(at + entry.text.length);
  return (
    <>
      {before && <span className="text-ink-500">…{before}</span>}
      <mark className="rounded bg-amber-100 px-1 py-0.5 text-amber-900">{entry.text}</mark>
      {after && <span className="text-ink-500">{after}…</span>}
    </>
  );
}

interface PlaceholdersPanelProps {
  review: ReviewReport;
}

export function PlaceholdersPanel({ review }: PlaceholdersPanelProps) {
  const ws = useWorkspace();
  const { projectId } = ws;
  const leaves = ws.data.leaves;
  const groups = useMemo(() => groupByChapter(review.placeholders, leaves), [review.placeholders, leaves]);

  if (review.placeholders.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-white">
        <EmptyState
          icon={<CheckCircleIcon className="text-emerald-600" />}
          title="正文里没有待补充的占位"
          description="上次检查时，没有发现【待补充】、XX、某某公司这类还没填的内容。业绩、资质、人员等企业信息仍然要你自己核对一遍是否属实。"
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-[13px] leading-6 text-amber-900">
        <ExclamationTriangleIcon className="mt-[3px] h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        <p>
          这些是模型拿不到的企业信息（业绩、资质、人员、联系方式等），所以先留了占位。
          <strong className="font-semibold">导出前必须逐个换成真实内容</strong>
          ，否则占位会原样出现在 Word 里。
        </p>
      </div>

      <ul className="space-y-2.5">
        {groups.map((group) => (
          <li key={group.uid} className="rounded-lg border border-line bg-white">
            <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
              {group.leaf ? (
                <button
                  type="button"
                  className="min-w-0 truncate text-left text-sm font-medium text-ink-900 hover:text-primary-700"
                  title="打开这一章"
                  onClick={() => goChapter(projectId, group.uid)}
                >
                  <span className="mr-1.5 tabular-nums text-ink-400">{group.leaf.id}</span>
                  {group.leaf.title}
                </button>
              ) : (
                <span className="min-w-0 truncate text-sm text-ink-500">已不在目录里的章节</span>
              )}
              <span className="shrink-0 text-xs tabular-nums text-ink-500">{group.total} 处</span>
              {group.leaf && (
                <Button
                  size="sm"
                  className="ml-auto shrink-0"
                  icon={<PencilSquareIcon />}
                  title="打开这一章，点“编辑”把占位换成真实内容"
                  onClick={() => goChapter(projectId, group.uid)}
                >
                  去填写
                </Button>
              )}
            </div>
            <ol className="divide-y divide-line">
              {group.entries.map((entry, index) => (
                <li key={index} className="flex items-start gap-3 px-4 py-2.5 text-[13px] leading-6">
                  <span className="mt-px w-5 shrink-0 text-right text-xs tabular-nums leading-6 text-ink-400">{index + 1}</span>
                  <p className="min-w-0 flex-1 break-words">
                    <Context entry={entry} />
                  </p>
                  {entry.times > 1 && <span className="shrink-0 text-xs text-ink-400">出现 {entry.times} 次</span>}
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ul>
    </div>
  );
}
