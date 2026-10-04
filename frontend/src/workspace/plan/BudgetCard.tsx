/**
 * 篇幅：目标页数 × 每页字数 = 全书目标字数。目标页数可以直接改。
 */
import React, { useEffect, useRef, useState } from 'react';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { api, errorMessage } from '../../api/client';
import { formatChars } from '../../lib/format';
import { Button, NumberInput, useToast } from '../../ui';
import { useWorkspace } from '../WorkspaceContext';

interface BudgetCardProps {
  /** 不能修改的原因（有任务在跑）；可以修改时为 null */
  lockedReason: string | null;
  /** 改了页数还没有应用（离开页面前要提醒） */
  onDirtyChange?: (dirty: boolean) => void;
}

export function BudgetCard({ lockedReason, onDirtyChange }: BudgetCardProps) {
  const ws = useWorkspace();
  const toast = useToast();
  const settings = ws.data.project.settings;
  const saved = settings.target_pages;
  const leafCount = ws.data.leaves.length;

  const [pages, setPages] = useState(saved);
  const [seen, setSeen] = useState(saved);
  // 本页改了页数还没应用时，别处（正文页的“写作设置”、另一个标签页）也改了页数
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const [saving, setSaving] = useState(false);
  // 别处改了页数：本页没动过就跟上；动过就保留本页的输入，提示应用会覆盖那边的修改
  if (seen !== saved) {
    const untouched = pages === seen || pages === saved;
    setSeen(saved);
    if (untouched) {
      setPages(saved);
      setChangedElsewhere(false);
    } else {
      setChangedElsewhere(true);
    }
  }
  // 回车提交时，输入框刚钳制出来的值可能还没进入本次渲染，用 ref 取最新的
  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  const dirty = pages !== saved;
  useEffect(() => {
    if (!onDirtyChange) return undefined;
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  const total = pages * settings.words_per_page;
  const average = leafCount > 0 ? Math.round(total / leafCount) : 0;

  const change = (value: number) => {
    pagesRef.current = value;
    setPages(value);
  };

  const revert = () => {
    change(saved);
    setChangedElsewhere(false);
  };

  const apply = async () => {
    const next = pagesRef.current;
    if (next === saved || saving || lockedReason) return;
    setSaving(true);
    try {
      const state = await api.patchProject(ws.projectId, { settings: { ...settings, target_pages: next } });
      ws.apply(state);
      // 记下应用后的页数，不把自己的修改当成“别处改过”
      setSeen(state.project.settings.target_pages);
      setChangedElsewhere(false);
      toast.success(`目标页数已改为 ${next} 页，各章的目标字数已重新分配`);
    } catch (error) {
      toast.error(errorMessage(error, '目标页数没有保存成功，请重试'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-lg border border-line bg-white px-5 py-4 shadow-card" aria-label="篇幅">
      <form
        className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm text-ink-700"
        onSubmit={(event) => {
          event.preventDefault();
          void apply();
        }}
      >
        <h2 className="mr-3 text-sm font-semibold text-ink-900">篇幅</h2>
        <label htmlFor="plan-target-pages">目标</label>
        <NumberInput
          id="plan-target-pages"
          className="w-24"
          value={pages}
          min={1}
          max={500}
          suffix="页"
          disabled={lockedReason !== null || saving}
          onChange={change}
        />
        <span>× 每页 {settings.words_per_page} 字 = 共</span>
        <strong className="font-semibold tabular-nums text-ink-900">{formatChars(total)}</strong>
        {dirty && (
          <span className="ml-2 flex items-center gap-1.5">
            <Button type="submit" size="sm" variant="primary" loading={saving}>
              应用
            </Button>
            <Button size="sm" variant="ghost" disabled={saving} onClick={revert}>
              撤销
            </Button>
          </span>
        )}
      </form>
      {dirty && changedElsewhere && !saving && (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs leading-5 text-amber-900" role="status">
          <span className="min-w-0 flex-1 basis-64">
            目标页数在别处改成了 {saved} 页（正文页的“写作设置”或另一个窗口）。点“应用”会覆盖那边的修改。
          </span>
          <Button size="sm" onClick={revert}>
            看新内容
          </Button>
        </p>
      )}
      <p className="mt-2 text-xs leading-5 text-ink-500">
        共 {leafCount} 章，平均每章约 {formatChars(average)}。各章的目标字数按篇幅权重从总字数里分配：权重 2 的章节大约是权重 1 的两倍。每页字数在正文页的“写作设置”里改。
        {lockedReason ? ` ${lockedReason}` : ''}
      </p>
      {ws.data.budget_note && (
        <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-amber-700">
          <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{ws.data.budget_note}</span>
        </p>
      )}
    </section>
  );
}
