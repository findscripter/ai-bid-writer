/**
 * 审校阶段：导出前把漏项、重复、矛盾和待补充信息过一遍。
 *
 * 上面是概览数字和两种检查（规则检查 / 让模型参与的深度检查），
 * 下面三个页签：问题、评分点覆盖、待补充信息。页签写在地址里（?tab=coverage），别的页面可以直接跳过来。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowPathIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  MagnifyingGlassIcon,
  SparklesIcon,
  StopIcon,
} from '@heroicons/react/24/outline';
import { api, errorMessage } from '../../api/client';
import type { JobKind, ReviewIssue, ReviewResponse } from '../../api/types';
import { useAppShell } from '../../app/AppShell';
import { estimatePages, formatChars, formatRelativeTime } from '../../lib/format';
import { navigate, useHashRoute } from '../../lib/router';
import { Button, EmptyState, ProgressBar, Spinner, Tabs, cx, useToast } from '../../ui';
import { goChapter, goStage } from '../ProjectWorkspace';
import { useWorkspace } from '../WorkspaceContext';
import { CoveragePanel } from '../review/CoveragePanel';
import { IssuesPanel } from '../review/IssuesPanel';
import { PlaceholdersPanel } from '../review/PlaceholdersPanel';
import { ReviseIssueModal } from '../review/ReviseIssueModal';
import { chapterReadiness, countBySeverity, openIssues, plainText, reviewFreshness } from '../review/shared';

type TabKey = 'issues' | 'coverage' | 'placeholders';
const TAB_KEYS: TabKey[] = ['issues', 'coverage', 'placeholders'];

/** 别的任务在跑时，为什么现在不能检查（hasReview：已经有检查结果——修订完成后只在有结果时自动重新检查） */
function busyHint(kind: JobKind, hasReview: boolean): string {
  switch (kind) {
    case 'plan':
      return '正在制定写作计划，等它结束后才能检查。';
    case 'write':
      return '正在撰写正文。写完会自动检查一次，现在不用手动检查。';
    case 'revise':
      return hasReview ? '正在修订章节，完成后会自动重新检查。' : '正在修订章节，等它结束后再检查。';
    default:
      return '';
  }
}

/**
 * 深度检查的提示里说明一致性检查没有做成、或有批次没做完。
 * 只认“第 N 批一致性检查没有完成”（对应任务结果里 failed_batches > 0）；
 * “章节较多，一致性检查分 N 批进行”只是说明分了批，每一批都检查完了，不算没做完
 */
const CONSISTENCY_SKIPPED = /未做一致性检查|没有核对前后矛盾/;
const CONSISTENCY_PARTIAL = /第\s*\d+\s*批一致性检查没有完成/;

interface StatProps {
  label: string;
  value: React.ReactNode;
  sub: React.ReactNode;
  title?: string;
  onClick?: () => void;
}

function Stat({ label, value, sub, title, onClick }: StatProps) {
  const body = (
    <>
      <span className="block text-xs text-ink-500">{label}</span>
      <span className="mt-1 block text-[22px] font-semibold leading-7 tabular-nums text-ink-900">{value}</span>
      <span className="mt-1 block truncate text-xs text-ink-500">{sub}</span>
    </>
  );
  const base = 'block w-full rounded-lg border border-line bg-white px-4 py-3 text-left shadow-card';
  if (!onClick) return <div className={base}>{body}</div>;
  return (
    <button type="button" title={title} onClick={onClick} className={cx(base, 'transition-colors hover:border-line-strong hover:bg-subtle')}>
      {body}
    </button>
  );
}

export default function ReviewStage() {
  const ws = useWorkspace();
  const shell = useAppShell();
  const toast = useToast();
  const route = useHashRoute();
  const { data, running, job, projectId, setReview } = ws;
  const review = data.review;
  const { openSettings } = shell;
  // 设置读到了、确实没配好才拦；没读到时交给后端判断
  const modelNeedsSetup = shell.settings !== null && !shell.modelReady;

  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [reviseIssue, setReviseIssue] = useState<ReviewIssue | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const readiness = useMemo(() => chapterReadiness(data), [data]);
  const freshness = useMemo(() => reviewFreshness(data), [data]);
  const open = useMemo(() => openIssues(review), [review]);
  const severity = useMemo(() => countBySeverity(open), [open]);

  const requestedTab = route.query.get('tab') as TabKey | null;
  const tab: TabKey = requestedTab && TAB_KEYS.indexOf(requestedTab) >= 0 ? requestedTab : 'issues';
  const setTab = useCallback(
    (key: string) => {
      navigate(`/projects/${projectId}/review${key === 'issues' ? '' : `?tab=${key}`}`, { replace: true });
    },
    [projectId]
  );

  /** 规则检查：不调用模型，直接拿到新的结果 */
  const runLocal = useCallback(
    async (quiet: boolean = false) => {
      setChecking(true);
      try {
        // 原样交给状态中心：返回里带着 outline_changed（这份结果与当前目录对不对得上），
        // “目录变了，请重新检查”的提示据此消失，不用刷新页面
        const report: ReviewResponse = await api.runReview(projectId);
        setReview(report);
        if (!quiet) {
          const count = openIssues(report).length;
          toast.success(count > 0 ? `检查完成，有 ${count} 个问题待处理` : '检查完成，没有发现问题');
        }
      } catch (error) {
        toast.error(errorMessage(error, '检查没有完成，请重试'), { title: '重新检查' });
      } finally {
        if (mounted.current) setChecking(false);
      }
    },
    [projectId, setReview, toast]
  );

  /** 深度检查：后台任务，过程和结果由状态中心推送 */
  const runDeep = async () => {
    if (modelNeedsSetup) {
      toast.info('深度检查要调用模型，请先配置模型服务（API Key、接口地址、模型）。');
      openSettings();
      return;
    }
    setStarting(true);
    await ws.startJob('review', {}, (message) => toast.error(message, { title: '没能开始深度检查' }));
    if (mounted.current) setStarting(false);
  };

  const stop = async () => {
    setStopping(true);
    try {
      await ws.cancelJob();
    } catch (error) {
      toast.error(errorMessage(error, '没能停下来，请重试'));
    } finally {
      if (mounted.current) setStopping(false);
    }
  };

  const onRevise = useCallback(
    (issue: ReviewIssue) => {
      if (modelNeedsSetup) {
        toast.info('修订要调用模型，请先配置模型服务（API Key、接口地址、模型）。');
        openSettings();
        return;
      }
      setReviseIssue(issue);
    },
    [modelNeedsSetup, openSettings, toast]
  );

  // 修订任务结束后的重新检查由后端完成（有检查结果时，修订一结束就按新的正文再检查一遍），
  // 结果随任务事件刷新过来，不需要一直停在这一页。

  const deepRunning = Boolean(running && job && job.kind === 'review');
  const busyText = running && job && !deepRunning ? busyHint(job.kind, review !== null) : '';

  // ---------- 还不能检查的几种情况 ----------

  if (data.leaves.length === 0) {
    return (
      <div className="h-full overflow-y-auto">
        <EmptyState
          className="pt-24"
          icon={<MagnifyingGlassIcon />}
          title="还没有目录"
          description="先生成目录、写出正文，再回来检查。"
          action={
            <Button variant="primary" onClick={() => goStage(projectId, 'outline')}>
              去生成目录
            </Button>
          }
        />
      </div>
    );
  }

  if (!readiness.anyText) {
    const writing = Boolean(running && job && job.kind === 'write');
    return (
      <div className="h-full overflow-y-auto">
        <EmptyState
          className="pt-24"
          icon={writing ? <Spinner label="正在撰写" /> : <MagnifyingGlassIcon />}
          title={writing ? '正文正在撰写' : '还没有正文可以检查'}
          description={
            writing
              ? '写完会自动检查一次，稍后回到这里看结果。'
              : `目录里的 ${data.leaves.length} 章都还没有正文。先去“正文”把内容写出来，写作结束后会自动检查一次。`
          }
          action={
            <Button variant="primary" onClick={() => goStage(projectId, 'write')}>
              {writing ? '去正文看进度' : '去撰写正文'}
            </Button>
          }
        />
      </div>
    );
  }

  if (!review) {
    return (
      <div className="h-full overflow-y-auto">
        <EmptyState
          className="pt-24"
          icon={<MagnifyingGlassIcon />}
          title="还没有检查过"
          description={
            busyText ||
            '检查会找出没写完的章节、跨章重复、套话、格式残留、评分点漏项，并列出正文里所有【待补充】的地方。按规则检查，几秒完成，不调用模型。'
          }
          action={
            <Button
              variant="primary"
              loading={checking}
              disabled={running}
              icon={<MagnifyingGlassIcon />}
              onClick={() => void runLocal()}
            >
              开始检查
            </Button>
          }
        />
      </div>
    );
  }

  // ---------- 有检查结果 ----------

  const stats = review.stats;
  // 章节写到什么程度按当前数据算（与导出前检查、阶段导航、正文页同一口径）：
  // 结尾可能不完整的章节算写完，另外提醒一句
  const remaining = Math.max(readiness.total - readiness.done, 0);
  const failedCount = readiness.unfinished.filter((item) => item.kind === 'failed').length;
  const truncatedCount = readiness.truncated.length;
  const remainingNote = failedCount > 0 ? `（${failedCount} 章失败）` : '';
  const truncatedNote = truncatedCount > 0 ? `${truncatedCount} 章结尾可能不完整` : '';
  const wordsPerPage = data.project.settings.words_per_page;
  const coverageProblems = review.coverage.filter((item) => item.status !== 'covered').length;
  // 前后矛盾按“待处理”算：已忽略的不算进页头的数字（与问题列表、待处理问题数同一口径）
  const allContradictions = review.issues.filter((issue) => issue.type === 'consistency');
  const contradictions = allContradictions.filter((issue) => review.dismissed.indexOf(issue.id) < 0).length;
  const dismissedContradictions = allContradictions.length - contradictions;
  const checkedAt = formatRelativeTime(review.generated_at);
  const batch = job && job.progress.total > 1 ? `（第 ${Math.max(job.progress.done, 1)}/${job.progress.total} 批）` : '';

  // 这份结果有没有真正做成一致性检查（deep 为 true 才算），没做成或只做了一部分时要说清楚
  let deepNote: string;
  if (review.deep) {
    if (contradictions > 0) deepNote = `含深度检查，有 ${contradictions} 处前后矛盾待处理`;
    else if (dismissedContradictions > 0) deepNote = `含深度检查，发现的 ${dismissedContradictions} 处前后矛盾都已忽略`;
    else deepNote = '含深度检查，没有发现前后矛盾';
    if (review.warnings.some((text) => CONSISTENCY_PARTIAL.test(text))) deepNote += '（有的批次没有检查完，见下方提示）';
  } else if (review.warnings.some((text) => CONSISTENCY_SKIPPED.test(text))) {
    deepNote = '只做了规则检查：深度检查这次没能核对前后矛盾，原因见下方提示';
  } else {
    deepNote = '只做了规则检查';
  }

  let deepBlocked = '';
  if (!deepRunning && readiness.done < 2) deepBlocked = '至少要写完两章，才能核对前后是否一致。';

  let staleText = '';
  if (!running && !checking && freshness.stale) {
    staleText = freshness.outlineChanged
      ? '上次检查之后目录变了，下面的结果可能已经过时，请重新检查。'
      : `上次检查之后有 ${freshness.changed.length} 章正文改过，下面的结果可能已经过时，请重新检查。`;
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-4 px-6 py-6">
        <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
          <div>
            <h1 className="text-lg font-semibold leading-7 text-ink-900">审校</h1>
            <p className="mt-0.5 text-[13px] text-ink-500">导出前把漏项、重复、矛盾和待补充信息过一遍。</p>
          </div>
          <p className="flex items-center gap-1.5 text-xs text-ink-500">
            {checking && <Spinner size="sm" label="正在检查" />}
            {checking ? (
              '正在重新检查…'
            ) : (
              <>
                上次检查：{checkedAt || '时间未知'}
                <span className="text-ink-300">·</span>
                {deepNote}
              </>
            )}
          </p>
        </header>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            label="已完成章节"
            value={
              <>
                {readiness.done}
                <span className="text-base font-medium text-ink-400">/{readiness.total}</span>
              </>
            }
            sub={
              remaining === 0 ? (
                truncatedNote ? (
                  <span className="text-amber-700">其中 {truncatedNote}</span>
                ) : (
                  <span className="text-emerald-700">全部写完</span>
                )
              ) : (
                <span className="text-amber-700">
                  还有 {remaining} 章没写完{remainingNote}
                  {truncatedNote ? `，另有 ${truncatedNote}` : ''}
                </span>
              )
            }
            title={
              truncatedNote && remaining === 0 ? `${truncatedNote}：模型写到了输出上限，点这里去正文页看一眼结尾` : '去正文'
            }
            onClick={() =>
              remaining === 0 && readiness.truncated.length > 0
                ? goChapter(projectId, readiness.truncated[0].uid)
                : goStage(projectId, 'write')
            }
          />
          <Stat
            label="全书字数"
            value={formatChars(stats.total_chars)}
            sub={
              stats.target_chars > 0
                ? `目标 ${formatChars(stats.target_chars)} · 现约 ${estimatePages(stats.total_chars, wordsPerPage)} 页`
                : `约 ${estimatePages(stats.total_chars, wordsPerPage)} 页`
            }
          />
          <Stat
            label="待处理问题"
            value={open.length}
            sub={
              open.length === 0 ? (
                <span className="text-emerald-700">都处理完了</span>
              ) : (
                <>
                  <span className={severity.high > 0 ? 'text-rose-600' : undefined}>重要 {severity.high}</span>
                  {' · '}一般 {severity.medium}
                  {' · '}提示 {severity.low}
                </>
              )
            }
            title="看问题列表"
            onClick={() => setTab('issues')}
          />
          <Stat
            label="待补充信息"
            value={stats.placeholder_count}
            sub={
              stats.placeholder_count > 0 ? (
                <span className="text-amber-700">导出前要换成真实内容</span>
              ) : (
                <span className="text-emerald-700">正文里没有占位</span>
              )
            }
            title="看待补充信息"
            onClick={() => setTab('placeholders')}
          />
        </div>

        <section className="rounded-lg border border-line bg-white shadow-card" aria-label="检查">
          <div className="grid grid-cols-1 divide-y divide-line md:grid-cols-2 md:divide-x md:divide-y-0">
            <div className="flex items-start gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold leading-6 text-ink-900">重新检查</h2>
                <p className="mt-0.5 text-xs leading-5 text-ink-500">
                  按规则找出没写完的章节、篇幅偏差、重复、套话、格式残留和评分点漏项。几秒完成，不调用模型。
                </p>
              </div>
              <Button
                className="mt-0.5 shrink-0"
                variant={staleText ? 'primary' : 'secondary'}
                loading={checking}
                disabled={running}
                icon={<ArrowPathIcon />}
                onClick={() => void runLocal()}
              >
                重新检查
              </Button>
            </div>

            <div className="flex items-start gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold leading-6 text-ink-900">深度检查</h2>
                {deepRunning && job ? (
                  <div className="mt-1" role="status">
                    <p className="flex items-center gap-2 text-xs leading-5 text-primary-700">
                      <Spinner size="sm" label="深度检查进行中" />
                      <span className="min-w-0 truncate">
                        {job.message || '正在检查'}
                        {batch}
                      </span>
                    </p>
                    <ProgressBar value={null} size="sm" className="mt-2" />
                  </div>
                ) : (
                  <p className="mt-0.5 text-xs leading-5 text-ink-500">
                    在规则检查之外，让模型核对各章的数字、期限、指标有没有前后矛盾。会调用模型，章节多时要等几分钟。
                  </p>
                )}
                {deepBlocked && <p className="mt-1 text-xs leading-5 text-amber-700">{deepBlocked}</p>}
              </div>
              {deepRunning ? (
                <Button className="mt-0.5 shrink-0" loading={stopping} icon={<StopIcon />} onClick={() => void stop()}>
                  停止
                </Button>
              ) : (
                <Button
                  className="mt-0.5 shrink-0"
                  loading={starting}
                  disabled={running || checking || Boolean(deepBlocked)}
                  icon={<SparklesIcon />}
                  onClick={() => void runDeep()}
                >
                  深度检查
                </Button>
              )}
            </div>
          </div>

          {busyText && (
            <p className="flex items-center gap-2 rounded-b-lg border-t border-line bg-subtle px-4 py-2 text-xs text-ink-600" role="status">
              <Spinner size="sm" tone="muted" label="有任务正在进行" />
              {busyText}
            </p>
          )}
          {staleText && (
            <p className="flex items-start gap-2 rounded-b-lg border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs leading-5 text-amber-900">
              <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
              {staleText}
            </p>
          )}
        </section>

        {review.warnings.length > 0 && (
          <ul className="space-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5" aria-label="检查时的提示">
            {review.warnings.map((warning, index) => (
              <li key={index} className="flex items-start gap-2 text-[13px] leading-6 text-amber-900">
                <InformationCircleIcon className="mt-1 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
                <span className="min-w-0 break-words">{plainText(warning)}</span>
              </li>
            ))}
          </ul>
        )}

        <div>
          <div className="sticky top-0 z-10 -mx-6 bg-canvas px-6 pt-1">
            <Tabs
              value={tab}
              onChange={setTab}
              aria-label="检查结果"
              tabs={[
                { key: 'issues', label: '问题', badge: open.length > 0 ? open.length : undefined },
                { key: 'coverage', label: '评分点覆盖', badge: coverageProblems > 0 ? coverageProblems : undefined },
                {
                  key: 'placeholders',
                  label: '待补充信息',
                  badge: review.placeholders.length > 0 ? review.placeholders.length : undefined,
                },
              ]}
            />
          </div>
          <div className="pt-4" role="tabpanel">
            {tab === 'issues' && <IssuesPanel review={review} locked={deepRunning} onRevise={onRevise} />}
            {tab === 'coverage' && <CoveragePanel review={review} />}
            {tab === 'placeholders' && <PlaceholdersPanel review={review} />}
          </div>
        </div>
      </div>

      <ReviseIssueModal issue={reviseIssue} onClose={() => setReviseIssue(null)} />
    </div>
  );
}
