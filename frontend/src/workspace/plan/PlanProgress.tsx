/**
 * 写作计划生成过程中的进度卡：现在在做哪一步、做到哪了，可以停止。
 */
import React, { useState } from 'react';
import { CheckIcon, StopIcon } from '@heroicons/react/20/solid';
import type { JobRecord } from '../../api/types';
import { Button, ProgressBar, Spinner, cx } from '../../ui';

const STEPS: Array<{ key: string; label: string }> = [
  { key: 'facts', label: '归纳统一口径' },
  { key: 'chapters', label: '分批给各章定要点' },
  { key: 'coverage', label: '核对评分项由哪一章负责' },
];

interface PlanProgressProps {
  job: JobRecord;
  /** 已有计划（重新生成或补全）时为 true：说明里要交代原有计划的去向 */
  hasBlueprint: boolean;
  /** 停止任务；失败时抛出异常 */
  onStop: () => Promise<void>;
  /** 停止失败时的提示 */
  onStopError: (error: unknown) => void;
}

export function PlanProgress({ job, hasBlueprint, onStop, onStopError }: PlanProgressProps) {
  const [stopping, setStopping] = useState(false);
  const onlyMissing = hasBlueprint && Boolean(job.params && job.params.only_missing);
  const { done, total } = job.progress;
  const percent = total > 0 ? Math.round((Math.min(done, total) / total) * 100) : null;
  const currentIndex = STEPS.findIndex((step) => step.key === job.stage);

  const stop = async () => {
    setStopping(true);
    try {
      await onStop();
    } catch (error) {
      onStopError(error);
    } finally {
      setStopping(false);
    }
  };

  return (
    <section className="rounded-lg border border-primary-200 bg-white shadow-card" aria-live="polite">
      <div className="flex items-start gap-3 px-5 pt-4">
        <Spinner className="mt-0.5" label="正在生成" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold leading-6 text-ink-900">{onlyMissing ? '正在补全写作计划' : '正在制定写作计划'}</h2>
          <p className="mt-0.5 break-words text-[13px] leading-6 text-ink-600">{job.message || '正在准备，马上开始…'}</p>
        </div>
        <Button size="sm" loading={stopping} icon={<StopIcon />} onClick={() => void stop()}>
          停止
        </Button>
      </div>

      <div className="px-5 pt-3">
        <ProgressBar value={percent} />
      </div>

      <ol className="flex flex-wrap gap-x-6 gap-y-2 px-5 pt-3 text-[13px] leading-5">
        {STEPS.map((step, index) => {
          const skipped = onlyMissing && step.key === 'facts';
          const finished = skipped || (currentIndex >= 0 && index < currentIndex);
          const active = !skipped && index === currentIndex;
          return (
            <li key={step.key} className="flex items-center gap-2">
              <span
                className={cx(
                  'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-2xs font-semibold',
                  finished ? 'bg-emerald-500 text-white' : active ? 'bg-primary-600 text-white' : 'bg-line text-ink-500'
                )}
                aria-hidden="true"
              >
                {finished ? <CheckIcon className="h-3 w-3" /> : index + 1}
              </span>
              <span className={cx(active ? 'font-medium text-ink-900' : finished ? 'text-ink-600' : 'text-ink-400')}>
                {skipped ? '沿用现有的统一口径' : step.label}
                {step.key === 'chapters' && active && total > 0 && (
                  <span className="ml-1.5 font-normal tabular-nums text-ink-500">
                    已完成 {Math.min(done, total)}/{total} 批
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>

      <p className="mt-4 rounded-b-lg border-t border-line bg-subtle px-5 py-2.5 text-xs leading-5 text-ink-500">
        生成在后台进行，可以先去别的页面，不会中断；已经写好的正文不受影响。
        {hasBlueprint
          ? onlyMissing
            ? '统一口径和已有章节的要点、权重不会改动；没有章节负责的条目，只在这次新补计划的章节里找内容相近的分配，找不到的仍要手动指定。中途停止的话，原来的计划不变。'
            : '中途停止的话，这次的结果不保留，原来的计划不变。'
          : '中途停止的话，这次的结果不保留。'}
      </p>
    </section>
  );
}
