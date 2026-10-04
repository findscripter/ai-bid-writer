/**
 * API 服务与流式响应工具
 */
import axios from 'axios';
import { ConfigData, OutlineData, OutlineItem, OutlineMode } from '../types';

// 生产构建由后端同端口托管，走同源（换端口也不用改）；开发服务器默认连本机 8000
const API_BASE_URL =
  process.env.REACT_APP_API_URL || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8000');

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 120000,
});

api.interceptors.response.use(
  (response) => response,
  (error) => Promise.reject(error)
);

export interface FileUploadResponse {
  success: boolean;
  message: string;
  file_content?: string;
  old_outline?: string;
}

export interface AnalysisRequest {
  file_content: string;
  analysis_type: 'overview' | 'requirements';
}

export interface OutlineRequest {
  overview: string;
  requirements: string;
  mode?: OutlineMode;
  uploaded_expand?: boolean;
  old_outline?: string;
  old_document?: string;
}

export interface ChapterContentRequest {
  chapter: OutlineItem;
  parent_chapters?: OutlineItem[];
  sibling_chapters?: OutlineItem[];
  project_overview: string;
  target_words?: number;
  persona?: string;
  prior_summaries?: { copy_index: string; summary: string }[];
}

export interface Persona {
  id: string;
  name: string;
  description: string;
}

export interface MultiCopyContentRequest {
  outline: { outline: OutlineItem[] };
  project_overview: string;
  target_pages: number;
  extended_target_pages?: number;
  words_per_page?: number;
  copies: number;
  personas?: Persona[];
  inject_response_chapters?: boolean;
  parallel_concurrency?: number;
  models?: string[];
}

export type MultiCopyEvent =
  | { type: 'meta'; leaf_count: number; total_leaf_count?: number; copies: number; target_pages: number; extended_target_pages?: number | null; words_per_page: number; personas: Persona[]; injected_response_chapters?: boolean; parallel_concurrency?: number; copies_plan?: { copy_index: number; leaf_count: number; is_extended?: boolean; target_pages?: number; persona?: Persona | null; variant_failed?: boolean; model?: string; }[]; }
  | { type: 'copy_start'; copy_index: number; persona: Persona | null; is_extended?: boolean; target_pages?: number; leaf_count?: number; outline?: OutlineItem[]; variant_failed?: boolean; model?: string; }
  | { type: 'chapter_start'; copy_index: number; chapter_id: string; title: string; target_words: number | null; persona_id: string | null; is_response_chapter?: boolean; }
  | { type: 'chapter_chunk'; copy_index: number; chapter_id: string; delta: string; }
  | { type: 'chapter_end'; copy_index: number; chapter_id: string; content: string; char_count: number; error?: boolean; }
  | { type: 'copy_end'; copy_index: number; }
  | { type: 'all_done'; }
  | { error: true; message?: string; };

export interface WordExportRequest {
  project_name?: string;
  project_overview?: string;
  outline: OutlineItem[];
  copy_index?: number;
  persona_name?: string;
  with_diagrams?: boolean;
  diagram_model?: string;
}

export interface StreamEvent {
  type?: 'progress' | 'result';
  chunk?: string;
  outline?: OutlineData;
  error?: boolean;
  message?: string;
}

const formatErrorDetail = (detail: unknown): string | null => {
  if (!detail) {
    return null;
  }

  if (typeof detail === 'string') {
    return detail;
  }

  if (Array.isArray(detail)) {
    const lines = detail
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        if (item && typeof item === 'object') {
          const maybeItem = item as { loc?: Array<string | number>; msg?: string };
          const path = maybeItem.loc?.join(' -> ');
          return path ? `${path}: ${maybeItem.msg || '参数校验失败'}` : (maybeItem.msg || '参数校验失败');
        }

        return null;
      })
      .filter((line): line is string => Boolean(line));

    return lines.length > 0 ? lines.join('；') : null;
  }

  if (detail && typeof detail === 'object') {
    const maybeDetail = detail as { detail?: unknown; message?: string };
    return formatErrorDetail(maybeDetail.detail) || maybeDetail.message || JSON.stringify(detail);
  }

  return String(detail);
};

export const getErrorMessage = (error: unknown, fallback = '请求失败'): string => {
  if (axios.isAxiosError(error)) {
    const detail = error.response?.data?.detail;
    const message = error.response?.data?.message;
    return formatErrorDetail(detail) || message || error.message || fallback;
  }

  if (error instanceof Error) {
    return error.message || fallback;
  }

  return fallback;
};

const ensureResponseOk = async (response: Response, fallback: string): Promise<Response> => {
  if (response.ok) {
    return response;
  }

  try {
    const data = await response.json();
    throw new Error(formatErrorDetail(data.detail) || data.message || fallback);
  } catch (error) {
    if (error instanceof Error && error.message !== 'Unexpected end of JSON input') {
      throw error;
    }
  }

  const text = await response.text();
  throw new Error(text || fallback);
};

export const readSseStream = async (
  response: Response,
  onEvent: (event: StreamEvent) => void,
  fallbackMessage: string
): Promise<void> => {
  await ensureResponseOk(response, fallbackMessage);

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('无法读取响应流');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const eventBlock of events) {
      const dataLine = eventBlock
        .split('\n')
        .find((line) => line.startsWith('data: '));

      if (!dataLine) {
        continue;
      }

      const data = dataLine.slice(6);
      if (data === '[DONE]') {
        return;
      }

      let event: StreamEvent | null = null;
      try {
        event = JSON.parse(data) as StreamEvent;
      } catch {
        // 忽略非法片段，等待后续完整数据
        continue;
      }

      onEvent(event);
    }
  }
};

export const collectSseText = async (
  response: Response,
  onText?: (fullText: string, chunk: string) => void,
  fallbackMessage = '流式请求失败'
): Promise<string> => {
  let fullText = '';

  await readSseStream(
    response,
    (event) => {
      if (event.error) {
        throw new Error(event.message || fallbackMessage);
      }

      if (!event.chunk) {
        return;
      }

      fullText += event.chunk;
      onText?.(fullText, event.chunk);
    },
    fallbackMessage
  );

  return fullText;
};

const postJson = (path: string, data: unknown) =>
  fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });

export const configApi = {
  saveConfig: (config: ConfigData) => api.post('/api/config/save', config),
  loadConfig: () => api.get<ConfigData>('/api/config/load'),
  getModels: (config: ConfigData) => api.post<{ models: string[]; success: boolean; message: string }>('/api/config/models', config),
};

export const documentApi = {
  uploadFile: (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post<FileUploadResponse>('/api/document/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
  },
  analyzeDocumentStream: (data: AnalysisRequest) => postJson('/api/document/analyze-stream', data),
  exportWord: async (data: WordExportRequest) => ensureResponseOk(await postJson('/api/document/export-word', data), '导出失败'),
};

export const outlineApi = {
  generateOutline: (data: OutlineRequest) => api.post<OutlineData>('/api/outline/generate', data),
  generateOutlineStream: (data: OutlineRequest) => postJson('/api/outline/generate-stream', data),
};

export const contentApi = {
  generateChapterContent: (data: ChapterContentRequest) => api.post<{ success: boolean; content: string }>('/api/content/generate-chapter', data),
  generateChapterContentStream: (data: ChapterContentRequest) => postJson('/api/content/generate-chapter-stream', data),
  generateMultiCopiesStream: (data: MultiCopyContentRequest) => postJson('/api/content/generate-multi-copies', data),
  getPersonas: () => api.get<{ personas: Persona[] }>('/api/content/personas'),
};

export const readMultiCopySseStream = async (
  response: Response,
  onEvent: (event: MultiCopyEvent) => void,
  fallbackMessage = '多份生成失败'
): Promise<void> => {
  await ensureResponseOk(response, fallbackMessage);
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('无法读取响应流');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const block of events) {
      const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
      if (!dataLine) {
        continue;
      }
      const data = dataLine.slice(6);
      if (data === '[DONE]') {
        return;
      }
      try {
        onEvent(JSON.parse(data) as MultiCopyEvent);
      } catch {
        // 忽略不完整片段
      }
    }
  }
};

export const expandApi = {
  uploadExpandFile: (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post<FileUploadResponse>('/api/expand/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
      timeout: 300000,
    });
  },
};

export default api;
