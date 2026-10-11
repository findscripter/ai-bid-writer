/**
 * 目录生成的过程状态：发起、逐条收过程记录、中止、收尾。
 *
 * 生成由后端完成并直接保存；这里只负责把过程讲给使用者听，结束后重新取一次项目状态。
 * 离开目录页（组件卸载）时会自动中止。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { useWorkspace } from '../WorkspaceContext';

export type OutlineMode = 'free' | 'aligned';

export type GenerationStatus = 'idle' | 'running' | 'done' | 'failed' | 'cancelled';

export interface GenerationLogLine {
  /** 距开始的毫秒数 */
  at: number;
  message: string;
}

interface GenerationState {
  status: GenerationStatus;
  /** 这一次生成用的方式 */
  mode: OutlineMode;
  log: GenerationLogLine[];
  error: string;
  startedAt: number;
  finishedAt: number;
}

export interface OutlineGeneration extends GenerationState {
  running: boolean;
  /** 开始生成；新目录已经保存时返回 true */
  start: (options: { mode: OutlineMode; materialId: string | null }) => Promise<boolean>;
  abort: () => void;
  /** 收起上一次的结果 */
  dismiss: () => void;
}

const IDLE: GenerationState = { status: 'idle', mode: 'free', log: [], error: '', startedAt: 0, finishedAt: 0 };

export function useOutlineGeneration(): OutlineGeneration {
  const ws = useWorkspace();
  const projectId = ws.projectId;
  const [state, setState] = useState<GenerationState>(IDLE);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const reloadRef = useRef(ws.reload);
  reloadRef.current = ws.reload;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (controllerRef.current) controllerRef.current.abort();
    };
  }, []);

  const start = useCallback(
    async (options: { mode: OutlineMode; materialId: string | null }): Promise<boolean> => {
      if (controllerRef.current) return false;
      const controller = new AbortController();
      controllerRef.current = controller;
      const startedAt = Date.now();
      setState({ status: 'running', mode: options.mode, log: [], error: '', startedAt, finishedAt: 0 });

      const push = (message: string) => {
        if (!mountedRef.current) return;
        setState((prev) =>
          prev.startedAt === startedAt ? { ...prev, log: prev.log.concat([{ at: Date.now() - startedAt, message }]) } : prev
        );
      };

      let saved = false;
      let failure: unknown = null;
      try {
        await api.generateOutline(
          projectId,
          { mode: options.mode, material_id: options.materialId },
          (event) => {
            if (event.type === 'progress' && event.message) push(event.message);
            else if (event.type === 'result') saved = true; // 后端已经把新目录存好了
          },
          controller.signal
        );
      } catch (error) {
        failure = error;
      }
      controllerRef.current = null;

      // 目录以后端为准：不管是正常结束、失败还是中止，都重新取一次，界面和后端保持一致
      await reloadRef.current();
      if (!mountedRef.current) return saved;

      let status: GenerationStatus;
      let error = '';
      if (saved) {
        status = 'done';
        push('新目录已保存。');
      } else if (controller.signal.aborted) {
        status = 'cancelled';
      } else {
        status = 'failed';
        error = failure
          ? errorMessage(failure, '目录生成失败，请重试')
          : '生成中途断开了，没有收到目录。请重试。';
      }
      setState((prev) => (prev.startedAt === startedAt ? { ...prev, status, error, finishedAt: Date.now() } : prev));
      return saved;
    },
    [projectId]
  );

  const abort = useCallback(() => {
    if (controllerRef.current) controllerRef.current.abort();
  }, []);

  const dismiss = useCallback(() => {
    setState((prev) => (prev.status === 'running' ? prev : IDLE));
  }, []);

  return { ...state, running: state.status === 'running', start, abort, dismiss };
}
