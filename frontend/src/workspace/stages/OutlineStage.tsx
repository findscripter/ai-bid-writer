/**
 * 目录阶段：生成三级目录，并让使用者逐章调整。
 *
 * 从上到下：生成区（还没有解析结果时换成去“招标解读”的引导）→ 目录树编辑区 → 下一步。
 * 具体实现在 ../outline 下：GeneratePanel（生成与过程记录）、OutlineEditor（目录树编辑）。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { ArrowRightIcon, DocumentMagnifyingGlassIcon } from '@heroicons/react/24/outline';
import type { JobKind, Project } from '../../api/types';
import { navigate, useUnsavedChangesGuard } from '../../lib/router';
import { Button, EmptyState } from '../../ui';
import { GeneratePanel } from '../outline/GeneratePanel';
import { OutlineEditor } from '../outline/OutlineEditor';
import { useOutlineGeneration } from '../outline/useOutlineGeneration';
import { unassignedRequirements } from '../plan/shared';
import { goStage } from '../ProjectWorkspace';
import { useWorkspace } from '../WorkspaceContext';

const JOB_NAME: Record<JobKind, string> = {
  plan: '制定写作计划',
  write: '撰写正文',
  revise: '修订章节',
  review: '深度审校',
};

/** 生成目录要用到项目概述和技术评分要求；缺哪样就说哪样 */
function missingAnalysis(project: Project): { title: string; description: string } | null {
  const hasOverview = project.overview.trim() !== '';
  const hasRequirements = project.requirements.trim() !== '';
  if (hasOverview && hasRequirements) return null;
  if (!project.tender.filename) {
    return {
      title: '还没有解析结果',
      description: '生成目录要用到招标文件的解析结果：项目概述和技术评分要求。先到“招标解读”上传招标文件并完成解析。',
    };
  }
  if (!hasOverview && !hasRequirements) {
    return {
      title: '还没有解析结果',
      description: '招标文件已经上传，但还没有解析。到“招标解读”解析出项目概述和技术评分要求之后，再回来生成目录。',
    };
  }
  return {
    title: '解析结果还不完整',
    description: `还缺${hasOverview ? '技术评分要求' : '项目概述'}。到“招标解读”补上之后，再回来生成目录。`,
  };
}

function NextStep() {
  const ws = useWorkspace();
  // blueprint_stale：有章节还没有写作计划（只调整顺序、删掉章节都不算）
  const { blueprint, blueprint_stale: stale, leaves, requirements } = ws.data;
  const missingCount = blueprint ? leaves.filter((leaf) => !blueprint.plans[leaf.uid]).length : 0;
  // 删掉的章节原来负责的条目，现在没有章节负责了
  const unassignedCount = useMemo(
    () => (blueprint ? unassignedRequirements(leaves, blueprint.plans, requirements).length : 0),
    [blueprint, leaves, requirements]
  );

  let text = '目录定好之后，下一步是制定写作计划：统一全书口径，给每一章定要点与篇幅。';
  let action = '下一步：制定写作计划';
  if (blueprint && stale) {
    text = `目录改过了，有 ${missingCount > 0 ? `${missingCount} 个` : ''}章节还没有写作计划。建议先到写作计划页补全，再撰写正文。`;
    action = '下一步：补全写作计划';
  } else if (blueprint && unassignedCount > 0) {
    text = `每一章都有写作计划，但有 ${unassignedCount} 条评分项或采购人要求现在没有章节负责（可能是负责的章节被删掉了）。建议到写作计划页重新指定。`;
    action = '下一步：到写作计划指定';
  } else if (blueprint) {
    text = '写作计划已经制定。目录如果再有增减，记得回去看一眼计划。';
    action = '下一步：查看写作计划';
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-lg border border-line bg-white px-4 py-3 shadow-card">
      <p className="min-w-0 flex-1 basis-72 text-[13px] leading-5 text-ink-600">{text}</p>
      <Button
        variant="primary"
        iconRight={<ArrowRightIcon />}
        onClick={() => {
          // 有条目没人负责时，直接打开“章节计划”页签去指定
          if (blueprint && !stale && unassignedCount > 0) navigate(`/projects/${ws.projectId}/plan?tab=chapters`);
          else goStage(ws.projectId, 'plan');
        }}
      >
        {action}
      </Button>
    </div>
  );
}

export default function OutlineStage() {
  const ws = useWorkspace();
  const generation = useOutlineGeneration();
  const [saving, setSaving] = useState(false);
  const onSavingChange = useCallback((value: boolean) => setSaving(value), []);
  const [formDirty, setFormDirty] = useState(false);
  const onFormDirty = useCallback((value: boolean) => setFormDirty(value), []);

  // 离开这一页（站内跳转、前进后退、刷新）之前先确认：会中止正在生成的目录，或丢掉表单里没保存的标题与说明；
  // 生成期间填了一半的表单会留着（只是暂时不能保存），两种情况同时存在时一并说清楚
  let leaveMessage = '目录里正在编辑的章节标题或说明还没有保存，离开这一页后会丢失。确定要离开吗？';
  if (generation.running && formDirty) {
    leaveMessage = '正在生成目录，正在编辑的章节标题或说明也还没有保存。离开这一页会中止生成（当前目录保持不变），也会丢掉这些修改。确定要离开吗？';
  } else if (generation.running) {
    leaveMessage = '正在生成目录，离开这一页会中止生成，当前目录保持不变。确定要离开吗？';
  }
  useUnsavedChangesGuard(generation.running || formDirty, leaveMessage);

  const { project } = ws.data;
  const hasOutline = project.outline.length > 0;
  const missing = missingAnalysis(project);

  const jobName = ws.job ? `（${JOB_NAME[ws.job.kind]}）` : '';
  const blockedReason = ws.running ? `有任务正在运行${jobName}，结束后才能${hasOutline ? '重新生成' : '生成'}目录。` : null;
  const lockedReason = ws.running
    ? `有任务正在运行${jobName}，结束后才能改目录。`
    : generation.running
      ? '正在生成新目录，完成后会替换当前目录，这期间不能改目录。'
      : null;

  const toTender = () => goStage(ws.projectId, 'tender');

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 px-6 py-6">
        <header>
          <h1 className="text-lg font-semibold leading-7 text-ink-900">目录</h1>
          <p className="mt-1 text-[13px] leading-5 text-ink-500">
            先生成三级目录，再逐章调整。最末一级的每个章节之后会单独写一篇正文，上级标题只起分组作用。
          </p>
        </header>

        {missing === null ? (
          <GeneratePanel generation={generation} blockedReason={blockedReason} saving={saving} formDirty={formDirty} />
        ) : hasOutline ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-white px-4 py-3 shadow-card">
            <DocumentMagnifyingGlassIcon className="h-5 w-5 shrink-0 text-ink-400" aria-hidden="true" />
            <div className="min-w-0 flex-1 basis-72">
              <p className="text-sm font-medium text-ink-900">{missing.title}，暂时不能重新生成目录</p>
              <p className="mt-0.5 text-xs leading-5 text-ink-500">{missing.description}现有的目录仍然可以在下面调整。</p>
            </div>
            <Button onClick={toTender}>去招标解读</Button>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-line-strong bg-white">
            <EmptyState
              className="py-14"
              icon={<DocumentMagnifyingGlassIcon />}
              title={missing.title}
              description={missing.description}
              action={
                <Button variant="primary" iconRight={<ArrowRightIcon />} onClick={toTender}>
                  去招标解读
                </Button>
              }
            />
          </div>
        )}

        {(hasOutline || missing === null) && (
          <OutlineEditor
            lockedReason={lockedReason}
            onSavingChange={onSavingChange}
            onDirtyChange={onFormDirty}
            regenerating={!ws.running && generation.running}
          />
        )}

        {hasOutline && <NextStep />}
      </div>
    </div>
  );
}
