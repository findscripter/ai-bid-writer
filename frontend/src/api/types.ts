/**
 * 项目工作台的数据类型（与后端 app/writing/models.py、routers/projects.py 一一对应）。
 */

export interface OutlineNode {
  /** 稳定标识：正文、写作计划、审校结果都按它关联 */
  uid: string;
  /** 显示用的位置编号（"2.1.3"），目录一改就会重排 */
  id: string;
  title: string;
  description: string;
  children?: OutlineNode[];
  is_response_chapter?: boolean;
  source_requirement_id?: string;
  source_requirement_title?: string;
}

export interface LeafInfo {
  uid: string;
  id: string;
  title: string;
  description: string;
  path_titles: string[];
  parent_uid: string | null;
  level: number;
  is_response_chapter: boolean;
}

export interface ProjectSettings {
  target_pages: number;
  words_per_page: number;
  concurrency: number;
  section_threshold: number;
  use_tender_excerpts: boolean;
  persona_id: string | null;
  model_name: string | null;
  temperature: number;
  style_notes: string;
}

export interface TenderMeta {
  filename: string;
  char_count: number;
  uploaded_at: string;
  warning: string;
}

export interface Project {
  schema_version: number;
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  tender: TenderMeta;
  overview: string;
  requirements: string;
  outline: OutlineNode[];
  outline_mode: string;
  company_profile: string;
  settings: ProjectSettings;
}

export interface ProjectSummary {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  tender_filename: string;
  leaf_total: number;
  leaf_done: number;
  /** 写完的章节里，结尾因输出上限被截断、可能不完整的章数（已计入 leaf_done） */
  leaf_truncated: number;
  total_chars: number;
  has_blueprint: boolean;
  /** 项目概述与技术评分要求是否都已经有了 */
  has_analysis: boolean;
  busy: boolean;
}

export type ChapterStatus = 'empty' | 'done' | 'failed' | 'cancelled';

export interface ChapterDigest {
  summary: string;
  claims: string[];
}

/** 章节数据（不含历史版本的正文，只有个数） */
export interface ChapterView {
  uid: string;
  status: ChapterStatus;
  content: string;
  chars: number;
  target_words: number | null;
  source: 'ai' | 'manual' | 'revised';
  error: string | null;
  /** error 的类型：write 撰写没写成 / rewrite 重新生成没成功（保留了原正文）/ revise 修订没成功（保留了原正文）；旧数据可能没有 */
  error_kind?: 'write' | 'rewrite' | 'revise' | null;
  truncated: boolean;
  section_titles: string[];
  digest: ChapterDigest | null;
  updated_at: string;
  version_count: number;
}

export interface ChapterVersion {
  content: string;
  saved_at: string;
  source: string;
  note: string;
}

export interface ChapterDetail extends Omit<ChapterView, 'version_count'> {
  versions: ChapterVersion[];
}

export interface FactItem {
  key: string;
  value: string;
  source?: string;
}

export interface TermItem {
  term: string;
  definition: string;
}

export interface FactSheet {
  project_name: string;
  purchaser: string;
  facts: FactItem[];
  decisions: FactItem[];
  terminology: TermItem[];
  placeholders: string[];
}

export type PlanForm = 'paragraph' | 'table' | 'steps' | 'mixed';

export interface ChapterPlan {
  uid: string;
  key_points: string[];
  requirement_ids: string[];
  auto_assigned: string[];
  avoid: string[];
  weight: number;
  form: PlanForm;
  note: string;
}

export interface Blueprint {
  version: number;
  generated_at: string;
  model: string;
  fact_sheet: FactSheet;
  plans: Record<string, ChapterPlan>;
  unassigned_requirements: string[];
  warnings: string[];
  outline_fingerprint: string;
}

export interface RequirementItem {
  id: string;
  kind: 'scoring' | 'requirement';
  name: string;
  score: string;
  detail: string;
  keywords: string[];
  location: string;
  suggestion: string;
  raw: string;
}

export type IssueSeverity = 'high' | 'medium' | 'low';

export type IssueType =
  | 'empty'
  | 'failed'
  | 'partial'
  | 'length'
  | 'duplicate'
  | 'repeat'
  | 'boilerplate'
  | 'markup'
  | 'coverage'
  | 'consistency';

export interface ReviewIssue {
  id: string;
  type: IssueType;
  severity: IssueSeverity;
  chapter_uids: string[];
  title: string;
  detail: string;
  suggestion: string;
  excerpt: string;
  fixable: boolean;
  fix_instruction: string;
}

export interface CoverageItem {
  requirement_id: string;
  name: string;
  kind: string;
  status: 'covered' | 'partial' | 'missing' | 'unassigned';
  chapter_uids: string[];
  missing_keywords: string[];
  note: string;
}

export interface PlaceholderItem {
  chapter_uid: string;
  text: string;
  context: string;
}

export interface ReviewStats {
  leaf_total: number;
  done: number;
  failed: number;
  empty: number;
  total_chars: number;
  target_chars: number;
  placeholder_count: number;
  issue_count: number;
}

/** 审校接口（重新检查、忽略/恢复问题）的返回：审校结果 + 它与当前目录是否对不上 */
export interface ReviewResponse extends ReviewReport {
  /** 这份结果检查时的章节集合与当前目录不一致（增删过章节）；对应 ProjectState.review_outline_changed */
  outline_changed: boolean;
  /** 服务端返回这份结果的时刻（与 ProjectState.state_at 同一口径）：比它早读出的整份状态里的审校结果是旧的 */
  state_at?: string;
}

export interface ReviewReport {
  generated_at: string;
  deep: boolean;
  stats: ReviewStats;
  issues: ReviewIssue[];
  coverage: CoverageItem[];
  placeholders: PlaceholderItem[];
  warnings: string[];
  dismissed: string[];
  /** 检查时叶子章节集合的指纹（服务端用来判断目录是否变过） */
  outline_fingerprint: string;
}

export type JobKind = 'plan' | 'write' | 'revise' | 'review';
export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export interface JobProgress {
  total: number;
  done: number;
  failed: number;
  chars: number;
}

export interface JobRecord {
  id: string;
  project_id: string;
  kind: JobKind;
  status: JobStatus;
  stage: string;
  message: string;
  params: Record<string, unknown>;
  progress: JobProgress;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  usage: Record<string, number>;
  /**
   * 任务的结果摘要。深度审校：deep 是否真的核对了前后一致性；batches 一致性检查分了几批（0 表示没有可核对的表述）；
   * failed_batches 其中没检查完的批数（分批本身不算问题）
   */
  result?: Record<string, unknown>;
}

export interface JobSnapshot {
  job: JobRecord;
  last_seq: number;
  /** 正在写的章节当前已写出的文本（uid → 文本） */
  live: Record<string, string>;
  /** 已排进本次任务、还没开始写的章节 */
  queued: string[];
}

export interface MaterialMeta {
  id: string;
  name: string;
  kind: string;
  char_count: number;
  uploaded_at: string;
  warning: string;
}

export interface ProjectState {
  /**
   * 这份整份状态在服务端读取的时刻（同一进程内严格递增，可以直接按字符串比较先后）。
   * 晚到的旧响应（state_at 更早）不应把更新的计划、审校结果等换回去
   */
  state_at: string;
  /**
   * 只在前端使用：本页的审校结果来自审校接口时，记下那次响应的 state_at。
   * 比它早读出的整份状态里的审校结果是旧的，合并时保留本页的
   */
  review_at?: string;
  project: Project;
  leaves: LeafInfo[];
  chapters: Record<string, ChapterView>;
  budget: Record<string, number>;
  budget_note: string;
  blueprint: Blueprint | null;
  /** 有章节还没有写作计划（只调整顺序、删掉章节都不算） */
  blueprint_stale: boolean;
  review: ReviewReport | null;
  /** 审校之后增删过章节：审校结果可能已经对不上 */
  review_outline_changed: boolean;
  materials: MaterialMeta[];
  requirements: RequirementItem[];
  job: JobSnapshot | null;
}

/** 任务事件流里的事件 */
export type JobEvent =
  | { type: 'job_start'; job: JobRecord }
  | { type: 'job_stage'; stage: string; message: string }
  | { type: 'job_progress'; progress: JobProgress }
  | { type: 'job_end'; job: JobRecord }
  | { type: 'write_plan'; uids: string[]; budget: Record<string, number | null>; note: string }
  | { type: 'chapter_start'; uid: string; id: string; title: string; target_words: number | null; revise?: boolean }
  | { type: 'chapter_delta'; uid: string; text: string }
  | { type: 'chapter_reset'; uid: string; text: string }
  | { type: 'chapter_done'; uid: string; chapter: ChapterView }
  | { type: 'chapter_failed'; uid: string; error: string; chapter: ChapterView }
  | { type: 'chapter_stopped'; uid: string; chapter: ChapterView }
  | { type: 'blueprint_ready'; plan_count: number; warnings: string[] }
  | { type: 'review_ready'; stats: ReviewStats }
  | { type: 'resync' };

export interface Persona {
  id: string;
  name: string;
  description: string;
}

export interface AppMeta {
  app_name: string;
  version: string;
  demo: boolean;
  personas: Persona[];
  max_file_size: number;
}

export interface AppSettings {
  api_key_set: boolean;
  api_key_hint: string;
  base_url: string;
  model_name: string;
  demo: boolean;
}

export interface ExportOptions {
  with_diagrams?: boolean;
  diagram_model?: string | null;
  include_toc?: boolean;
  include_overview?: boolean;
  allow_incomplete?: boolean;
}

export interface ExportResult {
  blob: Blob;
  filename: string;
  diagramCount: number;
  diagramError: string;
  missingChapters: number;
}

/** 流式接口（解析、目录生成）里的事件 */
export interface StreamEvent {
  /** warning：结果可能不完整之类的提示，解析结束后页面仍保留 */
  type?: 'progress' | 'result' | 'warning';
  message?: string;
  chunk?: string;
  text?: string;
  outline?: OutlineNode[];
  error?: boolean;
  /** 错误事件的固定错误码，例如项目被占用时为 project_busy */
  code?: string;
}
