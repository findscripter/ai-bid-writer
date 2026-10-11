/**
 * 正文页的两个弹层：按要求修订、历史版本。
 */
import React, { useEffect, useRef, useState } from 'react';
import { ApiError, api, errorMessage } from '../../api/client';
import type { ChapterDetail, ChapterVersion, ChapterView, LeafInfo } from '../../api/types';
import { formatChars, formatRelativeTime } from '../../lib/format';
import { MarkdownView } from '../../lib/MarkdownView';
import { Badge, Button, Drawer, EmptyState, Field, Modal, Spinner, Textarea, useConfirm, useToast } from '../../ui';
import { useWorkspace } from '../WorkspaceContext';

const PRESETS = [
  '写得更具体：补充实施步骤、责任分工和交付物',
  '压缩篇幅：删掉重复和空泛的表述',
  '逐条对照本章负责的评分项，补充没有响应到的内容',
  '把并列的内容整理成表格',
  '语气更平实，去掉宣传性的形容词',
];

const SOURCE_LABEL: Record<string, string> = { ai: 'AI 撰写', manual: '手动编辑', revised: 'AI 修订' };

export function toChapterView(detail: ChapterDetail): ChapterView {
  const { versions, ...rest } = detail;
  return { ...rest, version_count: versions.length };
}

interface ReviseModalProps {
  open: boolean;
  leaf: LeafInfo;
  /** 预填的修改要求（例如来自审校问题） */
  initial?: string;
  onClose: () => void;
}

export function ReviseModal({ open, leaf, initial, onClose }: ReviseModalProps) {
  const ws = useWorkspace();
  const toast = useToast();
  const [instruction, setInstruction] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) setInstruction(initial || '');
  }, [open, initial]);

  const submit = async () => {
    const text = instruction.trim();
    if (!text) return;
    setSubmitting(true);
    const ok = await ws.startJob('revise', { uid: leaf.uid, instruction: text }, (message) => toast.error(message));
    setSubmitting(false);
    if (ok) onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={`修订：${leaf.id} ${leaf.title}`}
      description="说明要怎么改。模型会在现有正文的基础上修改，只动与要求有关的部分；修改前的版本会保留在历史版本里。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={!instruction.trim()} loading={submitting} onClick={() => void submit()}>
            开始修订
          </Button>
        </>
      }
    >
      <Field label="修改要求" required>
        <Textarea
          autoFocus
          rows={5}
          value={instruction}
          placeholder="例如：补充系统响应时间不超过 3 秒的达成措施"
          onChange={(event) => setInstruction(event.target.value)}
        />
      </Field>
      <div className="mt-3 flex flex-wrap gap-2">
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => setInstruction((prev) => (prev.trim() ? `${prev.trim()}\n${preset}` : preset))}
            className="rounded-full border border-line bg-white px-2.5 py-1 text-xs text-ink-600 hover:border-primary-300 hover:text-primary-700"
          >
            {preset}
          </button>
        ))}
      </div>
    </Modal>
  );
}

interface VersionsDrawerProps {
  open: boolean;
  leaf: LeafInfo;
  onClose: () => void;
}

/** 一个历史版本的标识（列表重新载入后，展开状态跟着版本走，而不是跟着位置走） */
function versionKey(version: ChapterVersion): string {
  return `${version.saved_at}|${version.source}|${version.content.length}`;
}

/** 正文或历史版本变了，这个值就会变 */
function chapterStamp(updatedAt: string, versionCount: number): string {
  return `${updatedAt}|${versionCount}`;
}

export function VersionsDrawer({ open, leaf, onClose }: VersionsDrawerProps) {
  const ws = useWorkspace();
  const toast = useToast();
  const confirm = useConfirm();
  const [detail, setDetail] = useState<ChapterDetail | null>(null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  const detailRef = useRef<ChapterDetail | null>(null);
  detailRef.current = detail;

  // 每次打开、换章时从空白开始重新取；关上时不清空，免得收起的动画里内容闪成加载中
  const viewKey = open ? `${ws.projectId}|${leaf.uid}` : null;
  const [shownKey, setShownKey] = useState<string | null>(null);
  if (viewKey !== null && viewKey !== shownKey) {
    setShownKey(viewKey);
    setDetail(null);
    setError('');
    setExpanded(null);
  } else if (viewKey === null && shownKey !== null) {
    setShownKey(null);
  }

  // 抽屉开着时这一章被重写、修订或恢复过：历史版本整体后移了一位，必须重新取，
  // 否则按旧列表的位置恢复，恢复的会是相邻的另一个版本
  const chapter = ws.data.chapters[leaf.uid];
  const stamp = chapter ? chapterStamp(chapter.updated_at, chapter.version_count) : '';
  // 取回的这一章交给外层之前和页面上已有的比一比：不比它旧才放进去（事件流可能先送来了更新的一份）
  const chapterRef = useRef(chapter);
  chapterRef.current = chapter;
  const putChapter = (next: ChapterDetail) => {
    const current = chapterRef.current;
    if (current && (current.updated_at || '') > (next.updated_at || '')) return;
    ws.setChapter(toChapterView(next));
  };
  useEffect(() => {
    if (!open) return undefined;
    const current = detailRef.current;
    if (current && current.uid === leaf.uid && chapterStamp(current.updated_at, current.versions.length) === stamp) {
      return undefined;
    }
    let cancelled = false;
    api
      .getChapter(ws.projectId, leaf.uid)
      .then((next) => {
        if (cancelled) return;
        setDetail(next);
        setError('');
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e, '历史版本加载失败'));
      });
    return () => {
      cancelled = true;
    };
  }, [open, ws.projectId, leaf.uid, stamp]);

  const restore = async (index: number, version: ChapterVersion) => {
    const ok = await confirm({
      title: '恢复这个版本？',
      description: '当前的正文会换进历史版本里，不会丢。',
      confirmText: '恢复',
    });
    if (!ok) return;
    setRestoring(index);
    try {
      // 带上这个版本的保存时间：列表在此期间变过，后端会拒绝，不会恢复错
      const next = await api.restoreChapter(ws.projectId, leaf.uid, index, version.saved_at);
      setDetail(next);
      setExpanded(null);
      putChapter(next);
      toast.success('已恢复所选版本');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'versions_changed') {
        toast.error('历史版本刚刚有了变化（可能是重新生成、修订，或者在别处保存过），列表已经重新载入，请确认后再选一次。', {
          title: '没有恢复',
        });
        try {
          const fresh = await api.getChapter(ws.projectId, leaf.uid);
          setDetail(fresh);
          setExpanded(null);
          putChapter(fresh);
        } catch {
          // 取不到就等下次打开再取
        }
      } else {
        toast.error(errorMessage(e, '恢复失败'));
        // 这一章正在生成（任务可能是在别的标签页里开始的）：同步一次，页面上就能看到它
        if (e instanceof ApiError && e.code === 'chapter_busy') void ws.reload();
      }
    } finally {
      setRestoring(null);
    }
  };

  return (
    <Drawer open={open} onClose={onClose} width={560} title="历史版本" description={`${leaf.id} ${leaf.title} · 最多保留最近 5 个版本`}>
      {error && <p className="text-sm text-rose-600">{error}</p>}
      {!detail && !error && (
        <div className="flex justify-center py-10">
          <Spinner label="正在加载" />
        </div>
      )}
      {detail && detail.versions.length === 0 && <EmptyState title="还没有历史版本" description="重写、修订或手动编辑之后，之前的内容会保存在这里。" />}
      {detail && detail.versions.length > 0 && ws.running && (
        <p className="mb-3 text-xs leading-5 text-amber-700">有任务正在进行，结束后才能恢复。任务改动这一章时，列表会自动更新。</p>
      )}
      {detail && detail.versions.length > 0 && (
        <ul className="space-y-3">
          {detail.versions.map((version, index) => {
            const key = versionKey(version);
            const shown = expanded === key;
            return (
              <li key={`${key}-${index}`} className="rounded-lg border border-line bg-white">
                <div className="flex items-center gap-2 px-3 py-2">
                  <Badge tone="neutral" size="sm">
                    {SOURCE_LABEL[version.source] || version.source}
                  </Badge>
                  <span className="text-xs text-ink-500">{formatRelativeTime(version.saved_at)}</span>
                  <span className="text-xs text-ink-400">{formatChars(version.content.replace(/\s/g, '').length)}</span>
                  <div className="ml-auto flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setExpanded(shown ? null : key)}>
                      {shown ? '收起' : '查看'}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={restoring === index}
                      disabled={ws.running || restoring !== null}
                      onClick={() => void restore(index, version)}
                    >
                      恢复
                    </Button>
                  </div>
                </div>
                {version.note && <p className="border-t border-line px-3 py-1.5 text-xs text-ink-500">{version.note}</p>}
                {shown && (
                  <div className="max-h-96 overflow-y-auto border-t border-line px-3 py-2">
                    <MarkdownView content={version.content} variant="compact" />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Drawer>
  );
}
