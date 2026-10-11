/**
 * 招标文件区：上传、查看原文、更换。
 */
import React, { memo, useEffect, useRef, useState } from 'react';
import {
  ArrowPathIcon,
  ArrowUpTrayIcon,
  DocumentTextIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { api, errorMessage } from '../../api/client';
import type { ProjectState } from '../../api/types';
import { useAppShell } from '../../app/AppShell';
import { formatChars, formatRelativeTime } from '../../lib/format';
import { Button, ProgressBar, cx, useConfirm, useToast } from '../../ui';
import { useWorkspace } from '../WorkspaceContext';
import { FileDropzone } from './FileDropzone';
import type { FileDropzoneHandle, FileSource } from './FileDropzone';
import { TenderTextDrawer } from './TenderTextDrawer';
import { checkDocumentFile, formatFileSize, formatHint } from './upload';

interface TenderFileCardProps {
  /** 现在不能更换文件的原因；可以更换时传空串 */
  lockReason: string;
  /** 是否已经有解析结果（更换前要先确认） */
  hasAnalysis: boolean;
  /** 上传成功之后（项目数据已更新）；replaced 表示换掉了原来的文件 */
  onUploaded: (state: ProjectState, replaced: boolean) => void;
  /** 开始、结束上传时通知外层（上传、读取期间不能解析：解析读到的还是旧文件） */
  onUploadingChange?: (uploading: boolean) => void;
}

/** 「5 分钟前上传」「昨天 14:05 上传」 */
function uploadedLabel(iso: string): string {
  const text = formatRelativeTime(iso);
  if (!text) return '';
  return /\d$/.test(text) ? `${text} 上传` : `${text}上传`;
}

function fullTime(iso: string): string | undefined {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString();
}

function TenderFileCardImpl({ lockReason, hasAnalysis, onUploaded, onUploadingChange }: TenderFileCardProps) {
  const ws = useWorkspace();
  const shell = useAppShell();
  const toast = useToast();
  const confirm = useConfirm();
  const dropRef = useRef<FileDropzoneHandle>(null);
  const [uploading, setUploading] = useState<{ name: string; size: number } | null>(null);
  const [failure, setFailure] = useState<{ name: string; message: string } | null>(null);
  const [textOpen, setTextOpen] = useState(false);

  const tender = ws.data.project.tender;
  const hasTender = Boolean(tender.filename);
  const hasOutline = ws.data.leaves.length > 0;
  const maxSize = shell.meta ? shell.meta.max_file_size : null;
  const busy = uploading !== null;

  useEffect(() => {
    if (!onUploadingChange) return undefined;
    onUploadingChange(busy);
    return () => onUploadingChange(false);
  }, [busy, onUploadingChange]);
  const consequence = hasOutline
    ? '现有的项目概述和技术评分要求是按现在这份文件解析的，更换后需要重新解析。已经生成的目录和正文不会跟着变。'
    : '现有的项目概述和技术评分要求是按现在这份文件解析的，更换后需要重新解析。';

  const upload = async (file: File) => {
    const problem = checkDocumentFile(file, maxSize);
    if (problem) {
      setFailure({ name: file.name, message: problem });
      return;
    }
    setFailure(null);
    setUploading({ name: file.name, size: file.size });
    try {
      const state = await api.uploadTender(ws.projectId, file);
      ws.apply(state);
      onUploaded(state, hasTender);
      toast.success(hasTender ? '招标文件已更换' : '招标文件已上传');
    } catch (error) {
      setFailure({ name: file.name, message: errorMessage(error, '上传失败，请重试') });
    } finally {
      setUploading(null);
    }
  };

  const onFiles = async (files: File[], source: FileSource) => {
    if (busy || lockReason) return;
    if (files.length > 1) {
      setFailure({ name: `${files.length} 个文件`, message: '一次只能上传一份招标文件，请只选择或拖入一个文件。' });
      return;
    }
    const file = files[0];
    // 点“更换文件”时已经确认过；直接拖进来的要在这里确认
    if (source === 'drop' && hasTender && hasAnalysis) {
      const ok = await confirm({
        title: '更换招标文件？',
        description: (
          <>
            用《{file.name}》替换《{tender.filename}》。{consequence}
          </>
        ),
        confirmText: '更换',
      });
      if (!ok) return;
    }
    await upload(file);
  };

  const replace = async () => {
    if (hasAnalysis) {
      const ok = await confirm({ title: '更换招标文件？', description: consequence, confirmText: '选择新文件' });
      if (!ok) return;
    }
    if (dropRef.current) dropRef.current.open();
  };

  const failureBox = failure && (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] leading-6 text-rose-700"
    >
      <ExclamationCircleIcon className="mt-1 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="break-all font-medium">{failure.name} 没有上传成功</p>
        <p className="break-words">{failure.message}</p>
      </div>
      <button
        type="button"
        aria-label="关闭提示"
        title="关闭提示"
        onClick={() => setFailure(null)}
        className="-mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-rose-500 transition-colors hover:bg-rose-100 hover:text-rose-700"
      >
        <XMarkIcon className="h-4 w-4" />
      </button>
    </div>
  );

  if (!hasTender) {
    return (
      <div className="space-y-2">
        <FileDropzone
          ref={dropRef}
          clickable
          label="选择招标文件"
          inputName="tender-file"
          disabled={busy || Boolean(lockReason)}
          onFiles={(files, source) => void onFiles(files, source)}
          className="rounded-lg"
        >
          {({ dragging }) => (
            <div
              className={cx(
                'flex min-h-[11rem] flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors',
                dragging
                  ? 'border-primary-400 bg-primary-50'
                  : busy || lockReason
                    ? 'border-line-strong bg-white'
                    : 'border-line-strong bg-white hover:border-primary-300 hover:bg-primary-50/40'
              )}
            >
              {uploading ? (
                <div className="w-full max-w-sm">
                  <p className="truncate text-sm font-medium text-ink-900">正在上传并读取 {uploading.name}</p>
                  <ProgressBar value={null} className="mt-3" />
                  <p className="mt-2 text-xs text-ink-500">
                    {formatFileSize(uploading.size)} · 页数多的 PDF 可能需要十几秒，请稍候
                  </p>
                </div>
              ) : (
                <>
                  <span
                    className={cx(
                      'flex h-11 w-11 items-center justify-center rounded-full',
                      dragging ? 'bg-primary-100 text-primary-600' : 'bg-canvas text-ink-500'
                    )}
                    aria-hidden="true"
                  >
                    <ArrowUpTrayIcon className="h-5 w-5" />
                  </span>
                  <p className="mt-3 text-sm font-medium text-ink-900">
                    {dragging ? (
                      '松开鼠标，上传这份文件'
                    ) : (
                      <>
                        把招标文件拖到这里，或<span className="text-primary-600">点击选择文件</span>
                      </>
                    )}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-ink-500">{lockReason || formatHint(maxSize)}</p>
                </>
              )}
            </div>
          )}
        </FileDropzone>
        {failureBox}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <FileDropzone
        ref={dropRef}
        label="更换招标文件"
        inputName="tender-file"
        disabled={busy || Boolean(lockReason)}
        onFiles={(files, source) => void onFiles(files, source)}
      >
        {({ dragging }) => (
          <div
            className={cx(
              'overflow-hidden rounded-lg border bg-white shadow-card transition-colors',
              dragging ? 'border-primary-400 ring-2 ring-primary-500/20' : 'border-line'
            )}
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3.5">
              <span
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-600"
                aria-hidden="true"
              >
                <DocumentTextIcon className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1 basis-48">
                <p className="truncate text-sm font-medium text-ink-900" title={tender.filename}>
                  {tender.filename}
                </p>
                <p className="mt-0.5 text-xs text-ink-500">
                  <span className="tabular-nums">{formatChars(tender.char_count)}</span>
                  {tender.uploaded_at ? (
                    <span title={fullTime(tender.uploaded_at)}> · {uploadedLabel(tender.uploaded_at)}</span>
                  ) : null}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button icon={<EyeIcon />} onClick={() => setTextOpen(true)}>
                  查看原文
                </Button>
                <Button
                  icon={<ArrowPathIcon />}
                  loading={busy}
                  disabled={Boolean(lockReason)}
                  title={lockReason || undefined}
                  onClick={() => void replace()}
                >
                  更换文件
                </Button>
              </div>
            </div>

            {dragging && (
              <p className="border-t border-primary-200 bg-primary-50 px-4 py-2 text-[13px] text-primary-800">
                松开鼠标，用这份文件替换当前的招标文件
              </p>
            )}

            {uploading && (
              <div className="border-t border-line bg-subtle px-4 py-3">
                <ProgressBar value={null} label={`正在上传并读取 ${uploading.name}`} />
                <p className="mt-1.5 text-xs text-ink-500">页数多的 PDF 可能需要十几秒，请稍候。读取成功后才会替换现在的文件。</p>
              </div>
            )}

            {tender.warning && (
              <div className="flex items-start gap-2 border-t border-amber-200 bg-amber-50 px-4 py-2.5 text-[13px] leading-6 text-amber-900">
                <ExclamationTriangleIcon className="mt-1 h-4 w-4 shrink-0 text-amber-600" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">这份文件读出来的内容可能有问题</p>
                  <p className="break-words">{tender.warning}</p>
                </div>
              </div>
            )}
          </div>
        )}
      </FileDropzone>
      {failureBox}

      <TenderTextDrawer
        open={textOpen}
        onClose={() => setTextOpen(false)}
        projectId={ws.projectId}
        filename={tender.filename}
        charCount={tender.char_count}
        version={tender.uploaded_at}
      />
    </div>
  );
}

export const TenderFileCard = memo(TenderFileCardImpl);
