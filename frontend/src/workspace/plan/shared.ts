/**
 * 写作计划页各部分共用的常量与小工具（纯函数，无副作用）。
 */
import type { ChapterPlan, FactSheet, JobKind, LeafInfo, PlanForm, RequirementItem } from '../../api/types';

/** 后台任务的中文名（用在“正在××，期间不能修改”这类说明里） */
export const JOB_LABEL: Record<JobKind, string> = {
  plan: '制定写作计划',
  write: '撰写正文',
  revise: '修订章节',
  review: '深度审校',
};

export const FORM_OPTIONS: Array<{ value: PlanForm; label: string }> = [
  { value: 'paragraph', label: '以段落为主' },
  { value: 'table', label: '以表格为主' },
  { value: 'steps', label: '以流程步骤为主' },
  { value: 'mixed', label: '混合（段落、列表、表格结合）' },
];

/** 篇幅权重的范围与步长（与后端一致） */
export const WEIGHT_MIN = 0.2;
export const WEIGHT_MAX = 5;
export const WEIGHT_STEP = 0.1;

/** 后端分配字数时每章的下限与上限 */
export const MIN_WORDS_PER_CHAPTER = 200;
export const MAX_WORDS_PER_CHAPTER = 8000;

export function clampWeight(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, value));
}

/** 权重保留一位小数（0.1 的步长在浮点数下会出现 1.2000000000000002） */
export function roundWeight(value: number): number {
  return Math.round(clampWeight(value) * 10) / 10;
}

export function emptyPlan(uid: string): ChapterPlan {
  return { uid, key_points: [], requirement_ids: [], auto_assigned: [], avoid: [], weight: 1, form: 'paragraph', note: '' };
}

// 行首的列表符号：「- 」「* 」「• 」「· 」「1. 」「1、」「1）」。
// 「2.1 节」「3 秒」这类以数字开头的正常内容不会被误删（数字后面必须紧跟顿号、右括号，或“点 + 空格”）
const LIST_MARK = /^(?:[-*]\s+|[•·]\s*|\d{1,2}(?:[、)）]\s*|\.\s+))/;

/** “每行一条”的文本 → 列表：去掉空行、行首的列表符号和重复项 */
export function linesToList(text: string): string[] {
  const result: string[] = [];
  text.split(/\r?\n/).forEach((line) => {
    const item = line.trim().replace(LIST_MARK, '').trim();
    if (item && result.indexOf(item) < 0) result.push(item);
  });
  return result;
}

export function listToLines(list: string[] | undefined): string {
  return (list || []).join('\n');
}

/**
 * 只保留统一口径里界面会编辑的字段，并补上缺失的数组（老数据可能缺字段）。
 * 字段顺序固定，方便用 JSON 串比较“有没有改动”。
 */
export function normalizeFactSheet(sheet: FactSheet | null | undefined): FactSheet {
  const source = sheet || ({} as Partial<FactSheet>);
  return {
    project_name: source.project_name || '',
    purchaser: source.purchaser || '',
    facts: (source.facts || []).map((item) => ({ key: item.key || '', value: item.value || '', source: item.source || 'tender' })),
    decisions: (source.decisions || []).map((item) => ({ key: item.key || '', value: item.value || '', source: item.source || 'design' })),
    terminology: (source.terminology || []).map((item) => ({ term: item.term || '', definition: item.definition || '' })),
    placeholders: (source.placeholders || []).map((text) => text || ''),
  };
}

/** 条目编号的比对形式：去掉首尾空白、统一大写（与审校核对覆盖时的口径一致） */
export function requirementKey(id: string): string {
  return (id || '').trim().toUpperCase();
}

/**
 * 按当前的目录、写作计划和评分要求，算出还没有章节负责的条目编号（按招标解读里的顺序）。
 * 只认目录里还在的章节：删掉的章节原来负责的条目算没人负责。
 * 与章节计划编辑区里的“还没有章节负责”、审校里的“无章节负责”是同一个口径。
 */
export function unassignedRequirements(
  leaves: LeafInfo[],
  plans: Record<string, ChapterPlan>,
  requirements: RequirementItem[]
): string[] {
  const owned: Record<string, true> = {};
  leaves.forEach((leaf) => {
    const plan = plans[leaf.uid];
    if (!plan) return;
    (plan.requirement_ids || []).forEach((rid) => {
      owned[requirementKey(rid)] = true;
    });
  });
  return requirements.filter((item) => !owned[requirementKey(item.id)]).map((item) => item.id);
}

/** 条目的称呼：评分项 / 采购人要求 */
export function requirementKindLabel(kind: string): string {
  return kind === 'requirement' ? '采购人要求' : '评分项';
}

/** 条目的一行说明：「E1 项目理解与总体方案（25 分）」 */
export function requirementTitle(item: RequirementItem): string {
  const score = item.score ? `（${item.score}）` : '';
  return `${item.id} ${item.name}${score}`.trim();
}

export interface LeafGroup {
  /** 一级章节的编号，如 "2" */
  id: string;
  /** 一级章节的标题 */
  title: string;
  /** 一级章节本身就是叶子（下面没有子章节） */
  solo: boolean;
  leaves: LeafInfo[];
}

/** 按一级章节把叶子章节分组（保持目录顺序） */
export function groupLeaves(leaves: LeafInfo[]): LeafGroup[] {
  const groups: LeafGroup[] = [];
  leaves.forEach((leaf) => {
    const topId = leaf.id.split('.')[0];
    const last = groups.length > 0 ? groups[groups.length - 1] : null;
    if (last && last.id === topId) {
      last.leaves.push(leaf);
      return;
    }
    const solo = leaf.path_titles.length === 0;
    groups.push({ id: topId, title: solo ? leaf.title : leaf.path_titles[0], solo, leaves: [leaf] });
  });
  return groups;
}

/** 叶子章节的上级编号："2.1.3" → "2.1" */
export function parentId(leafId: string): string {
  const cut = leafId.lastIndexOf('.');
  return cut > 0 ? leafId.slice(0, cut) : '';
}
