/**
 * 章节计划：按一级章节分组列出全部叶子章节，一次展开一章编辑。
 * 章节可能上百个：每行是独立的 memo 组件，编辑区只挂载展开的那一个。
 * 没保存的修改只留在这一页上：离开页面前由写作计划页统一确认，确认离开就是放弃。
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatBubbleLeftEllipsisIcon, ChevronRightIcon } from '@heroicons/react/20/solid';
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { api, errorMessage } from '../../api/client';
import type { ChapterPlan, LeafInfo, RequirementItem } from '../../api/types';
import { formatChars } from '../../lib/format';
import { Badge, Button, EmptyState, Input, Tabs, cx, useConfirm, useToast } from '../../ui';
import type { TabItem } from '../../ui';
import { useWorkspace } from '../WorkspaceContext';
import { ChapterPlanEditor } from './ChapterPlanEditor';
import type { RequirementOwners } from './ChapterPlanEditor';
import { clampWeight, groupLeaves, parentId, requirementTitle } from './shared';

type RowFilter = 'all' | 'missing' | 'auto';

const COLS = 'grid grid-cols-[1rem_minmax(0,1fr)_12.5rem_4.5rem_3rem_5.5rem] items-center gap-x-3';
const MAX_TAGS = 5;
const NO_PLANS: Record<string, ChapterPlan> = {};

interface PlanRowProps {
  leaf: LeafInfo;
  plan: ChapterPlan | undefined;
  target: number | undefined;
  expanded: boolean;
  /** 一级章节本身就是叶子：没有分组标题，这一行自己要醒目一点 */
  solo: boolean;
  requirementById: Record<string, RequirementItem>;
  onToggle: (uid: string) => void;
  /** 展开时的编辑区 */
  editor: React.ReactNode;
}

const PlanRow = memo(function PlanRow({ leaf, plan, target, expanded, solo, requirementById, onToggle, editor }: PlanRowProps) {
  const ids = plan ? plan.requirement_ids : [];
  const weight = plan ? clampWeight(plan.weight) : 1;
  return (
    <div id={`plan-row-${leaf.uid}`} className={cx('border-t border-line', expanded && 'bg-primary-50/40')}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => onToggle(leaf.uid)}
        className={cx(COLS, 'w-full px-4 py-2 text-left transition-colors', !expanded && 'hover:bg-subtle')}
      >
        <ChevronRightIcon className={cx('h-4 w-4 text-ink-400 transition-transform', expanded && 'rotate-90')} aria-hidden="true" />
        <span className={cx('flex min-w-0 items-center gap-1.5', leaf.level > 2 && 'pl-4')}>
          <span className={cx('min-w-0 truncate text-sm text-ink-900', (solo || expanded) && 'font-medium')} title={`${leaf.id} ${leaf.title}`}>
            <span className="mr-1.5 font-normal tabular-nums text-ink-400">{leaf.id}</span>
            {leaf.title}
          </span>
          {leaf.is_response_chapter && <span className="shrink-0 text-xs text-ink-400">响应表</span>}
          {plan && plan.note && (
            <span className="inline-flex shrink-0 text-ink-400" title={`你对本章的补充要求：${plan.note}`}>
              <ChatBubbleLeftEllipsisIcon className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only">有补充要求</span>
            </span>
          )}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          {!plan ? (
            <Badge tone="warning" size="sm">
              尚无计划
            </Badge>
          ) : ids.length === 0 ? (
            <span className="text-xs text-ink-300">—</span>
          ) : (
            <>
              {ids.slice(0, MAX_TAGS).map((rid) => {
                const item = requirementById[rid];
                const auto = plan.auto_assigned.indexOf(rid) >= 0;
                return (
                  <Badge
                    key={rid}
                    size="sm"
                    tone={!item ? 'neutral' : auto ? 'warning' : 'primary'}
                    title={
                      item
                        ? `${requirementTitle(item)}${auto ? '\n系统按内容相近自动分配到本章，请核对是否合适' : ''}`
                        : `${rid}：招标解读里已经没有这一条`
                    }
                  >
                    {rid}
                  </Badge>
                );
              })}
              {ids.length > MAX_TAGS && (
                <span className="text-2xs tabular-nums text-ink-500" title={ids.slice(MAX_TAGS).join('、')}>
                  +{ids.length - MAX_TAGS}
                </span>
              )}
            </>
          )}
        </span>
        <span className="text-xs tabular-nums text-ink-500">{plan ? `${plan.key_points.length} 个要点` : '—'}</span>
        <span
          className={cx(
            'text-xs tabular-nums',
            !plan ? 'text-ink-300' : weight > 1 ? 'font-medium text-ink-900' : weight < 1 ? 'text-ink-400' : 'text-ink-600'
          )}
          title="篇幅权重：1 为平均，越大分到的字数越多"
        >
          ×{weight.toFixed(1)}
        </span>
        <span className="text-right text-[13px] tabular-nums text-ink-700">{target ? formatChars(target) : '—'}</span>
      </button>
      {editor}
    </div>
  );
});

interface ChapterPlanListProps {
  /** 进入页面时要直接展开的章节（从正文页跳过来） */
  focusUid: string | null;
  /** 不能编辑的原因（有任务在跑）；可以编辑时为 null */
  lockedReason: string | null;
  /** 展开的那一章有没有未保存的修改 */
  onDirtyChange: (dirty: boolean) => void;
  /**
   * seq 每变一次：使用者确认过“会丢掉没保存的修改”的生成已经开始，展开的那一章放弃草稿。
   * onlyMissing（补全计划）时只放弃还没有计划的那一章：已有计划的章节补全不会改动
   */
  discardSignal?: { seq: number; onlyMissing: boolean };
}

export function ChapterPlanList({ focusUid, lockedReason, onDirtyChange, discardSignal }: ChapterPlanListProps) {
  const ws = useWorkspace();
  const toast = useToast();
  const confirm = useConfirm();
  const { projectId, apply } = ws;
  const { leaves, budget, requirements, chapters, blueprint } = ws.data;
  const plans = blueprint ? blueprint.plans : NO_PLANS;
  const settings = ws.data.project.settings;

  const [query, setQuery] = useState('');
  const [filterKey, setFilterKey] = useState<RowFilter>('all');
  const [expandedUid, setExpandedUid] = useState<string | null>(focusUid);

  const expandedRef = useRef(expandedUid);
  expandedRef.current = expandedUid;
  const editorDirtyRef = useRef(false);
  const chaptersRef = useRef(chapters);
  chaptersRef.current = chapters;
  const plansRef = useRef(plans);
  plansRef.current = plans;

  // 外层通知放弃草稿：只对受影响的那一章生效
  const [editorDiscard, setEditorDiscard] = useState(0);
  const signalSeq = discardSignal ? discardSignal.seq : 0;
  const signalOnlyMissing = Boolean(discardSignal && discardSignal.onlyMissing);
  const lastSignal = useRef(signalSeq);
  useEffect(() => {
    if (signalSeq === lastSignal.current) return;
    lastSignal.current = signalSeq;
    const uid = expandedRef.current;
    if (!uid || (signalOnlyMissing && plansRef.current[uid])) return;
    setEditorDiscard((value) => value + 1);
  }, [signalSeq, signalOnlyMissing]);

  const groups = useMemo(() => groupLeaves(leaves), [leaves]);

  const requirementById = useMemo(() => {
    const map: Record<string, RequirementItem> = {};
    requirements.forEach((item) => {
      map[item.id] = item;
    });
    return map;
  }, [requirements]);

  const owners = useMemo(() => {
    const map: RequirementOwners = {};
    leaves.forEach((leaf) => {
      const plan: ChapterPlan | undefined = plans[leaf.uid];
      if (!plan) return;
      plan.requirement_ids.forEach((rid) => {
        if (!map[rid]) map[rid] = [];
        map[rid].push({ uid: leaf.uid, id: leaf.id });
      });
    });
    return map;
  }, [leaves, plans]);

  const stats = useMemo(() => {
    let missing = 0;
    let auto = 0;
    let weightSum = 0;
    leaves.forEach((leaf) => {
      const plan: ChapterPlan | undefined = plans[leaf.uid];
      if (!plan) missing += 1;
      else if (plan.auto_assigned.length > 0) auto += 1;
      weightSum += plan ? clampWeight(plan.weight) : 1;
    });
    return { missing, auto, weightSum };
  }, [leaves, plans]);

  // 筛选项对应的章节没有了（比如补全之后不再有“尚无计划”的章节），自动回到“全部”
  const filter: RowFilter =
    (filterKey === 'missing' && stats.missing === 0) || (filterKey === 'auto' && stats.auto === 0) ? 'all' : filterKey;

  const handleDirty = useCallback(
    (dirty: boolean) => {
      editorDirtyRef.current = dirty;
      onDirtyChange(dirty);
    },
    [onDirtyChange]
  );

  const toggle = useCallback(
    async (uid: string) => {
      const current = expandedRef.current;
      if (current !== null && editorDirtyRef.current) {
        const ok = await confirm({
          title: '放弃未保存的修改？',
          description: '正在编辑的这一章，计划有修改还没有保存。',
          confirmText: '放弃修改',
          tone: 'danger',
        });
        if (!ok) return;
      }
      setExpandedUid(current === uid ? null : uid);
    },
    [confirm]
  );

  const close = useCallback(() => {
    setExpandedUid(null);
  }, []);

  const save = useCallback(
    async (plan: ChapterPlan): Promise<ChapterPlan | null> => {
      try {
        const state = await api.saveBlueprint(projectId, { plans: { [plan.uid]: plan } });
        apply(state);
        const chapter = chaptersRef.current[plan.uid];
        const written = Boolean(chapter && chapter.status === 'done' && chapter.chars > 0);
        toast.success(written ? '本章计划已保存。这一章已有正文，到正文页重写后才会按新计划来。' : '本章计划已保存，各章的目标字数已按权重重新分配。');
        const stored = state.blueprint ? state.blueprint.plans[plan.uid] : undefined;
        return stored || plan;
      } catch (error) {
        toast.error(errorMessage(error, '本章计划没有保存成功，请重试'));
        return null;
      }
    },
    [apply, projectId, toast]
  );

  // 从正文页带着章节跳过来：展开那一章并滚到它
  useEffect(() => {
    if (!focusUid) return undefined;
    // 正在编辑的那一章还有没保存的修改时，不抢
    const keep = editorDirtyRef.current ? expandedRef.current : null;
    if (!keep) setExpandedUid(focusUid);
    const target = keep || focusUid;
    const timer = window.setTimeout(() => {
      const node = document.getElementById(`plan-row-${target}`);
      if (node) node.scrollIntoView({ block: 'center' });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [focusUid]);

  // 展开的章节被删掉了（目录改过）：收起
  useEffect(() => {
    if (expandedUid && !ws.leafByUid[expandedUid]) setExpandedUid(null);
  }, [expandedUid, ws.leafByUid]);

  const keyword = query.trim().toLowerCase();
  const visible = (leaf: LeafInfo): boolean => {
    if (leaf.uid === expandedUid) return true; // 正在编辑的那一章不能因为筛选而消失
    const plan: ChapterPlan | undefined = plans[leaf.uid];
    if (filter === 'missing' && plan) return false;
    if (filter === 'auto' && !(plan && plan.auto_assigned.length > 0)) return false;
    if (!keyword) return true;
    return `${leaf.id} ${leaf.title} ${leaf.path_titles.join(' ')}`.toLowerCase().indexOf(keyword) >= 0;
  };

  const totalWords = settings.target_pages * settings.words_per_page;
  let shownCount = 0;

  const body = groups.map((group) => {
    const shown = group.leaves.filter(visible);
    if (shown.length === 0) return null;
    shownCount += shown.length;
    let groupWords = 0;
    group.leaves.forEach((leaf) => {
      groupWords += budget[leaf.uid] || 0;
    });

    const rows: React.ReactNode[] = [];
    let lastParent: string | null = null;
    shown.forEach((leaf) => {
      // 三级及以下的章节：上级标题变了就插一行小标题，层级一目了然
      if (leaf.level > 2 && leaf.parent_uid !== lastParent) {
        rows.push(
          <div key={`parent-${leaf.uid}`} className="border-t border-line px-4 py-1.5 pl-11 text-xs font-medium leading-5 text-ink-500">
            <span className="mr-1.5 font-normal tabular-nums text-ink-400">{parentId(leaf.id)}</span>
            {leaf.path_titles.slice(1).join(' › ')}
          </div>
        );
      }
      lastParent = leaf.level > 2 ? leaf.parent_uid : null;
      const expanded = leaf.uid === expandedUid;
      const chapter = chapters[leaf.uid];
      rows.push(
        <PlanRow
          key={leaf.uid}
          leaf={leaf}
          plan={plans[leaf.uid]}
          target={budget[leaf.uid]}
          expanded={expanded}
          solo={group.solo}
          requirementById={requirementById}
          onToggle={toggle}
          editor={
            expanded ? (
              <ChapterPlanEditor
                key={leaf.uid}
                leaf={leaf}
                plan={plans[leaf.uid]}
                target={budget[leaf.uid]}
                requirements={requirements}
                owners={owners}
                totalWords={totalWords}
                weightSum={stats.weightSum}
                hasContent={Boolean(chapter && chapter.status === 'done' && chapter.chars > 0)}
                lockedReason={lockedReason}
                onSave={save}
                onClose={close}
                onDirtyChange={handleDirty}
                discardSeq={editorDiscard}
              />
            ) : null
          }
        />
      );
    });

    return (
      <section key={group.id} aria-label={`${group.id} ${group.title}`}>
        {!group.solo && (
          <div className="flex items-baseline gap-3 border-t border-line bg-subtle px-4 py-2">
            <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-5 text-ink-900">
              <span className="mr-1.5 font-normal tabular-nums text-ink-400">{group.id}</span>
              {group.title}
            </h3>
            <span className="shrink-0 text-xs tabular-nums text-ink-500">
              {group.leaves.length} 章 · 目标 {formatChars(groupWords)}
            </span>
          </div>
        )}
        {rows}
      </section>
    );
  });

  const tabs: TabItem[] = [{ key: 'all', label: '全部', badge: leaves.length }];
  if (stats.missing > 0) tabs.push({ key: 'missing', label: '尚无计划', badge: stats.missing });
  if (stats.auto > 0) tabs.push({ key: 'auto', label: '有自动分配的条目', badge: stats.auto });
  const filtering = keyword !== '' || filter !== 'all';

  return (
    <div className="rounded-lg border border-line bg-white shadow-card">
      <div className="sticky top-0 z-10 rounded-t-lg border-b border-line bg-white">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
          <div className="relative w-64 max-w-full">
            <MagnifyingGlassIcon className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-ink-400" aria-hidden="true" />
            <Input
              type="search"
              value={query}
              placeholder="按章节标题或编号筛选"
              aria-label="按章节标题或编号筛选"
              className="pl-8"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {tabs.length > 1 && (
            <Tabs size="sm" variant="pill" value={filter} tabs={tabs} aria-label="筛选章节" onChange={(key) => setFilterKey(key as RowFilter)} />
          )}
          {stats.auto > 0 && (
            <span className="ml-auto flex flex-wrap items-center gap-x-3 text-xs leading-5 text-ink-500">
              <span className="flex items-center gap-1">
                <Badge size="sm" tone="primary">
                  E1
                </Badge>
                规划时指定
              </span>
              <span className="flex items-center gap-1" title="规划时没有章节认领的条目，系统按内容相近分给了最贴切的章节，建议逐个核对">
                <Badge size="sm" tone="warning">
                  E1
                </Badge>
                系统按内容相近自动分配，建议核对
              </span>
            </span>
          )}
        </div>
        <div className={cx(COLS, 'border-t border-line bg-subtle px-4 py-1.5 text-xs leading-5 text-ink-500')} aria-hidden="true">
          <span />
          <span>章节</span>
          <span>负责响应的条目</span>
          <span>要点</span>
          <span>权重</span>
          <span className="text-right">目标字数</span>
        </div>
      </div>

      <div className="-mt-px">{body}</div>

      {shownCount === 0 && (
        <EmptyState
          title="没有符合条件的章节"
          description={keyword ? `没有标题或编号包含“${query.trim()}”的章节。` : '换一个筛选条件试试。'}
          action={
            filtering ? (
              <Button
                size="sm"
                onClick={() => {
                  setQuery('');
                  setFilterKey('all');
                }}
              >
                清除筛选
              </Button>
            ) : undefined
          }
        />
      )}
      {shownCount > 0 && filtering && (
        <p className="border-t border-line px-4 py-2 text-xs leading-5 text-ink-500">
          显示 {shownCount} / {leaves.length} 章
        </p>
      )}
    </div>
  );
}
