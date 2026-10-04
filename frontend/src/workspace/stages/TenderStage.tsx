/**
 * 招标解读阶段：上传招标文件 → 解析出项目概述与技术评分要求并核对 → 补充企业资料与参考资料。
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ArrowRightIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  PlayIcon,
  StopIcon,
} from '@heroicons/react/24/outline';
import { CheckCircleIcon } from '@heroicons/react/20/solid';
import type { JobKind, ProjectState } from '../../api/types';
import { useAppShell } from '../../app/AppShell';
import { useUnsavedChangesGuard } from '../../lib/router';
import { Button, cx, useConfirm, useToast } from '../../ui';
import { goStage } from '../ProjectWorkspace';
import { useWorkspace } from '../WorkspaceContext';
import { AnalysisPanel } from '../tender/AnalysisPanel';
import { CompanyProfileCard } from '../tender/CompanyProfileCard';
import { MaterialsCard } from '../tender/MaterialsCard';
import { RequirementList } from '../tender/RequirementList';
import { TenderFileCard } from '../tender/TenderFileCard';
import { useStaleMark } from '../tender/staleMark';
import { ANALYSIS_KINDS, ANALYSIS_LABEL, shownText, useTenderAnalysis } from '../tender/useTenderAnalysis';
import type { AnalysisKind } from '../tender/useTenderAnalysis';

const JOB_LABEL: Record<JobKind, string> = {
  plan: '制定写作计划',
  write: '撰写正文',
  revise: '修订章节',
  review: '深度审校',
};

/** 撰写正文时带入项目概述的字数上限（与后端 writing/prompts.py 的截取长度一致） */
const OVERVIEW_LIMIT = 3000;

/** 可能有没保存修改的几处，按页面上的顺序 */
const DIRTY_ORDER = ['overview', 'requirements', 'company'];
const DIRTY_LABEL: Record<string, string> = {
  overview: '项目概述',
  requirements: '技术评分要求',
  company: '企业资料',
};

const OVERVIEW_PURPOSE =
  '项目的名称、背景、建设内容、工期和主要技术要求。生成目录、制定写作计划、撰写每一章时，模型都把它当作项目背景——这里写错了，全书都会跟着错。';
const REQUIREMENTS_PURPOSE =
  '评审办法里的评分项和采购人的技术要求，整理成带编号的条目（评审项 E1、E2……，采购人要求 R1、R2……）。目录按它来排，写作计划把每一条分配到具体章节，审校时再逐条核对有没有响应到——漏掉一条，后面就没人替你发现。';

function joinLabels(kinds: AnalysisKind[]): string {
  return kinds.map((kind) => ANALYSIS_LABEL[kind]).join('和');
}

function isFileDrag(event: React.DragEvent): boolean {
  const types = event.dataTransfer ? event.dataTransfer.types : null;
  return Boolean(types) && Array.prototype.indexOf.call(types, 'Files') >= 0;
}

function SectionHeading({ title, hint, action }: { title: string; hint?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1 basis-80">
        <h2 className="text-[15px] font-semibold leading-6 text-ink-900">{title}</h2>
        {hint ? <p className="mt-0.5 text-[13px] leading-5 text-ink-500">{hint}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

function CheckItem({ done, label, note, tone = 'todo' }: { done: boolean; label: string; note?: string; tone?: 'todo' | 'optional' }) {
  return (
    <li className="flex items-center gap-1.5 whitespace-nowrap">
      {done ? (
        <CheckCircleIcon className="h-4 w-4 text-emerald-500" aria-hidden="true" />
      ) : (
        <span
          className={cx('mx-0.5 h-3 w-3 rounded-full border-[1.5px]', tone === 'optional' ? 'border-ink-300' : 'border-amber-500')}
          aria-hidden="true"
        />
      )}
      <span className={done ? 'text-ink-700' : tone === 'optional' ? 'text-ink-500' : 'text-ink-900'}>{label}</span>
      {note ? <span className="text-xs text-ink-400">{note}</span> : null}
    </li>
  );
}

export default function TenderStage() {
  const ws = useWorkspace();
  const shell = useAppShell();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, running, job } = ws;
  const project = data.project;
  const tender = project.tender;
  const hasTender = Boolean(tender.filename);

  const { stale, markStale, clearStale } = useStaleMark(ws.projectId, tender.uploaded_at);

  const analysis = useTenderAnalysis({
    onDone: clearStale,
    // 项目被占着（有任务在跑、别处正在解析或生成目录）时解析根本没有开始：说清楚是这个原因，不笼统地说“解析失败”
    onError: (kind, message, blocked) =>
      blocked
        ? toast.info(message, { title: `${ANALYSIS_LABEL[kind]}没有开始解析` })
        : toast.error(message, { title: `${ANALYSIS_LABEL[kind]}没有解析成功` }),
    onAllDone: (kinds) => toast.success(`${joinLabels(kinds)}解析好了，请对照招标文件核对一遍。`),
  });
  const { items, active } = analysis;

  const text: Record<AnalysisKind, string> = {
    overview: shownText(items.overview, project.overview, project.updated_at),
    requirements: shownText(items.requirements, project.requirements, project.updated_at),
  };
  const hasOverview = text.overview.trim() !== '';
  const hasRequirements = text.requirements.trim() !== '';
  const missing = useMemo(() => {
    const list: AnalysisKind[] = [];
    if (!hasOverview) list.push('overview');
    if (!hasRequirements) list.push('requirements');
    return list;
  }, [hasOverview, hasRequirements]);

  // 正在上传、读取新的招标文件：这期间解析读到的还是旧文件，所以不能解析
  const [uploading, setUploading] = useState(false);
  const jobLock = running ? `正在${job ? JOB_LABEL[job.kind] : '执行后台任务'}，任务结束或停止后才能操作` : '';
  const analyzeBlocked =
    jobLock ||
    (uploading ? '正在上传新的招标文件，读取完成后才能解析' : '') ||
    (active ? '正在解析，请等它结束或先中止' : '');

  // ---- 未保存的修改 ----
  const dirtyRef = useRef<Record<string, boolean>>({});
  // 哪几处有没保存的修改（按页面上的顺序）：company 企业资料 / overview 项目概述 / requirements 技术评分要求
  const [dirtyKeys, setDirtyKeys] = useState<string[]>([]);
  const reportDirty = useCallback((key: string, dirty: boolean) => {
    dirtyRef.current[key] = dirty;
    const next = DIRTY_ORDER.filter((name) => dirtyRef.current[name]);
    setDirtyKeys((prev) => (prev.join('|') === next.join('|') ? prev : next));
  }, []);
  const anyDirty = dirtyKeys.length > 0;
  const dirtyNames = dirtyKeys.map((key) => DIRTY_LABEL[key] || key).join('、');

  // 有未保存的修改、或者解析还在进行时，离开这一页（站内跳转、前进后退、刷新、关闭）之前先确认；
  // 两种情况同时存在时一并说清楚
  let leaveMessage = `招标解读里有修改还没有保存（${dirtyNames}），离开这一页后这些修改会丢失。确定要离开吗？`;
  if (active && anyDirty) {
    leaveMessage = `解析还在进行，${dirtyNames}也有修改没保存。离开这一页会中止解析（没有生成完的内容不会保存），也会丢掉这些修改。确定要离开吗？`;
  } else if (active) {
    leaveMessage = '解析还在进行，离开这一页会中止解析，没有生成完的内容不会保存。确定要离开吗？';
  }
  useUnsavedChangesGuard(anyDirty || active, leaveMessage);

  // ---- 启动解析 ----
  const latest = useRef({ hasTender, analyzeBlocked, hasOverview, hasRequirements, shell });
  latest.current = { hasTender, analyzeBlocked, hasOverview, hasRequirements, shell };
  const startAnalysis = analysis.start;

  const requestAnalyze = useCallback(
    async (kinds: AnalysisKind[], skipOverwriteConfirm = false) => {
      const now = latest.current;
      if (!now.hasTender) {
        toast.info('请先上传招标文件。');
        return;
      }
      if (now.analyzeBlocked) {
        toast.info(now.analyzeBlocked);
        return;
      }
      // 设置读到了、确实没配好才拦；没读到时交给后端判断
      if (now.shell.settings !== null && !now.shell.modelReady) {
        toast.info('解析要调用大模型，请先配置模型服务（API Key、接口地址、模型）。');
        now.shell.openSettings();
        return;
      }
      const has: Record<AnalysisKind, boolean> = { overview: now.hasOverview, requirements: now.hasRequirements };
      const unsaved = kinds.filter((kind) => dirtyRef.current[kind]);
      const overwritten = kinds.filter((kind) => has[kind]);
      if (unsaved.length > 0 || (overwritten.length > 0 && !skipOverwriteConfirm)) {
        const ok = await confirm({
          title: `重新解析${joinLabels(kinds)}？`,
          description:
            unsaved.length > 0
              ? `${joinLabels(unsaved)}有修改还没有保存，重新解析会把它丢掉，并用新的结果覆盖现在的内容。`
              : `新的解析结果会覆盖现在的${joinLabels(overwritten)}，包括手动改过的地方。`,
          confirmText: '重新解析',
          tone: unsaved.length > 0 ? 'danger' : 'primary',
        });
        if (!ok) return;
        // 确认框开着的这段时间里，情况可能变了
        if (latest.current.analyzeBlocked) {
          toast.info(latest.current.analyzeBlocked);
          return;
        }
      }
      startAnalysis(kinds);
    },
    [confirm, toast, startAnalysis]
  );

  const analyzeOne = useCallback((kind: AnalysisKind) => void requestAnalyze([kind]), [requestAnalyze]);
  const reanalyzeRequirements = useCallback(() => void requestAnalyze(['requirements']), [requestAnalyze]);

  const [editRequirementsRequest, setEditRequirementsRequest] = useState(0);
  const editRequirements = useCallback(() => setEditRequirementsRequest((value) => value + 1), []);

  // ---- 招标文件上传之后 ----
  const onUploaded = useCallback(
    (state: ProjectState, replaced: boolean) => {
      const parsed = ANALYSIS_KINDS.filter((kind) => state.project[kind].trim() !== '');
      if (replaced && parsed.length > 0) markStale(state.project.tender.uploaded_at, parsed);
      else clearStale();
    },
    [markStale, clearStale]
  );

  const staleKinds = useMemo(
    () => stale.filter((kind) => (kind === 'overview' ? hasOverview : hasRequirements)),
    [stale, hasOverview, hasRequirements]
  );

  // ---- 解析区的说明与主操作 ----
  const runningKind = ANALYSIS_KINDS.filter((kind) => items[kind].phase === 'running' || items[kind].phase === 'syncing')[0];
  const queuedKinds = ANALYSIS_KINDS.filter((kind) => items[kind].phase === 'queued');
  let analysisHint: string;
  if (active) {
    analysisHint = runningKind
      ? `正在解析${ANALYSIS_LABEL[runningKind]}${queuedKinds.length > 0 ? `，接下来是${joinLabels(queuedKinds)}` : ''}。可以随时中止，没有生成完的内容不会保存。`
      : '正在准备解析。';
  } else if (uploading) {
    analysisHint = '正在上传并读取新的招标文件，读取完成后再解析。';
  } else if (!hasTender) {
    analysisHint = '上传招标文件之后才能解析。';
  } else if (missing.length === 2) {
    analysisHint = '先解析项目概述，再解析技术评分要求，一般需要一两分钟；篇幅很长的招标文件会分段处理，时间更久一些。';
  } else if (missing.length === 1) {
    analysisHint = `还差${ANALYSIS_LABEL[missing[0]]}。`;
  } else {
    analysisHint = '请对照招标文件核对一遍，有出入可以直接改。后面的目录、写作计划和正文都以这里的内容为准。';
  }

  let analysisAction: React.ReactNode;
  if (active) {
    analysisAction = (
      <Button icon={<StopIcon />} onClick={analysis.stop}>
        中止解析
      </Button>
    );
  } else if (missing.length > 0) {
    analysisAction = (
      <Button
        variant="primary"
        icon={<PlayIcon />}
        disabled={!hasTender || Boolean(analyzeBlocked)}
        title={analyzeBlocked || (!hasTender ? '先上传招标文件' : undefined)}
        onClick={() => void requestAnalyze(missing)}
      >
        {missing.length === 2 ? '开始解析' : `解析${ANALYSIS_LABEL[missing[0]]}`}
      </Button>
    );
  } else {
    analysisAction = (
      <Button
        disabled={!hasTender || Boolean(analyzeBlocked)}
        title={analyzeBlocked || (!hasTender ? '先上传招标文件' : undefined)}
        onClick={() => void requestAnalyze(ANALYSIS_KINDS)}
      >
        全部重新解析
      </Button>
    );
  }

  const requirementsSettling = items.requirements.phase === 'running' || items.requirements.phase === 'syncing';
  const requirementFooter = useMemo(
    () => (
      <RequirementList
        items={data.requirements}
        hasText={hasRequirements}
        settling={requirementsSettling}
        reanalyzeBlocked={analyzeBlocked || (hasTender ? '' : '先上传招标文件')}
        onReanalyze={reanalyzeRequirements}
        onEdit={editRequirements}
      />
    ),
    [data.requirements, hasRequirements, requirementsSettling, analyzeBlocked, hasTender, reanalyzeRequirements, editRequirements]
  );

  // ---- 下一步 ----
  const savedReady = project.overview.trim() !== '' && project.requirements.trim() !== '';
  const hasOutline = data.leaves.length > 0;
  const hasProfile = project.company_profile.trim() !== '';
  let nextHint: string;
  if (active) nextHint = '解析结束后再进入下一步；现在离开这一页会中止解析。';
  else if (!hasTender && missing.length > 0) nextHint = '先上传招标文件并完成解析。';
  else if (missing.length > 0) nextHint = `还差${joinLabels(missing)}。`;
  else if (data.requirements.length === 0) nextHint = '评分要求里没有识别出条目，建议先处理，否则后面无法核对评分点覆盖。';
  else if (!hasProfile) nextHint = '企业资料还没有填：正文里涉及资质、业绩、人员的地方都会留成【待补充】，可以之后再补。';
  else nextHint = '解读完成，可以生成目录了。';

  // 文件拖到上传区以外的地方时，别让浏览器把它直接打开、离开当前页面
  const swallowFileDrag = (event: React.DragEvent) => {
    if (event.defaultPrevented || !isFileDrag(event)) return;
    event.preventDefault();
    if (event.type === 'dragover') event.dataTransfer.dropEffect = 'none';
  };

  return (
    <div className="h-full overflow-y-auto" onDragOver={swallowFileDrag} onDrop={swallowFileDrag}>
      <div className="mx-auto max-w-5xl space-y-8 px-6 py-6">
        {running && (
          <div className="flex items-start gap-2 rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-[13px] leading-6 text-primary-900">
            <InformationCircleIcon className="mt-1 h-4 w-4 shrink-0 text-primary-600" />
            <p>
              正在{job ? JOB_LABEL[job.kind] : '执行后台任务'}。任务结束或停止之前，不能更换招标文件，也不能重新解析——不然写到一半的内容会和新的解析结果对不上。
              解析结果、企业资料和参考资料仍然可以修改，改动要到下一次撰写时才会用上。
            </p>
          </div>
        )}

        <section aria-label="招标文件">
          <SectionHeading
            title="招标文件"
            hint={
              hasTender
                ? '解析和撰写都以这份文件里提取出的文字为准。'
                : '从这里开始：上传招标文件，再解析出项目概述和技术评分要求。'
            }
          />
          <TenderFileCard
            lockReason={jobLock || (active ? '正在解析，请等它结束或先中止，再更换文件' : '')}
            hasAnalysis={hasOverview || hasRequirements}
            onUploaded={onUploaded}
            onUploadingChange={setUploading}
          />
        </section>

        <section aria-label="解析结果">
          <SectionHeading title="解析结果" hint={analysisHint} action={analysisAction} />

          <div className="space-y-4">
            {shell.settings !== null && !shell.modelReady && hasTender && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] leading-6 text-amber-900">
                <ExclamationTriangleIcon className="h-4 w-4 shrink-0 text-amber-600" />
                <p className="min-w-0 flex-1 basis-64">解析要调用大模型，但模型服务还没有配置好（API Key、接口地址、模型）。</p>
                <Button size="sm" onClick={shell.openSettings}>
                  去配置
                </Button>
              </div>
            )}

            {staleKinds.length > 0 && !active && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] leading-6 text-amber-900">
                <ExclamationTriangleIcon className="h-4 w-4 shrink-0 text-amber-600" />
                <p className="min-w-0 flex-1 basis-64">
                  招标文件已经更换，但{joinLabels(staleKinds)}还是按旧文件解析的。不重新解析的话，后面的目录和正文会照着旧文件来写。
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    disabled={Boolean(analyzeBlocked)}
                    title={analyzeBlocked || undefined}
                    onClick={() => void requestAnalyze(staleKinds, true)}
                  >
                    重新解析
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => clearStale()}>
                    不再提醒
                  </Button>
                </div>
              </div>
            )}

            <AnalysisPanel
              kind="overview"
              summary="项目是什么、要做什么。目录、写作计划和每一章正文都拿它当背景。"
              purpose={OVERVIEW_PURPOSE}
              editHint="可以直接改，支持 Markdown（**加粗**、- 列表）。原文没有提到的信息不要自己补，写“招标文件未提及”更稳妥。"
              content={text.overview}
              item={items.overview}
              hasTender={hasTender}
              blocked={analyzeBlocked}
              stale={staleKinds.indexOf('overview') >= 0}
              softLimit={OVERVIEW_LIMIT}
              onAnalyze={analyzeOne}
              onDirtyChange={reportDirty}
              onDismissWarnings={analysis.dismissWarnings}
            />

            <AnalysisPanel
              kind="requirements"
              summary="评分项和采购人要求。目录按它排，计划按它分工，审校按它逐条核对。"
              purpose={REQUIREMENTS_PURPOSE}
              editHint="每一条保持“【评审项ID】：E1”“【要求ID】：R1”这样的开头，系统才认得出条目；保存后下面的识别结果会跟着更新。"
              content={text.requirements}
              item={items.requirements}
              hasTender={hasTender}
              blocked={analyzeBlocked}
              stale={staleKinds.indexOf('requirements') >= 0}
              onAnalyze={analyzeOne}
              onDirtyChange={reportDirty}
              editRequest={editRequirementsRequest}
              footer={requirementFooter}
              onDismissWarnings={analysis.dismissWarnings}
            />
          </div>
        </section>

        <section aria-label="企业资料与参考资料">
          <SectionHeading
            title="企业资料与参考资料"
            hint="让正文写的是你们公司的真实情况。可以先跳过，开始撰写之前随时回来补。"
          />
          <div className="grid gap-4 lg:grid-cols-5">
            <div className="lg:col-span-3">
              <CompanyProfileCard onDirtyChange={reportDirty} />
            </div>
            <div className="lg:col-span-2">
              <MaterialsCard />
            </div>
          </div>
        </section>

        <footer className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-line bg-white px-4 py-3 shadow-card">
          <div className="min-w-0 flex-1 basis-96">
            <ul className="flex flex-wrap gap-x-5 gap-y-1 text-[13px] leading-6">
              <CheckItem done={hasTender} label="招标文件" />
              <CheckItem done={hasOverview} label="项目概述" />
              <CheckItem
                done={hasRequirements}
                label="技术评分要求"
                note={hasRequirements && !requirementsSettling ? `识别出 ${data.requirements.length} 条` : undefined}
              />
              <CheckItem done={hasProfile} label="企业资料" tone="optional" note={hasProfile ? undefined : '建议填写'} />
              <CheckItem
                done={data.materials.length > 0}
                label="参考资料"
                tone="optional"
                note={data.materials.length > 0 ? `${data.materials.length} 份` : '可选'}
              />
            </ul>
            <p className="mt-1 text-xs leading-5 text-ink-500">{nextHint}</p>
          </div>
          <Button
            variant="primary"
            size="lg"
            disabled={!savedReady || active}
            iconRight={<ArrowRightIcon />}
            onClick={() => goStage(ws.projectId, 'outline')}
          >
            {hasOutline ? '下一步：查看目录' : '下一步：生成目录'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
