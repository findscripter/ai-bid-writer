/**
 * 项目工作台：一个项目从招标解读到导出的全过程。
 *
 * 顶部是阶段导航和后台任务的状态条，下面是当前阶段的页面。
 * 各阶段页面的约定：
 * - 默认导出一个无属性的组件，通过 useWorkspace() 取数据；
 * - 根元素自己负责滚动：<div className="h-full overflow-y-auto">，内部再放定宽容器；
 * - 跳到别的阶段用 goStage('write')，跳到某一章用 goChapter(uid)。
 */
import React, { useEffect, useRef, useState } from 'react';
import { CheckIcon, ExclamationTriangleIcon, StopIcon, XMarkIcon } from '@heroicons/react/20/solid';
import { api, errorMessage } from '../api/client';
import type { JobKind, JobRecord, LeafInfo, ProjectState } from '../api/types';
import { AppShell } from '../app/AppShell';
import { Link, navigate } from '../lib/router';
import { Button, EmptyState, IconButton, Input, ProgressBar, Spinner, cx, useToast } from '../ui';
import { useWorkspace, WorkspaceProvider } from './WorkspaceContext';
import { readDismissedJob, writeDismissedJob } from './dismissedJobs';
import { unassignedRequirements } from './plan/shared';
import { reviewFreshness } from './review/shared';
import ExportStage from './stages/ExportStage';
import OutlineStage from './stages/OutlineStage';
import PlanStage from './stages/PlanStage';
import ReviewStage from './stages/ReviewStage';
import TenderStage from './stages/TenderStage';
import WriteStage from './stages/WriteStage';

export type StageKey = 'tender' | 'outline' | 'plan' | 'write' | 'review' | 'export';

export const STAGES: Array<{ key: StageKey; label: string; hint: string }> = [
  { key: 'tender', label: '招标解读', hint: '上传招标文件，解析项目概述与评分要求' },
  { key: 'outline', label: '目录', hint: '生成并调整三级目录' },
  { key: 'plan', label: '写作计划', hint: '统一全书口径，给每章定要点与篇幅' },
  { key: 'write', label: '正文', hint: '撰写、修订各章正文' },
  { key: 'review', label: '审校', hint: '检查漏项、重复、矛盾与待补充信息' },
  { key: 'export', label: '导出', hint: '导出 Word' },
];

const JOB_LABEL: Record<JobKind, string> = {
  plan: '制定写作计划',
  write: '撰写正文',
  revise: '修订章节',
  review: '深度审校',
};

/** 跳到某个阶段 */
export function goStage(projectId: string, stage: StageKey): void {
  navigate(`/projects/${projectId}/${stage}`);
}

/** 跳到正文阶段并选中某一章 */
export function goChapter(projectId: string, uid: string): void {
  navigate(`/projects/${projectId}/write?chapter=${encodeURIComponent(uid)}`);
}

function stageDone(key: StageKey, data: ProjectState): boolean {
  const leaves = data.leaves;
  switch (key) {
    case 'tender':
      return Boolean(data.project.overview.trim() && data.project.requirements.trim());
    case 'outline':
      return leaves.length > 0;
    case 'plan':
      // 有章节还没有计划、或者有评分项/采购人要求没有章节负责（负责的章节被删了），都还不算定好
      return (
        data.blueprint !== null &&
        !data.blueprint_stale &&
        unassignedRequirements(leaves, data.blueprint.plans, data.requirements).length === 0
      );
    case 'write':
      return (
        leaves.length > 0 &&
        leaves.every((leaf) => {
          const chapter = data.chapters[leaf.uid];
          return chapter && chapter.status === 'done' && chapter.chars > 0;
        })
      );
    case 'review': {
      const review = data.review;
      // 检查之后目录或正文又改过，结论就不作数了
      if (!review || reviewFreshness(data).stale) return false;
      const open = review.issues.filter((issue) => issue.severity === 'high' && review.dismissed.indexOf(issue.id) < 0);
      return open.length === 0;
    }
    default:
      return false;
  }
}

interface InterruptedNotice {
  title: string;
  text: string;
  /** 到哪个阶段去继续 */
  stage: StageKey;
}

/**
 * 任务在服务关闭（重启）时被中断了：说清楚是哪种任务、做到哪一步、怎么继续。
 * 说法按现在的数据来定（这一章有没有正文、项目有没有写作计划），不能说“保留了原来的内容”而其实原来什么都没有。
 */
function interruptedNotice(job: JobRecord, data: ProjectState, leafByUid: Record<string, LeafInfo>): InterruptedNotice {
  const params = job.params || {};
  const chapterOf = (uid: unknown) => (typeof uid === 'string' ? data.chapters[uid] : undefined);
  const chapterName = (uid: unknown): string => {
    const leaf = typeof uid === 'string' ? leafByUid[uid] : undefined;
    return leaf ? `“${leaf.id} ${leaf.title}”` : '这一章';
  };
  const complete = (uid: unknown): boolean => {
    const chapter = chapterOf(uid);
    return Boolean(chapter && chapter.status === 'done' && chapter.chars > 0);
  };
  // 这一章的正文是在任务开始之后保存的：关闭服务之前任务已经把它写完了
  const savedDuringJob = (uid: unknown): boolean => {
    const chapter = chapterOf(uid);
    return Boolean(chapter && job.started_at && chapter.updated_at && chapter.updated_at > job.started_at);
  };
  switch (job.kind) {
    case 'write': {
      const uids = Array.isArray(params.uids) ? params.uids : [];
      if (uids.length === 1) {
        const uid = uids[0];
        const name = chapterName(uid);
        const chapter = chapterOf(uid);
        if (complete(uid) && savedDuringJob(uid)) {
          return {
            title: '撰写被中断了',
            text: `服务在任务收尾时被关闭，${name}在此之前已经写完并保存了，可以在正文页查看。`,
            stage: 'write',
          };
        }
        if (complete(uid)) {
          return {
            title: '重写被中断了',
            text: `服务在重写${name}时被关闭，这一章保留了原来的内容，可以在正文页重新撰写。`,
            stage: 'write',
          };
        }
        if (chapter && chapter.chars > 0) {
          return {
            title: '撰写被中断了',
            text: `服务在撰写${name}时被关闭，这一章只有没写完的一部分，可以在正文页重新撰写。`,
            stage: 'write',
          };
        }
        return {
          title: '撰写被中断了',
          text: `服务在撰写${name}时被关闭，这一章还没有写出内容，可以在正文页重新撰写。`,
          stage: 'write',
        };
      }
      if (uids.length > 1) {
        const finished = uids.filter(complete).length;
        const rest = uids.length - finished;
        let text = `服务在撰写指定的 ${uids.length} 章时被关闭，`;
        if (rest === 0) text += '这几章在此之前都已经写完了，可以在正文页查看。';
        else if (finished > 0) text += `其中 ${finished} 章已经写完，另外 ${rest} 章没有写完，可以在正文页重新撰写。`;
        else text += '这几章都没有写完，可以在正文页重新撰写。';
        return { title: '撰写被中断了', text, stage: 'write' };
      }
      if (params.mode === 'all') {
        return {
          title: '全部重写被中断了',
          text: '服务在重写过程中被关闭，只有一部分章节换成了新内容，其余章节还是原来的正文。需要的话可以在正文页再点“全部重写”。',
          stage: 'write',
        };
      }
      return {
        title: '撰写正文被中断了',
        text: '服务在撰写过程中被关闭。已经写完的章节都保存了，到正文页点“继续撰写”接着写。',
        stage: 'write',
      };
    }
    case 'revise':
      if (savedDuringJob(params.uid)) {
        return {
          title: '修订被中断了',
          text: `服务在任务收尾时被关闭，${chapterName(params.uid)}在此之前已经修订并保存了，可以在正文页查看。`,
          stage: 'write',
        };
      }
      return {
        title: '修订被中断了',
        text: `服务在修订${chapterName(params.uid)}时被关闭，这一章保留了修订前的正文，可以重新修订。`,
        stage: 'write',
      };
    case 'plan':
      if (!data.blueprint) {
        return {
          title: '生成写作计划被中断了',
          text: '服务在生成过程中被关闭，这次的结果没有保留，项目还没有写作计划。可以到写作计划页重新生成。',
          stage: 'plan',
        };
      }
      if (params.only_missing) {
        return {
          title: '补全章节计划被中断了',
          text: '服务在补全过程中被关闭，这次的结果没有保留，原来的写作计划没有变动，缺计划的章节还是没有计划。可以到写作计划页重新补全。',
          stage: 'plan',
        };
      }
      return {
        title: '生成写作计划被中断了',
        text: '服务在生成过程中被关闭，这次的结果没有保留，原来的写作计划没有变动。可以到写作计划页重新生成。',
        stage: 'plan',
      };
    default:
      return {
        title: '深度检查被中断了',
        text: data.review
          ? '服务在检查过程中被关闭，上一次的审校结果原样保留，可以到审校页重新检查。'
          : '服务在检查过程中被关闭，这次没有得到检查结果，可以到审校页重新检查。',
        stage: 'review',
      };
  }
}

const GO_STAGE_LABEL: Record<StageKey, string> = {
  tender: '去招标解读',
  outline: '去目录',
  plan: '去写作计划',
  write: '去正文',
  review: '去审校',
  export: '去导出',
};

/** 进入项目时落在哪个阶段：第一个还没做完的 */
function defaultStage(data: ProjectState): StageKey {
  if (!stageDone('tender', data)) return 'tender';
  if (!stageDone('outline', data)) return 'outline';
  const anyChapter = Object.keys(data.chapters).length > 0;
  if (!data.blueprint && !anyChapter) return 'plan';
  return 'write';
}

function ProjectName() {
  const ws = useWorkspace();
  const toast = useToast();
  const name = ws.data.project.name;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);

  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  const commit = async () => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === name) return;
    try {
      ws.apply(await api.patchProject(ws.projectId, { name: next }));
    } catch (error) {
      toast.error(errorMessage(error, '重命名失败'));
    }
  };

  if (editing) {
    return (
      <Input
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void commit();
          if (event.key === 'Escape') setEditing(false);
        }}
        className="h-7 w-72 text-sm"
        aria-label="项目名称"
      />
    );
  }
  return (
    <button
      type="button"
      className="max-w-[28rem] truncate rounded px-1 py-0.5 text-sm font-medium text-ink-900 hover:bg-subtle"
      title="点击重命名"
      onClick={() => setEditing(true)}
    >
      {name}
    </button>
  );
}

function JobBar({ job }: { job: JobRecord }) {
  const ws = useWorkspace();
  const toast = useToast();
  const [stopping, setStopping] = useState(false);
  const { progress } = job;
  const percent = progress.total > 0 ? Math.round(((progress.done + progress.failed) / progress.total) * 100) : null;

  const stop = async () => {
    setStopping(true);
    try {
      await ws.cancelJob();
    } catch (error) {
      // 服务连不上、请求被拒：说清楚停止没有生效，任务条照旧留着，可以再点一次
      toast.error(errorMessage(error, '请稍后再点一次“停止”。'), { title: '没能停下来' });
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-3 whitespace-nowrap rounded-md border border-primary-200 bg-primary-50 px-3 py-1 text-xs text-primary-800">
      <Spinner size="sm" />
      <span className="font-medium">{JOB_LABEL[job.kind]}</span>
      {progress.total > 0 && (
        <span className="tabular-nums">
          {progress.done + progress.failed}/{progress.total}
          {progress.failed > 0 && <span className="ml-1 text-rose-600">（失败 {progress.failed}）</span>}
        </span>
      )}
      <span className="hidden max-w-[14rem] truncate text-primary-700 2xl:inline">{job.message}</span>
      <ProgressBar value={percent} size="sm" className="w-24" />
      <Button size="sm" variant="secondary" loading={stopping} icon={<StopIcon className="h-3.5 w-3.5" />} onClick={() => void stop()}>
        停止
      </Button>
    </div>
  );
}

function WorkspaceBody({ stage }: { stage?: string }) {
  const ws = useWorkspace();
  const toast = useToast();
  const { data, job } = ws;
  const known = STAGES.some((item) => item.key === stage);
  const current: StageKey = known ? (stage as StageKey) : defaultStage(data);

  useEffect(() => {
    // 只是把地址补全成具体的阶段，不算离开
    if (!known) navigate(`/projects/${ws.projectId}/${current}`, { replace: true, force: true });
  }, [known, current, ws.projectId]);

  // 最近一次任务在服务关闭时被中断了：在阶段导航下面一直提示，直到使用者关掉或重新开始。
  // 关掉过的记在 dismissedJobs 里，和写作计划页共用（在那边关掉的，切到别的页面也不再出现），
  // 所以每次都从那里读，不在这里另存一份
  const [, setDismissTick] = useState(0);
  const dismissedJobId = job && job.status === 'interrupted' ? readDismissedJob(ws.projectId) : null;
  const interrupted = !ws.running && job && job.status === 'interrupted' && job.id !== dismissedJobId ? job : null;
  // 写作计划页自己会提示计划生成被中断，不重复
  const notice =
    interrupted && !(interrupted.kind === 'plan' && current === 'plan') ? interruptedNotice(interrupted, data, ws.leafByUid) : null;
  const dismissInterrupted = () => {
    if (!interrupted) return;
    writeDismissedJob(ws.projectId, interrupted.id);
    setDismissTick((tick) => tick + 1);
  };

  // 任务结束时给一个结果提示（成功的写作任务由正文页自己展示结果，这里只报异常）
  const lastStatus = useRef<string | null>(null);
  useEffect(() => {
    if (!job) return;
    const key = `${job.id}:${job.status}`;
    if (lastStatus.current !== null && lastStatus.current !== key) {
      if (job.status === 'failed') toast.error(job.error || '任务失败', { title: JOB_LABEL[job.kind] });
      else if (job.status === 'done' && job.progress.failed > 0) {
        toast.error(`有 ${job.progress.failed} 章没有写成，可以在正文页点“重试失败章节”。`, { title: JOB_LABEL[job.kind] });
      } else if (job.status === 'done' && job.kind === 'review') {
        // 与审校页页头的说法一致：一致性检查没做成、或者有批次没检查完时，不能说成“已完成”；
        // 章节多、分了几批但每一批都检查完了，仍然是“已完成”，只提醒跨批的矛盾可能查不到
        const result = job.result || {};
        const batches = typeof result.batches === 'number' ? result.batches : 0;
        const failedBatches = typeof result.failed_batches === 'number' ? result.failed_batches : 0;
        if (result.deep === false) {
          toast.info('这次只做了规则检查，没能核对前后矛盾，原因见审校页的提示。', { title: '深度审校结束' });
        } else if (failedBatches > 0) {
          toast.info(`有的批次没有检查完（共 ${batches} 批，${failedBatches} 批没检查完），详见审校页的提示。`, {
            title: '深度审校已完成',
          });
        } else if (batches > 1) {
          toast.success(`章节较多，一致性检查分 ${batches} 批进行，跨批的矛盾可能查不到。`, { title: '深度审校已完成' });
        } else toast.success('深度审校已完成');
      } else if (job.status === 'done') toast.success(`${JOB_LABEL[job.kind]}已完成`);
    }
    lastStatus.current = key;
  }, [job, toast]);

  let page: React.ReactNode;
  switch (current) {
    case 'tender':
      page = <TenderStage />;
      break;
    case 'outline':
      page = <OutlineStage />;
      break;
    case 'plan':
      page = <PlanStage />;
      break;
    case 'write':
      page = <WriteStage />;
      break;
    case 'review':
      page = <ReviewStage />;
      break;
    default:
      page = <ExportStage />;
  }

  return (
    <AppShell
      breadcrumb={
        <>
          <Link to="/" className="shrink-0 hover:text-ink-700">
            项目
          </Link>
          <span className="text-ink-300">/</span>
          <ProjectName />
        </>
      }
    >
      <div className="flex h-full flex-col">
        <div className="flex h-11 shrink-0 items-center gap-4 border-b border-line bg-white px-4">
          <nav className="flex h-full shrink-0 items-stretch gap-1 whitespace-nowrap" aria-label="项目阶段">
            {STAGES.map((item, index) => {
              const done = stageDone(item.key, data);
              const active = item.key === current;
              return (
                <Link
                  key={item.key}
                  to={`/projects/${ws.projectId}/${item.key}`}
                  title={item.hint}
                  aria-current={active ? 'page' : undefined}
                  className={cx(
                    'relative flex items-center gap-1.5 px-3 text-sm transition-colors',
                    active ? 'font-medium text-primary-700' : 'text-ink-600 hover:text-ink-900'
                  )}
                >
                  <span
                    className={cx(
                      'flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold',
                      done
                        ? 'bg-emerald-500 text-white'
                        : active
                          ? 'bg-primary-600 text-white'
                          : 'bg-line text-ink-500'
                    )}
                  >
                    {done ? <CheckIcon className="h-3 w-3" /> : index + 1}
                  </span>
                  {item.label}
                  {active && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary-600" />}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-2">{ws.running && job && <JobBar job={job} />}</div>
        </div>
        {notice && (
          <div
            role="status"
            className="flex shrink-0 items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-[13px] leading-5 text-amber-900"
          >
            <ExclamationTriangleIcon className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
            <p className="min-w-0 flex-1">
              <span className="font-medium">{notice.title}。</span>
              {notice.text}
            </p>
            {current !== notice.stage && (
              <Button size="sm" variant="secondary" className="shrink-0" onClick={() => goStage(ws.projectId, notice.stage)}>
                {GO_STAGE_LABEL[notice.stage]}
              </Button>
            )}
            <IconButton label="关闭这条提示" size="sm" icon={<XMarkIcon />} className="shrink-0" onClick={dismissInterrupted} />
          </div>
        )}
        <div className="min-h-0 flex-1">{page}</div>
      </div>
    </AppShell>
  );
}

interface ProjectWorkspaceProps {
  projectId: string;
  stage?: string;
}

export default function ProjectWorkspace({ projectId, stage }: ProjectWorkspaceProps) {
  return (
    <WorkspaceProvider
      projectId={projectId}
      fallback={({ loading, error, retry }) => (
        <AppShell
          breadcrumb={
            <Link to="/" className="hover:text-ink-700">
              项目
            </Link>
          }
        >
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <Spinner size="lg" label="正在打开项目" />
            </div>
          ) : (
            <EmptyState
              className="pt-24"
              title="项目打不开"
              description={error}
              action={
                <div className="flex justify-center gap-2">
                  <Button onClick={retry}>重试</Button>
                  <Button variant="ghost" onClick={() => navigate('/')}>
                    回到项目列表
                  </Button>
                </div>
              }
            />
          )}
        </AppShell>
      )}
    >
      <WorkspaceBody stage={stage} />
    </WorkspaceProvider>
  );
}
