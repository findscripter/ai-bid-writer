/**
 * 写作计划阶段：动笔之前先定下全书的“统一口径”和每一章的写作计划。
 *
 * 页面有四种状态：
 * - 还没有目录：引导去“目录”；
 * - 还没有写作计划：讲清楚它是什么、为什么值得做，一键生成（也可以跳过）；
 * - 生成中：阶段说明 + 进度，可以停止；
 * - 已有写作计划：提示（目录改过、有条目没人负责……）、篇幅、“统一口径 / 章节计划”两个页签。
 *
 * 地址里可以带参数：?tab=chapters 直接打开章节计划；?chapter=<章节> 再展开那一章。
 * 有没保存的修改时，离开这一页（站内跳转、浏览器前进后退、刷新）都会先确认；确认离开就是放弃这些修改。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowPathIcon, ArrowRightIcon, ListBulletIcon } from '@heroicons/react/24/outline';
import { errorMessage } from '../../api/client';
import type { RequirementItem } from '../../api/types';
import { useAppShell } from '../../app/AppShell';
import { formatRelativeTime } from '../../lib/format';
import { navigate, useHashRoute, useUnsavedChangesGuard } from '../../lib/router';
import { Button, EmptyState, Spinner, Tabs, cx, useConfirm, useToast } from '../../ui';
import { goStage } from '../ProjectWorkspace';
import { useWorkspace } from '../WorkspaceContext';
import { readDismissedJob, writeDismissedJob } from '../dismissedJobs';
import { BudgetCard } from '../plan/BudgetCard';
import { ChapterPlanList } from '../plan/ChapterPlanList';
import { FactSheetEditor } from '../plan/FactSheetEditor';
import { Notice } from '../plan/Notice';
import { PlanIntro } from '../plan/PlanIntro';
import { PlanProgress } from '../plan/PlanProgress';
import { JOB_LABEL, requirementKindLabel, unassignedRequirements } from '../plan/shared';

type TabKey = 'facts' | 'chapters';

// 规划时写进提示里的“有 N 条找不到章节承接”：页面上另有一块实时的清单，这条旧提示不再重复显示
const UNASSIGNED_WARNING = /^有 \d+ 条评审项\/采购人要求找不到合适的章节承接/;

function UnsavedDot() {
  return <span className="h-1.5 w-1.5 rounded-full bg-amber-500" role="img" aria-label="有未保存的修改" title="有未保存的修改" />;
}

export default function PlanStage() {
  const ws = useWorkspace();
  const shell = useAppShell();
  const toast = useToast();
  const confirm = useConfirm();
  const route = useHashRoute();
  const { projectId, data, job, running, startJob, cancelJob, reload } = ws;
  const { blueprint, leaves, requirements } = data;

  // 正在启动哪一种生成：full 全部重新生成 / fill 只补全缺的
  const [starting, setStarting] = useState<'full' | 'fill' | null>(null);
  // 关掉过的“失败 / 被中断”提示：和阶段外壳共用一份记录（在哪一处关掉，两处都不再出现，刷新后也有效）
  const [dismissTick, setDismissTick] = useState(0);
  const jobId = job ? job.id : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const dismissedJobId = useMemo(() => readDismissedJob(projectId), [projectId, jobId, dismissTick]);
  const [settledJobId, setSettledJobId] = useState<string | null>(null);
  // 使用者确认过“会丢掉没保存的修改”的生成开始之后，通知编辑区放弃草稿
  const [factsDiscard, setFactsDiscard] = useState(0);
  const [chapterDiscard, setChapterDiscard] = useState<{ seq: number; onlyMissing: boolean }>({ seq: 0, onlyMissing: false });
  const [factsDirty, setFactsDirty] = useState(false);
  const [chapterDirty, setChapterDirty] = useState(false);
  const [budgetDirty, setBudgetDirty] = useState(false);
  // 重新生成会覆盖的修改：统一口径、正在编辑的那一章
  const dirty = factsDirty || chapterDirty;
  // 离开这一页（站内跳转、前进后退、刷新）之前先确认；确认离开就是放弃这些修改
  useUnsavedChangesGuard(dirty || budgetDirty, '写作计划里有修改还没有保存，离开这一页后这些修改会丢失。确定要离开吗？');

  const planning = running && job !== null && job.kind === 'plan';
  const busyLabel = running && job !== null && job.kind !== 'plan' ? JOB_LABEL[job.kind] : null;
  const lockedReason = !running || !job ? null : job.kind === 'plan' ? '正在生成写作计划，结束后才能修改。' : `正在${JOB_LABEL[job.kind]}，结束后才能修改。`;
  // 设置已经读到、确实没有配置好时才拦；还没读到就交给后端去判断
  const modelNeedsSetup = shell.settings !== null && !shell.modelReady;

  const requirementById = useMemo(() => {
    const map: Record<string, RequirementItem> = {};
    requirements.forEach((item) => {
      map[item.id] = item;
    });
    return map;
  }, [requirements]);

  const missingLeaves = useMemo(() => (blueprint ? leaves.filter((leaf) => !blueprint.plans[leaf.uid]) : []), [blueprint, leaves]);
  // 没有章节负责的条目：按当前的目录、计划和评分要求实时算（删掉了负责的章节、新解析出条目都能马上反映出来）
  const unassigned = useMemo(
    () => (blueprint ? unassignedRequirements(leaves, blueprint.plans, requirements) : []),
    [blueprint, leaves, requirements]
  );

  // 任务刚结束、新的计划还在路上：等一下结果，不要闪回“还没有计划”的页面
  const awaitingJobId =
    !running && job !== null && job.kind === 'plan' && job.status === 'done' && blueprint === null && settledJobId !== job.id ? job.id : null;
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    if (!awaitingJobId) return undefined;
    let alive = true;
    const settle = () => {
      if (alive) setSettledJobId(awaitingJobId);
    };
    reloadRef.current().then(settle, settle);
    return () => {
      alive = false;
    };
  }, [awaitingJobId]);

  const onFactsDirty = useCallback((value: boolean) => setFactsDirty(value), []);
  const onChapterDirty = useCallback((value: boolean) => setChapterDirty(value), []);
  const onBudgetDirty = useCallback((value: boolean) => setBudgetDirty(value), []);

  const focusParam = route.query.get('chapter');
  const focusUid = focusParam && ws.leafByUid[focusParam] ? focusParam : null;
  const tabParam = route.query.get('tab');
  const tab: TabKey = tabParam === 'chapters' || (tabParam !== 'facts' && focusUid !== null) ? 'chapters' : 'facts';
  // 两个页签的面板都一直挂着，切换不会丢修改：不必经过离开前的确认
  const setTab = (key: string) => navigate(`/projects/${projectId}/plan?tab=${key}`, { replace: true, force: true });

  const startPlan = async (params: Record<string, unknown>) => {
    if (modelNeedsSetup) {
      toast.info('请先配置模型服务（API Key、接口地址、模型），再生成写作计划。');
      shell.openSettings();
      return;
    }
    const onlyMissing = Boolean(params.only_missing);
    setStarting(onlyMissing ? 'fill' : 'full');
    try {
      const started = await startJob('plan', params, (message) => toast.error(message, { title: '写作计划没有开始生成' }));
      // 开始之前已经确认过“没保存的修改会被新的结果替换”：生成真的开始了，编辑区就放弃草稿，
      // 结果出来后直接显示新内容（补全只放弃还没有计划的那一章：已有计划的章节补全不会改动）
      if (started) {
        if (!onlyMissing) setFactsDiscard((value) => value + 1);
        setChapterDiscard((prev) => ({ seq: prev.seq + 1, onlyMissing }));
      }
    } finally {
      setStarting(null);
    }
  };

  const regenerate = async () => {
    const ok = await confirm({
      title: '重新生成写作计划？',
      description: (
        <>
          <p>会重新归纳统一口径、重新给每一章定计划。你改过的统一口径，以及各章的要点、负责条目、权重，都会被新的结果覆盖。</p>
          <p className="mt-2">你给各章写的“补充要求”会保留；已经写好的正文不受影响。</p>
          {dirty && <p className="mt-2 font-medium text-rose-700">页面上还有没保存的修改，重新生成后会丢失。</p>}
        </>
      ),
      confirmText: '重新生成',
      tone: 'danger',
    });
    if (ok) await startPlan({});
  };

  /**
   * 补全计划：只给还没有计划的章节定计划。没有章节负责的条目，只会在这次新补计划的章节里找内容相近的分配，
   * 找不到合适的仍然没人负责，要到章节计划里手动指定
   */
  const fill = async () => {
    // 统一口径和已有计划的章节不会被补全改动；正在编辑的那一章如果还没有计划，草稿会换成补全的结果
    if (chapterDirty) {
      const ok = await confirm({
        title: '正在编辑的章节计划还没有保存',
        description:
          '补全计划只给还没有计划的章节定计划，已经有计划的章节不受影响。如果正在编辑的这一章还没有计划，没保存的修改会被补全的结果替换。建议先保存或撤销，再补全。',
        confirmText: '仍然补全',
        tone: 'danger',
      });
      if (!ok) return;
    }
    await startPlan({ only_missing: true });
  };

  // 补全计划结束后仍有条目没人负责：明确告诉使用者要手动指定（补全只在新补计划的章节里找）
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const lastJobKey = useRef<string | null>(job ? `${job.id}:${job.status}` : null);
  const [fillChecked, setFillChecked] = useState<string | null>(null);
  // 在这一页上看着结束的补全任务（离开再回来就不再特别说明，按普通的“没人负责”提示）
  const [fillDoneId, setFillDoneId] = useState<string | null>(null);
  useEffect(() => {
    if (!job) return;
    const key = `${job.id}:${job.status}`;
    const previous = lastJobKey.current;
    lastJobKey.current = key;
    if (previous === null || previous === key) return;
    if (job.kind !== 'plan' || job.status !== 'done' || !(job.params && job.params.only_missing)) return;
    // 等补全后的计划刷新过来再核对（刷新本身会换掉 job 对象，这里不能随 job 变化取消）
    const doneId = job.id;
    const settle = () => {
      if (!mountedRef.current) return;
      setFillDoneId(doneId);
      setFillChecked(doneId);
    };
    reloadRef.current().then(settle, settle);
  }, [job]);
  const unassignedCount = unassigned.length;
  // 最近一次任务是刚在这一页上结束的补全计划
  const afterFill = !running && job !== null && fillDoneId !== null && job.id === fillDoneId;
  useEffect(() => {
    if (!fillChecked) return;
    setFillChecked(null);
    if (unassignedCount > 0) {
      toast.info(
        `还有 ${unassignedCount} 条评分项或采购人要求没有章节负责：补全只会在新补计划的章节里找内容相近的分配，这几条没找到合适的，需要到“章节计划”里手动指定。`,
        { title: '补全计划已结束', duration: 10000 }
      );
    }
  }, [fillChecked, unassignedCount, toast]);

  const stop = () => cancelJob();
  const onStopError = (error: unknown) => toast.error(errorMessage(error, '没能停下来，请再试一次'));

  // 上次生成没有成功：留在页面上，直到使用者关掉（和阶段外壳的提示共用一份“已关掉”的记录）或再跑一次
  const failedJob = !running && job !== null && job.kind === 'plan' && (job.status === 'failed' || job.status === 'interrupted') && job.id !== dismissedJobId ? job : null;
  const dismissFailure = (id: string) => {
    writeDismissedJob(projectId, id);
    setDismissTick((value) => value + 1);
  };
  // 再试一次：和页面上对应的按钮走同一套确认（全部重新生成会覆盖现有计划，要先确认）
  const failedFill = Boolean(failedJob && failedJob.params && failedJob.params.only_missing);
  const retry = () => {
    if (!blueprint) void startPlan({});
    else if (failedFill) void fill();
    else void regenerate();
  };
  // 与阶段外壳的中断提示同一说法
  const failedAction = failedFill ? '补全章节计划' : '生成写作计划';
  let failureText = '';
  if (failedJob) {
    if (failedJob.status === 'interrupted') {
      failureText = blueprint
        ? '做到一半时服务被关闭了，这次的结果没有保留，原来的写作计划没有变动。'
        : '做到一半时服务被关闭了，这次的结果没有保留。项目现在还没有写作计划，可以点“再试一次”重新生成。';
    } else {
      failureText = `${failedJob.error || '没有拿到具体原因，可以直接再试一次。'}${blueprint ? ' 原来的写作计划没有变动。' : ''}`;
    }
  }
  const failureNotice = failedJob && (
    <Notice
      tone="danger"
      title={failedJob.status === 'interrupted' ? `上次${failedAction}被中断了` : `上次${failedAction}没有成功`}
      onClose={() => dismissFailure(failedJob.id)}
      actions={
        <>
          <Button size="sm" loading={starting !== null} icon={<ArrowPathIcon />} onClick={retry}>
            再试一次
          </Button>
          {failedJob.status !== 'interrupted' && (
            <Button size="sm" variant="ghost" onClick={shell.openSettings}>
              检查模型服务设置
            </Button>
          )}
        </>
      }
    >
      {failureText}
    </Notice>
  );

  if (leaves.length === 0) {
    return (
      <div className="h-full overflow-y-auto">
        <EmptyState
          className="pt-24"
          icon={<ListBulletIcon />}
          title="还没有目录"
          description="写作计划是照着目录一章一章定的。先把目录生成好，再回来制定写作计划。"
          action={
            <Button variant="primary" onClick={() => goStage(projectId, 'outline')}>
              去生成目录
            </Button>
          }
        />
      </div>
    );
  }

  if (awaitingJobId) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="flex flex-col items-center gap-3 pt-28 text-sm text-ink-500">
          <Spinner size="lg" label="正在载入写作计划" />
          <p>写作计划已经生成，正在载入…</p>
        </div>
      </div>
    );
  }

  if (!blueprint) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-5 px-6 py-8">
          {failureNotice && <div className="mx-auto max-w-3xl">{failureNotice}</div>}
          {planning && job ? (
            <div className="mx-auto max-w-3xl space-y-4">
              <div>
                <h1 className="text-xl font-semibold leading-8 text-ink-900">写作计划</h1>
                <p className="mt-1 text-[13px] leading-6 text-ink-500">
                  正在为 {leaves.length} 个章节制定计划。完成后这里会显示统一口径和各章的计划，都可以再改。
                </p>
              </div>
              <PlanProgress job={job} hasBlueprint={false} onStop={stop} onStopError={onStopError} />
            </div>
          ) : (
            <PlanIntro
              leafCount={leaves.length}
              requirementCount={requirements.length}
              hasRequirementsText={data.project.requirements.trim() !== ''}
              modelNeedsSetup={modelNeedsSetup}
              busyLabel={busyLabel}
              starting={starting !== null}
              onGenerate={() => void startPlan({})}
              onSkip={() => goStage(projectId, 'write')}
              onOpenSettings={shell.openSettings}
              onGoTender={() => goStage(projectId, 'tender')}
            />
          )}
        </div>
      </div>
    );
  }

  const planned = leaves.length - missingLeaves.length;
  const warnings = blueprint.warnings.filter((text) => !UNASSIGNED_WARNING.test(text));
  const generated = blueprint.generated_at ? formatRelativeTime(blueprint.generated_at) : '';

  let nextHint = `${leaves.length} 章都有计划了。计划可以随时回来调整。`;
  if (missingLeaves.length > 0) nextHint = `还有 ${missingLeaves.length} 章没有计划，建议先补全再写。`;
  else if (unassigned.length > 0) nextHint = `还有 ${unassigned.length} 条评分项或采购人要求没有章节负责，建议先指定。`;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-5 px-6 py-6">
        <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold leading-7 text-ink-900">写作计划</h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] leading-5 text-ink-500">
              {generated && <span>生成时间：{generated}</span>}
              {blueprint.model && <span>所用模型：{blueprint.model}</span>}
              <span className="tabular-nums">
                {planned}/{leaves.length} 章有计划
              </span>
            </p>
          </div>
          <Button
            icon={<ArrowPathIcon />}
            disabled={running}
            loading={starting === 'full' && !running}
            title={lockedReason || '重新归纳统一口径、重新给每一章定计划'}
            onClick={() => void regenerate()}
          >
            重新生成
          </Button>
        </header>

        {planning && job && <PlanProgress job={job} hasBlueprint onStop={stop} onStopError={onStopError} />}

        {busyLabel && (
          <Notice tone="info">
            正在{busyLabel}。结束之前，写作计划只能看、不能改，也不能重新生成；需要现在就改的话，先在右上角停止它。
          </Notice>
        )}

        {failureNotice}

        {missingLeaves.length > 0 && !planning && (
          <Notice
            tone="warning"
            title={`目录在制定计划之后改过，有 ${missingLeaves.length} 个章节还没有写作计划`}
            actions={
              <Button size="sm" variant="primary" disabled={running} loading={starting === 'fill'} onClick={() => void fill()}>
                补全计划
              </Button>
            }
          >
            <span className="tabular-nums">
              {missingLeaves
                .slice(0, 4)
                .map((leaf) => `${leaf.id} ${leaf.title}`)
                .join('、')}
              {missingLeaves.length > 4 ? ` 等 ${missingLeaves.length} 章` : ''}
            </span>
            还没有计划。“补全计划”只给这些章节定计划，统一口径和其他章节已有的要点、权重都不变。
            {unassigned.length > 0
              ? `还没有章节负责的 ${unassigned.length} 条，只会在这次新补计划的章节里找内容相近的分配（标成“自动分配”，建议核对）；找不到合适的，仍要到“章节计划”里手动指定。`
              : ''}
          </Notice>
        )}

        {unassigned.length > 0 && (
          <Notice
            tone="warning"
            title={
              afterFill
                ? `补全计划已结束，还有 ${unassigned.length} 条评分项或采购人要求没有章节负责，可能漏项`
                : `${unassigned.length} 条评分项或采购人要求还没有章节负责响应，可能漏项`
            }
            actions={
              <>
                <Button size="sm" onClick={() => setTab('chapters')}>
                  到章节计划里指定
                </Button>
                <Button size="sm" variant="ghost" onClick={() => goStage(projectId, 'outline')}>
                  回目录补充章节
                </Button>
              </>
            }
          >
            <ul className="mb-2 mt-1 flex flex-wrap gap-1.5">
              {unassigned.map((rid) => {
                const item = requirementById[rid];
                return (
                  <li
                    key={rid}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-amber-200 bg-white px-2 py-0.5 text-xs leading-5 text-ink-700"
                    title={item ? `${requirementKindLabel(item.kind)}${item.detail ? `：${item.detail}` : ''}` : undefined}
                  >
                    <span className="font-medium tabular-nums text-ink-900">{rid}</span>
                    <span className="min-w-0 truncate">{item ? item.name : '（招标解读里已经没有这一条）'}</span>
                    {item && item.score && <span className="shrink-0 text-ink-400">{item.score}</span>}
                  </li>
                );
              })}
            </ul>
            {afterFill ? '补全只会在新补计划的章节里找内容相近的分配，这几条没有找到合适的章节，需要手动指定。' : ''}
            没有章节负责，写正文时就没有哪一章去响应它们。可以在下面的“章节计划”里展开合适的章节、勾选这些条目；如果目录里确实没有合适的章节，就回到目录补充。
          </Notice>
        )}

        {warnings.length > 0 && (
          <Notice tone="info" title="生成过程中的提示">
            {warnings.length === 1 ? (
              warnings[0]
            ) : (
              <ul className="list-disc space-y-0.5 pl-4">
                {warnings.map((text, index) => (
                  <li key={index}>{text}</li>
                ))}
              </ul>
            )}
          </Notice>
        )}

        <BudgetCard lockedReason={lockedReason} onDirtyChange={onBudgetDirty} />

        <div>
          <Tabs
            value={tab}
            onChange={setTab}
            aria-label="写作计划的内容"
            tabs={[
              { key: 'facts', label: '统一口径', badge: factsDirty ? <UnsavedDot /> : undefined },
              { key: 'chapters', label: '章节计划', badge: chapterDirty ? <UnsavedDot /> : leaves.length },
            ]}
          />
          {/* 两个面板都保持挂载：切换页签不丢正在编辑的内容 */}
          <div role="tabpanel" aria-label="统一口径" className={cx('pt-4', tab !== 'facts' && 'hidden')}>
            <FactSheetEditor lockedReason={lockedReason} onDirtyChange={onFactsDirty} discardSeq={factsDiscard} />
          </div>
          <div role="tabpanel" aria-label="章节计划" className={cx('pt-4', tab !== 'chapters' && 'hidden')}>
            <ChapterPlanList
              focusUid={focusUid}
              lockedReason={lockedReason}
              onDirtyChange={onChapterDirty}
              discardSignal={chapterDiscard}
            />
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
          <p className="text-[13px] leading-6 text-ink-500">{nextHint}</p>
          <Button variant="primary" size="lg" iconRight={<ArrowRightIcon />} onClick={() => goStage(projectId, 'write')}>
            下一步：撰写正文
          </Button>
        </footer>
      </div>
    </div>
  );
}
