/**
 * 章节计划的展开编辑区：要点、负责响应的条目、不展开的内容、呈现形式、篇幅权重、补充要求。
 * 一次只展开一章；保存后本章的计划立即生效，目标字数随权重重新分配。
 *
 * 编辑期间别处改了这一章的计划（另一个标签页、正文页的“补充要求”）：没改过的部分跟上新内容，
 * 改过的部分保留；两边改了同一部分时提示“保存会覆盖那边的修改”，可以选择看新内容。
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import type { ChapterPlan, LeafInfo, PlanForm, RequirementItem } from '../../api/types';
import { formatChars } from '../../lib/format';
import { Button, Checkbox, Field, NumberInput, Select, Textarea, cx } from '../../ui';
import {
  FORM_OPTIONS,
  MAX_WORDS_PER_CHAPTER,
  MIN_WORDS_PER_CHAPTER,
  WEIGHT_MAX,
  WEIGHT_MIN,
  WEIGHT_STEP,
  clampWeight,
  linesToList,
  listToLines,
  requirementKindLabel,
  roundWeight,
} from './shared';

/** 每个条目目前由哪些章节负责 */
export type RequirementOwners = Record<string, Array<{ uid: string; id: string }>>;

/** 编辑中的草稿（要点、不展开的内容是“每行一条”的文本） */
export interface PlanDraft {
  points: string;
  avoid: string;
  note: string;
  form: PlanForm;
  weight: number;
  /** 勾选的条目编号 */
  selected: string[];
  /** 其中由系统自动分配、使用者还没动过的 */
  auto: string[];
}

type Draft = PlanDraft;

const WEIGHT_PRESETS: Array<{ value: number; label: string }> = [
  { value: 0.5, label: '略写' },
  { value: 1, label: '平均' },
  { value: 2, label: '重点' },
  { value: 3, label: '核心' },
];

const LABEL = 'mb-1.5 block text-[13px] font-medium leading-5 text-ink-700';

function toForm(value: string | undefined): PlanForm {
  return FORM_OPTIONS.some((option) => option.value === value) ? (value as PlanForm) : 'paragraph';
}

function toDraft(plan: ChapterPlan | undefined, validIds: string[]): Draft {
  if (!plan) return { points: '', avoid: '', note: '', form: 'paragraph', weight: 1, selected: [], auto: [] };
  // 招标解读里已经没有的条目不再带着（保存时后端也会去掉）
  const known = (rid: string) => validIds.length === 0 || validIds.indexOf(rid) >= 0;
  const selected = (plan.requirement_ids || []).filter(known);
  return {
    points: listToLines(plan.key_points),
    avoid: listToLines(plan.avoid),
    note: plan.note || '',
    form: toForm(plan.form),
    weight: roundWeight(plan.weight),
    selected,
    auto: (plan.auto_assigned || []).filter((rid) => selected.indexOf(rid) >= 0),
  };
}

function toPlan(uid: string, draft: Draft, validIds: string[]): ChapterPlan {
  // 条目按招标解读里的顺序排，读起来整齐，也避免“只是顺序不同”被当成改动
  const selected = validIds.length > 0 ? validIds.filter((rid) => draft.selected.indexOf(rid) >= 0) : draft.selected.slice();
  return {
    uid,
    key_points: linesToList(draft.points),
    requirement_ids: selected,
    auto_assigned: selected.filter((rid) => draft.auto.indexOf(rid) >= 0),
    avoid: linesToList(draft.avoid),
    weight: roundWeight(draft.weight),
    form: draft.form,
    note: draft.note.trim(),
  };
}

type PlanField = 'points' | 'avoid' | 'note' | 'form' | 'weight' | 'requirements';

/** 草稿的各个部分：比较时用整理后的计划字段，跟上新内容时换草稿里对应的字段 */
const PLAN_FIELDS: Array<{ key: PlanField; planKeys: Array<keyof ChapterPlan>; draftKeys: Array<keyof Draft>; label: string }> = [
  { key: 'points', planKeys: ['key_points'], draftKeys: ['points'], label: '必须写到的要点' },
  { key: 'requirements', planKeys: ['requirement_ids', 'auto_assigned'], draftKeys: ['selected', 'auto'], label: '负责响应的条目' },
  { key: 'avoid', planKeys: ['avoid'], draftKeys: ['avoid'], label: '不在本章展开的内容' },
  { key: 'form', planKeys: ['form'], draftKeys: ['form'], label: '呈现形式' },
  { key: 'weight', planKeys: ['weight'], draftKeys: ['weight'], label: '篇幅权重' },
  { key: 'note', planKeys: ['note'], draftKeys: ['note'], label: '对本章的补充要求' },
];

function takeDraftField<K extends keyof Draft>(target: Draft, source: Draft, key: K): void {
  target[key] = source[key];
}

function planPart(plan: ChapterPlan, keys: Array<keyof ChapterPlan>): string {
  return JSON.stringify(keys.map((key) => plan[key]));
}

/**
 * 已保存的计划在别处变了（base → next）：草稿里没改过的部分跟上新内容，改过的部分保留。
 * 返回合并后的草稿，以及两边都改了的部分（保存时会覆盖那边的修改）。
 */
function mergePlanDraft(
  uid: string,
  draft: Draft,
  base: ChapterPlan | undefined,
  next: ChapterPlan | undefined,
  validIds: string[]
): { draft: Draft; conflicts: PlanField[] } {
  const fresh = toDraft(next, validIds);
  const mine = toPlan(uid, draft, validIds);
  const before = toPlan(uid, toDraft(base, validIds), validIds);
  const after = toPlan(uid, fresh, validIds);
  const merged: Draft = { ...draft };
  const conflicts: PlanField[] = [];
  PLAN_FIELDS.forEach((field) => {
    const minePart = planPart(mine, field.planKeys);
    const basePart = planPart(before, field.planKeys);
    const nextPart = planPart(after, field.planKeys);
    if (minePart === basePart || minePart === nextPart) {
      field.draftKeys.forEach((key) => takeDraftField(merged, fresh, key));
    } else if (nextPart !== basePart) {
      conflicts.push(field.key);
    }
  });
  return { draft: merged, conflicts };
}

interface ChapterPlanEditorProps {
  leaf: LeafInfo;
  /** 已保存的计划；这一章还没有计划时为 undefined */
  plan: ChapterPlan | undefined;
  /** 当前的目标字数 */
  target: number | undefined;
  requirements: RequirementItem[];
  owners: RequirementOwners;
  /** 全书目标总字数、全部章节的权重之和：用来估算改了权重之后的目标字数 */
  totalWords: number;
  weightSum: number;
  /** 这一章是否已经有正文 */
  hasContent: boolean;
  /** 不能编辑的原因（有任务在跑）；可以编辑时为 null */
  lockedReason: string | null;
  /** 保存；成功时返回保存后的计划，失败返回 null */
  onSave: (plan: ChapterPlan) => Promise<ChapterPlan | null>;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
  /** 每变一次就放弃草稿、换回已保存的内容（使用者确认过会丢掉没保存的修改的生成已经开始） */
  discardSeq?: number;
}

function ChapterPlanEditorImpl({
  leaf,
  plan,
  target,
  requirements,
  owners,
  totalWords,
  weightSum,
  hasContent,
  lockedReason,
  onSave,
  onClose,
  onDirtyChange,
  discardSeq = 0,
}: ChapterPlanEditorProps) {
  const validIds = useMemo(() => requirements.map((item) => item.id), [requirements]);
  const savedKey = useMemo(() => JSON.stringify(plan || null), [plan]);

  const [draft, setDraft] = useState<Draft>(() => toDraft(plan, validIds));
  // 草稿是在哪一版已保存的计划上改的
  const [seen, setSeen] = useState<{ key: string; plan: ChapterPlan | undefined }>(() => ({ key: savedKey, plan }));
  // 别处改过、这里也改了的部分：保存会覆盖那边的修改
  const [conflicts, setConflicts] = useState<PlanField[]>([]);
  // 编辑期间别处改过这一章的计划：没改过的地方已经跟上了新内容
  const [refreshed, setRefreshed] = useState(false);
  const [saving, setSaving] = useState(false);

  // 已保存的计划整理成和草稿同样的形式，用来判断有没有改动
  const savedPlan = useMemo(() => toPlan(leaf.uid, toDraft(plan, validIds), validIds), [leaf.uid, plan, validIds]);
  const baselineKey = useMemo(() => JSON.stringify(savedPlan), [savedPlan]);

  // 已保存的计划变了（别处保存、补全计划、本页保存成功）：没动过就跟上，动过就保留改过的部分
  if (seen.key !== savedKey) {
    const result = mergePlanDraft(leaf.uid, draft, seen.plan, plan, validIds);
    const stillDirty = JSON.stringify(toPlan(leaf.uid, result.draft, validIds)) !== baselineKey;
    setSeen({ key: savedKey, plan });
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

  const current = useMemo(() => toPlan(leaf.uid, draft, validIds), [leaf.uid, draft, validIds]);
  // 没有计划的章节：填了任何内容才算有改动
  const dirty = JSON.stringify(current) !== baselineKey;
  // 现在仍然两边不一致的冲突部分（改回和那边一样的就不算了）
  const conflictLabels = dirty
    ? PLAN_FIELDS.filter(
        (field) => conflicts.indexOf(field.key) >= 0 && planPart(current, field.planKeys) !== planPart(savedPlan, field.planKeys)
      ).map((field) => field.label)
    : [];

  const discard = useCallback(() => {
    setDraft(toDraft(plan, validIds));
    setSeen({ key: savedKey, plan });
    setConflicts([]);
    setRefreshed(false);
  }, [plan, validIds, savedKey]);

  // 外层要求放弃草稿（确认过的重新生成、补全已经开始）
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

  const disabled = lockedReason !== null || saving;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((prev) => ({ ...prev, [key]: value }));

  const toggle = (rid: string) =>
    setDraft((prev) => {
      const checked = prev.selected.indexOf(rid) >= 0;
      return {
        ...prev,
        selected: checked ? prev.selected.filter((item) => item !== rid) : prev.selected.concat(rid),
        // 使用者亲手动过的条目不再算“自动分配”
        auto: prev.auto.filter((item) => item !== rid),
      };
    });

  const save = async () => {
    setSaving(true);
    try {
      const stored = await onSave(current);
      if (stored) {
        // 记下保存后的这一版，不把自己的保存当成“别处改过”
        setSeen({ key: JSON.stringify(stored), plan: stored });
        setDraft(toDraft(stored, validIds));
        setConflicts([]);
        setRefreshed(false);
      }
    } finally {
      setSaving(false);
    }
  };

  const savedWeight = plan ? clampWeight(plan.weight) : 1;
  const weightChanged = current.weight !== roundWeight(savedWeight);
  const estimate = useMemo(() => {
    if (!weightChanged || totalWords <= 0) return null;
    const rest = Math.max(weightSum - savedWeight, 0);
    const share = Math.round((totalWords * current.weight) / (rest + current.weight));
    return Math.min(MAX_WORDS_PER_CHAPTER, Math.max(MIN_WORDS_PER_CHAPTER, share));
  }, [weightChanged, totalWords, weightSum, savedWeight, current.weight]);

  const pointCount = current.key_points.length;
  const scoring = requirements.filter((item) => item.kind !== 'requirement');
  const others = requirements.filter((item) => item.kind === 'requirement');

  const renderItem = (item: RequirementItem) => {
    const checked = draft.selected.indexOf(item.id) >= 0;
    const auto = checked && draft.auto.indexOf(item.id) >= 0;
    const elsewhere = (owners[item.id] || []).filter((owner) => owner.uid !== leaf.uid);
    const orphan = !checked && elsewhere.length === 0;
    return (
      <li key={item.id}>
        <label
          title={item.detail || undefined}
          className={cx('flex items-start gap-2.5 px-3 py-1.5', disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-subtle')}
        >
          <Checkbox className="mt-0.5" checked={checked} disabled={disabled} onChange={() => toggle(item.id)} />
          <span className="min-w-0 flex-1 text-[13px] leading-5">
            <span className="font-medium tabular-nums text-ink-900">{item.id}</span>
            <span className="ml-1.5 text-ink-700">{item.name || '（没有名称）'}</span>
            {item.score && <span className="ml-1.5 text-xs text-ink-400">{item.score}</span>}
            {(auto || elsewhere.length > 0 || orphan) && (
              <span className="block text-xs leading-5">
                {auto && <span className="text-amber-700">系统按内容相近自动分配到本章，请核对是否合适</span>}
                {auto && elsewhere.length > 0 && <span className="text-ink-300"> · </span>}
                {elsewhere.length > 0 && (
                  <span className="text-ink-400">
                    {checked ? '同时' : '已'}由 {elsewhere.map((owner) => owner.id).join('、')} 负责
                  </span>
                )}
                {orphan && <span className="text-amber-700">还没有章节负责</span>}
              </span>
            )}
          </span>
        </label>
      </li>
    );
  };

  return (
    <div className="border-t border-line bg-subtle px-5 pb-4 pt-4">
      {leaf.description && (
        <p className="mb-3 line-clamp-3 whitespace-pre-line text-xs leading-5 text-ink-500" title={leaf.description}>
          <span className="text-ink-400">目录里的说明：</span>
          {leaf.description}
        </p>
      )}
      {!plan && (
        <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] leading-6 text-amber-800">
          这一章还没有计划。可以用页面上方的“补全计划”让模型来定，也可以在这里自己填好后保存。
        </p>
      )}

      <div className="grid grid-cols-1 gap-x-6 gap-y-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Field
            label={`必须写到的要点${pointCount > 0 ? `（${pointCount} 条）` : ''}`}
            hint="每行一条。撰写本章时会逐条写到，写不到的会在审校里提示。"
          >
            <Textarea
              rows={4}
              autoResize
              value={draft.points}
              disabled={disabled}
              placeholder={'例如：\n说明系统响应时间不超过 3 秒的达成措施\n给出压力测试的方法与通过标准'}
              className="max-h-72 bg-white"
              onChange={(event) => set('points', event.target.value)}
            />
          </Field>
          <Field label="不在本章展开的内容" hint="每行一条。划清和其他章节的边界，避免重复，例如：培训安排（放在 4.2 写）。">
            <Textarea
              rows={2}
              autoResize
              value={draft.avoid}
              disabled={disabled}
              className="max-h-48 bg-white"
              onChange={(event) => set('avoid', event.target.value)}
            />
          </Field>
          <Field label="对本章的补充要求" hint="你自己对这一章的要求。重新生成写作计划时也会保留。">
            <Textarea
              rows={2}
              autoResize
              value={draft.note}
              disabled={disabled}
              placeholder="例如：重点写与现有 DCS 系统的对接方式"
              className="max-h-48 bg-white"
              onChange={(event) => set('note', event.target.value)}
            />
          </Field>
        </div>

        <div className="space-y-4">
          <div>
            <p className={LABEL}>
              负责响应的条目
              <span className="ml-1.5 font-normal text-ink-500">已选 {current.requirement_ids.length} 条</span>
            </p>
            {requirements.length === 0 ? (
              <p className="rounded-md border border-dashed border-line-strong bg-white px-3 py-2.5 text-[13px] leading-6 text-ink-500">
                招标解读里没有识别出评分项和采购人要求，这里没法指定。到“招标解读”里检查一下技术评分要求。
              </p>
            ) : (
              <div className="max-h-[21rem] overflow-y-auto rounded-md border border-line-strong bg-white py-1">
                {scoring.length > 0 && (
                  <>
                    <p className="px-3 pb-0.5 pt-1.5 text-xs font-medium text-ink-400">{requirementKindLabel('scoring')}</p>
                    <ul>{scoring.map(renderItem)}</ul>
                  </>
                )}
                {others.length > 0 && (
                  <>
                    <p className="px-3 pb-0.5 pt-1.5 text-xs font-medium text-ink-400">{requirementKindLabel('requirement')}</p>
                    <ul>{others.map(renderItem)}</ul>
                  </>
                )}
              </div>
            )}
            <p className="mt-1.5 text-xs leading-5 text-ink-500">勾选的条目由本章负责写到位；审校时会按这里核对有没有漏项。</p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="呈现形式">
              <Select
                value={draft.form}
                disabled={disabled}
                options={FORM_OPTIONS}
                className="bg-white"
                onChange={(event) => set('form', toForm(event.target.value))}
              />
            </Field>
            <Field label="篇幅权重">
              <NumberInput
                value={draft.weight}
                min={WEIGHT_MIN}
                max={WEIGHT_MAX}
                step={WEIGHT_STEP}
                precision={1}
                disabled={disabled}
                onChange={(value) => set('weight', value)}
              />
            </Field>
          </div>
          <div className="-mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs leading-5 text-ink-500">
            <span className="flex items-center gap-1">
              {WEIGHT_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  disabled={disabled}
                  aria-pressed={current.weight === preset.value}
                  onClick={() => set('weight', preset.value)}
                  className={cx(
                    'rounded-full border px-2 py-0.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                    current.weight === preset.value
                      ? 'border-primary-300 bg-primary-50 text-primary-700'
                      : 'border-line bg-white text-ink-600 enabled:hover:border-ink-300 enabled:hover:text-ink-900'
                  )}
                >
                  {preset.label} {preset.value}
                </button>
              ))}
            </span>
            <span className="tabular-nums">
              {target ? `现在的目标 ${formatChars(target)}` : '还没有分配目标字数'}
              {estimate !== null && <span className="text-ink-700">，保存后约 {formatChars(estimate)}</span>}
            </span>
          </div>
        </div>
      </div>

      {conflictLabels.length > 0 && !saving && (
        <div
          role="status"
          className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] leading-5 text-amber-900"
        >
          <ExclamationTriangleIcon className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <span className="min-w-0 flex-1 basis-64">
            写作计划在别处更新过，这一章的{conflictLabels.map((label) => `“${label}”`).join('、')}那边也改了。保存会覆盖那边的修改。
          </span>
          <Button size="sm" onClick={discard} title="放弃这一章没保存的修改，换成别处保存的内容">
            看新内容
          </Button>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <p className="mr-auto min-w-0 text-xs leading-5 text-ink-500">
          {lockedReason ||
            (dirty && refreshed && conflictLabels.length === 0
              ? '这一章的计划在别处更新过，你没改过的地方已经换成新内容，改过的地方还在，记得保存。'
              : hasContent
                ? '这一章已经有正文。改了计划之后，要到正文页重写本章才会按新计划来。'
                : '保存后，撰写本章时就按这份计划来。')}
        </p>
        {dirty ? (
          <Button variant="ghost" disabled={saving} onClick={discard}>
            撤销修改
          </Button>
        ) : (
          <Button variant="ghost" onClick={onClose}>
            收起
          </Button>
        )}
        <Button variant="primary" loading={saving} disabled={!dirty || lockedReason !== null} onClick={() => void save()}>
          保存本章计划
        </Button>
      </div>
    </div>
  );
}

export const ChapterPlanEditor = memo(ChapterPlanEditorImpl);
