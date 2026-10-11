/**
 * 审校页的「评分点覆盖」页签：每条评审项 / 采购人要求有没有章节负责、正文里响应到了没有。
 */
import React, { useMemo, useState } from 'react';
import { ClipboardDocumentCheckIcon } from '@heroicons/react/24/outline';
import type { CoverageItem, LeafInfo, RequirementItem, ReviewReport } from '../../api/types';
import { navigate } from '../../lib/router';
import { Badge, Button, EmptyState, Tabs, cx } from '../../ui';
import { goStage } from '../ProjectWorkspace';
import { useWorkspace } from '../WorkspaceContext';
import { ChapterChip } from './ChapterChip';
import { COVERAGE_META, plainText } from './shared';

const MAX_CHIPS = 4;

const STATUS_ORDER: Array<CoverageItem['status']> = ['covered', 'partial', 'missing', 'unassigned'];

const STATUS_DOT: Record<CoverageItem['status'], string> = {
  covered: 'bg-emerald-500',
  partial: 'bg-amber-500',
  missing: 'bg-rose-500',
  unassigned: 'bg-rose-500',
};

function statusOf(item: CoverageItem): CoverageItem['status'] {
  return COVERAGE_META[item.status] ? item.status : 'unassigned';
}

interface RowProps {
  item: CoverageItem;
  requirement: RequirementItem | undefined;
  projectId: string;
  leafByUid: Record<string, LeafInfo>;
  /** 有没有写作计划（没有的话，谈不上“分配给章节”） */
  hasPlan: boolean;
}

function CoverageRow({ item, requirement, projectId, leafByUid, hasPlan }: RowProps) {
  const [showAll, setShowAll] = useState(false);
  const status = statusOf(item);
  const meta = COVERAGE_META[status];
  const chips = showAll ? item.chapter_uids : item.chapter_uids.slice(0, MAX_CHIPS);
  const hidden = item.chapter_uids.length - chips.length;
  const score = requirement && requirement.score ? requirement.score : '';
  const detail = requirement && requirement.detail ? requirement.detail : '';

  return (
    <tr className="align-top">
      <td className="whitespace-nowrap py-3 pl-4 pr-3">
        <span className="font-medium tabular-nums text-ink-900">{item.requirement_id}</span>
        <span className="mt-0.5 block text-2xs text-ink-400">{item.kind === 'requirement' ? '采购人要求' : '评审项'}</span>
      </td>
      <td className="px-3 py-3">
        <p className="text-ink-900">
          {item.name || '（没有名称）'}
          {score && <span className="ml-1.5 whitespace-nowrap text-xs text-ink-500">{score}</span>}
        </p>
        {detail && (
          <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-ink-500" title={detail}>
            {detail}
          </p>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-3">
        <Badge tone={meta.tone} dot>
          {meta.label}
        </Badge>
      </td>
      <td className="px-3 py-3">
        {item.chapter_uids.length === 0 && !hasPlan ? (
          <span className="text-ink-300">—</span>
        ) : item.chapter_uids.length === 0 ? (
          <button
            type="button"
            className="text-xs text-primary-600 hover:underline"
            onClick={() => navigate(`/projects/${projectId}/plan?tab=chapters`)}
            title="到写作计划的“章节计划”里把这一条分配给合适的章节"
          >
            没有章节负责，去分配
          </button>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {chips.map((uid) => (
              <ChapterChip key={uid} projectId={projectId} uid={uid} leaf={leafByUid[uid]} className="max-w-[15rem]" />
            ))}
            {hidden > 0 && (
              <button type="button" className="text-xs text-primary-600 hover:underline" onClick={() => setShowAll(true)}>
                共 {item.chapter_uids.length} 章，展开
              </button>
            )}
          </div>
        )}
      </td>
      <td className="py-3 pl-3 pr-4">
        {item.missing_keywords.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {item.missing_keywords.map((word) => (
              <span key={word} className="rounded bg-amber-50 px-1.5 py-0.5 text-xs leading-5 text-amber-800">
                {word}
              </span>
            ))}
          </div>
        ) : !item.note ? (
          <span className="text-ink-300">—</span>
        ) : null}
        {item.note && (
          <p className={cx('text-xs text-ink-400', item.missing_keywords.length > 0 ? 'mt-1 leading-5' : 'leading-6')}>{plainText(item.note)}</p>
        )}
      </td>
    </tr>
  );
}

interface CoveragePanelProps {
  review: ReviewReport;
}

export function CoveragePanel({ review }: CoveragePanelProps) {
  const ws = useWorkspace();
  const { projectId, leafByUid } = ws;
  const { requirements, blueprint } = ws.data;
  const coverage = review.coverage;
  const [only, setOnly] = useState<'all' | 'problem'>('all');

  const requirementById = useMemo(() => {
    const map: Record<string, RequirementItem> = {};
    requirements.forEach((item) => {
      map[item.id.trim().toUpperCase()] = item;
    });
    return map;
  }, [requirements]);

  const counts = useMemo(() => {
    const result: Record<CoverageItem['status'], number> = { covered: 0, partial: 0, missing: 0, unassigned: 0 };
    coverage.forEach((item) => {
      result[statusOf(item)] += 1;
    });
    return result;
  }, [coverage]);

  if (coverage.length === 0) {
    const noItems = requirements.length === 0;
    return (
      <div className="rounded-lg border border-line bg-white">
        <EmptyState
          icon={<ClipboardDocumentCheckIcon />}
          title="没有可以逐条核对的条目"
          description={
            noItems
              ? '“技术评分要求”里没有解析出带编号的评审项或采购人要求，所以没法逐条核对有没有响应。到“招标解读”里重新解析，或者把评分要求整理成带编号的条目，然后回来重新检查。'
              : '上次检查的时候还没有评分条目。回到页面上方点“重新检查”，就能看到每一条的响应情况。'
          }
          action={
            noItems ? (
              <Button onClick={() => goStage(projectId, 'tender')}>去招标解读</Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  const problems = coverage.length - counts.covered;
  const rows = only === 'problem' ? coverage.filter((item) => statusOf(item) !== 'covered') : coverage;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-[13px] text-ink-700">
          共 <span className="font-medium tabular-nums text-ink-900">{coverage.length}</span> 条评审项和采购人要求，
          {problems === 0 ? (
            <span className="text-emerald-700">全部已响应。</span>
          ) : (
            <>
              <span className="font-medium tabular-nums text-ink-900">{counts.covered}</span> 条已响应，
              <span className="font-medium tabular-nums text-rose-600">{problems}</span> 条有问题。
            </>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500">
          {STATUS_ORDER.map((status) =>
            counts[status] > 0 ? (
              <span key={status} className="inline-flex items-center gap-1.5">
                <span className={cx('h-1.5 w-1.5 rounded-full', STATUS_DOT[status])} aria-hidden="true" />
                {COVERAGE_META[status].label} {counts[status]}
              </span>
            ) : null
          )}
        </div>
        {problems > 0 && (
          <Tabs
            className="ml-auto"
            size="sm"
            variant="pill"
            value={only}
            onChange={(key) => setOnly(key as 'all' | 'problem')}
            tabs={[
              { key: 'all', label: '全部' },
              { key: 'problem', label: '只看有问题的' },
            ]}
            aria-label="筛选"
          />
        )}
      </div>

      {!blueprint && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
          <span className="min-w-0 flex-1">还没有写作计划，所以不知道每一条由哪一章负责响应。制定写作计划后重新检查，这里才能核对。</span>
          <Button size="sm" onClick={() => goStage(projectId, 'plan')}>
            去写作计划
          </Button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-line bg-white">
        <table className="w-full min-w-[720px] border-collapse text-left text-[13px] leading-6">
          <thead>
            <tr className="border-b border-line bg-subtle text-xs text-ink-500">
              <th scope="col" className="w-[4.5rem] py-2 pl-4 pr-3 font-medium">
                编号
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                评审项 / 采购人要求
              </th>
              <th scope="col" className="w-[6.5rem] px-3 py-2 font-medium">
                状态
              </th>
              <th scope="col" className="w-[30%] px-3 py-2 font-medium">
                负责章节
              </th>
              <th scope="col" className="w-[20%] py-2 pl-3 pr-4 font-medium">
                缺失的关键词
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((item, index) => (
              <CoverageRow
                key={`${item.requirement_id}-${index}`}
                item={item}
                requirement={requirementById[item.requirement_id.trim().toUpperCase()]}
                projectId={projectId}
                leafByUid={leafByUid}
                hasPlan={blueprint !== null}
              />
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs leading-5 text-ink-400">
        判断依据：这一条在写作计划里分给了哪些章节、这些章节写完了没有、招标文件要求的关键词在正文里出现了没有。关键词都出现不等于写得好，重要的评分项仍要人工对照评分标准再看一遍。
      </p>
    </div>
  );
}
