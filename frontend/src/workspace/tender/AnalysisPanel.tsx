/**
 * 一项解析结果的面板（项目概述 / 技术评分要求）：查看、编辑、解析过程、失败提示。
 */
import React, { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowPathIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  PencilSquareIcon,
} from '@heroicons/react/24/outline';
import { api, errorMessage } from '../../api/client';
import { formatChars } from '../../lib/format';
import { MarkdownView } from '../../lib/MarkdownView';
import { Badge, Button, Card, ProgressBar, Skeleton, Spinner, Textarea, cx, useConfirm, useToast } from '../../ui';
import { useWorkspace } from '../WorkspaceContext';
import { ANALYSIS_LABEL } from './useTenderAnalysis';
import type { AnalysisItem, AnalysisKind } from './useTenderAnalysis';

interface AnalysisPanelProps {
  kind: AnalysisKind;
  /** 标题下面的一句话 */
  summary: string;
  /** 还没有内容时，说明这一项是做什么用的 */
  purpose: string;
  /** 编辑时的提示 */
  editHint: string;
  /** 现在应该显示的内容 */
  content: string;
  item: AnalysisItem;
  hasTender: boolean;
  /** 现在不能解析的原因（后台任务在跑、别的解析在进行）；可以时传空串 */
  blocked: string;
  /** 内容还是按旧招标文件解析的 */
  stale: boolean;
  /** 撰写正文时最多带入的字数，超过时提醒 */
  softLimit?: number;
  /** 解析 / 重新解析这一项（确认、检查模型服务由外层负责） */
  onAnalyze: (kind: AnalysisKind) => void;
  /** 有没有未保存的修改 */
  onDirtyChange: (kind: AnalysisKind, dirty: boolean) => void;
  /** 外层要求进入编辑（数值每变一次触发一次） */
  editRequest?: number;
  /** 接在内容下面的附加区域 */
  footer?: React.ReactNode;
  /** 关掉解析结束后留下的提示 */
  onDismissWarnings?: (kind: AnalysisKind) => void;
}

// 解析结果里经常是连着几行“【字段】：值”，中间没有空行：让段落内的换行照原样显示。
// 面板里的标题只是分组用的小标题，比文稿里的章节标题小一号。
const PROSE_CLASS =
  '[&_p]:whitespace-pre-line [&_h1]:text-[17px] [&_h2]:text-[16px] [&_h3]:text-[15px] [&_h1]:mt-[1.2em] [&_h2]:mt-[1.2em]';

/** 解析过程中面板大致会长到多高：轮到它时要在视野里留出这么大的位置 */
const LIVE_PANEL_HEIGHT = 580;

function scrollParent(node: HTMLElement): HTMLElement | null {
  let current = node.parentElement;
  while (current) {
    const overflow = window.getComputedStyle(current).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return current;
    current = current.parentElement;
  }
  return null;
}

function countChars(text: string): number {
  return text.replace(/\s/g, '').length;
}

/** 从“已完成 2/5 段”这样的提示里取出进度 */
function progressValue(message: string): number | null {
  const match = /(\d+)\s*\/\s*(\d+)/.exec(message);
  if (!match) return null;
  const done = Number(match[1]);
  const total = Number(match[2]);
  if (!(total > 0) || done > total) return null;
  return (done / total) * 100;
}

function AnalysisPanelImpl({
  kind,
  summary,
  purpose,
  editHint,
  content,
  item,
  hasTender,
  blocked,
  stale,
  softLimit,
  onAnalyze,
  onDirtyChange,
  editRequest,
  footer,
  onDismissWarnings,
}: AnalysisPanelProps) {
  const ws = useWorkspace();
  const toast = useToast();
  const confirm = useConfirm();
  const label = ANALYSIS_LABEL[kind];

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // 开始编辑时的内容：有没有改动按它比较（编辑期间内容在别处更新了，也不会把没动过的草稿误判成有修改）
  const [base, setBase] = useState('');
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);

  const running = item.phase === 'running';
  const queued = item.phase === 'queued';
  const working = running || queued;
  const hasContent = content.trim() !== '';
  const dirty = editing && draft !== base;
  // 编辑期间这一项在别处更新过（另一个窗口保存、重新解析），这里又改过：保存会覆盖那边的修改
  const changedElsewhere = editing && dirty && content !== base;

  useEffect(() => {
    onDirtyChange(kind, dirty);
  }, [kind, dirty, onDirtyChange]);

  // 编辑期间这一项在别处更新了：没动过就跟上新内容；动过就保留，并提示保存会覆盖
  useEffect(() => {
    if (!editing || content === base || draft !== base) return;
    setDraft(content);
    setBase(content);
  }, [editing, content, base, draft]);

  const beginEdit = (text: string) => {
    setDraft(text);
    setBase(text);
    setEditing(true);
  };

  const takeNewContent = () => {
    setDraft(content);
    setBase(content);
  };

  // 这一项开始解析：退出编辑（外层已经确认过未保存的修改）
  useEffect(() => {
    if (working) setEditing(false);
  }, [working]);

  // 外层要求进入编辑
  const lastRequest = useRef(editRequest);
  useEffect(() => {
    if (editRequest === lastRequest.current) return;
    lastRequest.current = editRequest;
    if (working) return;
    beginEdit(content);
    if (cardRef.current) cardRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    // 只响应 editRequest 的变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRequest]);

  // 轮到这一项时把它带进视野，并给正在生成的内容留出位置（使用者正在别处输入时不打扰）
  useEffect(() => {
    const node = cardRef.current;
    if (!running || !node) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement) return;
    const parent = scrollParent(node);
    const top = parent ? parent.getBoundingClientRect().top : 0;
    const bottom = parent ? parent.getBoundingClientRect().bottom : window.innerHeight;
    const rect = node.getBoundingClientRect();
    if (rect.top < top || rect.top + LIVE_PANEL_HEIGHT > bottom) {
      node.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }, [running]);

  // 解析过程中跟随到文末（使用者往回翻看时不打扰）
  const stickRef = useRef(true);
  useEffect(() => {
    if (running) stickRef.current = true;
  }, [running]);
  useEffect(() => {
    const node = liveRef.current;
    if (!running || !node || !stickRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [item.text, running]);
  const onLiveScroll = () => {
    const node = liveRef.current;
    if (!node) return;
    stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
  };

  // 内容超出限高时才给“展开全部”
  const viewing = !editing && !running && hasContent;
  useLayoutEffect(() => {
    const node = viewRef.current;
    if (!viewing || !node) {
      setOverflowing(false);
      return undefined;
    }
    if (expanded) return undefined;
    const measure = () => setOverflowing(node.scrollHeight > node.clientHeight + 1);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [viewing, expanded, content]);

  const startEdit = () => beginEdit(content);

  const cancelEdit = async () => {
    if (dirty) {
      const ok = await confirm({
        title: '放弃修改？',
        description: `对${label}的修改还没有保存。`,
        confirmText: '放弃修改',
        tone: 'danger',
      });
      if (!ok) return;
    }
    setEditing(false);
  };

  const save = async () => {
    const value = draft.replace(/\s+$/, '');
    if (!value.trim() && hasContent) {
      const ok = await confirm({
        title: `清空${label}？`,
        description:
          kind === 'overview'
            ? '清空后，生成目录和撰写正文时就没有项目背景可用了，需要重新解析或重新填写。'
            : '清空后，目录、写作计划和审校就没有评分要求可以对照了，需要重新解析或重新填写。',
        confirmText: '清空',
        tone: 'danger',
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      ws.apply(await api.patchProject(ws.projectId, kind === 'overview' ? { overview: value } : { requirements: value }));
      setEditing(false);
      toast.success(`${label}已保存`);
    } catch (error) {
      toast.error(errorMessage(error, '保存失败，请重试'));
    } finally {
      setSaving(false);
    }
  };

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    if (!next && cardRef.current) cardRef.current.scrollIntoView({ block: 'nearest' });
  };

  let status: React.ReactNode;
  if (running) {
    status = (
      <Badge tone="primary" size="sm" dot>
        解析中
      </Badge>
    );
  } else if (queued) {
    status = <Badge size="sm">等待中</Badge>;
  } else if (item.error) {
    status = item.blocked ? (
      <Badge tone="warning" size="sm">
        没有开始解析
      </Badge>
    ) : (
      <Badge tone="danger" size="sm">
        解析失败
      </Badge>
    );
  } else if (!hasContent) {
    status = <Badge size="sm">还没有内容</Badge>;
  } else if (stale) {
    status = (
      <Badge tone="warning" size="sm">
        按旧文件解析
      </Badge>
    );
  } else {
    status = <span className="text-xs font-normal tabular-nums text-ink-400">{formatChars(countChars(content))}</span>;
  }

  const progress = running ? progressValue(item.progress) : null;
  const tooLong = softLimit !== undefined && content.trim().length > softLimit;
  const analyzeTitle = blocked || (!hasTender ? '先上传招标文件' : undefined);

  return (
    <div ref={cardRef} className="scroll-mt-4">
    <Card
      padded={false}
      className="overflow-hidden"
      title={
        <span className="flex items-center gap-2">
          {label}
          {status}
        </span>
      }
      description={hasContent || working ? summary : undefined}
      actions={
        editing || working ? undefined : (
          <>
            <Button size="sm" icon={<PencilSquareIcon />} onClick={startEdit}>
              {hasContent ? '编辑' : '手动填写'}
            </Button>
            <Button
              size="sm"
              icon={<ArrowPathIcon />}
              disabled={Boolean(blocked) || !hasTender}
              title={analyzeTitle}
              onClick={() => onAnalyze(kind)}
            >
              {hasContent ? '重新解析' : '解析'}
            </Button>
          </>
        )
      }
    >
      {item.error && !working && (
        <div
          role="alert"
          className={cx(
            'flex items-start gap-2 border-b px-4 py-2.5 text-[13px] leading-6',
            item.blocked ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-rose-200 bg-rose-50 text-rose-700'
          )}
        >
          <ExclamationCircleIcon className="mt-1 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {item.blocked ? `${label}没有开始解析` : `${label}没有解析成功`}
              {hasContent ? '，下面仍是之前的内容' : ''}
            </p>
            <p className="break-words">{item.error}</p>
          </div>
          <Button
            size="sm"
            className="mt-0.5"
            disabled={Boolean(blocked) || !hasTender}
            title={analyzeTitle}
            onClick={() => onAnalyze(kind)}
          >
            重试
          </Button>
        </div>
      )}
      {item.warnings.length > 0 && !working && (
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs leading-5 text-amber-800" role="status">
          <div className="min-w-0 flex-1">
            <p className="font-medium">这次解析的结果可能不完整</p>
            <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
              {item.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
          {onDismissWarnings && (
            <button type="button" className="shrink-0 text-amber-700 hover:underline" onClick={() => onDismissWarnings(kind)}>
              知道了
            </button>
          )}
        </div>
      )}
      {item.stopped && !working && (
        <p className="border-b border-line bg-subtle px-4 py-2 text-xs leading-5 text-ink-500">
          上一次解析被中止了，没有生成完的内容不会保存{hasContent ? '，下面仍是之前的内容' : ''}。
        </p>
      )}

      {running ? (
        <div key="live">
          <div className="flex items-center gap-2 border-b border-primary-100 bg-primary-50/70 px-4 py-2 text-xs leading-5 text-primary-800">
            <Spinner size="sm" label="解析中" />
            <span className="min-w-0 flex-1 truncate">
              {item.progress || (item.text ? '正在生成解析结果' : '正在阅读招标文件，马上开始输出')}
            </span>
            {progress !== null && <ProgressBar value={progress} size="sm" className="w-28 shrink-0" />}
            {item.text ? <span className="shrink-0 tabular-nums text-primary-700">{formatChars(countChars(item.text))}</span> : null}
          </div>
          <div ref={liveRef} onScroll={onLiveScroll} className="max-h-[28rem] min-h-[9rem] overflow-y-auto px-5 py-4">
            {item.text ? (
              <MarkdownView content={item.text} streaming className={PROSE_CLASS} />
            ) : (
              <div className="space-y-3" aria-hidden="true">
                <Skeleton className="h-4 w-10/12" />
                <Skeleton className="h-4 w-11/12" />
                <Skeleton className="h-4 w-7/12" />
              </div>
            )}
          </div>
        </div>
      ) : editing ? (
        <div key="edit">
          {changedElsewhere && !saving && (
            <div
              role="status"
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[13px] leading-5 text-amber-900"
            >
              <ExclamationTriangleIcon className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
              <span className="min-w-0 flex-1 basis-64">
                {label}在别处更新过（另一个窗口保存过，或者重新解析过）。保存会覆盖那边的修改。
              </span>
              <Button size="sm" onClick={takeNewContent} title="放弃这里没保存的修改，换成别处保存的内容">
                看新内容
              </Button>
            </div>
          )}
          <div className="px-4 pt-3">
            <Textarea
              autoFocus
              rows={16}
              value={draft}
              disabled={saving}
              onChange={(event) => setDraft(event.target.value)}
              className="h-[26rem] min-h-[10rem] font-mono text-[13px] leading-6"
              aria-label={`${label}内容`}
            />
            <p className="mt-2 text-xs leading-5 text-ink-500">{editHint}</p>
          </div>
          <div className="mt-3 flex items-center gap-2 border-t border-line bg-subtle px-4 py-2.5">
            <span className="mr-auto text-xs tabular-nums text-ink-500">{formatChars(countChars(draft))}</span>
            <Button variant="ghost" disabled={saving} onClick={() => void cancelEdit()}>
              取消
            </Button>
            <Button variant="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>
              保存
            </Button>
          </div>
        </div>
      ) : hasContent ? (
        <div key="view">
          {queued && (
            <p className="border-b border-line bg-subtle px-4 py-2 text-xs leading-5 text-ink-500">
              排在前一项之后，轮到后开始解析。下面是之前的内容。
            </p>
          )}
          <div ref={viewRef} className={cx('px-5 py-4', !expanded && 'max-h-[28rem] overflow-y-auto')}>
            <MarkdownView content={content} className={PROSE_CLASS} />
          </div>
          {tooLong && softLimit !== undefined && (
            <p className="border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs leading-5 text-amber-800">
              内容比较长：撰写正文时只会带上前 {softLimit.toLocaleString('en-US')} 个字。建议把最要紧的信息放在前面，或者删掉与实施无关的部分。
            </p>
          )}
          {(overflowing || expanded) && (
            <button
              type="button"
              onClick={toggleExpanded}
              aria-expanded={expanded}
              className="flex w-full items-center justify-center gap-1 border-t border-line py-1.5 text-xs text-ink-500 transition-colors hover:bg-subtle hover:text-ink-900"
            >
              {expanded ? (
                <>
                  收起
                  <ChevronUpIcon className="h-3.5 w-3.5" />
                </>
              ) : (
                <>
                  展开全部
                  <ChevronDownIcon className="h-3.5 w-3.5" />
                </>
              )}
            </button>
          )}
        </div>
      ) : (
        <div key="empty" className="px-5 py-5">
          <p className="max-w-3xl text-[13px] leading-6 text-ink-600">{purpose}</p>
          <p className="mt-2 text-xs leading-5 text-ink-400">
            {queued
              ? '排在前一项之后，轮到后开始解析。'
              : hasTender
                ? '点上方的“开始解析”自动生成；也可以点右上角手动填写。'
                : '上传招标文件后才能解析；也可以点右上角手动填写。'}
          </p>
        </div>
      )}

      {!editing && footer}
      <span className="sr-only" aria-live="polite">
        {running ? `正在解析${label}` : ''}
      </span>
    </Card>
    </div>
  );
}

export const AnalysisPanel = memo(AnalysisPanelImpl);
