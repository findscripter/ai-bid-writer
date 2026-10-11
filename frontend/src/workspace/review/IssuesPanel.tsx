/**
 * 审校页的「问题」页签：按严重度分组，可以按类型筛选；已忽略的收在最下面。
 */
import React, { memo, useCallback, useMemo, useRef, useState } from 'react';
import {
  ArrowUturnLeftIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EyeSlashIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline';
import { api, errorMessage } from '../../api/client';
import type { IssueSeverity, LeafInfo, ReviewIssue, ReviewReport, ReviewResponse } from '../../api/types';
import { navigate } from '../../lib/router';
import { Badge, Button, EmptyState, Spinner, cx, useToast } from '../../ui';
import { goChapter, goStage } from '../ProjectWorkspace';
import { useWorkspace } from '../WorkspaceContext';
import { ChapterChip } from './ChapterChip';
import { ISSUE_TYPE_ORDER, SEVERITY_META, SEVERITY_ORDER, issueKind, issueTypeLabel, plainText, severityOf } from './shared';

/** 每组一次最多列出多少条，其余点「再显示」 */
const PAGE_SIZE = 20;
/** 一条问题最多先列出多少个章节 */
const MAX_CHIPS = 6;

interface IssueCardProps {
  issue: ReviewIssue;
  projectId: string;
  leafByUid: Record<string, LeafInfo>;
  /** uid → 在当前目录里的位置（判断哪一章“靠后”） */
  orderByUid: Record<string, number>;
  /** uid → 这一章有没有正文（有正文才能修订） */
  hasText: Record<string, boolean>;
  /** 有没有写作计划（没有章节负责的评分项，要到写作计划里去分配） */
  hasPlan: boolean;
  /** 正在保存「忽略」 */
  busy: boolean;
  /** 深度检查进行中：结果马上会被整体替换，这时不能忽略 */
  locked: boolean;
  /** 有后台任务在跑：不能再启动修订 */
  running: boolean;
  /** 模型正在按这个问题修订的章节 */
  revisingUid: string | null;
  onRevise: (issue: ReviewIssue) => void;
  onDismiss: (issue: ReviewIssue, dismissed: boolean) => void;
}

const IssueCard = memo(function IssueCard({
  issue,
  projectId,
  leafByUid,
  orderByUid,
  hasText,
  hasPlan,
  busy,
  locked,
  running,
  revisingUid,
  onRevise,
  onDismiss,
}: IssueCardProps) {
  const [showAllChapters, setShowAllChapters] = useState(false);
  const meta = SEVERITY_META[severityOf(issue)];
  const known = issue.chapter_uids.filter((uid) => leafByUid[uid]);
  // 涉及多章时，要改的通常是（按当前目录顺序）靠后的那一章
  const target = known.reduce<string | null>(
    (best, uid) => (best === null || orderByUid[uid] > orderByUid[best] ? uid : best),
    null
  );
  const kind = issueKind(issue);
  // 结尾可能不完整的章节已经写完了：去“查看章节”，不说“去撰写”
  const unwritten = kind === 'empty' || kind === 'failed' || kind === 'partial';
  const fixable = issue.fixable && Boolean(issue.fix_instruction);
  const revisable = known.some((uid) => hasText[uid]);
  const chips = showAllChapters ? issue.chapter_uids : issue.chapter_uids.slice(0, MAX_CHIPS);
  const hidden = issue.chapter_uids.length - chips.length;
  const revisingLeaf = revisingUid ? leafByUid[revisingUid] : undefined;

  let reviseTitle: string | undefined;
  if (running) reviseTitle = '有任务正在进行，等它结束后再修订';
  else if (!revisable) reviseTitle = '涉及的章节还没有正文，先去撰写';

  return (
    <li className="relative overflow-hidden rounded-lg border border-line bg-white">
      <span className={cx('absolute inset-y-0 left-0 w-[3px]', meta.bar)} aria-hidden="true" />
      <div className="py-3 pl-5 pr-4">
        <div className="flex items-start gap-2">
          <Badge size="sm" tone="neutral" className="mt-[3px]">
            {issueTypeLabel(kind)}
          </Badge>
          <h4 className="min-w-0 flex-1 text-sm font-medium leading-6 text-ink-900">{plainText(issue.title)}</h4>
        </div>

        {issue.chapter_uids.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-ink-400">涉及章节</span>
            {chips.map((uid) => (
              <ChapterChip key={uid} projectId={projectId} uid={uid} leaf={leafByUid[uid]} />
            ))}
            {hidden > 0 && (
              <button type="button" className="text-xs text-primary-600 hover:underline" onClick={() => setShowAllChapters(true)}>
                共 {issue.chapter_uids.length} 章，展开
              </button>
            )}
          </div>
        )}

        {issue.detail && <p className="mt-2 text-[13px] leading-6 text-ink-600">{plainText(issue.detail)}</p>}

        {issue.excerpt && (
          <blockquote className="mt-2 whitespace-pre-line break-words rounded-r-md border-l-2 border-line-strong bg-subtle px-3 py-2 text-[13px] leading-6 text-ink-600">
            {issue.excerpt}
          </blockquote>
        )}

        {revisingLeaf ? (
          <p className="mt-2 flex min-w-0 items-center gap-2 rounded-md bg-primary-50 px-3 py-1.5 text-xs leading-5 text-primary-800" role="status">
            <Spinner size="sm" label="修订中" />
            <span className="min-w-0 truncate">
              模型正在修订「{revisingLeaf.id} {revisingLeaf.title}」，完成后会自动重新检查。
            </span>
          </p>
        ) : null}

        {/* 建议和操作排在一行；建议长了就各占一行 */}
        <div className="mt-2 flex flex-wrap items-end justify-end gap-x-4 gap-y-2">
          {issue.suggestion ? (
            <p className="min-w-[16rem] flex-1 text-[13px] leading-6 text-ink-700">
              <span className="text-ink-400">建议：</span>
              {plainText(issue.suggestion)}
            </p>
          ) : null}
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {target ? (
              <Button size="sm" onClick={() => goChapter(projectId, revisingUid || target)}>
                {revisingLeaf ? '看修订过程' : unwritten ? '去撰写' : '查看章节'}
              </Button>
            ) : issue.type === 'coverage' ? (
              <Button
                size="sm"
                onClick={() => (hasPlan ? navigate(`/projects/${projectId}/plan?tab=chapters`) : goStage(projectId, 'plan'))}
              >
                {hasPlan ? '去写作计划分配' : '去制定写作计划'}
              </Button>
            ) : null}
            {fixable && !revisingLeaf && (
              <Button
                size="sm"
                icon={<SparklesIcon />}
                disabled={running || !revisable}
                title={reviseTitle}
                onClick={() => onRevise(issue)}
              >
                让模型修订
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon={<EyeSlashIcon />}
              loading={busy}
              disabled={locked}
              title={locked ? '深度检查正在进行，结束后再操作' : '不再提醒这个问题；之后可以在列表最下面恢复'}
              onClick={() => onDismiss(issue, true)}
            >
              忽略
            </Button>
          </div>
        </div>
      </div>
    </li>
  );
});

interface DismissedRowProps {
  issue: ReviewIssue;
  projectId: string;
  leafByUid: Record<string, LeafInfo>;
  busy: boolean;
  locked: boolean;
  onDismiss: (issue: ReviewIssue, dismissed: boolean) => void;
}

const DismissedRow = memo(function DismissedRow({ issue, projectId, leafByUid, busy, locked, onDismiss }: DismissedRowProps) {
  const meta = SEVERITY_META[severityOf(issue)];
  return (
    <li className="flex items-start gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="inline-flex items-center gap-1.5 text-xs text-ink-500">
            <span className={cx('h-1.5 w-1.5 rounded-full', meta.dot)} aria-hidden="true" />
            {meta.label} · {issueTypeLabel(issueKind(issue))}
          </span>
          <span className="min-w-0 text-[13px] text-ink-700">{plainText(issue.title)}</span>
        </div>
        {issue.chapter_uids.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {issue.chapter_uids.slice(0, MAX_CHIPS).map((uid) => (
              <ChapterChip key={uid} projectId={projectId} uid={uid} leaf={leafByUid[uid]} />
            ))}
            {issue.chapter_uids.length > MAX_CHIPS && (
              <span className="text-xs text-ink-400">等 {issue.chapter_uids.length} 章</span>
            )}
          </div>
        )}
        {issue.detail && <p className="mt-1 text-xs leading-5 text-ink-500">{plainText(issue.detail)}</p>}
      </div>
      <Button
        size="sm"
        variant="ghost"
        icon={<ArrowUturnLeftIcon />}
        loading={busy}
        disabled={locked}
        title={locked ? '深度检查正在进行，结束后再操作' : '放回待处理的问题里'}
        onClick={() => onDismiss(issue, false)}
      >
        恢复
      </Button>
    </li>
  );
});

interface FilterChipProps {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}

function FilterChip({ label, count, active, onClick }: FilterChipProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        'inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs transition-colors',
        active
          ? 'border-primary-300 bg-primary-50 font-medium text-primary-700'
          : 'border-line bg-white text-ink-600 hover:border-line-strong hover:text-ink-900'
      )}
    >
      {label}
      <span className={cx('tabular-nums', active ? 'text-primary-600' : 'text-ink-400')}>{count}</span>
    </button>
  );
}

interface IssuesPanelProps {
  review: ReviewReport;
  /** 深度检查进行中：不能忽略或恢复 */
  locked: boolean;
  onRevise: (issue: ReviewIssue) => void;
}

export function IssuesPanel({ review, locked, onRevise }: IssuesPanelProps) {
  const ws = useWorkspace();
  const toast = useToast();
  const { projectId, leafByUid, running, job, setReview } = ws;
  const { chapters, leaves } = ws.data;
  const hasPlan = ws.data.blueprint !== null;

  const orderByUid = useMemo(() => {
    const map: Record<string, number> = {};
    leaves.forEach((leaf, index) => {
      map[leaf.uid] = index;
    });
    return map;
  }, [leaves]);

  const [filter, setFilter] = useState<string>('all');
  const [pending, setPending] = useState<Record<string, true>>({});
  const [shown, setShown] = useState<Record<IssueSeverity, number>>({ high: PAGE_SIZE, medium: PAGE_SIZE, low: PAGE_SIZE });
  const [showDismissed, setShowDismissed] = useState(false);
  const hinted = useRef(false);

  const { open, dismissed } = useMemo(() => {
    const dismissedIds: Record<string, true> = {};
    review.dismissed.forEach((id) => {
      dismissedIds[id] = true;
    });
    const openList: ReviewIssue[] = [];
    const dismissedList: ReviewIssue[] = [];
    review.issues.forEach((issue) => {
      (dismissedIds[issue.id] ? dismissedList : openList).push(issue);
    });
    return { open: openList, dismissed: dismissedList };
  }, [review]);

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    open.forEach((issue) => {
      const kind = issueKind(issue);
      counts[kind] = (counts[kind] || 0) + 1;
    });
    return counts;
  }, [open]);

  // 筛选的类型处理完之后回到「全部」
  const activeFilter = filter !== 'all' && typeCounts[filter] ? filter : 'all';

  const types = useMemo(() => {
    const known = ISSUE_TYPE_ORDER.filter((type) => typeCounts[type]);
    const extra = Object.keys(typeCounts).filter((type) => known.indexOf(type) < 0);
    return known.concat(extra);
  }, [typeCounts]);

  const groups = useMemo(() => {
    const buckets: Record<IssueSeverity, ReviewIssue[]> = { high: [], medium: [], low: [] };
    open.forEach((issue) => {
      if (activeFilter === 'all' || issueKind(issue) === activeFilter) buckets[severityOf(issue)].push(issue);
    });
    return buckets;
  }, [open, activeFilter]);

  const hasText = useMemo(() => {
    const map: Record<string, boolean> = {};
    Object.keys(chapters).forEach((uid) => {
      map[uid] = chapters[uid].chars > 0;
    });
    return map;
  }, [chapters]);

  const onDismiss = useCallback(
    async (issue: ReviewIssue, value: boolean) => {
      setPending((prev) => ({ ...prev, [issue.id]: true }));
      try {
        // 原样交给状态中心：返回里带着 outline_changed，目录是否对得上以它为准
        const report: ReviewResponse = await api.dismissIssue(projectId, issue.id, value);
        setReview(report);
        if (value && !hinted.current) {
          hinted.current = true;
          toast.info('已忽略。想找回来，到列表最下面的“已忽略的问题”里点“恢复”。');
        }
      } catch (error) {
        toast.error(errorMessage(error, value ? '没能忽略这个问题，请重试' : '没能恢复这个问题，请重试'));
      } finally {
        setPending((prev) => {
          const next = { ...prev };
          delete next[issue.id];
          return next;
        });
      }
    },
    [projectId, setReview, toast]
  );

  // 模型正在按哪个问题修订哪一章（刷新页面后也能对上）
  const revising =
    running && job && job.kind === 'revise'
      ? { uid: String(job.params.uid || ''), instruction: String(job.params.instruction || '') }
      : null;

  const filteredCount = groups.high.length + groups.medium.length + groups.low.length;

  return (
    <div className="space-y-4">
      {open.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="按类型筛选">
          <FilterChip label="全部" count={open.length} active={activeFilter === 'all'} onClick={() => setFilter('all')} />
          {types.map((type) => (
            <FilterChip
              key={type}
              label={issueTypeLabel(type)}
              count={typeCounts[type]}
              active={activeFilter === type}
              onClick={() => setFilter(type)}
            />
          ))}
        </div>
      )}

      {open.length === 0 ? (
        <div className="rounded-lg border border-line bg-white">
          <EmptyState
            icon={<CheckCircleIcon className="text-emerald-600" />}
            title="没有待处理的问题"
            description={
              dismissed.length > 0
                ? `另有 ${dismissed.length} 个问题被你忽略了，可以在下面查看。`
                : '上次检查没有发现问题。之后只要改过正文，记得再检查一次。'
            }
          />
        </div>
      ) : filteredCount === 0 ? (
        <p className="rounded-lg border border-line bg-white px-4 py-8 text-center text-[13px] text-ink-500">这个类型下没有待处理的问题。</p>
      ) : (
        SEVERITY_ORDER.map((severity) => {
          const list = groups[severity];
          if (list.length === 0) return null;
          const meta = SEVERITY_META[severity];
          const limit = shown[severity];
          const visible = list.slice(0, limit);
          const rest = list.length - visible.length;
          return (
            <section key={severity} aria-label={`${meta.label}问题`}>
              <div className="mb-2 flex items-baseline gap-2">
                <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-900">
                  <span className={cx('h-2 w-2 rounded-full', meta.dot)} aria-hidden="true" />
                  {meta.label}
                  <span className="font-normal tabular-nums text-ink-500">{list.length}</span>
                </h3>
                <span className="text-xs text-ink-400">{meta.hint}</span>
              </div>
              <ul className="space-y-2.5">
                {visible.map((issue) => (
                  <IssueCard
                    key={issue.id}
                    issue={issue}
                    projectId={projectId}
                    leafByUid={leafByUid}
                    orderByUid={orderByUid}
                    hasText={hasText}
                    hasPlan={hasPlan}
                    busy={Boolean(pending[issue.id])}
                    locked={locked}
                    running={running}
                    revisingUid={
                      revising && revising.instruction === issue.fix_instruction && issue.chapter_uids.indexOf(revising.uid) >= 0
                        ? revising.uid
                        : null
                    }
                    onRevise={onRevise}
                    onDismiss={onDismiss}
                  />
                ))}
              </ul>
              {rest > 0 && (
                <div className="mt-2.5 flex justify-center">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setShown((prev) => ({ ...prev, [severity]: prev[severity] + PAGE_SIZE }))}
                  >
                    再显示 {Math.min(rest, PAGE_SIZE)} 条（还有 {rest} 条）
                  </Button>
                </div>
              )}
            </section>
          );
        })
      )}

      {dismissed.length > 0 && (
        <section className="rounded-lg border border-line bg-white">
          <button
            type="button"
            aria-expanded={showDismissed}
            onClick={() => setShowDismissed((value) => !value)}
            className={cx(
              'flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] text-ink-700 hover:bg-subtle',
              showDismissed ? 'rounded-t-lg' : 'rounded-lg'
            )}
          >
            {showDismissed ? (
              <ChevronDownIcon className="h-4 w-4 shrink-0 text-ink-400" />
            ) : (
              <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-400" />
            )}
            <span className="font-medium">已忽略的问题</span>
            <span className="tabular-nums text-ink-500">{dismissed.length}</span>
            <span className="ml-1 truncate text-xs text-ink-400">不算进待处理，导出前也不再提醒</span>
          </button>
          {showDismissed && (
            <ul className="divide-y divide-line border-t border-line">
              {dismissed.map((issue) => (
                <DismissedRow
                  key={issue.id}
                  issue={issue}
                  projectId={projectId}
                  leafByUid={leafByUid}
                  busy={Boolean(pending[issue.id])}
                  locked={locked}
                  onDismiss={onDismiss}
                />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
