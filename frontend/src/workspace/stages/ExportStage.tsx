/**
 * 导出阶段：导出前检查清单 → 导出选项 → 导出 Word；另外可以导出整个项目的备份。
 *
 * 清单只提醒，不替使用者做决定：除了“有章节没有正文”会拦住导出（勾选“仍然导出”后放行），
 * 其余几项有问题也可以导出。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircleIcon as CheckSolid,
  ExclamationCircleIcon as BlockSolid,
  ExclamationTriangleIcon as WarnSolid,
  MinusCircleIcon as NeutralSolid,
  QuestionMarkCircleIcon as UnknownSolid,
} from '@heroicons/react/20/solid';
import {
  ArchiveBoxArrowDownIcon,
  ArrowDownTrayIcon,
  DocumentArrowDownIcon,
  DocumentTextIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/outline';
import { api, errorMessage, saveBlob } from '../../api/client';
import type { ExportOptions, LeafInfo } from '../../api/types';
import { useAppShell } from '../../app/AppShell';
import { formatDuration } from '../../lib/format';
import { navigate } from '../../lib/router';
import { Badge, Button, Card, Checkbox, EmptyState, Field, Input, ProgressBar, cx, useToast } from '../../ui';
import { goChapter, goStage } from '../ProjectWorkspace';
import { useWorkspace } from '../WorkspaceContext';
import { unassignedRequirements } from '../plan/shared';
import { ChapterChip } from '../review/ChapterChip';
import { chapterReadiness, countBySeverity, groupUnfinished, openIssues, plainText, reviewFreshness } from '../review/shared';

/** 清单里最多先列出多少个章节 */
const MAX_LISTED = 5;

type CheckState = 'ok' | 'warn' | 'block' | 'unknown' | 'neutral';

const STATE_ICON: Record<CheckState, { icon: React.ReactNode; label: string }> = {
  ok: { icon: <CheckSolid className="h-5 w-5 text-emerald-500" />, label: '通过' },
  warn: { icon: <WarnSolid className="h-5 w-5 text-amber-500" />, label: '需要注意' },
  block: { icon: <BlockSolid className="h-5 w-5 text-rose-500" />, label: '会拦住导出' },
  unknown: { icon: <UnknownSolid className="h-5 w-5 text-ink-400" />, label: '还不知道' },
  neutral: { icon: <NeutralSolid className="h-5 w-5 text-ink-300" />, label: '不影响导出' },
};

interface CheckRowProps {
  state: CheckState;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}

function CheckRow({ state, title, children, action }: CheckRowProps) {
  const meta = STATE_ICON[state];
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 shrink-0" role="img" aria-label={meta.label} title={meta.label}>
        {meta.icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-6 text-ink-900">{title}</p>
        {children != null && children !== false ? <div className="mt-0.5 text-xs leading-5 text-ink-500">{children}</div> : null}
      </div>
      {action != null ? <div className="mt-0.5 shrink-0">{action}</div> : null}
    </li>
  );
}

function ChapterList({ projectId, label, leaves }: { projectId: string; label: string; leaves: LeafInfo[] }) {
  if (leaves.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <span className="text-ink-400">{label}</span>
      {leaves.slice(0, MAX_LISTED).map((leaf) => (
        <ChapterChip key={leaf.uid} projectId={projectId} uid={leaf.uid} leaf={leaf} className="max-w-[16rem]" />
      ))}
      {leaves.length > MAX_LISTED && <span className="text-ink-400">等 {leaves.length} 章</span>}
    </div>
  );
}

interface OptionRowProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  title: string;
  hint: React.ReactNode;
  disabled?: boolean;
  children?: React.ReactNode;
}

function OptionRow({ checked, onChange, title, hint, disabled, children }: OptionRowProps) {
  return (
    <div className="px-4 py-3">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="flex"
        label={
          <>
            <span className={cx('block font-medium', disabled ? 'text-ink-400' : 'text-ink-900')}>{title}</span>
            <span className="mt-0.5 block text-xs leading-5 text-ink-500">{hint}</span>
          </>
        }
      />
      {children}
    </div>
  );
}

interface Outcome {
  filename: string;
  blob: Blob;
  diagramCount: number;
  diagramError: string;
  missingChapters: number;
  withDiagrams: boolean;
  includeToc: boolean;
}

function formatSize(bytes: number): string {
  if (!(bytes > 0)) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 记住上次的导出选项（只是界面偏好；“自动插图”耗时又要调用模型，每次都从关闭开始） */
const PREFS_KEY = 'aibid.export.options';

interface Prefs {
  includeToc: boolean;
  includeOverview: boolean;
  diagramModel: string;
}

function loadPrefs(): Prefs {
  const defaults: Prefs = { includeToc: true, includeOverview: false, diagramModel: '' };
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return defaults;
    const saved = JSON.parse(raw) as Partial<Prefs> | null;
    if (!saved || typeof saved !== 'object') return defaults;
    return {
      includeToc: saved.includeToc !== false,
      includeOverview: saved.includeOverview === true,
      diagramModel: typeof saved.diagramModel === 'string' ? saved.diagramModel : '',
    };
  } catch {
    return defaults;
  }
}

function savePrefs(prefs: Prefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 存不了就算了，不影响导出
  }
}

export default function ExportStage() {
  const ws = useWorkspace();
  const shell = useAppShell();
  const toast = useToast();
  const { data, projectId, running, job } = ws;
  const { review, blueprint } = data;

  const [initial] = useState(loadPrefs);
  const [includeToc, setIncludeToc] = useState(initial.includeToc);
  const [includeOverview, setIncludeOverview] = useState(initial.includeOverview);
  const [withDiagrams, setWithDiagrams] = useState(false);
  const [diagramModel, setDiagramModel] = useState(initial.diagramModel);
  const [allowIncomplete, setAllowIncomplete] = useState(false);

  const [exporting, setExporting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [failure, setFailure] = useState('');
  const [archiving, setArchiving] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    savePrefs({ includeToc, includeOverview, diagramModel: diagramModel.trim() });
  }, [includeToc, includeOverview, diagramModel]);

  // 导出中显示已经等了多久（带插图时可能要几分钟）
  useEffect(() => {
    if (!exporting) return undefined;
    const started = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(Date.now() - started), 1000);
    return () => window.clearInterval(timer);
  }, [exporting]);

  const readiness = useMemo(() => chapterReadiness(data), [data]);
  const freshness = useMemo(() => reviewFreshness(data), [data]);
  const open = useMemo(() => openIssues(review), [review]);
  const severity = useMemo(() => countBySeverity(open), [open]);
  // 没有章节负责的评分项、采购人要求（与写作计划页、目录页同一口径：负责的章节被删掉了也算）
  const { leaves, requirements } = data;
  const unassigned = useMemo(
    () => (blueprint ? unassignedRequirements(leaves, blueprint.plans, requirements) : []),
    [blueprint, leaves, requirements]
  );

  if (data.leaves.length === 0) {
    return (
      <div className="h-full overflow-y-auto">
        <EmptyState
          className="pt-24"
          icon={<DocumentTextIcon />}
          title="还没有可以导出的内容"
          description="先生成目录、写出正文，再回来导出 Word。"
          action={
            <Button variant="primary" onClick={() => goStage(projectId, 'outline')}>
              去生成目录
            </Button>
          }
        />
      </div>
    );
  }

  const missing = readiness.missing;
  const unfinished = readiness.unfinished.map((item) => item.leaf);
  const unfinishedGroups = groupUnfinished(readiness);
  // 已写完、但结尾可能不完整的章节：不算没写完，单独列一项提醒去看
  const truncated = readiness.truncated;
  const firstTodo = missing[0] || unfinished[0];
  const missingPlans = blueprint ? data.leaves.filter((leaf) => !blueprint.plans[leaf.uid]).length : 0;
  const writing = Boolean(running && job && (job.kind === 'write' || job.kind === 'revise'));
  const staleNote = review && freshness.stale ? '上次检查之后正文或目录改过，这个结论可能不准，建议重新检查。' : '';
  const placeholderCount = review ? review.stats.placeholder_count : 0;
  const placeholderChapters = countDistinct(review ? review.placeholders.map((item) => item.chapter_uid) : []);
  const importantTitles = open.filter((issue) => issue.severity === 'high').slice(0, 3);

  // ---------- 检查清单 ----------

  let chapterState: CheckState = 'ok';
  let chapterTitle = `${readiness.total} 章都写完了`;
  if (writing && job && job.kind === 'write') {
    chapterState = 'warn';
    chapterTitle = '正文正在撰写，还没写完';
  } else if (missing.length > 0) {
    chapterState = 'block';
    chapterTitle =
      missing.length === readiness.total ? `${readiness.total} 章都还没有正文` : `还有 ${missing.length} 章没有正文`;
  } else if (unfinished.length > 0) {
    chapterState = 'warn';
    chapterTitle = `有 ${unfinished.length} 章没写完`;
  }
  // 与审校页“已完成章节”同一口径：结尾可能不完整的章节算写完，作为需要注意的一项另外列出
  const truncatedState: CheckState | null = truncated.length > 0 ? 'warn' : null;

  let issueState: CheckState = 'ok';
  let issueTitle = '没有未处理的重要问题';
  if (!review) {
    issueState = 'unknown';
    issueTitle = '还没有检查过';
  } else if (severity.high > 0) {
    issueState = 'warn';
    issueTitle = `还有 ${severity.high} 个重要问题没处理`;
  } else if (staleNote) {
    issueState = 'warn';
  }

  let placeholderState: CheckState = 'ok';
  let placeholderTitle = '正文里没有【待补充】占位';
  if (!review) {
    placeholderState = 'unknown';
    placeholderTitle = '还不知道有没有【待补充】占位';
  } else if (placeholderCount > 0) {
    placeholderState = 'warn';
    placeholderTitle = `还有 ${placeholderCount} 处【待补充】没换成真实内容`;
  } else if (staleNote) {
    placeholderState = 'warn';
  }

  let planState: CheckState = 'ok';
  let planTitle = '写作计划和目录一致';
  if (!blueprint) {
    planState = 'neutral';
    planTitle = '没有制定写作计划';
  } else if (data.blueprint_stale) {
    planState = 'warn';
    planTitle = missingPlans > 0 ? `有 ${missingPlans} 章还没有写作计划` : '有章节还没有写作计划';
  } else if (unassigned.length > 0) {
    planState = 'warn';
    planTitle = `有 ${unassigned.length} 条评分项或采购人要求没有章节负责`;
  }
  const unassignedNames = unassigned.slice(0, 3).map((rid) => {
    const item = requirements.find((entry) => entry.id === rid);
    return item && item.name ? `${rid} ${item.name}` : rid;
  });

  const states: CheckState[] = [chapterState, issueState, placeholderState, planState];
  if (truncatedState) states.push(truncatedState);
  const attention = states.filter((state) => state === 'warn' || state === 'block' || state === 'unknown').length;
  const blocked = missing.length > 0 && !allowIncomplete;

  let disabledReason = '';
  if (writing) disabledReason = job && job.kind === 'revise' ? '正在修订章节，等它结束后再导出。' : '正在撰写正文，等它结束后再导出。';
  else if (blocked) disabledReason = `有 ${missing.length} 章没有正文。先去补全，或者勾选上面的“仍然导出”。`;

  const effectiveModel = data.project.settings.model_name || (shell.settings ? shell.settings.model_name : '');
  const modelNeedsSetup = shell.settings !== null && !shell.modelReady;

  // ---------- 操作 ----------

  const doExport = async () => {
    // 设置读到了、确实没配好才拦；没读到时交给后端判断
    if (withDiagrams && modelNeedsSetup) {
      toast.info('自动插图要调用模型，请先配置模型服务（API Key、接口地址、模型）。');
      shell.openSettings();
      return;
    }
    const options: ExportOptions = {
      include_toc: includeToc,
      include_overview: includeOverview,
      with_diagrams: withDiagrams,
      diagram_model: withDiagrams && diagramModel.trim() ? diagramModel.trim() : null,
      allow_incomplete: missing.length > 0 && allowIncomplete,
    };
    setExporting(true);
    setFailure('');
    setOutcome(null);
    try {
      const result = await api.exportWord(projectId, options);
      // 即使已经离开这个页面，文件也照常保存
      saveBlob(result.blob, result.filename);
      toast.success(`已导出「${result.filename}」，在浏览器的下载位置里。`);
      if (mounted.current) {
        setOutcome({
          filename: result.filename,
          blob: result.blob,
          diagramCount: result.diagramCount,
          diagramError: result.diagramError,
          missingChapters: result.missingChapters,
          withDiagrams,
          includeToc,
        });
      }
    } catch (error) {
      const message = errorMessage(error, '导出失败，请重试');
      if (mounted.current) setFailure(message);
      else toast.error(message, { title: '导出 Word 失败' });
    } finally {
      if (mounted.current) setExporting(false);
    }
  };

  const doArchive = async () => {
    setArchiving(true);
    try {
      await api.downloadArchive(projectId);
      toast.success('项目备份已导出，在浏览器的下载位置里。');
    } catch (error) {
      toast.error(errorMessage(error, '备份没有导出成功，请重试'), { title: '导出项目备份' });
    } finally {
      if (mounted.current) setArchiving(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6">
        <header>
          <h1 className="text-lg font-semibold leading-7 text-ink-900">导出</h1>
          <p className="mt-0.5 text-[13px] text-ink-500">把全部章节按目录顺序合成一份 Word 文档。导出前先看一眼下面的检查。</p>
        </header>

        <div className="mt-4 grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="space-y-4">
            <Card
              padded={false}
              title="导出前检查"
              actions={
                attention === 0 ? (
                  <Badge tone="success" dot>
                    都没问题
                  </Badge>
                ) : (
                  <Badge tone={chapterState === 'block' ? 'danger' : 'warning'} dot>
                    {attention} 项需要注意
                  </Badge>
                )
              }
            >
              <ul className="divide-y divide-line">
                <CheckRow
                  state={chapterState}
                  title={chapterTitle}
                  action={
                    firstTodo ? (
                      <Button size="sm" onClick={() => goChapter(projectId, firstTodo.uid)}>
                        去撰写
                      </Button>
                    ) : undefined
                  }
                >
                  {missing.length > 0 || unfinished.length > 0 ? (
                    <>
                      {missing.length > 0 && <p>没有正文的章节在 Word 里只有一个标题。</p>}
                      <ChapterList projectId={projectId} label="没有正文" leaves={missing} />
                      {unfinishedGroups.map((group) => (
                        <ChapterList key={group.kind} projectId={projectId} label={group.label} leaves={group.leaves} />
                      ))}
                    </>
                  ) : chapterState === 'warn' ? (
                    <p>等写作结束后再导出，否则正在写的章节会缺内容。</p>
                  ) : null}
                </CheckRow>

                {truncatedState && (
                  <CheckRow
                    state={truncatedState}
                    title={`${truncated.length} 章结尾可能不完整`}
                    action={
                      <Button size="sm" onClick={() => goChapter(projectId, truncated[0].uid)}>
                        去查看
                      </Button>
                    }
                  >
                    <p>这些章节已经写完，只是模型写到了输出上限，结尾可能缺了一截。到正文页看一眼结尾，必要时补全或重写。</p>
                    <ChapterList projectId={projectId} label="结尾可能不完整" leaves={truncated} />
                  </CheckRow>
                )}

                <CheckRow
                  state={issueState}
                  title={issueTitle}
                  action={
                    !review ? (
                      <Button size="sm" onClick={() => goStage(projectId, 'review')}>
                        去检查
                      </Button>
                    ) : severity.high > 0 ? (
                      <Button size="sm" onClick={() => goStage(projectId, 'review')}>
                        去处理
                      </Button>
                    ) : staleNote ? (
                      <Button size="sm" onClick={() => goStage(projectId, 'review')}>
                        去重新检查
                      </Button>
                    ) : undefined
                  }
                >
                  {!review ? (
                    <p>不知道有没有漏掉评分项、跨章重复或前后矛盾。先到“审校”里检查一遍，几秒就好。</p>
                  ) : (
                    <>
                      {importantTitles.length > 0 && (
                        <ul className="space-y-0.5">
                          {importantTitles.map((issue) => (
                            <li key={issue.id} className="truncate">
                              · {plainText(issue.title)}
                            </li>
                          ))}
                          {severity.high > importantTitles.length && <li>· 另有 {severity.high - importantTitles.length} 个</li>}
                        </ul>
                      )}
                      {severity.medium + severity.low > 0 && (
                        <p className={importantTitles.length > 0 ? 'mt-1' : undefined}>
                          另有
                          {[
                            severity.medium > 0 ? `一般问题 ${severity.medium} 个` : '',
                            severity.low > 0 ? `提示 ${severity.low} 个` : '',
                          ]
                            .filter(Boolean)
                            .join('、')}
                          ，可以酌情处理。
                        </p>
                      )}
                      {staleNote && <p className="mt-1 text-amber-700">{staleNote}</p>}
                    </>
                  )}
                </CheckRow>

                <CheckRow
                  state={placeholderState}
                  title={placeholderTitle}
                  action={
                    !review ? undefined : placeholderCount > 0 ? (
                      <Button size="sm" onClick={() => navigate(`/projects/${projectId}/review?tab=placeholders`)}>
                        去查看
                      </Button>
                    ) : undefined
                  }
                >
                  {!review ? (
                    <p>检查之后才知道正文里留了多少处没填的企业信息。</p>
                  ) : placeholderCount > 0 ? (
                    <p>
                      分布在 {placeholderChapters} 章里。这些是业绩、资质、人员等模型拿不到的企业信息，不换掉的话会原样出现在 Word 里。
                    </p>
                  ) : null}
                </CheckRow>

                <CheckRow
                  state={planState}
                  title={planTitle}
                  action={
                    blueprint && data.blueprint_stale ? (
                      <Button size="sm" onClick={() => goStage(projectId, 'plan')}>
                        去补全
                      </Button>
                    ) : blueprint && unassigned.length > 0 ? (
                      <Button size="sm" onClick={() => navigate(`/projects/${projectId}/plan?tab=chapters`)}>
                        去指定
                      </Button>
                    ) : undefined
                  }
                >
                  {!blueprint ? (
                    <p>不影响导出。只是各章没有共用的统一口径，更要留意前后说法是否一致。</p>
                  ) : data.blueprint_stale ? (
                    <p>
                      制定计划之后目录加了章节，这些章节没有计划，写出来的内容可能和全书的口径对不上。到写作计划页点“补全计划”。
                      {unassigned.length > 0 ? `另外还有 ${unassigned.length} 条评分项或采购人要求没有章节负责，补全之后到“章节计划”里核对。` : ''}
                    </p>
                  ) : unassigned.length > 0 ? (
                    <>
                      <p>
                        可能漏项：写正文时没有哪一章去响应它们（例如负责的章节被删掉了）。到写作计划的“章节计划”里给它们指定章节，再重写相关章节。
                      </p>
                      <p className="mt-1 truncate" title={unassigned.join('、')}>
                        {unassignedNames.join('、')}
                        {unassigned.length > unassignedNames.length ? ` 等 ${unassigned.length} 条` : ''}
                      </p>
                    </>
                  ) : null}
                </CheckRow>
              </ul>
            </Card>

            <Card padded={false} title="导出选项">
              <div className="divide-y divide-line">
                <OptionRow
                  checked={includeToc}
                  onChange={setIncludeToc}
                  disabled={exporting}
                  title="插入目录"
                  hint="目录放在正文前面。打开 Word 后，在目录上点右键 →“更新域”，页码就出来了。"
                />
                <OptionRow
                  checked={includeOverview}
                  onChange={setIncludeOverview}
                  disabled={exporting}
                  title="在文前附上项目概述"
                  hint="概述是对招标文件的摘要，方便内部传阅；一般不放进正式的投标文件。"
                />
                <OptionRow
                  checked={withDiagrams}
                  onChange={setWithDiagrams}
                  disabled={exporting}
                  title="自动插入技术插图"
                  hint="导出时由模型为合适的章节生成架构图、流程图。会调用模型，耗时较长；需要本机装有 Chrome，时序图和组织架构图还需要 mermaid-cli 和 Java。"
                >
                  {withDiagrams && (
                    <div className="mt-3 pl-6">
                      <Field
                        label="插图所用的模型"
                        hint={
                          effectiveModel
                            ? `留空就用撰写正文的模型（${effectiveModel}）。画图对模型要求更高，可以单独指定一个更强的。`
                            : '留空就用撰写正文的模型。画图对模型要求更高，可以单独指定一个更强的。'
                        }
                      >
                        <Input
                          value={diagramModel}
                          disabled={exporting}
                          placeholder="留空：和撰写正文用同一个模型"
                          onChange={(event) => setDiagramModel(event.target.value)}
                          className="max-w-sm"
                        />
                      </Field>
                      {modelNeedsSetup && (
                        <p className="mt-2 text-xs leading-5 text-amber-700">
                          模型服务还没有配置，插图生成不了。
                          <button type="button" className="ml-1 text-primary-600 hover:underline" onClick={shell.openSettings}>
                            去配置
                          </button>
                        </p>
                      )}
                    </div>
                  )}
                </OptionRow>
              </div>
            </Card>
          </div>

          <aside className="space-y-4 lg:sticky lg:top-6">
            <Card>
              <div className="flex gap-2.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5">
                <ShieldCheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
                <div className="min-w-0 text-xs leading-5 text-amber-900">
                  <p className="font-semibold">用于投标前，请人工逐条审阅</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 marker:text-amber-500">
                    <li>生成的内容要对照招标文件逐条核对，确认无误再用。</li>
                    <li>【待补充】必须换成真实信息。</li>
                    <li>不要让模型替你编造业绩、资质和人员。</li>
                  </ul>
                </div>
              </div>

              {missing.length > 0 && (
                <Checkbox
                  className="mt-3 flex"
                  checked={allowIncomplete}
                  disabled={exporting}
                  onChange={(event) => setAllowIncomplete(event.target.checked)}
                  label={
                    <>
                      <span className="block font-medium text-ink-900">仍然导出</span>
                      <span className="mt-0.5 block text-xs leading-5 text-ink-500">
                        有 {missing.length} 章没有正文，它们在 Word 里只有标题。
                      </span>
                    </>
                  }
                />
              )}

              <Button
                className="mt-3"
                block
                size="lg"
                variant="primary"
                loading={exporting}
                disabled={writing || blocked}
                icon={<DocumentArrowDownIcon />}
                onClick={() => void doExport()}
              >
                {exporting ? (withDiagrams ? '正在生成插图并导出…' : '正在导出…') : '导出 Word'}
              </Button>

              {disabledReason && !exporting && <p className="mt-2 text-xs leading-5 text-amber-700">{disabledReason}</p>}

              {!readiness.anyText && !exporting && (
                <Button className="mt-2" block onClick={() => goStage(projectId, 'write')}>
                  去撰写正文
                </Button>
              )}

              {exporting && (
                <div className="mt-3" role="status">
                  <ProgressBar value={null} size="sm" />
                  <p className="mt-2 text-xs leading-5 text-ink-500">
                    {withDiagrams
                      ? '正在逐章生成插图，章节多时要几分钟，请不要关闭页面。'
                      : '正在生成文档，一般几秒就好。'}
                    {elapsed >= 3000 && <span className="ml-1 tabular-nums">已用 {formatDuration(elapsed)}</span>}
                  </p>
                </div>
              )}

              {failure && !exporting && (
                <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs leading-5 text-rose-700" role="alert">
                  <p className="font-semibold">没有导出成功</p>
                  <p className="mt-0.5 break-words">{failure}</p>
                </div>
              )}

              {outcome && !exporting && (
                <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs leading-5" role="status">
                  <p className="flex items-start gap-1.5 font-semibold text-emerald-800">
                    <CheckSolid className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />
                    已导出
                  </p>
                  <p className="mt-1 break-all text-ink-900">
                    {outcome.filename}
                    {formatSize(outcome.blob.size) && <span className="ml-1.5 whitespace-nowrap text-ink-500">{formatSize(outcome.blob.size)}</span>}
                  </p>
                  <ul className="mt-1.5 space-y-1 text-ink-600">
                    {outcome.withDiagrams && outcome.diagramError && (
                      <li className="text-amber-800">插图没有生成，导出的是不带插图的版本。原因：{outcome.diagramError}</li>
                    )}
                    {outcome.withDiagrams && !outcome.diagramError && outcome.diagramCount > 0 && (
                      <li>插入了 {outcome.diagramCount} 张插图，请逐张核对图里的内容是否准确。</li>
                    )}
                    {outcome.withDiagrams && !outcome.diagramError && outcome.diagramCount === 0 && (
                      <li className="text-amber-800">没有插入插图：模型没有找到适合配图的章节，或者图没有画成功。</li>
                    )}
                    {outcome.missingChapters > 0 && (
                      <li className="text-amber-800">有 {outcome.missingChapters} 章是空的，Word 里只有标题，记得补上。</li>
                    )}
                    {outcome.includeToc && <li>打开后在目录上点右键 →“更新域”，生成页码。</li>}
                  </ul>
                  <button
                    type="button"
                    className="mt-2 inline-flex items-center gap-1 text-primary-600 hover:underline"
                    onClick={() => saveBlob(outcome.blob, outcome.filename)}
                  >
                    <ArrowDownTrayIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    没有开始下载？再下载一次
                  </button>
                </div>
              )}
            </Card>

            <Card title="项目备份">
              <p className="text-xs leading-5 text-ink-500">
                把整个项目存成一个文件：招标文件原文、目录、写作计划、全部正文和历史版本都在里面。可以留作底稿，也可以拿到另一台电脑上导入继续写。
              </p>
              <Button className="mt-3" block loading={archiving} icon={<ArchiveBoxArrowDownIcon />} onClick={() => void doArchive()}>
                导出项目备份
              </Button>
            </Card>
          </aside>
        </div>
      </div>
    </div>
  );
}

/** 去重后有多少个 */
function countDistinct(values: string[]): number {
  const seen: Record<string, true> = {};
  let count = 0;
  values.forEach((value) => {
    if (!seen[value]) {
      seen[value] = true;
      count += 1;
    }
  });
  return count;
}
