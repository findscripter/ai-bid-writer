/**
 * 目录节点的就地表单：修改已有章节的标题与说明，或者填写一个新章节。
 *
 * 标题框里按回车保存，说明框里按 Ctrl + 回车保存，Esc 取消。
 * 输入只存在表单自己这里，敲字不会牵动整棵目录树重新渲染。
 * 填到一半时目录被锁住（别处开始了任务、正在生成新目录）：表单和填的内容都留着，只是暂时不能保存。
 */
import React, { useEffect, useRef, useState } from 'react';
import { LockClosedIcon } from '@heroicons/react/24/outline';
import { Button, Input, Textarea } from '../../ui';

interface NodeFormProps {
  /** 这张表单在做什么（读屏用），例如“编辑 2.1 实施组织” */
  label: string;
  /** 显示在标题框前面的编号；新章节给的是保存后会得到的编号 */
  number: string;
  initialTitle?: string;
  initialDescription?: string;
  submitText: string;
  saving: boolean;
  /** 目录暂时不能改的原因（有任务在跑、正在生成新目录）：表单留着、内容照填，只是不能保存 */
  lockedReason?: string | null;
  /** 锁定是因为正在重新生成目录：生成后这里对应的章节可能不在新目录里了 */
  regenerating?: boolean;
  onSubmit: (title: string, description: string) => void;
  onCancel: () => void;
  /** 填了内容还没有保存（离开页面前要提醒）；表单关掉时会报 false */
  onDirtyChange?: (dirty: boolean) => void;
}

export function NodeForm({
  label,
  number,
  initialTitle = '',
  initialDescription = '',
  submitText,
  saving,
  lockedReason = null,
  regenerating = false,
  onSubmit,
  onCancel,
  onDirtyChange,
}: NodeFormProps) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [showError, setShowError] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const dirty = title !== initialTitle || description !== initialDescription;
  useEffect(() => {
    if (!onDirtyChange) return undefined;
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    const focusTitle = () => {
      const form = formRef.current;
      const input = titleRef.current;
      if (!form || !input || form.contains(document.activeElement)) return;
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    };
    focusTitle();
    if (formRef.current) formRef.current.scrollIntoView({ block: 'nearest' });
    // 从确认对话框过来时，对话框关上的那一下可能把焦点带走，稍后再确认一次
    const timer = window.setTimeout(focusTitle, 320);
    return () => window.clearTimeout(timer);
  }, []);

  const empty = title.trim() === '';
  const locked = Boolean(lockedReason);

  const submit = () => {
    if (saving || locked) return;
    if (empty) {
      setShowError(true);
      if (titleRef.current) titleRef.current.focus();
      return;
    }
    onSubmit(title.trim(), description.trim());
  };

  return (
    <form
      ref={formRef}
      aria-label={label}
      className="my-1 rounded-lg border border-primary-300 bg-white p-3 shadow-card ring-2 ring-primary-500/10"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="flex items-center gap-2">
        {number ? <span className="shrink-0 text-[13px] tabular-nums text-ink-400">{number}</span> : null}
        <Input
          ref={titleRef}
          value={title}
          maxLength={200}
          readOnly={saving}
          invalid={showError && empty}
          placeholder="章节标题"
          aria-label="章节标题"
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      {showError && empty && (
        <p className="mt-1 text-xs text-rose-600" role="alert">
          标题不能为空。
        </p>
      )}
      <Textarea
        autoResize
        rows={2}
        value={description}
        readOnly={saving}
        placeholder="说明：这一章要写什么、对应哪些评分项。可以不填；写清楚了，正文会写得更贴题。"
        aria-label="章节说明"
        className="mt-2 max-h-60 text-[13px]"
        onChange={(event) => setDescription(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {locked && (
        <p className="mt-2 flex items-start gap-1.5 rounded-md bg-subtle px-2.5 py-1.5 text-xs leading-5 text-ink-600" role="status">
          <LockClosedIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-400" aria-hidden="true" />
          <span className="min-w-0">
            {lockedReason}
            {dirty
              ? regenerating
                ? '生成完成后，如果这里对应的章节还在新目录里（标题和位置都没变），可以接着保存；不在的话填的内容会丢失，需要的话先复制下来。'
                : '刚才填的内容还在这里，等能改目录了再保存。'
              : ''}
          </span>
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <span className="mr-auto text-xs text-ink-400">{locked ? '现在不能保存，Esc 取消' : '回车保存，Esc 取消'}</span>
        <Button size="sm" variant="ghost" disabled={saving} onClick={onCancel}>
          取消
        </Button>
        <Button size="sm" variant="primary" type="submit" loading={saving} disabled={locked} title={lockedReason || undefined}>
          {submitText}
        </Button>
      </div>
    </form>
  );
}
