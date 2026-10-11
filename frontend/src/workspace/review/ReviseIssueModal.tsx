/**
 * 「让模型修订」的确认框：确认要修订哪一章、交给模型的修改要求是什么。
 * 问题涉及多章时让使用者选一章，默认选按目录顺序最靠后、且有正文的那一章（前面的表述保持不动）。
 * 前后矛盾的问题要看建议里以哪一处为准，所以额外提醒使用者核对再选。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { LeafInfo, ReviewIssue } from '../../api/types';
import { Button, Modal, cx, useToast } from '../../ui';
import { useWorkspace } from '../WorkspaceContext';
import { issueKind, issueTypeLabel, plainText } from './shared';

interface Candidate {
  uid: string;
  leaf: LeafInfo;
  /** 有正文才能修订 */
  hasText: boolean;
}

interface ReviseIssueModalProps {
  /** 要修订的问题；为 null 时关闭 */
  issue: ReviewIssue | null;
  onClose: () => void;
}

export function ReviseIssueModal({ issue, onClose }: ReviseIssueModalProps) {
  const ws = useWorkspace();
  const toast = useToast();
  // 关闭动画期间继续显示刚才那个问题，避免内容先消失再淡出
  const lastIssue = useRef<ReviewIssue | null>(issue);
  if (issue) lastIssue.current = issue;
  const current = issue || lastIssue.current;

  const { leafByUid } = ws;
  const { chapters, leaves } = ws.data;

  // 候选章节按当前目录的顺序排（检查之后目录可能调整过顺序），“靠后的一章”才名副其实
  const candidates = useMemo<Candidate[]>(() => {
    if (!current) return [];
    const order: Record<string, number> = {};
    leaves.forEach((leaf, index) => {
      order[leaf.uid] = index;
    });
    const list: Candidate[] = [];
    current.chapter_uids.forEach((uid) => {
      const leaf = leafByUid[uid];
      if (!leaf || list.some((item) => item.uid === uid)) return;
      const chapter = chapters[uid];
      list.push({ uid, leaf, hasText: Boolean(chapter && chapter.chars > 0) });
    });
    return list.sort((a, b) => order[a.uid] - order[b.uid]);
  }, [current, leafByUid, leaves, chapters]);

  const [picked, setPicked] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 每次打开时默认选最靠后、且有正文的一章
  const issueId = issue ? issue.id : null;
  useEffect(() => {
    if (!issueId) return;
    let fallback: string | null = null;
    candidates.forEach((item) => {
      if (item.hasText) fallback = item.uid;
    });
    setPicked(fallback);
    // 只在换了一个问题时重置选择；章节数据的后续刷新不应该改掉使用者的选择
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueId]);

  const selected = candidates.find((item) => item.uid === picked && item.hasText);

  const submit = async () => {
    if (!current || !selected) return;
    setSubmitting(true);
    const ok = await ws.startJob('revise', { uid: selected.uid, instruction: current.fix_instruction }, (message) =>
      toast.error(message, { title: '没能开始修订' })
    );
    setSubmitting(false);
    if (ok) {
      toast.info(`正在修订「${selected.leaf.id} ${selected.leaf.title}」，完成后会自动重新检查。`);
      onClose();
    }
  };

  const multiple = candidates.length > 1;
  const contradiction = current !== null && current.type === 'consistency';
  // 默认选中的那一章（按目录顺序最靠后、有正文）：标注只落在它身上
  let defaultUid: string | null = null;
  candidates.forEach((item) => {
    if (item.hasText) defaultUid = item.uid;
  });
  // 只有它恰好是候选里按目录顺序的最后一章，才是“靠后的一章”；
  // 靠后的章节现在没有正文时，说清楚为什么默认选了它
  const defaultIndex = candidates.findIndex((item) => item.uid === defaultUid);
  const laterEmpty = defaultIndex >= 0 ? candidates.slice(defaultIndex + 1) : [];
  const laterNames = laterEmpty.map((item) => item.leaf.id).join('、');
  let suggestedNote = '';
  if (defaultIndex >= 0) {
    if (laterEmpty.length === 0) suggestedNote = contradiction ? '靠后的一章，默认改这一章' : '靠后的一章，一般改这一章';
    else suggestedNote = `默认选这一章：靠后的 ${laterNames} 还没有正文`;
  }

  return (
    <Modal
      open={issue !== null}
      onClose={onClose}
      size="md"
      title="让模型修订"
      description="模型会在现有正文上修改，只动与这个问题有关的部分。修订会生成新版本，旧版本保留在“历史版本”里，随时可以恢复。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={submitting} disabled={!selected || ws.running} onClick={() => void submit()} data-autofocus>
            开始修订
          </Button>
        </>
      }
    >
      {current && (
        <div className="space-y-4 text-[13px] leading-6">
          <div>
            <p className="text-xs text-ink-500">要解决的问题 · {issueTypeLabel(issueKind(current))}</p>
            <p className="mt-0.5 font-medium text-ink-900">{plainText(current.title)}</p>
          </div>

          <div>
            <p className="text-xs text-ink-500">{multiple ? '修订哪一章' : '修订的章节'}</p>
            {candidates.length === 0 ? (
              <p className="mt-1 text-rose-600">这个问题涉及的章节已经不在目录里了，请先重新检查。</p>
            ) : multiple ? (
              <div className="mt-1.5 space-y-1.5" role="radiogroup" aria-label="修订哪一章">
                {candidates.map((item) => {
                  const checked = item.uid === picked;
                  const suggested = item.uid === defaultUid;
                  return (
                    <label
                      key={item.uid}
                      className={cx(
                        'flex items-center gap-2.5 rounded-md border px-3 py-2 transition-colors',
                        !item.hasText
                          ? 'cursor-not-allowed border-line bg-subtle text-ink-400'
                          : checked
                            ? 'cursor-pointer border-primary-300 bg-primary-50 text-ink-900'
                            : 'cursor-pointer border-line bg-white text-ink-700 hover:border-line-strong'
                      )}
                    >
                      <input
                        type="radio"
                        name="revise-chapter"
                        className="h-4 w-4 shrink-0 border-line-strong text-primary-600 focus:ring-0 focus:ring-offset-0 disabled:opacity-50"
                        checked={checked}
                        disabled={!item.hasText}
                        onChange={() => setPicked(item.uid)}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="mr-1 tabular-nums text-ink-400">{item.leaf.id}</span>
                        {item.leaf.title}
                      </span>
                      <span className="shrink-0 text-xs text-ink-400">
                        {!item.hasText ? '还没有正文，不能修订' : suggested ? suggestedNote : ''}
                      </span>
                    </label>
                  );
                })}
                {laterEmpty.length > 0 && (
                  <p className="pt-0.5 text-xs leading-5 text-amber-700">
                    靠后的 {laterNames} 现在没有正文，这个问题检查之后情况已经变了，可能已经不存在。建议先关掉这里、回到审校页重新检查，再决定要不要修订。
                  </p>
                )}
                {contradiction && (
                  <p className="pt-0.5 text-xs leading-5 text-ink-500">
                    前后矛盾时，要改的是说法不对的那一章：先看下面修改要求里的建议以哪一处为准，再选。拿不准的话，先关掉这里，点“查看章节”核对原文。
                  </p>
                )}
              </div>
            ) : (
              <p className="mt-0.5 text-ink-900">
                <span className="mr-1 tabular-nums text-ink-400">{candidates[0].leaf.id}</span>
                {candidates[0].leaf.title}
                {!candidates[0].hasText && <span className="ml-2 text-rose-600">这一章还没有正文，不能修订。</span>}
              </p>
            )}
          </div>

          <div>
            <p className="text-xs text-ink-500">交给模型的修改要求</p>
            <div className="mt-1.5 max-h-44 overflow-y-auto whitespace-pre-line rounded-md border border-line bg-subtle px-3 py-2 text-xs leading-5 text-ink-600">
              {plainText(current.fix_instruction)}
            </div>
          </div>

          {ws.running && <p className="text-xs text-amber-700">有任务正在进行，等它结束后才能开始修订。</p>}
        </div>
      )}
    </Modal>
  );
}
