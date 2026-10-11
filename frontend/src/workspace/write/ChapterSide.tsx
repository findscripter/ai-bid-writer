/**
 * 正文页右侧：本章的写作计划、待处理问题、待补充信息、摘记。
 */
import React, { memo, useEffect, useMemo, useState } from 'react';
import { ApiError, api, errorMessage } from '../../api/client';
import type { ChapterPlan, ChapterView, LeafInfo, RequirementItem, ReviewIssue } from '../../api/types';
import { Link } from '../../lib/router';
import { Badge, Button, Textarea, Tooltip, useToast } from '../../ui';
import type { BadgeTone } from '../../ui';
import { useWorkspace } from '../WorkspaceContext';

const FORM_LABEL: Record<string, string> = {
  paragraph: '以段落为主',
  table: '以表格为主',
  steps: '以流程步骤为主',
  mixed: '段落、列表、表格结合',
};

const SEVERITY: Record<string, { tone: BadgeTone; label: string }> = {
  high: { tone: 'danger', label: '重要' },
  medium: { tone: 'warning', label: '一般' },
  low: { tone: 'neutral', label: '提示' },
};

const PLACEHOLDER_RE = /【待(?:补充|填写|填|定|确认)[^】]{0,80}】/g;

function Section({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-4 last:border-b-0">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">{title}</h3>
        {extra}
      </div>
      {children}
    </section>
  );
}

interface ChapterSideProps {
  leaf: LeafInfo;
  chapter: ChapterView | undefined;
  plan: ChapterPlan | undefined;
  hasBlueprint: boolean;
  requirements: RequirementItem[];
  issues: ReviewIssue[];
  running: boolean;
  /** 正文正在编辑：这时不能按问题修订（修订用的是已保存的正文，会和编辑框里的修改互相覆盖） */
  editing: boolean;
  onFix: (issue: ReviewIssue) => void;
  /** “补充要求”有没有还没保存的修改（切换章节、离开页面前要确认） */
  onNoteDirtyChange: (dirty: boolean) => void;
}

function ChapterSideImpl({
  leaf,
  chapter,
  plan,
  hasBlueprint,
  requirements,
  issues,
  running,
  editing,
  onFix,
  onNoteDirtyChange,
}: ChapterSideProps) {
  const ws = useWorkspace();
  const toast = useToast();
  const savedNote = plan ? plan.note : '';
  const [note, setNote] = useState(savedNote);
  const [savingNote, setSavingNote] = useState(false);
  // 写作计划在重新生成：生成结束时会整体保存新计划，这期间改补充要求会被后端拒绝
  const planning = ws.running && ws.job !== null && ws.job.kind === 'plan';

  // 输入框只在换章、或已保存的内容真的变了时才跟着同步。任务结束、改项目名等引起的整体刷新
  // 会换掉计划对象，但不应该冲掉使用者还没保存的输入
  const [noteBase, setNoteBase] = useState({ uid: leaf.uid, saved: savedNote });
  if (noteBase.uid !== leaf.uid) {
    setNoteBase({ uid: leaf.uid, saved: savedNote });
    setNote(savedNote);
  } else if (noteBase.saved !== savedNote) {
    setNoteBase({ uid: leaf.uid, saved: savedNote });
    // 没动过输入框就跟上新的内容；动过就保留使用者填的
    if (note.trim() === noteBase.saved) setNote(savedNote);
  }

  const requirementById = useMemo(() => {
    const map: Record<string, RequirementItem> = {};
    requirements.forEach((item) => {
      map[item.id] = item;
    });
    return map;
  }, [requirements]);

  const placeholders = useMemo(() => {
    const found: string[] = (chapter ? chapter.content : '').match(PLACEHOLDER_RE) || [];
    return found.filter((text, index) => found.indexOf(text) === index);
  }, [chapter]);

  const saveNote = async () => {
    if (!plan || planning) return;
    setSavingNote(true);
    try {
      // 只提交这一章的补充要求：页面上的计划可能已经过时（别处刚改过要点、权重），不能整份写回去
      ws.apply(await api.saveBlueprint(ws.projectId, { notes: { [leaf.uid]: note.trim() } }));
      toast.success('已保存，本章下次撰写或重写时生效');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        toast.error('写作计划正在重新生成，现在保存不了。填写的内容还留在输入框里，等生成结束后再点保存。', {
          title: '补充要求没有保存',
        });
        // 计划任务可能是在别的标签页里开始的：重新同步一次，页面上就能看到它的进度
        void ws.reload();
      } else {
        toast.error(errorMessage(error, '保存失败'));
        // 这一章的计划在别处被删掉了（后端说还没有写作计划）：同步一次，右侧随即显示实际情况
        if (error instanceof ApiError && error.status === 400) void ws.reload();
      }
    } finally {
      setSavingNote(false);
    }
  };

  const noteDirty = plan ? note.trim() !== plan.note : false;
  // 这一章还没有正文时不能按问题修订（修订是在现有正文上改，后端会拒绝）
  const hasContent = Boolean(chapter && chapter.content.replace(/\s/g, '').length > 0);
  // 写作计划页支持直接打开“章节计划”并展开这一章
  const planLink = hasBlueprint
    ? `/projects/${ws.projectId}/plan?tab=chapters&chapter=${encodeURIComponent(leaf.uid)}`
    : `/projects/${ws.projectId}/plan`;

  useEffect(() => {
    onNoteDirtyChange(noteDirty);
  }, [noteDirty, onNoteDirtyChange]);

  // 卸载时（离开正文页）不再算有未保存的修改
  useEffect(() => () => onNoteDirtyChange(false), [onNoteDirtyChange]);

  return (
    <div className="h-full overflow-y-auto bg-white text-[13px] leading-6 text-ink-700">
      <Section
        title="本章计划"
        extra={
          <Link to={planLink} className="text-xs text-primary-600 hover:underline">
            {hasBlueprint ? (plan ? '调整计划' : '去补全') : '去制定'}
          </Link>
        }
      >
        {!plan ? (
          <p className="text-ink-500">
            {hasBlueprint
              ? '这一章还没有写作计划（可能是后来新增的章节），到“写作计划”里补全。'
              : '还没有写作计划。没有计划也能写，但各章之间不会共享统一口径，容易重复或前后不一。'}
          </p>
        ) : (
          <div className="space-y-3">
            {plan.key_points.length > 0 && (
              <div>
                <p className="mb-1 text-xs text-ink-400">必须写到的要点</p>
                <ol className="list-decimal space-y-1 pl-4">
                  {plan.key_points.map((point, index) => (
                    <li key={index}>{point}</li>
                  ))}
                </ol>
              </div>
            )}
            {plan.requirement_ids.length > 0 && (
              <div>
                <p className="mb-1 text-xs text-ink-400">负责响应的评分项 / 采购人要求</p>
                <div className="flex flex-wrap gap-1.5">
                  {plan.requirement_ids.map((rid) => {
                    const item = requirementById[rid];
                    const auto = plan.auto_assigned.indexOf(rid) >= 0;
                    return (
                      <Tooltip
                        key={rid}
                        side="left"
                        content={
                          item ? (
                            <span className="block max-w-xs whitespace-normal">
                              <strong>{item.name}</strong>
                              {item.score ? `（${item.score}）` : ''}
                              {item.detail ? <span className="mt-1 block">{item.detail}</span> : null}
                              {auto ? <span className="mt-1 block opacity-80">系统按内容相近自动分配到本章</span> : null}
                            </span>
                          ) : (
                            rid
                          )
                        }
                      >
                        <Badge tone={auto ? 'warning' : 'primary'} size="sm">
                          {rid}
                          {item ? ` ${item.name.slice(0, 10)}` : ''}
                        </Badge>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>
            )}
            {plan.avoid.length > 0 && (
              <div>
                <p className="mb-1 text-xs text-ink-400">不在本章展开</p>
                <ul className="list-disc space-y-1 pl-4">
                  {plan.avoid.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-xs text-ink-500">
              呈现形式：{FORM_LABEL[plan.form] || plan.form} · 篇幅权重 {plan.weight.toFixed(1)}
            </p>
            <div>
              <p className="mb-1 text-xs text-ink-400">对本章的补充要求</p>
              <Textarea
                rows={2}
                autoResize
                value={note}
                disabled={planning}
                placeholder="例如：重点写与现有 DCS 系统的对接方式"
                onChange={(event) => setNote(event.target.value)}
                className="text-[13px]"
              />
              {planning && (
                <p className="mt-1 text-xs leading-5 text-amber-700">
                  写作计划正在重新生成，结束后才能修改补充要求（已保存的补充要求会保留）。
                </p>
              )}
              {noteDirty && (
                <div className="mt-1.5 flex justify-end gap-1.5">
                  <Button size="sm" variant="ghost" disabled={savingNote} onClick={() => setNote(plan.note)}>
                    撤销
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={savingNote}
                    disabled={planning}
                    title={planning ? '写作计划正在重新生成，结束后再保存' : undefined}
                    onClick={() => void saveNote()}
                  >
                    保存
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </Section>

      <Section
        title={`待处理问题${issues.length ? `（${issues.length}）` : ''}`}
        extra={
          <Link to={`/projects/${ws.projectId}/review`} className="text-xs text-primary-600 hover:underline">
            全部问题
          </Link>
        }
      >
        {issues.length === 0 ? (
          <p className="text-ink-400">暂无。写完后到“审校”里检查一遍。</p>
        ) : (
          <>
            {editing && issues.some((issue) => issue.fixable && issue.fix_instruction) && (
              <p className="mb-2 text-xs leading-5 text-amber-700">正在编辑正文。先保存或取消编辑，才能按问题修订。</p>
            )}
            {!editing && !hasContent && issues.some((issue) => issue.fixable && issue.fix_instruction) && (
              <p className="mb-2 text-xs leading-5 text-amber-700">这一章还没有正文，先撰写再按问题修订。</p>
            )}
            <ul className="space-y-2.5">
              {issues.map((issue) => {
                const severity = SEVERITY[issue.severity] || SEVERITY.low;
                return (
                  <li key={issue.id} className="rounded-md border border-line bg-subtle px-3 py-2">
                    <div className="flex items-start gap-2">
                      <Badge tone={severity.tone} size="sm" className="mt-0.5 shrink-0 whitespace-nowrap">
                        {severity.label}
                      </Badge>
                      <p className="min-w-0 flex-1 font-medium text-ink-900">{issue.title}</p>
                    </div>
                    {issue.detail && <p className="mt-1 text-xs leading-5 text-ink-600">{issue.detail}</p>}
                    {issue.fixable && issue.fix_instruction && (
                      <div className="mt-2 flex justify-end">
                        <Button
                          size="sm"
                          disabled={running || editing || !hasContent}
                          title={
                            editing
                              ? '正在编辑正文：先保存或取消编辑，再按问题修订'
                              : !hasContent
                                ? '这一章还没有正文，先撰写再修订'
                                : undefined
                          }
                          onClick={() => onFix(issue)}
                        >
                          按此修订
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Section>

      <Section title={`待补充信息${placeholders.length ? `（${placeholders.length}）` : ''}`}>
        {placeholders.length === 0 ? (
          <p className="text-ink-400">本章没有需要投标人补充的占位。</p>
        ) : (
          <>
            <ul className="space-y-1">
              {placeholders.map((text) => (
                <li key={text} className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
                  {text}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-ink-400">这些是模型拿不到的企业信息，导出前请在“编辑”里填上真实内容。</p>
          </>
        )}
      </Section>

      {chapter && chapter.digest && (chapter.digest.summary || chapter.digest.claims.length > 0) && (
        <Section title="本章摘记">
          {chapter.digest.summary && <p className="text-ink-600">{chapter.digest.summary}</p>}
          {chapter.digest.claims.length > 0 && (
            <>
              <p className="mb-1 mt-2 text-xs text-ink-400">本章出现的数字与承诺（用于核对前后一致）</p>
              <ul className="list-disc space-y-1 pl-4 text-xs text-ink-600">
                {chapter.digest.claims.map((claim) => (
                  <li key={claim}>{claim}</li>
                ))}
              </ul>
            </>
          )}
        </Section>
      )}
    </div>
  );
}

export const ChapterSide = memo(ChapterSideImpl);
