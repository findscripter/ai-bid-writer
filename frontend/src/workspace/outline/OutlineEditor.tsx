/**
 * 目录树编辑区：按层级显示全部章节，就地改标题与说明、添加、上下移动、删除。
 *
 * 每次修改都立刻保存：算出新的目录树 → 保存 → 用后端返回的状态刷新界面。
 * 保存期间不接受新的操作；失败时提示，目录保持原状。
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownIcon,
  ArrowTurnDownRightIcon,
  ArrowUpIcon,
  ClipboardDocumentCheckIcon,
  InformationCircleIcon,
  LockClosedIcon,
  PencilSquareIcon,
  PlusIcon,
  QueueListIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/20/solid';
import { api, errorMessage } from '../../api/client';
import type { OutlineNode } from '../../api/types';
import { formatChars } from '../../lib/format';
import { Button, EmptyState, IconButton, Spinner, StatusDot, cx, useConfirm, useToast } from '../../ui';
import { useWorkspace } from '../WorkspaceContext';
import type { ChapterUiStatus } from '../WorkspaceContext';
import { NodeForm } from './NodeForm';
import {
  addAfter,
  addChild,
  addRoot,
  allUids,
  countDescendants,
  groupUids,
  hasResponseChapters,
  isLeaf,
  leafUidsOf,
  locate,
  moveNode,
  newNode,
  nextChildNumber,
  nextSiblingNumber,
  removeNode,
  renameNode,
  treeDepth,
} from './tree';
import type { DraftNode } from './tree';

/** 当前打开的就地表单：改某个节点，或者在某个位置新加一个 */
type FormTarget =
  | { kind: 'edit'; uid: string }
  | { kind: 'child'; uid: string }
  | { kind: 'after'; uid: string }
  | { kind: 'root' };

/** 界面刷新之后把键盘焦点放回哪里 */
type FocusRequest =
  | { kind: 'action'; uid: string; action: string; flash: boolean }
  | { kind: 'row'; uid: string }
  | { kind: 'fresh'; known: string[] }
  | { kind: 'root' };

const MAX_COMFORTABLE_LEVELS = 4;
const MAX_COMFORTABLE_LEAVES = 120;

const TITLE_CLASS = ['font-semibold text-ink-900', 'font-medium text-ink-900', 'text-ink-700'];

const STATUS_HINT: Record<ChapterUiStatus, string> = {
  empty: '待撰写',
  queued: '排队中',
  writing: '撰写中',
  done: '已写',
  failed: '上次没有写成',
  cancelled: '上次没有写完',
};

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline gap-1.5" title={hint}>
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums text-ink-900">{value}</dd>
    </div>
  );
}

/** 章节说明：默认最多两行，放不下时可以展开 */
function Description({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || expanded) return undefined;
    const measure = () => setClamped(node.scrollHeight > node.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, expanded]);

  return (
    <div className="mt-0.5 text-xs leading-5 text-ink-500">
      <p ref={ref} className={cx('whitespace-pre-line break-words', !expanded && 'line-clamp-2')}>
        {text}
      </p>
      {(clamped || expanded) && (
        <button
          type="button"
          aria-expanded={expanded}
          className="rounded text-primary-600 hover:underline"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '收起' : '展开全部说明'}
        </button>
      )}
    </div>
  );
}

interface OutlineEditorProps {
  /** 不为空时整个编辑区只读，并显示这句原因 */
  lockedReason: string | null;
  /** 保存状态变化时通知外层（保存期间不能重新生成目录） */
  onSavingChange: (saving: boolean) => void;
  /** 就地表单里填了内容还没有保存（离开页面前要提醒） */
  onDirtyChange?: (dirty: boolean) => void;
  /** 正在重新生成目录：表单里没保存的内容在新目录里可能没有对应的章节 */
  regenerating?: boolean;
}

export function OutlineEditor({ lockedReason, onSavingChange, onDirtyChange, regenerating = false }: OutlineEditorProps) {
  const ws = useWorkspace();
  const toast = useToast();
  const confirm = useConfirm();
  const { projectId, apply, chapterStatus } = ws;
  const { project, leaves, chapters } = ws.data;
  const outline = project.outline;
  const locked = lockedReason !== null;

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [form, setForm] = useState<FormTarget | null>(null);
  const [saving, setSaving] = useState(false);
  const [slow, setSlow] = useState(false);
  const [appending, setAppending] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [justSaved, setJustSaved] = useState(false);
  const [flash, setFlash] = useState<{ uid: string; at: number } | null>(null);

  const rootRef = useRef<HTMLElement>(null);
  const savingRef = useRef(false);
  const focusRef = useRef<FocusRequest | null>(null);
  const outlineRef = useRef(outline);
  outlineRef.current = outline;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  // 就地表单里有没有填了还没保存的内容（目录被锁住时据此决定表单留不留）
  const formDirtyRef = useRef(false);
  const handleFormDirty = useCallback(
    (dirty: boolean) => {
      formDirtyRef.current = dirty;
      if (onDirtyChange) onDirtyChange(dirty);
    },
    [onDirtyChange]
  );

  useEffect(() => {
    onSavingChange(saving);
  }, [saving, onSavingChange]);

  // 保存很快时不闪“正在保存”，拖得久了才显示
  useEffect(() => {
    if (!saving) {
      setSlow(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setSlow(true), 400);
    return () => window.clearTimeout(timer);
  }, [saving]);

  useEffect(() => {
    if (!savedAt) return undefined;
    setJustSaved(true);
    const timer = window.setTimeout(() => setJustSaved(false), 2500);
    return () => window.clearTimeout(timer);
  }, [savedAt]);

  useEffect(() => {
    if (!flash) return undefined;
    const timer = window.setTimeout(() => setFlash(null), 1600);
    return () => window.clearTimeout(timer);
  }, [flash]);

  // 表单对应的章节已经不在目录里了（别处删掉了、目录重新生成了）：只能把表单收掉，填了内容的要说一声。
  // 目录被锁住（别处开始了任务、正在生成新目录）时：没填内容的表单收掉；填了内容的留着，只是暂时不能保存，
  // 离开页面的确认也继续有效
  const formLost = form !== null && form.kind !== 'root' && !locate(outline, form.uid);
  // 按这一次渲染时的情况判断表单里有没有没保存的内容：章节消失时表单会先卸载、报“没有修改”
  const formDirtyNow = formDirtyRef.current;
  const wasLockedRef = useRef(locked);
  useEffect(() => {
    const justLocked = locked && !wasLockedRef.current;
    wasLockedRef.current = locked;
    if (!form) return;
    if (formLost) {
      if (formDirtyNow) {
        toast.info(
          form.kind === 'edit'
            ? '正在修改的这一章已经不在目录里了，刚才填的标题和说明没有保存。'
            : '要添加新章节的位置已经不在目录里了，刚才填的标题和说明没有保存。'
        );
      }
      setForm(null);
      return;
    }
    if (justLocked && !formDirtyNow) setForm(null);
  }, [form, locked, formLost, formDirtyNow, toast]);

  // 目录刷新或表单关闭之后，把键盘焦点放回刚才操作的地方
  useEffect(() => {
    const request = focusRef.current;
    const root = rootRef.current;
    if (!request || !root) return;
    focusRef.current = null;

    if (request.kind === 'root') {
      const button = root.querySelector<HTMLButtonElement>('button[data-action="root"]');
      if (button) button.focus();
      return;
    }

    let uid: string | null = null;
    let action = '';
    let highlight = false;
    if (request.kind === 'fresh') {
      const known: Record<string, true> = {};
      request.known.forEach((item) => {
        known[item] = true;
      });
      const added = allUids(outline).filter((item) => !known[item]);
      uid = added.length > 0 ? added[0] : null;
      highlight = true;
    } else {
      uid = request.uid;
      if (request.kind === 'action') {
        action = request.action;
        highlight = request.flash;
      }
    }
    if (!uid) return;
    const row = root.querySelector<HTMLElement>(`[data-node-uid="${uid}"]`);
    if (!row) return;
    let target = action ? row.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`) : null;
    if (!target || target.disabled) target = row.querySelector<HTMLButtonElement>('button[data-action]:not(:disabled)');
    if (target) target.focus({ preventScroll: true });
    row.scrollIntoView({ block: 'nearest' });
    if (highlight) setFlash({ uid, at: Date.now() });
  }, [outline, form]);

  const stats = useMemo(() => {
    let written = 0;
    leaves.forEach((leaf) => {
      const chapter = chapters[leaf.uid];
      if (chapter && chapter.chars > 0) written += 1;
    });
    return { written, depth: treeDepth(outline), groups: groupUids(outline), hasResponse: hasResponseChapters(outline) };
  }, [leaves, chapters, outline]);

  const charsOf = (uid: string): number => {
    const chapter = chapters[uid];
    return chapter ? chapter.chars : 0;
  };

  const pages = project.settings.target_pages;
  const average = leaves.length > 0 ? Math.round((pages * project.settings.words_per_page) / leaves.length) : 0;

  const notices: string[] = [];
  if (stats.depth > MAX_COMFORTABLE_LEVELS) {
    notices.push(
      `目录现在有 ${stats.depth} 层。层级太深，评委不容易对照，导出后的标题层次也容易乱，建议控制在 ${MAX_COMFORTABLE_LEVELS} 层以内。`
    );
  }
  if (ws.data.budget_note) {
    notices.push(ws.data.budget_note.replace(/叶子章节/g, '需要撰写的章节'));
  } else if (leaves.length > MAX_COMFORTABLE_LEAVES) {
    notices.push(
      `现在有 ${leaves.length} 个需要撰写的章节。章节越多，每章篇幅越短——按目标 ${pages} 页估算，平均每章只有约 ${formatChars(average)}。可以把内容相近的章节合并起来。`
    );
  }

  /** 保存一棵新的目录树；成功返回 true。保存期间再来的操作直接忽略 */
  const commit = async (next: DraftNode[], failText: string, focus: FocusRequest | null): Promise<boolean> => {
    if (savingRef.current || lockedRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    try {
      // 已有节点原样带回去；新节点没有稳定标识，由后端分配
      const state = await api.saveOutline(projectId, next as OutlineNode[]);
      focusRef.current = focus;
      apply(state);
      setSavedAt(Date.now());
      return true;
    } catch (error) {
      toast.error(errorMessage(error, failText));
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const idle = () => !savingRef.current && !lockedRef.current;

  const closeForm = () => {
    if (!form) return;
    focusRef.current = form.kind === 'root' ? { kind: 'root' } : { kind: 'action', uid: form.uid, action: form.kind, flash: false };
    setForm(null);
  };

  const startAddChild = async (node: OutlineNode) => {
    if (!idle()) return;
    const written = isLeaf(node) ? charsOf(node.uid) : 0;
    if (written > 0) {
      const ok = await confirm({
        title: '这一章已经写了正文，还要添加子章节吗？',
        description: `「${node.id} ${node.title}」已经写了 ${formatChars(written)}。添加子章节之后，它只起分组作用、不再单独撰写，这些正文将不再显示。`,
        confirmText: '继续添加',
        tone: 'danger',
      });
      if (!ok || !idle()) return;
    }
    setCollapsed((prev) => (prev[node.uid] ? { ...prev, [node.uid]: false } : prev));
    setForm({ kind: 'child', uid: node.uid });
  };

  const submitForm = async (title: string, description: string) => {
    if (!form) return;
    const current = outlineRef.current;
    let next: DraftNode[] | null;
    let focus: FocusRequest;
    let failText: string;
    if (form.kind === 'edit') {
      const found = locate(current, form.uid);
      if (found && found.node.title === title && (found.node.description || '') === description) {
        closeForm(); // 什么都没改
        return;
      }
      next = renameNode(current, form.uid, title, description);
      focus = { kind: 'action', uid: form.uid, action: 'edit', flash: true };
      failText = '修改没有保存成功，请重试';
    } else {
      const fresh = newNode(title, description);
      if (form.kind === 'child') next = addChild(current, form.uid, fresh);
      else if (form.kind === 'after') next = addAfter(current, form.uid, fresh);
      else next = addRoot(current, fresh);
      focus = { kind: 'fresh', known: allUids(current) };
      failText = '章节没有添加成功，请重试';
    }
    if (!next) {
      setForm(null);
      return;
    }
    if (await commit(next, failText, focus)) setForm(null);
  };

  const move = async (node: OutlineNode, delta: -1 | 1) => {
    if (!idle()) return;
    const next = moveNode(outlineRef.current, node.uid, delta);
    if (!next) return;
    await commit(next, '移动没有保存成功，请重试', {
      kind: 'action',
      uid: node.uid,
      action: delta < 0 ? 'up' : 'down',
      flash: true,
    });
  };

  const remove = async (node: OutlineNode) => {
    if (!idle()) return;
    const below = countDescendants(node);
    let writtenCount = 0;
    let writtenChars = 0;
    leafUidsOf(node).forEach((uid) => {
      const chars = charsOf(uid);
      if (chars > 0) {
        writtenCount += 1;
        writtenChars += chars;
      }
    });
    const before = locate(outlineRef.current, node.uid);
    const orphan = before && before.parent && before.siblings.length === 1 ? before.parent : null;

    const ok = await confirm({
      title: below > 0 ? '删除这个章节和它下面的全部章节？' : '删除这个章节？',
      description: (
        <div className="space-y-2">
          <p>
            「{node.id} {node.title}」{below > 0 ? `和它下面的 ${below} 个章节` : ''}会从目录里删除，不能撤销。
          </p>
          {writtenCount > 0 && (
            <p className="font-medium text-ink-900">
              {below > 0
                ? `其中 ${writtenCount} 章已经写了正文（共 ${formatChars(writtenChars)}），删除后这些正文将不再显示。`
                : `这一章已经写了 ${formatChars(writtenChars)}正文，删除后正文将不再显示。`}
            </p>
          )}
          {orphan && (
            <p>
              删除后「{orphan.id} {orphan.title}」下面就没有子章节了，它自己会变成需要撰写的章节。
            </p>
          )}
        </div>
      ),
      confirmText: '删除',
      tone: 'danger',
    });
    if (!ok || !idle()) return;

    const current = outlineRef.current;
    const found = locate(current, node.uid);
    const next = removeNode(current, node.uid);
    if (!found || !next) return;
    const neighbor = found.siblings[found.index + 1] || found.siblings[found.index - 1] || found.parent;
    await commit(next, '删除没有保存成功，请重试', neighbor ? { kind: 'row', uid: neighbor.uid } : null);
  };

  const appendResponseChapters = async () => {
    if (!idle()) return;
    savingRef.current = true;
    setSaving(true);
    setAppending(true);
    try {
      const before = outlineRef.current;
      const state = await api.addResponseChapters(projectId);
      focusRef.current = { kind: 'fresh', known: allUids(before) };
      apply(state);
      setSavedAt(Date.now());
      const added = state.project.outline.length - before.length;
      toast.success(`已在目录末尾追加 ${added > 0 ? added : 5} 个响应表型章节`);
    } catch (error) {
      toast.error(errorMessage(error, '响应表型章节没有追加成功，请重试'));
    } finally {
      savingRef.current = false;
      setSaving(false);
      setAppending(false);
    }
  };

  const showActions = !locked && form === null;

  const renderNode = (node: OutlineNode, level: number, index: number, siblings: OutlineNode[]): React.ReactNode => {
    const leaf = isLeaf(node);
    const editing = form !== null && form.kind === 'edit' && form.uid === node.uid;
    const addingChild = form !== null && form.kind === 'child' && form.uid === node.uid;
    const addingAfter = form !== null && form.kind === 'after' && form.uid === node.uid;
    const closed = Boolean(collapsed[node.uid]) && !addingChild;
    const name = `${node.id} ${node.title}`;

    let trailing: React.ReactNode;
    let marker: React.ReactNode;
    if (leaf) {
      const status = chapterStatus(node.uid);
      const chars = charsOf(node.uid);
      marker = (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center">
          <StatusDot status={status} title={chars > 0 ? `${STATUS_HINT[status]} · ${formatChars(chars)}` : STATUS_HINT[status]} />
        </span>
      );
      trailing =
        chars > 0 ? (
          <span className="text-ink-600">{formatChars(chars)}</span>
        ) : (
          <span className="text-ink-400">{status === 'writing' || status === 'queued' ? STATUS_HINT[status] : '待撰写'}</span>
        );
    } else {
      const leafUids = leafUidsOf(node);
      const written = leafUids.filter((uid) => charsOf(uid) > 0).length;
      marker = (
        <button
          type="button"
          aria-expanded={!closed}
          aria-label={`${closed ? '展开' : '收起'} ${name}`}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-400 hover:bg-ink-900/[0.06] hover:text-ink-700"
          onClick={() => setCollapsed((prev) => ({ ...prev, [node.uid]: !closed }))}
        >
          {closed ? <ChevronRightIcon className="h-4 w-4" /> : <ChevronDownIcon className="h-4 w-4" />}
        </button>
      );
      trailing = (
        <span className="text-ink-400" title={`下面有 ${leafUids.length} 个需要撰写的章节${written > 0 ? `，已写 ${written} 个` : ''}`}>
          {written > 0 ? `已写 ${written}/${leafUids.length}` : `${leafUids.length} 章`}
        </span>
      );
    }

    return (
      <React.Fragment key={node.uid}>
        <li className={level === 1 ? 'border-t border-line pt-1 first:border-t-0 first:pt-0 [&:not(:last-child)]:pb-1' : undefined}>
          {editing ? (
            <NodeForm
              label={`编辑 ${name}`}
              number={node.id}
              initialTitle={node.title}
              initialDescription={node.description}
              submitText="保存"
              saving={saving}
              lockedReason={lockedReason}
              regenerating={regenerating}
              onSubmit={(title, description) => void submitForm(title, description)}
              onCancel={closeForm}
              onDirtyChange={handleFormDirty}
            />
          ) : (
            <div
              data-node-uid={node.uid}
              className={cx(
                'group flex items-start gap-1.5 rounded-md py-1.5 pl-1 pr-2 transition-colors duration-300',
                flash && flash.uid === node.uid ? 'bg-primary-50' : 'focus-within:bg-subtle hover:bg-subtle'
              )}
            >
              {marker}
              <div
                className="min-w-0 flex-1"
                title={showActions ? '双击可以修改标题与说明' : undefined}
                onDoubleClick={showActions ? () => idle() && setForm({ kind: 'edit', uid: node.uid }) : undefined}
              >
                <div className="flex flex-wrap items-baseline gap-x-2 text-sm leading-6">
                  <span className="shrink-0 text-[13px] tabular-nums text-ink-400">{node.id}</span>
                  <span className={cx('min-w-0 break-words', TITLE_CLASS[Math.min(level, TITLE_CLASS.length) - 1])}>{node.title}</span>
                  {node.is_response_chapter && (
                    <span
                      className="shrink-0 self-center rounded border border-line-strong px-1.5 text-2xs font-medium text-ink-600"
                      title="响应表型章节：逐条对应招标文件的硬性要求"
                    >
                      响应表
                    </span>
                  )}
                </div>
                {node.description ? <Description text={node.description} /> : null}
              </div>
              {!locked && (
                // 别处开着表单时只是藏起来、仍然占位：标题和说明的折行不会因为表单开关而跳动
                <div
                  className={cx(
                    'flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100',
                    form !== null && 'invisible'
                  )}
                >
                  <IconButton
                    size="sm"
                    data-action="edit"
                    label="编辑标题与说明"
                    icon={<PencilSquareIcon />}
                    onClick={() => idle() && setForm({ kind: 'edit', uid: node.uid })}
                  />
                  <IconButton
                    size="sm"
                    data-action="child"
                    label="添加子章节"
                    icon={<ArrowTurnDownRightIcon />}
                    onClick={() => void startAddChild(node)}
                  />
                  <IconButton
                    size="sm"
                    data-action="after"
                    label="在后面添加同级章节"
                    icon={<PlusIcon />}
                    onClick={() => idle() && setForm({ kind: 'after', uid: node.uid })}
                  />
                  <IconButton
                    size="sm"
                    data-action="up"
                    label="上移"
                    icon={<ArrowUpIcon />}
                    disabled={index === 0}
                    onClick={() => void move(node, -1)}
                  />
                  <IconButton
                    size="sm"
                    data-action="down"
                    label="下移"
                    icon={<ArrowDownIcon />}
                    disabled={index === siblings.length - 1}
                    onClick={() => void move(node, 1)}
                  />
                  <IconButton
                    size="sm"
                    variant="danger"
                    data-action="delete"
                    label="删除"
                    icon={<TrashIcon />}
                    onClick={() => void remove(node)}
                  />
                </div>
              )}
              <div className="w-[4.75rem] shrink-0 pt-0.5 text-right text-xs leading-5 tabular-nums">{trailing}</div>
            </div>
          )}
          {(!leaf && !closed) || addingChild ? (
            <ul className="ml-[15px] border-l border-line pl-1.5">
              {(node.children || []).map((child, childIndex, list) => renderNode(child, level + 1, childIndex, list))}
              {addingChild && (
                <li>
                  <NodeForm
                    label={`在 ${name} 下面添加子章节`}
                    number={nextChildNumber(node)}
                    submitText="添加"
                    saving={saving}
                    lockedReason={lockedReason}
                    regenerating={regenerating}
                    onSubmit={(title, description) => void submitForm(title, description)}
                    onCancel={closeForm}
                    onDirtyChange={handleFormDirty}
                  />
                </li>
              )}
            </ul>
          ) : null}
        </li>
        {addingAfter && (
          <li>
            <NodeForm
              label={`在 ${name} 后面添加同级章节`}
              number={nextSiblingNumber(node)}
              submitText="添加"
              saving={saving}
              lockedReason={lockedReason}
              regenerating={regenerating}
              onSubmit={(title, description) => void submitForm(title, description)}
              onCancel={closeForm}
              onDirtyChange={handleFormDirty}
            />
          </li>
        )}
      </React.Fragment>
    );
  };

  const addingRoot = form !== null && form.kind === 'root';
  const rootForm = addingRoot ? (
    <NodeForm
      label="添加一级章节"
      number={String(outline.length + 1)}
      submitText="添加"
      saving={saving}
      lockedReason={lockedReason}
      regenerating={regenerating}
      onSubmit={(title, description) => void submitForm(title, description)}
      onCancel={closeForm}
      onDirtyChange={handleFormDirty}
    />
  ) : null;

  if (outline.length === 0) {
    return (
      <section ref={rootRef} aria-label="目录" className="rounded-lg border border-dashed border-line-strong bg-white">
        {rootForm ? (
          <div className="p-3">{rootForm}</div>
        ) : (
          <EmptyState
            icon={<QueueListIcon />}
            title="还没有目录"
            description={
              locked
                ? lockedReason
                : '在上面选一种方式，让模型生成目录。也可以不用模型，自己从第一章开始搭。'
            }
            action={
              <Button data-action="root" icon={<PlusIcon />} disabled={locked} onClick={() => idle() && setForm({ kind: 'root' })}>
                自己添加一级章节
              </Button>
            }
          />
        )}
      </section>
    );
  }

  const anyCollapsed = stats.groups.some((uid) => Boolean(collapsed[uid]));
  const allCollapsed = stats.groups.length > 0 && stats.groups.every((uid) => Boolean(collapsed[uid]));

  return (
    <section ref={rootRef} aria-label="目录" aria-busy={saving} className="rounded-lg border border-line bg-white shadow-card">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line px-4 py-3">
        <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <Stat label="一级章节" value={outline.length} />
          <Stat label="需要撰写的章节" value={leaves.length} hint="最末一级的章节，每个都会单独写一篇正文；上级标题只起分组作用" />
          {stats.written > 0 && <Stat label="已写" value={`${stats.written} 章`} />}
          {average > 0 && (
            <Stat
              label="平均每章"
              value={`约 ${formatChars(average)}`}
              hint={`按写作设置里的目标 ${pages} 页、每页 ${project.settings.words_per_page} 字估算`}
            />
          )}
        </dl>
        <div className="ml-auto flex items-center gap-1">
          <span className="mr-1 flex items-center gap-1 text-xs text-ink-500" aria-live="polite">
            {slow ? (
              <>
                <Spinner size="sm" tone="muted" label="正在保存" />
                正在保存…
              </>
            ) : justSaved && !saving ? (
              <>
                <CheckIcon className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
                已保存
              </>
            ) : null}
          </span>
          <Button size="sm" variant="ghost" disabled={!anyCollapsed} onClick={() => setCollapsed({})}>
            全部展开
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={stats.groups.length === 0 || allCollapsed}
            onClick={() => {
              const next: Record<string, boolean> = {};
              stats.groups.forEach((uid) => {
                next[uid] = true;
              });
              setCollapsed(next);
            }}
          >
            全部收起
          </Button>
        </div>
      </div>

      {lockedReason && (
        <div className="flex items-center gap-2 border-b border-line bg-subtle px-4 py-2 text-xs leading-5 text-ink-600">
          <LockClosedIcon className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />
          {lockedReason}
        </div>
      )}

      {notices.map((notice) => (
        <div key={notice} className="flex items-start gap-2 border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs leading-5 text-amber-800">
          <InformationCircleIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {notice}
        </div>
      ))}

      <div className="px-2 py-2">
        <ul>
          {outline.map((node, index, list) => renderNode(node, 1, index, list))}
          {rootForm && <li>{rootForm}</li>}
        </ul>
        {showActions && (
          <button
            type="button"
            data-action="root"
            className="mt-1 flex w-full items-center gap-1.5 rounded-md py-1.5 pl-2 pr-2 text-left text-[13px] text-ink-500 transition-colors hover:bg-subtle hover:text-ink-900"
            onClick={() => idle() && setForm({ kind: 'root' })}
          >
            <PlusIcon className="h-4 w-4" aria-hidden="true" />
            添加一级章节
          </button>
        )}
      </div>

      {!stats.hasResponse && (
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-b-lg border-t border-line bg-subtle px-4 py-3">
          <ClipboardDocumentCheckIcon className="mt-0.5 h-5 w-5 shrink-0 text-ink-400" aria-hidden="true" />
          <div className="min-w-0 flex-1 basis-80">
            <p className="text-[13px] font-medium leading-5 text-ink-900">响应表型章节</p>
            <p className="mt-0.5 text-xs leading-5 text-ink-500">
              在目录末尾追加采购公告响应、评审办法逐项响应表、合同响应、采购人要求逐项响应、资格与商务响应五个章节，用于逐条对应招标文件的硬性要求。
            </p>
          </div>
          <Button
            size="sm"
            icon={<PlusIcon />}
            loading={appending}
            disabled={locked || form !== null || (saving && !appending)}
            onClick={() => void appendResponseChapters()}
          >
            追加响应表型章节
          </Button>
        </div>
      )}
    </section>
  );
}
