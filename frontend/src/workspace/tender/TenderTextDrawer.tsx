/**
 * 「查看原文」抽屉：显示从招标文件里提取出的全文（纯文本）。
 * 打开时才去取；同一版文件只取一次。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DocumentDuplicateIcon } from '@heroicons/react/24/outline';
import { api, errorMessage } from '../../api/client';
import { formatChars } from '../../lib/format';
import { Button, Drawer, EmptyState, Spinner, useToast } from '../../ui';

interface TenderTextDrawerProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  filename: string;
  charCount: number;
  /** 招标文件的上传时间：文件换了就要重新取 */
  version: string;
}

interface Page {
  /** PDF 的页码；Word 文档没有分页，为 null */
  number: number | null;
  text: string;
}

// 后端提取 PDF 时在每页前面加的标记
const PAGE_MARK = /^--- 第 (\d+) 页 ---$/;

function splitPages(text: string): Page[] {
  const pages: Page[] = [];
  let current: Page = { number: null, text: '' };
  let lines: string[] = [];
  const flush = () => {
    const body = lines.join('\n').replace(/^\n+|\n+$/g, '');
    if (body || current.number !== null) pages.push({ number: current.number, text: body });
    lines = [];
  };
  text.split('\n').forEach((line) => {
    const mark = PAGE_MARK.exec(line.trim());
    if (mark) {
      flush();
      current = { number: Number(mark[1]), text: '' };
    } else {
      lines.push(line);
    }
  });
  flush();
  return pages;
}

export function TenderTextDrawer({ open, onClose, projectId, filename, charCount, version }: TenderTextDrawerProps) {
  const toast = useToast();
  const [loaded, setLoaded] = useState<{ key: string; text: string } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(0);

  const cacheKey = `${projectId}:${version}`;
  const ready = loaded !== null && loaded.key === cacheKey;

  const load = useCallback(() => {
    const request = ++requestRef.current;
    setLoading(true);
    setError('');
    api
      .getTenderText(projectId)
      .then((text) => {
        if (requestRef.current !== request) return;
        setLoaded({ key: cacheKey, text });
      })
      .catch((cause) => {
        if (requestRef.current !== request) return;
        setError(errorMessage(cause, '原文读取失败'));
      })
      .then(() => {
        if (requestRef.current === request) setLoading(false);
      });
  }, [projectId, cacheKey]);

  useEffect(() => {
    if (open && !ready) load();
    // 只在打开、或文件换了的时候取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cacheKey]);

  // 组件卸载后不再处理返回结果
  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    []
  );

  const text = ready && loaded ? loaded.text : '';
  const pages = useMemo(() => (text ? splitPages(text) : []), [text]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('已复制原文');
    } catch {
      toast.error('复制失败，请手动选择文本复制');
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={760}
      padded={false}
      title="招标文件原文"
      description={`${filename} · ${formatChars(charCount)}`}
    >
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center gap-3 border-b border-line bg-subtle px-5 py-2 text-xs leading-5 text-ink-500">
          <p className="min-w-0 flex-1">
            这是从文件里提取出的文字，解析和撰写都以它为准。表格会转成用“|”分隔的文字。按 Ctrl+F 可以查找。
          </p>
          <Button
            size="sm"
            variant="ghost"
            disabled={!text}
            icon={<DocumentDuplicateIcon className="h-4 w-4" />}
            onClick={() => void copy()}
          >
            复制全文
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error ? (
            <EmptyState
              title="原文没有读出来"
              description={error}
              action={
                <Button loading={loading} onClick={load}>
                  重试
                </Button>
              }
            />
          ) : !ready ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-ink-500">
              <Spinner size="sm" label="正在读取原文" />
              正在读取原文…
            </div>
          ) : text.trim() === '' ? (
            <EmptyState
              title="没有提取到文字"
              description="这份文件里没有可以读取的文字，可能是扫描件或图片。请换用可以复制文字的版本后重新上传。"
            />
          ) : (
            <div className="space-y-5">
              {pages.map((page, index) => (
                <section key={index}>
                  {page.number !== null && (
                    <div className="mb-2 flex items-center gap-3 text-2xs text-ink-400">
                      <span className="shrink-0 tabular-nums">第 {page.number} 页</span>
                      <span className="h-px flex-1 bg-line" />
                    </div>
                  )}
                  {page.text ? (
                    <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-6 text-ink-700">
                      {page.text}
                    </pre>
                  ) : (
                    <p className="text-xs text-ink-400">这一页没有提取到文字（可能是扫描页或图片）。</p>
                  )}
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </Drawer>
  );
}
