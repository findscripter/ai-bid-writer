/**
 * 项目工作台的后端接口封装。
 *
 * - 普通请求：返回解析好的 JSON，失败时抛 ApiError（message 可以直接展示）。
 * - 流式请求（解析、目录生成）：postStream 逐个事件回调。
 * - 任务事件：subscribeJob 基于 EventSource，断线后浏览器自动重连并从上次的序号续传。
 */
import type {
  AppMeta,
  AppSettings,
  Blueprint,
  ChapterDetail,
  ChapterPlan,
  ChapterView,
  ExportOptions,
  ExportResult,
  FactSheet,
  JobEvent,
  JobKind,
  JobSnapshot,
  OutlineNode,
  ProjectSettings,
  ProjectState,
  ProjectSummary,
  ReviewResponse,
  StreamEvent,
} from './types';

/** 生产构建由后端同端口托管，走同源；开发服务器（3000 端口）默认连本机 8000 */
export const API_BASE: string =
  process.env.REACT_APP_API_URL || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8000');

export class ApiError extends Error {
  status: number;
  /** 服务端给的固定错误码（响应头 X-Error-Code），用来区分同一状态码下的不同原因，不依赖提示文案 */
  code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function describeDetail(detail: unknown): string | null {
  if (!detail) return null;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    const lines = detail
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const entry = item as { loc?: Array<string | number>; msg?: string };
          const where = entry.loc ? entry.loc.filter((part) => part !== 'body').join('.') : '';
          return where ? `${where}: ${entry.msg || '参数不正确'}` : entry.msg || '参数不正确';
        }
        return null;
      })
      .filter((line): line is string => Boolean(line));
    return lines.length ? lines.join('；') : null;
  }
  if (typeof detail === 'object') {
    const entry = detail as { detail?: unknown; message?: string };
    return describeDetail(entry.detail) || entry.message || null;
  }
  return String(detail);
}

async function toApiError(response: Response, fallback: string): Promise<ApiError> {
  let message = fallback;
  try {
    const text = await response.text();
    if (text) {
      try {
        const data = JSON.parse(text);
        message = describeDetail(data.detail) || data.message || fallback;
      } catch {
        message = text.length < 300 ? text : fallback;
      }
    }
  } catch {
    // 读不到响应体就用兜底文案
  }
  return new ApiError(message, response.status, response.headers.get('X-Error-Code'));
}

/** 把任意异常转成可以直接展示的文字 */
export function errorMessage(error: unknown, fallback = '操作失败，请重试'): string {
  if (error instanceof ApiError) return error.message || fallback;
  if (error instanceof DOMException && error.name === 'AbortError') return '已取消';
  if (error instanceof TypeError) return '连接不上本机服务，请确认后端正在运行';
  if (error instanceof Error) return error.message || fallback;
  return fallback;
}

async function send(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  const init: RequestInit = { method, signal };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) throw await toApiError(response, `请求失败（${response.status}）`);
  return response;
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await send(method, path, body, signal);
  return (await response.json()) as T;
}

/**
 * POST 一个流式接口，逐个事件回调。流里出现错误事件时抛 ApiError。
 * 服务端按 "data: {...}\n\n" 发送，以 "data: [DONE]" 结束。
 */
export async function postStream(
  path: string,
  body: unknown,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await send('POST', path, body, signal);
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError('浏览器不支持读取流式响应', 0);

  const decoder = new TextDecoder();
  let buffer = '';
  const handleBlock = (block: string): boolean => {
    const lines = block.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') return true;
      let event: StreamEvent;
      try {
        event = JSON.parse(data) as StreamEvent;
      } catch {
        continue;
      }
      if (event.error) throw new ApiError(event.message || '处理失败', 0, event.code || null);
      onEvent(event);
    }
    return false;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';
    for (let i = 0; i < blocks.length; i++) {
      if (handleBlock(blocks[i])) {
        reader.cancel().catch(() => undefined);
        return;
      }
    }
  }
  if (buffer.trim()) handleBlock(buffer);
}

export interface JobSubscription {
  close: () => void;
}

/**
 * 订阅任务事件。
 * - onEvent：每个事件回调一次（带序号，已去重）。
 * - onResync：服务端补发不上，调用方应当重新拉取项目状态后再订阅。
 * - onLost：连接彻底断了且无法恢复（例如服务重启后任务已不存在）。
 */
export function subscribeJob(
  projectId: string,
  jobId: string,
  afterSeq: number,
  handlers: {
    onEvent: (seq: number, event: JobEvent) => void;
    onResync: () => void;
    onLost: () => void;
  }
): JobSubscription {
  let lastSeq = afterSeq;
  let closed = false;
  const source = new EventSource(`${API_BASE}/api/projects/${projectId}/jobs/${jobId}/events?after=${afterSeq}`);

  const close = () => {
    if (closed) return;
    closed = true;
    source.close();
  };

  source.onmessage = (message) => {
    if (closed) return;
    const seq = Number(message.lastEventId) || 0;
    let event: JobEvent;
    try {
      event = JSON.parse(message.data) as JobEvent;
    } catch {
      return;
    }
    if (event.type === 'resync') {
      close();
      handlers.onResync();
      return;
    }
    if (seq && seq <= lastSeq) return; // 重连后服务端可能重发，丢弃已处理过的
    if (seq) lastSeq = seq;
    handlers.onEvent(seq, event);
    if (event.type === 'job_end') close();
  };

  source.onerror = () => {
    if (closed) return;
    // CONNECTING 表示浏览器正在自动重连；CLOSED 表示放弃了（如 404）
    if (source.readyState === EventSource.CLOSED) {
      close();
      handlers.onLost();
    }
  };

  return { close };
}

function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      return fallback;
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1] : fallback;
}

/** 触发浏览器下载 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const project = (id: string) => `/api/projects/${encodeURIComponent(id)}`;

export const api = {
  // ---- 应用 ----
  meta: () => request<AppMeta>('GET', '/api/meta'),
  getSettings: () => request<AppSettings>('GET', '/api/settings'),
  /** api_key 传 null 或不传表示沿用已保存的密钥 */
  saveSettings: (body: { api_key?: string | null; base_url: string; model_name: string }) =>
    request<AppSettings>('PUT', '/api/settings', body),
  listModels: (body: { api_key?: string | null; base_url?: string | null }) =>
    request<{ models: string[] }>('POST', '/api/settings/models', body),
  testSettings: (body: { api_key?: string | null; base_url?: string | null; model_name?: string | null }) =>
    request<{ ok: boolean; message: string; latency_ms: number }>('POST', '/api/settings/test', body),

  // ---- 项目 ----
  listProjects: () => request<{ projects: ProjectSummary[] }>('GET', '/api/projects').then((r) => r.projects),
  createProject: (name: string) => request<ProjectState>('POST', '/api/projects', { name }),
  importProject: (archive: unknown) => request<ProjectState>('POST', '/api/projects/import', archive),
  getProject: (id: string, signal?: AbortSignal) => request<ProjectState>('GET', project(id), undefined, signal),
  patchProject: (
    id: string,
    patch: {
      name?: string;
      overview?: string;
      requirements?: string;
      company_profile?: string;
      settings?: ProjectSettings;
    }
  ) => request<ProjectState>('PATCH', project(id), patch),
  deleteProject: (id: string) => request<{ success: boolean }>('DELETE', project(id)),
  downloadArchive: async (id: string): Promise<void> => {
    const response = await send('GET', `${project(id)}/archive`);
    const name = filenameFromDisposition(response.headers.get('Content-Disposition'), '项目.aibid.json');
    saveBlob(await response.blob(), name);
  },

  // ---- 招标文件与参考资料 ----
  uploadTender: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<ProjectState>('POST', `${project(id)}/tender`, form);
  },
  getTenderText: (id: string) => request<{ text: string }>('GET', `${project(id)}/tender`).then((r) => r.text),
  /** 流式解析；事件：{type:'progress',message} / {chunk} / {type:'result',text} */
  analyze: (
    id: string,
    analysisType: 'overview' | 'requirements',
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal
  ) => postStream(`${project(id)}/analyze`, { analysis_type: analysisType }, onEvent, signal),
  uploadMaterial: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<ProjectState>('POST', `${project(id)}/materials`, form);
  },
  deleteMaterial: (id: string, materialId: string) =>
    request<ProjectState>('DELETE', `${project(id)}/materials/${encodeURIComponent(materialId)}`),

  // ---- 目录 ----
  /** 流式生成目录；事件：{type:'progress',message} / {type:'result',outline} */
  generateOutline: (
    id: string,
    body: { mode: 'free' | 'aligned'; material_id?: string | null },
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal
  ) => postStream(`${project(id)}/outline/generate`, body, onEvent, signal),
  saveOutline: (id: string, outline: OutlineNode[]) =>
    request<ProjectState>('PUT', `${project(id)}/outline`, { outline }),
  addResponseChapters: (id: string) => request<ProjectState>('POST', `${project(id)}/outline/response-chapters`),

  // ---- 写作蓝图 ----
  /** notes：只改这几章的“补充要求”（uid → 文本），服务端保留计划里的其它字段 */
  saveBlueprint: (
    id: string,
    patch: { fact_sheet?: FactSheet; plans?: Record<string, ChapterPlan>; notes?: Record<string, string> }
  ) =>
    request<ProjectState>('PUT', `${project(id)}/blueprint`, patch),
  deleteBlueprint: (id: string) => request<ProjectState>('DELETE', `${project(id)}/blueprint`),

  // ---- 章节 ----
  getChapter: (id: string, uid: string) => request<ChapterDetail>('GET', `${project(id)}/chapters/${uid}`),
  /**
   * 保存手动编辑的正文。baseUpdatedAt 传开始编辑时这一章的 updated_at：期间被别处改过时
   * 后端返回 409（ApiError.status === 409），由调用方决定是否不带它再保存一次（覆盖）。
   */
  saveChapter: (id: string, uid: string, content: string, baseUpdatedAt?: string | null) =>
    request<ChapterView>('PUT', `${project(id)}/chapters/${uid}`, {
      content,
      base_updated_at: baseUpdatedAt === undefined ? null : baseUpdatedAt,
    }),
  /** 恢复历史版本；savedAt 传该版本的 saved_at，列表变过时后端返回 409 */
  restoreChapter: (id: string, uid: string, index: number, savedAt?: string) =>
    request<ChapterDetail>('POST', `${project(id)}/chapters/${uid}/restore`, { index, saved_at: savedAt || null }),

  // ---- 后台任务 ----
  startJob: (id: string, kind: JobKind, params: Record<string, unknown> = {}) =>
    request<JobSnapshot>('POST', `${project(id)}/jobs`, { kind, params }),
  currentJob: (id: string) =>
    request<{ job: JobSnapshot | null }>('GET', `${project(id)}/jobs/current`).then((r) => r.job),
  cancelJob: (id: string, jobId: string) => request<JobSnapshot>('POST', `${project(id)}/jobs/${jobId}/cancel`),

  // ---- 审校 ----
  runReview: (id: string) => request<ReviewResponse>('POST', `${project(id)}/review/run`),
  dismissIssue: (id: string, issueId: string, dismissed: boolean) =>
    request<ReviewResponse>('POST', `${project(id)}/review/dismiss`, { issue_id: issueId, dismissed }),

  // ---- 导出 ----
  exportWord: async (id: string, options: ExportOptions): Promise<ExportResult> => {
    const response = await send('POST', `${project(id)}/export`, options);
    let diagramError = '';
    try {
      diagramError = decodeURIComponent(response.headers.get('X-Diagram-Error') || '');
    } catch {
      diagramError = response.headers.get('X-Diagram-Error') || '';
    }
    return {
      blob: await response.blob(),
      filename: filenameFromDisposition(response.headers.get('Content-Disposition'), '标书文档.docx'),
      diagramCount: Number(response.headers.get('X-Diagram-Count') || 0),
      diagramError,
      missingChapters: Number(response.headers.get('X-Missing-Chapters') || 0),
    };
  },
};

export type { Blueprint };
