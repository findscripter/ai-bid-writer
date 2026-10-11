/**
 * 审校、导出两个阶段共用的常量与计算。
 */
import type {
  CoverageItem,
  IssueSeverity,
  IssueType,
  LeafInfo,
  ProjectState,
  ReviewIssue,
  ReviewReport,
} from '../../api/types';
import type { BadgeTone } from '../../ui';

/** 问题类型的中文名 */
export const ISSUE_TYPE_LABEL: Record<IssueType, string> = {
  empty: '未撰写',
  failed: '生成失败',
  partial: '未写完',
  length: '篇幅偏差',
  duplicate: '跨章重复',
  repeat: '章内重复',
  boilerplate: '套话',
  markup: '格式残留',
  coverage: '评分点漏项',
  consistency: '前后矛盾',
};

/** 界面上从某个类型里单列出来的分类 */
const EXTRA_KIND_LABEL: Record<string, string> = {
  truncated: '结尾可能不完整',
};

/** 类型筛选的排列顺序：先是没写出来的，再是影响得分的，最后是文字层面的 */
export const ISSUE_TYPE_ORDER: string[] = [
  'empty',
  'failed',
  'partial',
  'truncated',
  'coverage',
  'consistency',
  'duplicate',
  'repeat',
  'length',
  'boilerplate',
  'markup',
];

export function issueTypeLabel(type: string): string {
  return (ISSUE_TYPE_LABEL as Record<string, string>)[type] || EXTRA_KIND_LABEL[type] || '其他';
}

/**
 * 问题在界面上归哪一类（筛选、标签都按它）。
 * 结尾被截断的章节在检查结果里也记成 partial，但它已经写完、只是结尾可能不完整，
 * 单列成 truncated，不和“未写完”混在一起（与审校统计、导出前检查同一口径）。
 */
export function issueKind(issue: ReviewIssue): string {
  return issue.type === 'partial' && /截断/.test(issue.title) ? 'truncated' : issue.type;
}

export const SEVERITY_ORDER: IssueSeverity[] = ['high', 'medium', 'low'];

export const SEVERITY_META: Record<IssueSeverity, { label: string; tone: BadgeTone; hint: string; bar: string; dot: string }> = {
  high: { label: '重要', tone: 'danger', hint: '会直接丢分，或者导出后明显有缺漏', bar: 'bg-rose-400', dot: 'bg-rose-500' },
  medium: { label: '一般', tone: 'warning', hint: '建议在导出前处理', bar: 'bg-amber-400', dot: 'bg-amber-500' },
  low: { label: '提示', tone: 'neutral', hint: '不影响得分，有空再看', bar: 'bg-ink-300', dot: 'bg-ink-300' },
};

export function severityOf(issue: ReviewIssue): IssueSeverity {
  return issue.severity === 'high' || issue.severity === 'medium' ? issue.severity : 'low';
}

export const COVERAGE_META: Record<CoverageItem['status'], { label: string; tone: BadgeTone }> = {
  covered: { label: '已响应', tone: 'success' },
  partial: { label: '部分响应', tone: 'warning' },
  missing: { label: '未响应', tone: 'danger' },
  unassigned: { label: '无章节负责', tone: 'danger' },
};

/** 检查结果里个别说法与界面上的叫法不一致，显示前统一一下 */
export function plainText(text: string | null | undefined): string {
  return (text || '').replace(/写作蓝图/g, '写作计划').replace(/重新审校/g, '重新检查');
}

export function leafName(leaf: LeafInfo): string {
  return `${leaf.id} ${leaf.title}`;
}

export function isDismissed(review: ReviewReport, issueId: string): boolean {
  return review.dismissed.indexOf(issueId) >= 0;
}

/** 还没处理（没有被忽略）的问题 */
export function openIssues(review: ReviewReport | null): ReviewIssue[] {
  if (!review) return [];
  return review.issues.filter((issue) => review.dismissed.indexOf(issue.id) < 0);
}

export function countBySeverity(issues: ReviewIssue[]): Record<IssueSeverity, number> {
  const counts: Record<IssueSeverity, number> = { high: 0, medium: 0, low: 0 };
  issues.forEach((issue) => {
    counts[severityOf(issue)] += 1;
  });
  return counts;
}

function timeOf(iso: string): number {
  const value = Date.parse(iso);
  return Number.isNaN(value) ? 0 : value;
}

export interface ReviewFreshness {
  /** 上次检查之后正文改过的章节 */
  changed: LeafInfo[];
  /** 上次检查之后目录增删过章节（只调整顺序不算） */
  outlineChanged: boolean;
  /** 检查结果可能已经过时 */
  stale: boolean;
}

/** 上次检查之后，正文或目录有没有变过 */
export function reviewFreshness(data: ProjectState): ReviewFreshness {
  const review = data.review;
  if (!review) return { changed: [], outlineChanged: false, stale: false };
  // generated_at 是开始检查的时刻：检查期间手动改过的章节也算“检查之后改过”
  const checkedAt = timeOf(review.generated_at);
  const changed = data.leaves.filter((leaf) => {
    const chapter = data.chapters[leaf.uid];
    return Boolean(chapter && chapter.updated_at && timeOf(chapter.updated_at) > checkedAt);
  });
  // 由服务端按检查时的章节集合比对（删一章、补一章这种数量不变的改动也认得出来）
  const outlineChanged = Boolean(data.review_outline_changed);
  return { changed, outlineChanged, stale: changed.length > 0 || outlineChanged };
}

/** 章节没写完的几种情况（结尾可能不完整的章节算写完，单独列在 truncated 里） */
export type UnfinishedKind = 'failed' | 'cancelled';

export const UNFINISHED_LABEL: Record<UnfinishedKind, string> = {
  failed: '生成失败，只有一部分',
  cancelled: '中途停止，没写完',
};

export interface ChapterReadiness {
  /** 没有正文的章节：导出时只有标题 */
  missing: LeafInfo[];
  /** 有正文但没写完的章节（生成失败、中途停止） */
  unfinished: Array<{ leaf: LeafInfo; kind: UnfinishedKind; reason: string }>;
  /** 已写完、但结尾可能不完整的章节（模型写到了输出上限、续写也没补完）：算在 done 里，单独提醒去看一眼 */
  truncated: LeafInfo[];
  /** 写完的章节数（含结尾可能不完整的；与阶段导航、正文页、项目卡片同一口径） */
  done: number;
  total: number;
  /** 至少有一章有正文 */
  anyText: boolean;
}

/**
 * 各章写到什么程度了（按当前数据算，不依赖检查结果）。
 * 审校页的“已完成章节”和导出前检查都用它，两处的说法保持一致：
 * 结尾被截断的章节算“已写完、但结尾可能不完整”，不说成没写完。
 */
export function chapterReadiness(data: ProjectState): ChapterReadiness {
  const missing: LeafInfo[] = [];
  const unfinished: Array<{ leaf: LeafInfo; kind: UnfinishedKind; reason: string }> = [];
  const truncated: LeafInfo[] = [];
  let done = 0;
  data.leaves.forEach((leaf) => {
    const chapter = data.chapters[leaf.uid];
    let kind: UnfinishedKind | null = null;
    if (!chapter || chapter.chars <= 0) {
      missing.push(leaf);
      return;
    }
    if (chapter.status === 'failed') kind = 'failed';
    else if (chapter.status === 'cancelled') kind = 'cancelled';
    if (kind) {
      unfinished.push({ leaf, kind, reason: UNFINISHED_LABEL[kind] });
      return;
    }
    done += 1;
    if (chapter.truncated) truncated.push(leaf);
  });
  return { missing, unfinished, truncated, done, total: data.leaves.length, anyText: missing.length < data.leaves.length };
}

/** 没写完的章节按情况分组（保持目录顺序）：导出前检查里分开列出来 */
export function groupUnfinished(readiness: ChapterReadiness): Array<{ kind: UnfinishedKind; label: string; leaves: LeafInfo[] }> {
  const order: UnfinishedKind[] = ['failed', 'cancelled'];
  return order
    .map((kind) => ({
      kind,
      label: UNFINISHED_LABEL[kind],
      leaves: readiness.unfinished.filter((item) => item.kind === kind).map((item) => item.leaf),
    }))
    .filter((group) => group.leaves.length > 0);
}
