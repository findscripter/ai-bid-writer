/**
 * 招标文件解析的过程状态：依次解析若干项，实时给出正在生成的文本和阶段提示。
 *
 *   const analysis = useTenderAnalysis({ onDone, onError, onAllDone });
 *   analysis.start(['overview', 'requirements']);   // 依次解析；前一项失败或被中止，后面的不再继续
 *   analysis.stop();                                // 中止
 *   analysis.items.overview.phase / text / progress / error
 *
 * 每一项解析完，后端已经保存好结果；这里随即刷新项目数据（ws.reload）。
 * 离开页面时自动中止。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, errorMessage } from '../../api/client';
import type { StreamEvent } from '../../api/types';
import { useWorkspace } from '../WorkspaceContext';

export type AnalysisKind = 'overview' | 'requirements';

export const ANALYSIS_KINDS: AnalysisKind[] = ['overview', 'requirements'];

export const ANALYSIS_LABEL: Record<AnalysisKind, string> = {
  overview: '项目概述',
  requirements: '技术评分要求',
};

/** idle 空闲 / queued 等前一项 / running 解析中 / syncing 结果已保存、正在刷新项目数据 */
export type AnalysisPhase = 'idle' | 'queued' | 'running' | 'syncing';

export interface AnalysisItem {
  phase: AnalysisPhase;
  /** 正在生成的文本 */
  text: string;
  /** 阶段提示（长文件分段解析时出现） */
  progress: string;
  /** 这次解析过程中的提示（结果被输出上限截断等）：解析结束后仍然保留，直到下一次解析这一项或使用者关掉 */
  warnings: string[];
  /** 上一次解析失败的原因；下一次解析开始时清空 */
  error: string;
  /** 上一次解析根本没有开始：项目正被别的操作占着（有任务在跑、别处正在解析或生成目录） */
  blocked: boolean;
  /** 上一次解析是被使用者中止的 */
  stopped: boolean;
  /**
   * 刚解析完、后端已经存好的结果。项目数据刷新到新版本之前用它显示；version 是拿到结果时
   * 页面上项目数据的版本（project.updated_at）——项目数据一旦换了版本（刷新到了新结果，
   * 或者被手动修改过），就一律以项目数据为准，这份临时结果自动失效。
   */
  fresh: { text: string; version: string } | null;
}

const EMPTY_ITEM: AnalysisItem = {
  phase: 'idle',
  text: '',
  progress: '',
  warnings: [],
  error: '',
  blocked: false,
  stopped: false,
  fresh: null,
};

/**
 * 解析没能开始的原因（项目被占着，后端返回 409，或者流里第一条就是“请等它结束后再…”）；不是这种情况时返回 null。
 * 说法与页面上“任务结束或停止之前不能重新解析”的提示一致。
 */
export function busyReason(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const message = error.message || '';
  // 后端在“项目被占用”时带固定错误码（409 的响应头、流里的错误事件都有）；文字判断只为兼容旧服务
  const busy =
    error.code === 'project_busy' || error.status === 409 || (error.status === 0 && /请等它结束后再/.test(message));
  if (!busy) return null;
  if (/有任务正在运行|已有任务在运行/.test(message)) {
    return '有任务正在运行（可能是在别的窗口里开始的）。任务结束或停止之前不能解析，不然写到一半的内容会和新的解析结果对不上。';
  }
  if (/正在解析招标文件/.test(message)) return '这个项目正在别处解析招标文件（可能是另一个窗口），等那边结束后再解析。';
  if (/正在生成目录/.test(message)) return '这个项目正在别处生成目录（可能是另一个窗口），等那边结束后再解析。';
  return message || '项目正被别的操作占用，等它结束后再解析。';
}

type Items = Record<AnalysisKind, AnalysisItem>;

/**
 * 一项当前应该显示的内容：刚解析完、项目数据还没刷新过来时用新结果，其余时候都以项目数据为准。
 * version 传当前项目数据的 project.updated_at。
 */
export function shownText(item: AnalysisItem, saved: string, version: string): string {
  return item.fresh && item.fresh.version === version ? item.fresh.text : saved;
}

interface Options {
  /** 一项解析成功（结果已保存） */
  onDone?: (kind: AnalysisKind) => void;
  /** 一项解析失败（不含使用者主动中止）；blocked 为 true 表示根本没能开始（项目正被别的操作占着） */
  onError?: (kind: AnalysisKind, message: string, blocked: boolean) => void;
  /** 这一轮要解析的全部成功了（页面已经离开时不会调用） */
  onAllDone?: (kinds: AnalysisKind[]) => void;
}

export interface TenderAnalysis {
  /** 是否有解析在进行 */
  active: boolean;
  items: Items;
  start: (kinds: AnalysisKind[]) => void;
  stop: () => void;
  /** 关掉某一项解析结束后留下的提示 */
  dismissWarnings: (kind: AnalysisKind) => void;
}

export function useTenderAnalysis(options: Options = {}): TenderAnalysis {
  const ws = useWorkspace();
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [items, setItems] = useState<Items>({ overview: EMPTY_ITEM, requirements: EMPTY_ITEM });
  const [active, setActive] = useState(false);

  const mountedRef = useRef(true);
  const controllerRef = useRef<AbortController | null>(null);
  // 增量文本先攒着，每帧最多更新一次界面
  const bufferRef = useRef('');
  const frameRef = useRef<number | null>(null);

  const patch = useCallback((kind: AnalysisKind, change: (item: AnalysisItem) => AnalysisItem) => {
    if (!mountedRef.current) return;
    setItems((prev) => ({ ...prev, [kind]: change(prev[kind]) }));
  }, []);

  const dropBuffer = useCallback(() => {
    bufferRef.current = '';
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (controllerRef.current) controllerRef.current.abort();
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, []);

  const start = useCallback(
    (kinds: AnalysisKind[]) => {
      if (controllerRef.current || kinds.length === 0) return;
      const controller = new AbortController();
      controllerRef.current = controller;
      const projectId = wsRef.current.projectId;

      setActive(true);
      setItems((prev) => {
        const next = { ...prev };
        kinds.forEach((kind) => {
          next[kind] = { ...EMPTY_ITEM, phase: 'queued' };
        });
        return next;
      });

      const runOne = async (kind: AnalysisKind): Promise<void> => {
        const outcome: { text: string | null } = { text: null };
        dropBuffer();
        patch(kind, (item) => ({ ...item, phase: 'running' }));

        const onEvent = (event: StreamEvent) => {
          if (event.type === 'progress') {
            const message = event.message;
            if (message) patch(kind, (item) => ({ ...item, progress: message }));
          } else if (event.type === 'warning') {
            const message = event.message;
            if (message) {
              patch(kind, (item) => ({
                ...item,
                progress: message,
                warnings: item.warnings.indexOf(message) >= 0 ? item.warnings : item.warnings.concat(message),
              }));
            }
          } else if (event.type === 'result') {
            outcome.text = typeof event.text === 'string' ? event.text : '';
          } else if (typeof event.chunk === 'string' && event.chunk) {
            bufferRef.current += event.chunk;
            if (frameRef.current === null) {
              frameRef.current = window.requestAnimationFrame(() => {
                frameRef.current = null;
                const added = bufferRef.current;
                bufferRef.current = '';
                if (added) patch(kind, (item) => ({ ...item, text: item.text + added }));
              });
            }
          }
        };

        await api.analyze(projectId, kind, onEvent, controller.signal);
        // 流正常结束却没有结果：连接在中途断了
        if (outcome.text === null) throw new Error('连接中断，解析没有完成，请重试');
        const text = outcome.text;
        const version = wsRef.current.data.project.updated_at;
        dropBuffer();
        patch(kind, (item) => ({ ...item, phase: 'syncing', text: '', progress: '', fresh: { text, version } }));
        if (optionsRef.current.onDone) optionsRef.current.onDone(kind);
        await wsRef.current.reload();
        patch(kind, (item) => ({ ...item, phase: 'idle' }));
      };

      void (async () => {
        let finished = 0;
        for (; finished < kinds.length; finished++) {
          if (controller.signal.aborted) break;
          const kind = kinds[finished];
          try {
            await runOne(kind);
          } catch (error) {
            dropBuffer();
            const aborted = controller.signal.aborted;
            const busy = aborted ? null : busyReason(error);
            const message = aborted ? '' : busy || errorMessage(error, '解析失败，请重试');
            if (mountedRef.current) {
              const rest = kinds.slice(finished + 1);
              setItems((prev) => {
                const next = { ...prev };
                next[kind] = {
                  ...prev[kind],
                  phase: 'idle',
                  text: '',
                  progress: '',
                  // 这次没有存下结果，过程里的提示也就不用再看了
                  warnings: [],
                  error: message,
                  blocked: busy !== null,
                  stopped: aborted,
                };
                // 排在后面的不再继续
                rest.forEach((later) => {
                  next[later] = { ...prev[later], phase: 'idle' };
                });
                return next;
              });
              if (!aborted && optionsRef.current.onError) optionsRef.current.onError(kind, message, busy !== null);
            }
            break;
          }
        }
        // 没轮到的项（前一项失败，或者在两项之间被中止）回到空闲：不能一直显示“等待中”
        if (finished < kinds.length && mountedRef.current) {
          setItems((prev) => {
            let next = prev;
            kinds.forEach((kind) => {
              if (next[kind].phase !== 'queued') return;
              if (next === prev) next = { ...prev };
              next[kind] = { ...next[kind], phase: 'idle' };
            });
            return next;
          });
        }
        if (controllerRef.current === controller) controllerRef.current = null;
        if (mountedRef.current) setActive(false);
        if (finished < kinds.length) {
          // 失败或中止时也同步一次：后端有可能已经把结果存好了
          await wsRef.current.reload();
        } else if (mountedRef.current && optionsRef.current.onAllDone) {
          optionsRef.current.onAllDone(kinds);
        }
      })();
    },
    [dropBuffer, patch]
  );

  const stop = useCallback(() => {
    if (controllerRef.current) controllerRef.current.abort();
  }, []);

  const dismissWarnings = useCallback(
    (kind: AnalysisKind) => patch(kind, (item) => (item.warnings.length ? { ...item, warnings: [] } : item)),
    [patch]
  );

  return useMemo(() => ({ active, items, start, stop, dismissWarnings }), [active, items, start, stop, dismissWarnings]);
}
