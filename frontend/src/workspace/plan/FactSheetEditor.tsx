/**
 * 统一口径：全书所有章节共用的事实与设定。
 * 全部可以增、删、改；有改动时底部出现“保存 / 撤销”。
 *
 * 编辑期间别处保存了统一口径（另一个标签页、焦点核对带回的新数据）：
 * 没改过的部分跟上新内容，改过的部分保留；两边改了同一部分时提示“保存会覆盖那边的修改”，可以选择看新内容。
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExclamationTriangleIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/outline';
import { api, errorMessage } from '../../api/client';
import type { FactSheet } from '../../api/types';
import { Button, Field, IconButton, Input, Textarea, cx, useToast } from '../../ui';
import { useWorkspace } from '../WorkspaceContext';
import { normalizeFactSheet } from './shared';

/** 编辑中的一行：a 是名称（或单列时的内容），b 是内容 */
interface Row {
  id: number;
  a: string;
  b: string;
  source?: string;
}

interface Draft {
  project_name: string;
  purchaser: string;
  facts: Row[];
  decisions: Row[];
  terms: Row[];
  placeholders: Row[];
}

let rowSeq = 0;
function nextRowId(): number {
  rowSeq += 1;
  return rowSeq;
}

function toDraft(sheet: FactSheet): Draft {
  return {
    project_name: sheet.project_name,
    purchaser: sheet.purchaser,
    facts: sheet.facts.map((item) => ({ id: nextRowId(), a: item.key, b: item.value, source: item.source })),
    decisions: sheet.decisions.map((item) => ({ id: nextRowId(), a: item.key, b: item.value, source: item.source })),
    terms: sheet.terminology.map((item) => ({ id: nextRowId(), a: item.term, b: item.definition })),
    placeholders: sheet.placeholders.map((text) => ({ id: nextRowId(), a: text, b: '' })),
  };
}

/** clean=true 用于保存：去掉首尾空白和整行为空的条目；clean=false 用于判断有没有改动 */
function fromDraft(draft: Draft, clean: boolean): FactSheet {
  const text = (value: string) => (clean ? value.trim() : value);
  const keep = (row: Row) => !clean || row.a.trim() !== '' || row.b.trim() !== '';
  return {
    project_name: text(draft.project_name),
    purchaser: text(draft.purchaser),
    facts: draft.facts.filter(keep).map((row) => ({ key: text(row.a), value: text(row.b), source: row.source || 'tender' })),
    decisions: draft.decisions.filter(keep).map((row) => ({ key: text(row.a), value: text(row.b), source: row.source || 'design' })),
    terminology: draft.terms.filter(keep).map((row) => ({ term: text(row.a), definition: text(row.b) })),
    placeholders: draft.placeholders.filter(keep).map((row) => text(row.a)),
  };
}

type DraftField = 'project_name' | 'purchaser' | 'facts' | 'decisions' | 'terms' | 'placeholders';

/** 草稿的各个部分，与统一口径里的字段一一对应 */
const DRAFT_FIELDS: Array<{ key: DraftField; sheetKey: keyof FactSheet; label: string }> = [
  { key: 'project_name', sheetKey: 'project_name', label: '项目名称' },
  { key: 'purchaser', sheetKey: 'purchaser', label: '采购人' },
  { key: 'facts', sheetKey: 'facts', label: '招标文件给定的约束' },
  { key: 'decisions', sheetKey: 'decisions', label: '本方案的总体设定' },
  { key: 'terms', sheetKey: 'terminology', label: '统一术语' },
  { key: 'placeholders', sheetKey: 'placeholders', label: '需要投标人补充的信息' },
];

function takeField<K extends DraftField>(target: Draft, source: Draft, key: K): void {
  target[key] = source[key];
}

/**
 * 已保存的统一口径在别处变了（base → next）：草稿里没改过的部分跟上新内容，改过的部分保留。
 * 返回合并后的草稿，以及两边都改了的部分（保存时会覆盖那边的修改）。
 */
function mergeDraft(draft: Draft, base: FactSheet, next: FactSheet): { draft: Draft; conflicts: DraftField[] } {
  const mine = fromDraft(draft, false);
  const fresh = toDraft(next);
  const merged: Draft = { ...draft };
  const conflicts: DraftField[] = [];
  DRAFT_FIELDS.forEach(({ key, sheetKey }) => {
    const minePart = JSON.stringify(mine[sheetKey]);
    const basePart = JSON.stringify(base[sheetKey]);
    const nextPart = JSON.stringify(next[sheetKey]);
    if (minePart === basePart || minePart === nextPart) takeField(merged, fresh, key);
    else if (nextPart !== basePart) conflicts.push(key);
  });
  return { draft: merged, conflicts };
}

const TWO_COLS = 'grid grid-cols-[minmax(0,13rem)_minmax(0,1fr)_1.75rem] items-start gap-2';
const ONE_COL = 'grid grid-cols-[minmax(0,1fr)_1.75rem] items-start gap-2';

interface RowGroupProps {
  title: string;
  hint: string;
  rows: Row[];
  /** 两列（名称 + 内容）还是单列 */
  columns: 1 | 2;
  aLabel: string;
  bLabel?: string;
  aPlaceholder?: string;
  bPlaceholder?: string;
  addLabel: string;
  emptyText: string;
  /** 新增行的来源标记 */
  source?: string;
  disabled: boolean;
  onChange: (rows: Row[]) => void;
}

const RowGroup = memo(function RowGroup({
  title,
  hint,
  rows,
  columns,
  aLabel,
  bLabel,
  aPlaceholder,
  bPlaceholder,
  addLabel,
  emptyText,
  source,
  disabled,
  onChange,
}: RowGroupProps) {
  // 刚添加的那一行：出现后直接把光标放进去
  const [focusId, setFocusId] = useState<number | null>(null);

  const update = (id: number, patch: Partial<Row>) => onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const remove = (id: number) => onChange(rows.filter((row) => row.id !== id));
  const add = () => {
    const id = nextRowId();
    setFocusId(id);
    onChange(rows.concat({ id, a: '', b: '', source }));
  };

  const layout = columns === 2 ? TWO_COLS : ONE_COL;
  return (
    <section className="px-5 py-5">
      <h3 className="text-sm font-semibold leading-6 text-ink-900">
        {title}
        <span className="ml-2 text-xs font-normal tabular-nums text-ink-400">{rows.length} 条</span>
      </h3>
      <p className="mt-0.5 text-xs leading-5 text-ink-500">{hint}</p>

      {rows.length === 0 ? (
        <p className="mt-3 rounded-md border border-dashed border-line-strong px-3 py-2.5 text-[13px] leading-5 text-ink-500">{emptyText}</p>
      ) : (
        <div className="mt-3 space-y-2">
          {columns === 2 && (
            <div className={cx(layout, 'text-xs leading-4 text-ink-400')} aria-hidden="true">
              <span>{aLabel}</span>
              <span>{bLabel}</span>
            </div>
          )}
          {rows.map((row, index) => (
            <div key={row.id} className={layout}>
              <Input
                value={row.a}
                placeholder={aPlaceholder}
                disabled={disabled}
                autoFocus={row.id === focusId}
                aria-label={`${title}第 ${index + 1} 条的${aLabel}`}
                onChange={(event) => update(row.id, { a: event.target.value })}
              />
              {columns === 2 && (
                <Textarea
                  rows={1}
                  autoResize
                  value={row.b}
                  placeholder={bPlaceholder}
                  disabled={disabled}
                  aria-label={`${title}第 ${index + 1} 条的${bLabel || '内容'}`}
                  className="!py-[3px]"
                  onChange={(event) => update(row.id, { b: event.target.value })}
                />
              )}
              <IconButton
                label="删除这一条"
                size="sm"
                variant="danger"
                icon={<TrashIcon />}
                disabled={disabled}
                className="mt-0.5"
                onClick={() => remove(row.id)}
              />
            </div>
          ))}
        </div>
      )}

      <Button size="sm" variant="ghost" icon={<PlusIcon />} disabled={disabled} className="mt-2 -ml-1" onClick={add}>
        {addLabel}
      </Button>
    </section>
  );
});

interface FactSheetEditorProps {
  /** 不能编辑的原因（有任务在跑）；可以编辑时为 null */
  lockedReason: string | null;
  /** 有没有未保存的修改（切换页签、离开页面前要提醒） */
  onDirtyChange: (dirty: boolean) => void;
  /** 每变一次就放弃草稿、换回已保存的内容（使用者确认了“重新生成会丢掉没保存的修改”，生成已经开始） */
  discardSeq?: number;
}

export function FactSheetEditor({ lockedReason, onDirtyChange, discardSeq = 0 }: FactSheetEditorProps) {
  const ws = useWorkspace();
  const toast = useToast();
  const { projectId, apply } = ws;
  const blueprint = ws.data.blueprint;

  const saved = useMemo(() => normalizeFactSheet(blueprint ? blueprint.fact_sheet : null), [blueprint]);
  const savedKey = useMemo(() => JSON.stringify(saved), [saved]);

  // 没保存的修改只留在这一页上：离开页面前会先确认，确认离开就是放弃
  const [draft, setDraft] = useState<Draft>(() => toDraft(saved));
  // 草稿是在哪一版已保存的内容上改的
  const [seen, setSeen] = useState<{ key: string; sheet: FactSheet }>(() => ({ key: savedKey, sheet: saved }));
  // 别处更新过、这里也改了的部分：保存会覆盖那边的修改
  const [conflicts, setConflicts] = useState<DraftField[]>([]);
  // 编辑期间别处更新过：没改过的地方已经跟上了新内容
  const [refreshed, setRefreshed] = useState(false);
  const [saving, setSaving] = useState(false);
  // 已保存的内容变了（别处保存、重新生成、本页保存成功）：没动过就跟上，动过就保留改过的部分
  if (seen.key !== savedKey) {
    const result = mergeDraft(draft, seen.sheet, saved);
    const stillDirty = JSON.stringify(fromDraft(result.draft, false)) !== savedKey;
    setSeen({ key: savedKey, sheet: saved });
    setDraft(result.draft);
    setRefreshed(stillDirty);
    setConflicts((prev) => {
      if (!stillDirty) return [];
      const next = prev.slice();
      result.conflicts.forEach((key) => {
        if (next.indexOf(key) < 0) next.push(key);
      });
      return next;
    });
  }

  const current = useMemo(() => fromDraft(draft, false), [draft]);
  const dirty = useMemo(() => JSON.stringify(current) !== savedKey, [current, savedKey]);
  // 现在仍然两边不一致的冲突部分（改回和那边一样的就不算了）
  const conflictLabels = dirty
    ? DRAFT_FIELDS.filter(
        (field) =>
          conflicts.indexOf(field.key) >= 0 && JSON.stringify(current[field.sheetKey]) !== JSON.stringify(saved[field.sheetKey])
      ).map((field) => field.label)
    : [];

  const discard = useCallback(() => {
    setDraft(toDraft(saved));
    setSeen({ key: savedKey, sheet: saved });
    setConflicts([]);
    setRefreshed(false);
  }, [saved, savedKey]);

  // 外层要求放弃草稿（确认过的重新生成已经开始）
  const lastDiscard = useRef(discardSeq);
  useEffect(() => {
    if (discardSeq === lastDiscard.current) return;
    lastDiscard.current = discardSeq;
    discard();
  }, [discardSeq, discard]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const setFacts = useCallback((rows: Row[]) => setDraft((prev) => ({ ...prev, facts: rows })), []);
  const setDecisions = useCallback((rows: Row[]) => setDraft((prev) => ({ ...prev, decisions: rows })), []);
  const setTerms = useCallback((rows: Row[]) => setDraft((prev) => ({ ...prev, terms: rows })), []);
  const setPlaceholders = useCallback((rows: Row[]) => setDraft((prev) => ({ ...prev, placeholders: rows })), []);

  const hasWritten = useMemo(() => {
    const chapters = ws.data.chapters;
    return Object.keys(chapters).some((uid) => chapters[uid].status === 'done' && chapters[uid].chars > 0);
  }, [ws.data.chapters]);

  const save = async () => {
    setSaving(true);
    try {
      const state = await api.saveBlueprint(projectId, { fact_sheet: fromDraft(draft, true) });
      apply(state);
      // 保存的内容和原来等价（比如只多了个空行）时，已保存的内容不会变，草稿要自己收拾干净；
      // 同时记下这一版，不把自己的保存当成“别处更新过”
      const fresh = normalizeFactSheet(state.blueprint ? state.blueprint.fact_sheet : null);
      setSeen({ key: JSON.stringify(fresh), sheet: fresh });
      setDraft(toDraft(fresh));
      setConflicts([]);
      setRefreshed(false);
      toast.success(
        hasWritten ? '统一口径已保存。已经写好的章节不会自动跟着改，需要的话到正文页重写。' : '统一口径已保存，之后撰写的章节都会以它为准。'
      );
    } catch (error) {
      toast.error(errorMessage(error, '统一口径没有保存成功，请重试'));
    } finally {
      setSaving(false);
    }
  };

  const disabled = lockedReason !== null || saving;

  return (
    <div className="rounded-lg border border-line bg-white shadow-card">
      <p className="border-b border-line px-5 py-3 text-[13px] leading-6 text-ink-600">
        全书所有章节都以这里为准：撰写每一章时都会带上这些内容，所以同一个工期、同一项指标在哪一章出现都是同一个说法。发现不对就在这里改，不要到各章里分别改。
      </p>

      <section className="grid grid-cols-1 gap-x-6 gap-y-4 px-5 py-5 sm:grid-cols-2">
        <Field label="项目名称" hint="正文里提到本项目时用这个名称；导出的 Word 也用它做标题">
          <Input
            value={draft.project_name}
            disabled={disabled}
            placeholder="例如：智慧园区综合管理平台建设项目"
            onChange={(event) => {
              const value = event.target.value;
              setDraft((prev) => ({ ...prev, project_name: value }));
            }}
          />
        </Field>
        <Field label="采购人" hint="正文里统一这样称呼采购方">
          <Input
            value={draft.purchaser}
            disabled={disabled}
            placeholder="例如：某某市大数据管理局"
            onChange={(event) => {
              const value = event.target.value;
              setDraft((prev) => ({ ...prev, purchaser: value }));
            }}
          />
        </Field>
      </section>

      <div className="divide-y divide-line border-t border-line">
        <RowGroup
          title="招标文件给定的约束"
          hint="招标文件写死的内容：工期、地点、数量、指标等。正文会原样引用，各章不能写出别的数字。"
          rows={draft.facts}
          columns={2}
          aLabel="事项"
          bLabel="招标文件的规定"
          aPlaceholder="例如：服务期"
          bPlaceholder="例如：合同签订后 180 日历天"
          addLabel="添加一条约束"
          emptyText="还没有内容。把招标文件里写死的工期、地点、数量、指标填在这里，正文才不会各写各的。"
          source="tender"
          disabled={disabled}
          onChange={setFacts}
        />
        <RowGroup
          title="本方案的总体设定"
          hint="本方案自己定的内容：总体架构、关键选型、阶段划分、组织方式等。全书保持一致，不会这一章说三层架构、那一章说四层。"
          rows={draft.decisions}
          columns={2}
          aLabel="事项"
          bLabel="本方案的设定"
          aPlaceholder="例如：实施阶段"
          bPlaceholder="例如：分为调研确认、方案设计、部署实施、验证交付四个阶段"
          addLabel="添加一条设定"
          emptyText="还没有内容。把全书要统一的方案设定填在这里，例如总体架构、实施阶段的划分。"
          source="design"
          disabled={disabled}
          onChange={setDecisions}
        />
        <RowGroup
          title="统一术语"
          hint="同一个东西全书只用一个叫法，避免前面叫“管理平台”、后面叫“业务系统”。"
          rows={draft.terms}
          columns={2}
          aLabel="术语"
          bLabel="指的是什么"
          aPlaceholder="例如：试运行"
          bPlaceholder="例如：系统上线后、正式验收前的连续运行考核期"
          addLabel="添加一个术语"
          emptyText="还没有内容。有容易叫乱的名称时，在这里定下统一的叫法。"
          disabled={disabled}
          onChange={setTerms}
        />
        <RowGroup
          title="需要投标人补充的信息"
          hint="模型拿不到的企业信息：业绩、人员、资质、证书等。正文写到这些地方会留出“【待补充：……】”，不会编造；导出前要换成真实内容。"
          rows={draft.placeholders}
          columns={1}
          aLabel="需要补充的信息"
          aPlaceholder="例如：近三年同类项目业绩"
          addLabel="添加一项"
          emptyText="还没有内容。把需要你自己提供的企业信息列在这里，正文会为它们留出位置。"
          disabled={disabled}
          onChange={setPlaceholders}
        />
      </div>

      {(dirty || saving) && (
        <div className="sticky bottom-0 z-10 rounded-b-lg border-t border-line bg-white">
          {conflictLabels.length > 0 && !saving && (
            <div
              role="status"
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-amber-200 bg-amber-50 px-5 py-2 text-[13px] leading-5 text-amber-900"
            >
              <ExclamationTriangleIcon className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
              <span className="min-w-0 flex-1 basis-64">
                写作计划在别处更新过，{conflictLabels.map((label) => `“${label}”`).join('、')}那边也改了。保存会覆盖那边的修改。
              </span>
              <Button size="sm" onClick={discard} title="放弃这一页上没保存的修改，换成别处保存的内容">
                看新内容
              </Button>
            </div>
          )}
          <div className="flex items-center gap-2 px-5 py-3">
            <span className="mr-auto text-[13px] text-ink-600">
              统一口径有修改还没有保存
              {refreshed && conflictLabels.length === 0 && dirty && !saving ? (
                <span className="text-ink-500">（别处刚更新过，你没改过的地方已经换成新内容）</span>
              ) : null}
            </span>
            <Button variant="ghost" disabled={saving} onClick={discard}>
              撤销
            </Button>
            <Button variant="primary" loading={saving} disabled={lockedReason !== null} onClick={() => void save()}>
              保存
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
