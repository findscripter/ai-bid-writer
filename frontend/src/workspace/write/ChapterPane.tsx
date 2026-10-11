/**
 * 正文页中间的文稿区：展示、撰写、编辑、修订一章。
 */
import React, { memo, useEffect, useRef, useState } from 'react';
import {
  ArrowPathIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  DocumentDuplicateIcon,
  ExclamationTriangleIcon,
  PencilSquareIcon,
  PlayIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline';
import { ApiError, api, errorMessage } from '../../api/client';
import type { ChapterView, LeafInfo } from '../../api/types';
import { formatChars, formatRelativeTime } from '../../lib/format';
import { MarkdownView } from '../../lib/MarkdownView';
import { Badge, Button, EmptyState, Modal, Skeleton, Textarea, cx, useConfirm, useToast } from '../../ui';
import type { BadgeTone } from '../../ui';
import type { ChapterUiStatus } from '../WorkspaceContext';
import { useWorkspace } from '../WorkspaceContext';
import { ReviseModal, VersionsDrawer, toChapterView } from './ChapterDialogs';

const STATUS_BADGE: Record<ChapterUiStatus, { tone: BadgeTone; label: string }> = {
  empty: { tone: 'neutral', label: '未撰写' },
  queued: { tone: 'neutral', label: '排队中' },
  writing: { tone: 'primary', label: '撰写中' },
  done: { tone: 'success', label: '已完成' },
  failed: { tone: 'danger', label: '失败' },
  cancelled: { tone: 'warning', label: '未写完' },
};

const SOURCE_LABEL: Record<string, string> = { ai: 'AI 撰写', manual: '手动编辑', revised: 'AI 修订' };

function countChars(text: string): number {
  return text.replace(/\s/g, '').length;
}

interface ChapterPaneProps {
  leaf: LeafInfo;
  chapter: ChapterView | undefined;
  status: ChapterUiStatus;
  /** 撰写中的实时文本 */
  liveText: string | undefined;
  target: number | undefined;
  /** 是否有后台任务在跑（此时不能再启动新的任务） */
  running: boolean;
  /** 模型服务是否可用（还没读到设置时按可用处理，交给后端判断） */
  modelReady: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onNeedModel: () => void;
  /** 有没有还没保存的修改变化时通知外层（切换章节、离开页面前要确认） */
  onDirtyChange: (dirty: boolean) => void;
  /** 进入、退出编辑时通知外层（编辑中不能按问题修订） */
  onEditingChange: (editing: boolean) => void;
  /** 外层要求打开修订弹窗并预填修改要求（来自审校问题） */
  reviseRequest: { instruction: string; nonce: number } | null;
}

/** 编辑区顶部的提示条 */
function EditNotice({ tone, children, action }: { tone: 'info' | 'warning'; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div
      role="status"
      className={cx(
        'mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border px-3 py-2 text-[13px] leading-5',
        tone === 'warning' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-line bg-subtle text-ink-600'
      )}
    >
      <ExclamationTriangleIcon className={cx('h-4 w-4 shrink-0', tone === 'warning' ? 'text-amber-600' : 'text-ink-400')} />
      <p className="min-w-0 flex-1">{children}</p>
      {action}
    </div>
  );
}

function ChapterPaneImpl({
  leaf,
  chapter,
  status,
  liveText,
  target,
  running,
  modelReady,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onNeedModel,
  onDirtyChange,
  onEditingChange,
  reviseRequest,
}: ChapterPaneProps) {
  const ws = useWorkspace();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // 开始编辑时的正文与 updated_at：判断“改没改过”，保存时交给后端核对期间有没有被别处更新
  const [baseContent, setBaseContent] = useState('');
  const [baseUpdatedAt, setBaseUpdatedAt] = useState('');
  const [saving, setSaving] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [reviseOpen, setReviseOpen] = useState(false);
  const [reviseInitial, setReviseInitial] = useState('');
  const [versionsOpen, setVersionsOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 撰写中是否跟随到文末（使用者往回翻看时不打扰）
  const stickRef = useRef(true);

  const content = chapter ? chapter.content : '';
  const updatedAt = chapter ? chapter.updated_at || '' : '';
  const hasContent = countChars(content) > 0;
  const writing = status === 'writing';
  const dirty = editing && draft !== baseContent;

  // 编辑期间这一章的 updated_at 变了
  if (editing && updatedAt !== baseUpdatedAt) {
    if (content === baseContent) {
      // 正文一字没变（例如重新生成、修订没有成功只多了一条说明，或者别处原样保存了一次）：
      // 编辑基准跟到新的 updated_at，不算被更新过，保存也不会被当成冲突
      setBaseUpdatedAt(updatedAt);
    } else if (!dirty) {
      // 还没动过编辑框，正文就被更新了：直接换成新内容，免得之后拿旧稿去保存
      setDraft(content);
      setBaseContent(content);
      setBaseUpdatedAt(updatedAt);
    }
  }
  // 编辑期间这一章的正文真的被更新过（重新生成、修订、在别处保存）
  const changedWhileEditing = editing && content !== baseContent;

  // 取回的、保存后得到的这一章交给外层之前，和页面上已有的比一比：不比它旧才放进去
  // （事件流可能已经先送来了更新的一份，不能被晚到的响应换回旧稿）
  const chapterRef = useRef(chapter);
  chapterRef.current = chapter;
  const putChapter = (next: ChapterView) => {
    const current = chapterRef.current;
    if (current && (current.updated_at || '') > (next.updated_at || '')) return;
    ws.setChapter(next);
  };

  // 换章时退出编辑态、回到顶部；切到正在写的章节时从文末开始跟随
  useEffect(() => {
    setEditing(false);
    setConflictOpen(false);
    setReviseOpen(false);
    setVersionsOpen(false);
    stickRef.current = true;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [leaf.uid]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    onEditingChange(editing);
  }, [editing, onEditingChange]);

  // 卸载时（例如目录被清空、页面切走）不再算在编辑
  useEffect(
    () => () => {
      onDirtyChange(false);
      onEditingChange(false);
    },
    [onDirtyChange, onEditingChange]
  );

  // 每个修订请求只处理一次；编辑中不修订：修订用的是已保存的正文，会和编辑框里的修改互相覆盖
  const handledRevise = useRef<number | null>(null);
  useEffect(() => {
    if (!reviseRequest || handledRevise.current === reviseRequest.nonce) return;
    handledRevise.current = reviseRequest.nonce;
    if (editing) {
      toast.info('正在编辑正文：先保存或取消编辑，再按问题修订。');
      return;
    }
    if (!hasContent) {
      toast.info('这一章还没有正文，先撰写再修订。');
      return;
    }
    if (!modelReady) {
      onNeedModel();
      return;
    }
    setReviseInitial(reviseRequest.instruction);
    setReviseOpen(true);
  }, [reviseRequest, editing, hasContent, modelReady, onNeedModel, toast]);

  // 这一章开始写（排队轮到它、或刚点了开写）时，重新开始跟随。
  // 编辑中不跟随：编辑框和实时文本共用这个滚动容器，跟随会把正在编辑的位置拽走；
  // 退出编辑时这一章如果还在写，从这里接着跟随
  useEffect(() => {
    if (writing && !editing) stickRef.current = true;
  }, [writing, editing]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!writing || editing || !node || !stickRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [liveText, writing, editing]);

  const handleScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
  };

  const write = async () => {
    if (launching || ws.starting) return;
    if (!modelReady) {
      onNeedModel();
      return;
    }
    if (hasContent) {
      const ok = await confirm({
        title: '重写这一章？',
        description: '会按当前的写作计划重新撰写。现在的正文会保存到历史版本，可以随时恢复。',
        confirmText: '重写',
      });
      if (!ok) return;
    }
    stickRef.current = true;
    setLaunching(true);
    try {
      await ws.startJob('write', { uids: [leaf.uid] }, (message) => toast.error(message));
    } finally {
      setLaunching(false);
    }
  };

  const startEdit = () => {
    setDraft(content);
    setBaseContent(content);
    setBaseUpdatedAt(updatedAt);
    setConflictOpen(false);
    setEditing(true);
  };

  const stopEdit = () => {
    setConflictOpen(false);
    setEditing(false);
  };

  /** 编辑框底部的“取消”：有没保存的修改时先确认（和换章时的确认一致） */
  const cancelEdit = async () => {
    if (dirty) {
      const ok = await confirm({
        title: '放弃未保存的修改？',
        description: '当前章节的正文有修改还没有保存，取消编辑后会丢失。',
        confirmText: '放弃修改',
        tone: 'danger',
      });
      if (!ok) return;
    }
    stopEdit();
  };

  /** 取回这一章最新的内容并放进页面；取不到返回 null */
  const loadLatest = async (): Promise<ChapterView | null> => {
    try {
      const latest = toChapterView(await api.getChapter(ws.projectId, leaf.uid));
      putChapter(latest);
      return latest;
    } catch {
      return null;
    }
  };

  /** overwrite：使用者已经确认要用自己的版本覆盖期间更新过的内容 */
  const save = async (overwrite: boolean) => {
    if (saving) return;
    setSaving(true);
    const text = draft;
    // 冲突时已经取回过最新内容了，就不用再取一次
    let fetched = false;
    try {
      let saved: ChapterView;
      try {
        saved = await api.saveChapter(ws.projectId, leaf.uid, text, overwrite ? undefined : baseUpdatedAt);
      } catch (error) {
        if (overwrite || !(error instanceof ApiError) || error.status !== 409 || error.code !== 'chapter_changed') throw error;
        // 后端说期间被更新过：先看看正文是不是真的变了。只是状态、说明之类变了（正文和开始编辑时一字不差），
        // 就以最新的 updated_at 为基准再保存一次，不打扰使用者
        const latest = await loadLatest();
        fetched = true;
        if (!latest || latest.content !== baseContent) throw error;
        setBaseUpdatedAt(latest.updated_at || '');
        fetched = false;
        saved = await api.saveChapter(ws.projectId, leaf.uid, text, latest.updated_at || '');
      }
      putChapter(saved);
      stopEdit();
      toast.success('已保存');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        if (error.code === 'chapter_busy') {
          setConflictOpen(false);
          toast.error('这一章正在重新生成，现在保存不了。你的修改还在编辑框里，等它写完再保存。');
          // 任务可能是在别的标签页里开始的：同步一次，页面上就能看到它
          void ws.reload();
        } else {
          // 期间正文被别处改过：取回最新的内容，让使用者决定保留哪一版（取不到也不影响选择）
          if (!fetched) await loadLatest();
          setConflictOpen(true);
        }
      } else {
        toast.error(errorMessage(error, '保存失败'));
      }
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      toast.success('已复制本章正文');
    } catch {
      toast.error('复制失败，请手动选择文本复制');
    }
  };

  const badge = STATUS_BADGE[status];
  const chars = writing ? countChars(liveText || '') : editing ? countChars(draft) : chapter ? chapter.chars : 0;
  const ratio = target ? chars / target : 0;
  const startBlocked = running || ws.starting;

  let editNotice: React.ReactNode = null;
  if (editing && writing) {
    editNotice = (
      <EditNotice tone="warning">
        {dirty
          ? '这一章正在重新生成，生成期间不能保存。写完后可以选择看新内容，或者用你的修改覆盖它。'
          : '这一章正在重新生成，写完后编辑框会换成新的内容。'}
      </EditNotice>
    );
  } else if (dirty && changedWhileEditing) {
    editNotice = (
      <EditNotice
        tone="warning"
        action={
          <Button size="sm" onClick={stopEdit}>
            放弃我的修改，看新内容
          </Button>
        }
      >
        这一章在你编辑期间被更新过（重新生成、修订或在别处保存）。编辑框里是旧稿加上你的修改，直接保存会用它覆盖新的内容。
      </EditNotice>
    );
  } else if (editing && status === 'queued') {
    editNotice = (
      <EditNotice tone="info">这一章在排队等待重新生成，轮到它时编辑框里的修改会和新内容冲突。建议先保存，或者等任务结束后再改。</EditNotice>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      // 编辑时底部有吸底的保存栏：浏览器为露出光标滚动时留出它的高度，换行后光标不会钻到保存栏下面
      className={cx('h-full overflow-y-auto bg-canvas', editing && 'scroll-pb-20')}
    >
      <article className="mx-auto my-6 max-w-[820px] rounded-lg border border-line bg-white shadow-card">
        <header className="border-b border-line px-8 pb-4 pt-6">
          <p className="truncate text-xs text-ink-400">{leaf.path_titles.join(' › ') || '一级章节'}</p>
          <h2 className="mt-1 text-xl font-semibold leading-snug text-ink-900">
            <span className="mr-2 tabular-nums text-ink-400">{leaf.id}</span>
            {leaf.title}
          </h2>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-ink-500">
            <Badge tone={badge.tone} dot>
              {badge.label}
            </Badge>
            <span className="tabular-nums">
              {formatChars(chars)}
              {target ? <span className="text-ink-400"> / 目标约 {formatChars(target)}</span> : null}
            </span>
            {status === 'done' && target && (ratio < 0.6 || ratio > 1.6) ? (
              <Badge tone="warning" size="sm">
                {ratio < 0.6 ? '明显偏短' : '明显偏长'}
              </Badge>
            ) : null}
            {chapter && hasContent && !writing && <span>{SOURCE_LABEL[chapter.source] || chapter.source}</span>}
            {chapter && chapter.updated_at && hasContent && !writing && <span>{formatRelativeTime(chapter.updated_at)}</span>}
            {chapter && chapter.truncated && !writing && (
              <Badge tone="warning" size="sm">
                结尾可能不完整
              </Badge>
            )}
          </div>

          {!editing && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={hasContent ? 'secondary' : 'primary'}
                disabled={startBlocked}
                loading={launching}
                icon={hasContent ? <ArrowPathIcon className="h-4 w-4" /> : <PlayIcon className="h-4 w-4" />}
                onClick={() => void write()}
              >
                {hasContent ? '重写本章' : status === 'failed' || status === 'cancelled' ? '重新撰写' : '撰写本章'}
              </Button>
              <Button
                size="sm"
                disabled={startBlocked || !hasContent}
                icon={<SparklesIcon className="h-4 w-4" />}
                onClick={() => {
                  if (!modelReady) {
                    onNeedModel();
                    return;
                  }
                  setReviseInitial('');
                  setReviseOpen(true);
                }}
              >
                按要求修订
              </Button>
              <Button size="sm" disabled={writing} icon={<PencilSquareIcon className="h-4 w-4" />} onClick={startEdit}>
                编辑
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!chapter || chapter.version_count === 0}
                icon={<ClockIcon className="h-4 w-4" />}
                onClick={() => setVersionsOpen(true)}
              >
                历史版本{chapter && chapter.version_count > 0 ? `（${chapter.version_count}）` : ''}
              </Button>
              <Button size="sm" variant="ghost" disabled={!hasContent} icon={<DocumentDuplicateIcon className="h-4 w-4" />} onClick={() => void copy()}>
                复制
              </Button>
            </div>
          )}
        </header>

        {chapter && chapter.error && !writing && (
          <div className="mx-8 mt-5 flex gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="min-w-0 break-words">{chapter.error}</p>
          </div>
        )}

        <div className="px-8 py-6">
          {editing ? (
            <div>
              {editNotice}
              <Textarea
                autoFocus
                autoResize
                rows={16}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="min-h-[24rem] font-mono text-[13px] leading-6"
                aria-label="章节正文"
              />
              <p className="mt-2 text-xs text-ink-400">
                支持 Markdown：### 小标题、**加粗**、- 列表、| 表格 |。需要投标人补充的信息写成【待补充：……】。
              </p>
              <div className="sticky bottom-0 -mx-8 mt-4 flex items-center justify-end gap-2 border-t border-line bg-white px-8 py-3">
                <span className="mr-auto text-xs text-ink-500">{formatChars(countChars(draft))}</span>
                <Button variant="ghost" disabled={saving} onClick={() => void cancelEdit()}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  loading={saving}
                  disabled={!dirty || writing}
                  title={writing ? '这一章正在重新生成，写完再保存' : undefined}
                  onClick={() => void save(false)}
                >
                  保存
                </Button>
              </div>
            </div>
          ) : writing ? (
            liveText ? (
              <MarkdownView content={liveText} streaming />
            ) : (
              <div className="space-y-3" aria-label="正在准备">
                <p className="text-sm text-ink-500">正在整理本章的上下文并开始撰写…</p>
                <Skeleton className="h-4 w-11/12" />
                <Skeleton className="h-4 w-10/12" />
                <Skeleton className="h-4 w-8/12" />
              </div>
            )
          ) : hasContent ? (
            <MarkdownView content={content} />
          ) : (
            <EmptyState
              className="py-10"
              title={status === 'queued' ? '这一章在排队，轮到后会自动开始' : '这一章还没有正文'}
              description={leaf.description || undefined}
              action={
                status === 'queued' ? undefined : (
                  <Button
                    variant="primary"
                    disabled={startBlocked}
                    loading={launching}
                    icon={<PlayIcon className="h-4 w-4" />}
                    onClick={() => void write()}
                  >
                    撰写本章
                  </Button>
                )
              }
            />
          )}
        </div>

        {!editing && (
          <footer className="flex items-center justify-between border-t border-line px-6 py-3">
            <Button size="sm" variant="ghost" disabled={!hasPrev} icon={<ChevronLeftIcon className="h-4 w-4" />} onClick={onPrev}>
              上一章
            </Button>
            <Button size="sm" variant="ghost" disabled={!hasNext} iconRight={<ChevronRightIcon className="h-4 w-4" />} onClick={onNext}>
              下一章
            </Button>
          </footer>
        )}
      </article>

      <ReviseModal open={reviseOpen} leaf={leaf} initial={reviseInitial} onClose={() => setReviseOpen(false)} />
      <VersionsDrawer open={versionsOpen} leaf={leaf} onClose={() => setVersionsOpen(false)} />
      <Modal
        open={conflictOpen}
        onClose={() => setConflictOpen(false)}
        role="alertdialog"
        size="md"
        title="这一章在你编辑期间被更新过"
        description="可能是重新生成、修订，或者在别的页面保存过。请选择保留哪一版。"
        footer={
          <>
            <Button variant="ghost" disabled={saving} onClick={() => setConflictOpen(false)}>
              继续编辑
            </Button>
            <Button disabled={saving} onClick={stopEdit}>
              放弃我的修改，看新内容
            </Button>
            <Button variant="danger" loading={saving} onClick={() => void save(true)}>
              覆盖保存
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-6 text-ink-600">
          “覆盖保存”会用编辑框里的内容替换新的内容，新的内容会存进历史版本，之后还能恢复；“放弃我的修改”会丢掉编辑框里的修改。
        </p>
      </Modal>
      <span className={cx('sr-only')} aria-live="polite">
        {writing ? '正在撰写' : ''}
      </span>
    </div>
  );
}

export const ChapterPane = memo(ChapterPaneImpl);
