/**
 * 「招标文件换过了，解析结果还是旧的」这件事的记号。
 *
 * 后端不记录解析结果是按哪一版招标文件得出的，所以更换文件时在浏览器里记一笔：
 * 哪几项解析结果还停留在旧文件上。重新解析一项就划掉一项；使用者也可以手动关掉提醒。
 * 记号只存在本机浏览器里，换浏览器或清除缓存后不会再提醒。
 */
import { useCallback, useEffect, useState } from 'react';
import type { AnalysisKind } from './useTenderAnalysis';

interface StaleMark {
  /** 更换后那份招标文件的上传时间；项目里的文件再变，这条记号就作废 */
  at: string;
  kinds: AnalysisKind[];
}

const NONE: AnalysisKind[] = [];

function storageKey(projectId: string): string {
  return `ai-bid:tender-stale:${projectId}`;
}

function read(projectId: string): StaleMark | null {
  try {
    const raw = window.localStorage.getItem(storageKey(projectId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StaleMark> | null;
    if (!value || typeof value.at !== 'string' || !Array.isArray(value.kinds)) return null;
    const kinds = value.kinds.filter((kind): kind is AnalysisKind => kind === 'overview' || kind === 'requirements');
    return kinds.length > 0 ? { at: value.at, kinds } : null;
  } catch {
    return null;
  }
}

function write(projectId: string, mark: StaleMark | null): void {
  try {
    if (mark && mark.kinds.length > 0) window.localStorage.setItem(storageKey(projectId), JSON.stringify(mark));
    else window.localStorage.removeItem(storageKey(projectId));
  } catch {
    // 存不了就只在这次打开页面期间提醒
  }
}

export interface StaleMarkApi {
  /** 还停留在旧招标文件上的解析项 */
  stale: AnalysisKind[];
  /** 招标文件刚换成了 uploadedAt 这一版，kinds 这几项解析结果是旧的 */
  markStale: (uploadedAt: string, kinds: AnalysisKind[]) => void;
  /** 划掉一项（已经重新解析）；不传则全部划掉（使用者不想再被提醒） */
  clearStale: (kind?: AnalysisKind) => void;
}

export function useStaleMark(projectId: string, uploadedAt: string): StaleMarkApi {
  const [mark, setMark] = useState<StaleMark | null>(() => read(projectId));

  useEffect(() => {
    setMark(read(projectId));
  }, [projectId]);

  const markStale = useCallback(
    (at: string, kinds: AnalysisKind[]) => {
      const next = kinds.length > 0 ? { at, kinds } : null;
      write(projectId, next);
      setMark(next);
    },
    [projectId]
  );

  const clearStale = useCallback(
    (kind?: AnalysisKind) => {
      setMark((prev) => {
        if (!prev) return prev;
        const kinds = kind ? prev.kinds.filter((item) => item !== kind) : [];
        const next = kinds.length > 0 ? { at: prev.at, kinds } : null;
        write(projectId, next);
        return next;
      });
    },
    [projectId]
  );

  const stale = mark && mark.at === uploadedAt ? mark.kinds : NONE;
  return { stale, markStale, clearStale };
}
