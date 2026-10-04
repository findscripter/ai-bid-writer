/**
 * 目录页的生成区：选组织方式、可选的参考资料、发起生成，以及生成过程记录。
 *
 * - 还没有目录时整块展开，是这一页的主要操作；
 * - 已经有目录后收成一行，要重新生成时再展开；
 * - 生成过程中只显示过程记录（可以中止），结束后留下一行结果。
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  ClipboardDocumentCheckIcon,
  ExclamationTriangleIcon,
  QueueListIcon,
  SparklesIcon,
  StopIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { CheckCircleIcon, CheckIcon, ExclamationCircleIcon, MinusCircleIcon } from '@heroicons/react/20/solid';
import { useAppShell } from '../../app/AppShell';
import { formatChars, formatDuration } from '../../lib/format';
import { Link } from '../../lib/router';
import { Button, Card, Field, IconButton, ProgressBar, Select, Spinner, cx, useConfirm, useToast } from '../../ui';
import { useWorkspace } from '../WorkspaceContext';
import type { OutlineGeneration, OutlineMode } from './useOutlineGeneration';

const MODES: Array<{ key: OutlineMode; title: string; summary: string; fit: string; icon: React.ReactNode }> = [
  {
    key: 'free',
    title: '自由组织',
    summary: '模型根据项目概述和评分要求，自己组织目录。',
    fit: '结构更贴合方案本身的逻辑。适合评分项比较笼统、需要自己展开论述的项目。',
    icon: <QueueListIcon className="h-5 w-5" />,
  },
  {
    key: 'aligned',
    title: '与评分项一一对应',
    summary: '一级目录严格按技术评分大类生成，便于评委对照打分。',
    fit: '适合评分表条目清楚、评委按表逐项打分的项目。',
    icon: <ClipboardDocumentCheckIcon className="h-5 w-5" />,
  },
];

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  return `${Math.floor(total / 60)}:${seconds < 10 ? '0' : ''}${seconds}`;
}

interface ModeCardsProps {
  value: OutlineMode;
  onChange: (mode: OutlineMode) => void;
}

/** 两个选项卡片（单选）：方向键切换，Tab 只停在选中的那一个 */
function ModeCards({ value, onChange }: ModeCardsProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % MODES.length;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + MODES.length) % MODES.length;
    if (next < 0) return;
    event.preventDefault();
    onChange(MODES[next].key);
    const node = refs.current[next];
    if (node) node.focus();
  };

  return (
    <div role="radiogroup" aria-label="目录的组织方式" className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {MODES.map((mode, index) => {
        const selected = mode.key === value;
        return (
          <button
            key={mode.key}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(mode.key)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cx(
              'flex items-start gap-3 rounded-lg border p-4 text-left transition-colors',
              selected
                ? 'border-primary-500 bg-primary-50/60 ring-1 ring-primary-500'
                : 'border-line bg-white hover:border-line-strong hover:bg-subtle'
            )}
          >
            <span
              className={cx(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-md',
                selected ? 'bg-primary-100 text-primary-700' : 'bg-canvas text-ink-500'
              )}
              aria-hidden="true"
            >
              {mode.icon}
            </span>
            <span className="min-w-0 flex-1">
              {/* 略微拉开字距：不然“一一对应”的两个“一”会连成一条破折号 */}
              <span className="block text-sm font-medium tracking-[0.08em] text-ink-900">{mode.title}</span>
              <span className="mt-1 block text-[13px] leading-5 text-ink-700">{mode.summary}</span>
              <span className="mt-1 block text-xs leading-5 text-ink-500">{mode.fit}</span>
            </span>
            <span
              aria-hidden="true"
              className={cx(
                'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                selected ? 'border-primary-600 bg-primary-600' : 'border-line-strong bg-white'
              )}
            >
              {selected && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

interface GenerationLogProps {
  generation: OutlineGeneration;
  onRetry: () => void;
  retryDisabled: boolean;
}

/** 生成过程记录：进行中逐条追加并可中止；结束后留下结果，过程可以再展开看 */
function GenerationLog({ generation, onRetry, retryDisabled }: GenerationLogProps) {
  const { status, log, startedAt, finishedAt, error, mode } = generation;
  const running = status === 'running';
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(true);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!running) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  // 每次生成开始时展开；顺利结束后收起，失败或中止时留着，方便看停在了哪一步
  useEffect(() => {
    setOpen(status !== 'done');
  }, [status, startedAt]);

  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [log.length, open]);

  const elapsed = Math.max(0, (running ? now : finishedAt) - startedAt);
  const modeTitle = (MODES.find((item) => item.key === mode) || MODES[0]).title;

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-subtle">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 text-[13px]">
        {running && <Spinner size="sm" label="正在生成" />}
        {status === 'done' && <CheckCircleIcon className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />}
        {status === 'failed' && <ExclamationCircleIcon className="h-4 w-4 shrink-0 text-rose-500" aria-hidden="true" />}
        {status === 'cancelled' && <MinusCircleIcon className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />}
        <span className="font-medium text-ink-900">
          {running && `正在按「${modeTitle}」生成目录`}
          {status === 'done' && '新目录已生成'}
          {status === 'failed' && '目录没有生成成功'}
          {status === 'cancelled' && '已中止生成'}
        </span>
        <span className="tabular-nums text-xs text-ink-500">
          {running ? `已用时 ${clock(elapsed)}` : `用时 ${formatDuration(elapsed)}`}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {running ? (
            <Button size="sm" icon={<StopIcon />} onClick={generation.abort}>
              中止
            </Button>
          ) : (
            <>
              {status === 'failed' && (
                <Button size="sm" disabled={retryDisabled} onClick={onRetry}>
                  重试
                </Button>
              )}
              {log.length > 0 && (
                <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
                  {open ? '收起过程记录' : '查看过程记录'}
                </Button>
              )}
              <IconButton size="sm" label="关闭" icon={<XMarkIcon />} onClick={generation.dismiss} />
            </>
          )}
        </div>
      </div>

      {running && <ProgressBar value={null} size="sm" className="[&>div]:rounded-none" />}

      {status === 'failed' && (
        <p className="border-t border-rose-200 bg-rose-50 px-3 py-2 text-[13px] leading-5 text-rose-700" role="alert">
          {error}
          <span className="text-rose-600">　当前目录没有变化，可以直接重试。</span>
        </p>
      )}
      {status === 'cancelled' && (
        <p className="border-t border-line px-3 py-2 text-xs leading-5 text-ink-500">当前目录没有变化。</p>
      )}

      {open && (running || log.length > 0) && (
        <ol
          ref={listRef}
          aria-live="polite"
          aria-label="生成过程记录"
          className="max-h-52 space-y-1 overflow-y-auto border-t border-line bg-white px-3 py-2.5 text-xs leading-5"
        >
          {log.length === 0 && <li className="text-ink-500">正在连接模型，准备开始…</li>}
          {log.map((line, index) => {
            const last = index === log.length - 1;
            return (
              <li key={index} className="flex items-start gap-2">
                <span className="w-8 shrink-0 text-right tabular-nums text-ink-400">{clock(line.at)}</span>
                <span className="flex h-5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
                  {last && running ? (
                    <Spinner size="sm" tone="muted" label="进行中" className="h-3 w-3" />
                  ) : last && status === 'failed' ? (
                    <ExclamationCircleIcon className="h-3.5 w-3.5 text-rose-500" />
                  ) : last && status === 'cancelled' ? (
                    <MinusCircleIcon className="h-3.5 w-3.5 text-ink-400" />
                  ) : (
                    <CheckIcon className="h-3.5 w-3.5 text-emerald-500" />
                  )}
                </span>
                <span className={cx('min-w-0 break-words', last && running ? 'text-ink-900' : 'text-ink-600')}>{line.message}</span>
              </li>
            );
          })}
        </ol>
      )}

      {running && (
        <p className="border-t border-line px-3 py-2 text-xs leading-5 text-ink-500">
          通常需要一两分钟。请留在这一页等它完成——离开这一页会中止生成。
        </p>
      )}
    </div>
  );
}

interface GeneratePanelProps {
  generation: OutlineGeneration;
  /** 不为空时不能生成（有后台任务在跑），并显示这句原因 */
  blockedReason: string | null;
  /** 目录的修改正在保存 */
  saving: boolean;
  /** 目录里正在编辑的章节标题或说明还没有保存 */
  formDirty?: boolean;
}

export function GeneratePanel({ generation, blockedReason, saving, formDirty = false }: GeneratePanelProps) {
  const ws = useWorkspace();
  const shell = useAppShell();
  const toast = useToast();
  const confirm = useConfirm();
  const { project, materials, leaves, chapters } = ws.data;
  const hasOutline = project.outline.length > 0;

  const [mode, setMode] = useState<OutlineMode>(project.outline_mode === 'aligned' ? 'aligned' : 'free');
  const [picked, setPicked] = useState('');
  const [expanded, setExpanded] = useState(!hasOutline);

  // 目录从无到有（或被删空）时，跟着收起（或展开）选项
  const hadOutline = useRef(hasOutline);
  useEffect(() => {
    if (hadOutline.current !== hasOutline) {
      hadOutline.current = hasOutline;
      setExpanded(!hasOutline);
    }
  }, [hasOutline]);

  // 重新生成顺利结束后收起选项，把地方让给目录
  useEffect(() => {
    if (generation.status === 'done') setExpanded(false);
  }, [generation.status, generation.startedAt]);

  // 选中的资料后来被删掉了，就当没选
  const material = materials.find((item) => item.id === picked) || null;
  const materialId = material ? material.id : '';

  const settings = shell.settings;
  const needSetup = settings !== null && !settings.api_key_set && !settings.demo && !(shell.meta && shell.meta.demo);
  const writtenCount = leaves.filter((leaf) => {
    const chapter = chapters[leaf.uid];
    return Boolean(chapter && chapter.chars > 0);
  }).length;
  const blocked = blockedReason !== null || saving || generation.running;

  const generate = async () => {
    if (blocked) return;
    // 设置读到了、确实没配好才拦；没读到时交给后端判断
    if (shell.settings !== null && !shell.modelReady) {
      toast.info('请先配置模型服务（API Key、接口地址、模型）。');
      shell.openSettings();
      return;
    }
    if (hasOutline) {
      const ok = await confirm({
        title: '重新生成目录？',
        description: (
          <div className="space-y-2">
            <p>新目录会替换当前目录，之前手动做的调整不会保留。</p>
            <p>标题和位置都没变的章节，会保留已写的正文和写作计划；其余章节的正文将不再显示。</p>
            {writtenCount > 0 && <p className="font-medium text-ink-900">当前有 {writtenCount} 章已经写了正文。</p>}
            {formDirty && (
              <p className="font-medium text-ink-900">目录里正在编辑的章节还没有保存：如果新目录里没有这一章，填的内容会丢失。</p>
            )}
          </div>
        ),
        confirmText: '重新生成',
        tone: 'danger',
      });
      if (!ok) return;
    }
    const saved = await generation.start({ mode, materialId: materialId || null });
    if (saved) toast.success('新目录已生成，可以在下面逐章调整。');
  };

  const showOptions = !generation.running && (!hasOutline || expanded);
  const showLog = generation.status !== 'idle';

  return (
    <Card
      title={hasOutline ? '重新生成目录' : '生成目录'}
      description={
        hasOutline
          ? '想换一种组织方式，或者招标解读更新了，可以重新生成。新目录会替换当前目录。'
          : '选一种组织方式，让模型根据招标解读的结果生成三级目录。生成之后可以逐章调整。'
      }
      actions={
        hasOutline && !generation.running ? (
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={expanded}
            iconRight={expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '收起' : '选择方式'}
          </Button>
        ) : undefined
      }
    >
      {showOptions || showLog ? (
        <div className="space-y-4">
          {showOptions && (
            <>
              <ModeCards value={mode} onChange={setMode} />

              <Field
                label="参考旧方案的目录（可选）"
                hint={
                  materials.length === 0 ? undefined : material ? (
                    material.warning ? (
                      <span className="text-amber-700">这份资料有提示：{material.warning}</span>
                    ) : (
                      '模型会先提取这份资料原有的目录，再按这次的招标要求调整。'
                    )
                  ) : (
                    '手里有同类项目的旧方案时，可以让新目录沿用它的章节结构。'
                  )
                }
              >
                {materials.length === 0 ? (
                  <p className="rounded-md border border-dashed border-line-strong bg-subtle px-3 py-2 text-[13px] leading-5 text-ink-500">
                    还没有参考资料。想沿用旧方案的章节结构，可以先到
                    <Link to={`/projects/${ws.projectId}/tender`} className="mx-0.5 font-medium text-primary-600 hover:underline">
                      招标解读
                    </Link>
                    里上传旧方案。
                  </p>
                ) : (
                  <Select
                    className="max-w-md"
                    value={materialId}
                    onChange={(event) => setPicked(event.target.value)}
                    options={[{ value: '', label: '不参考' }].concat(
                      materials.map((item) => ({ value: item.id, label: `${item.name}（${formatChars(item.char_count)}）` }))
                    )}
                  />
                )}
              </Field>

              {needSetup && (
                <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] leading-5 text-amber-800">
                  <ExclamationTriangleIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1">生成目录要调用模型，但模型服务还没有配置（API Key、接口地址、模型）。</span>
                  <Button size="sm" onClick={shell.openSettings}>
                    去配置
                  </Button>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Button
                  variant={hasOutline ? 'secondary' : 'primary'}
                  icon={<SparklesIcon />}
                  disabled={blocked}
                  onClick={() => void generate()}
                >
                  {hasOutline ? '重新生成目录' : '生成目录'}
                </Button>
                {blockedReason ? (
                  <span className="flex min-w-0 items-center gap-1.5 text-xs text-amber-700">
                    <ExclamationTriangleIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {blockedReason}
                  </span>
                ) : saving ? (
                  <span className="text-xs text-ink-500">正在保存目录的修改，稍等一下…</span>
                ) : (
                  <span className="text-xs text-ink-500">通常需要一两分钟，过程会显示在这里，中途可以中止。</span>
                )}
              </div>
            </>
          )}

          {showLog && <GenerationLog generation={generation} onRetry={() => void generate()} retryDisabled={blocked} />}
        </div>
      ) : null}
    </Card>
  );
}
