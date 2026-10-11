/**
 * 写作设置：篇幅、并发、分节阈值、风格等项目级设置。
 */
import React, { useState } from 'react';
import { api, errorMessage } from '../../api/client';
import type { ProjectSettings } from '../../api/types';
import { useAppShell } from '../../app/AppShell';
import { formatChars } from '../../lib/format';
import { Button, Field, Input, Modal, NumberInput, Select, Switch, Textarea, useToast } from '../../ui';
import { useWorkspace } from '../WorkspaceContext';

interface Props {
  open: boolean;
  onClose: () => void;
}

function sameSettings(a: ProjectSettings, b: ProjectSettings): boolean {
  const keys = Object.keys(a) as Array<keyof ProjectSettings>;
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * 逐个字段合并：使用者没改过的字段（还等于打开弹窗时的值）换成最新保存的值，改过的保留使用者填的。
 * 设置在弹窗开着时被别处改了，不会把别处刚改的字段悄悄改回去。
 */
function followSettings(draft: ProjectSettings, base: ProjectSettings, latest: ProjectSettings): ProjectSettings {
  const next: Record<string, unknown> = { ...draft };
  const before = base as unknown as Record<string, unknown>;
  const mine = draft as unknown as Record<string, unknown>;
  const theirs = latest as unknown as Record<string, unknown>;
  Object.keys(theirs).forEach((key) => {
    if (mine[key] === before[key]) next[key] = theirs[key];
  });
  return next as unknown as ProjectSettings;
}

export default function WritingSettingsModal({ open, onClose }: Props) {
  const ws = useWorkspace();
  const shell = useAppShell();
  const toast = useToast();
  const saved = ws.data.project.settings;
  const [draft, setDraft] = useState<ProjectSettings>(saved);
  const [saving, setSaving] = useState(false);

  // 只在弹窗打开的那一刻用已保存的设置填表。弹窗开着时任务结束、别处保存等引起的刷新
  // 会换掉 settings 对象：逐个字段比较，使用者没动过的字段跟上新的值，动过的保留使用者填的内容
  const [base, setBase] = useState<ProjectSettings>(saved);
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setDraft(saved);
      setBase(saved);
    }
  } else if (open && saved !== base && !sameSettings(saved, base)) {
    setBase(saved);
    const next = followSettings(draft, base, saved);
    if (!sameSettings(next, draft)) setDraft(next);
  }

  const set = <K extends keyof ProjectSettings>(key: K, value: ProjectSettings[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const leafCount = ws.data.leaves.length;
  const total = draft.target_pages * draft.words_per_page;
  const average = leafCount > 0 ? Math.round(total / leafCount) : 0;
  const personas = shell.meta ? shell.meta.personas : [];

  const save = async () => {
    setSaving(true);
    try {
      // 保存会整体替换设置：先取一次服务端最新的设置，把使用者没动过的字段换成最新值，
      // 别的标签页刚改过、这里还没刷新到的字段就不会被改回去（取不到就按表单保存）
      let settings = draft;
      try {
        const latest = await api.getProject(ws.projectId);
        settings = followSettings(draft, base, latest.project.settings);
      } catch {
        // 取不到最新的设置不影响保存
      }
      ws.apply(await api.patchProject(ws.projectId, { settings }));
      toast.success('写作设置已保存');
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, '保存失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="写作设置"
      description="这些设置只影响本项目。修改后对之后撰写的章节生效，已经写好的章节不会变。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            保存
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        <Field label="目标页数" hint={`全书约 ${formatChars(total)}，共 ${leafCount} 章，平均每章约 ${formatChars(average)}`}>
          <NumberInput value={draft.target_pages} min={1} max={500} suffix="页" onChange={(value) => set('target_pages', value)} />
        </Field>
        <Field label="每页字数" hint="A4、小四、1.5 倍行距约 750 字">
          <NumberInput value={draft.words_per_page} min={300} max={2000} step={50} suffix="字" onChange={(value) => set('words_per_page', value)} />
        </Field>
        <Field label="同时撰写的章节数" hint="受模型服务的并发限制约束，遇到限流就调小">
          <NumberInput value={draft.concurrency} min={1} max={10} suffix="章" onChange={(value) => set('concurrency', value)} />
        </Field>
        <Field label="长章分节阈值" hint="单章目标字数超过这个值时，先划分小节再逐节撰写">
          <NumberInput value={draft.section_threshold} min={600} max={8000} step={100} suffix="字" onChange={(value) => set('section_threshold', value)} />
        </Field>
        <Field label="写作风格" hint="影响全书的侧重点">
          <Select
            value={draft.persona_id || ''}
            onChange={(event) => set('persona_id', event.target.value || null)}
            options={[{ value: '', label: '不指定' }].concat(personas.map((p) => ({ value: p.id, label: p.name })))}
          />
        </Field>
        <Field label="发散程度" hint="数值越低越稳重，越高越有变化；一般保持 0.7">
          <NumberInput value={draft.temperature} min={0} max={1.5} step={0.1} precision={1} onChange={(value) => set('temperature', value)} />
        </Field>
        <Field label="本项目使用的模型" hint="留空则使用全局设置里的模型" className="sm:col-span-2">
          <Input
            value={draft.model_name || ''}
            placeholder={shell.settings ? shell.settings.model_name : ''}
            onChange={(event) => set('model_name', event.target.value.trim() || null)}
          />
        </Field>
        <Field label="对全书的写作要求" hint="例如：多用表格呈现参数；避免出现具体品牌名" className="sm:col-span-2">
          <Textarea rows={3} value={draft.style_notes} onChange={(event) => set('style_notes', event.target.value)} />
        </Field>
        <div className="sm:col-span-2">
          <Switch
            checked={draft.use_tender_excerpts}
            onChange={(value) => set('use_tender_excerpts', value)}
            label="撰写每章时附带招标文件里的相关原文（推荐开启：指标、型号、期限才能引用准确）"
          />
        </div>
      </div>
    </Modal>
  );
}
