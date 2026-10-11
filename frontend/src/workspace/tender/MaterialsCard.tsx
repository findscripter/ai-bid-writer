/**
 * 参考资料：旧方案、企业介绍等文档。撰写时按章节检索引用，生成目录时可以参考其中一份的目录结构。
 */
import React, { memo, useRef, useState } from 'react';
import {
  ArrowUpTrayIcon,
  DocumentTextIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { api, errorMessage } from '../../api/client';
import type { MaterialMeta } from '../../api/types';
import { useAppShell } from '../../app/AppShell';
import { formatChars, formatRelativeTime } from '../../lib/format';
import { Button, IconButton, Spinner, cx, useConfirm, useToast } from '../../ui';
import { useWorkspace } from '../WorkspaceContext';
import { FileDropzone } from './FileDropzone';
import type { FileDropzoneHandle } from './FileDropzone';
import { checkDocumentFile, formatHint } from './upload';

interface Failure {
  id: string;
  name: string;
  message: string;
}

let failureSeq = 0;

function MaterialsCardImpl() {
  const ws = useWorkspace();
  const shell = useAppShell();
  const toast = useToast();
  const confirm = useConfirm();
  const dropRef = useRef<FileDropzoneHandle>(null);
  /** 正在上传的文件名（按顺序一份一份传，第一个是正在处理的） */
  const [pending, setPending] = useState<string[]>([]);
  const [failures, setFailures] = useState<Failure[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);

  const materials = ws.data.materials;
  const maxSize = shell.meta ? shell.meta.max_file_size : null;
  const busy = pending.length > 0;

  const fail = (name: string, message: string) => {
    failureSeq += 1;
    const id = `failure-${failureSeq}`;
    setFailures((prev) => prev.concat({ id, name, message }));
  };

  const upload = async (files: File[]) => {
    if (busy) return;
    const existing: Record<string, true> = {};
    materials.forEach((material) => {
      existing[material.name] = true;
    });
    const accepted: File[] = [];
    files.forEach((file) => {
      const problem = checkDocumentFile(file, maxSize);
      if (problem) {
        fail(file.name, problem);
      } else if (existing[file.name]) {
        fail(file.name, '已经有一份同名的资料了。如果这是新版本，请先删掉旧的再上传。');
      } else {
        existing[file.name] = true;
        accepted.push(file);
      }
    });
    if (accepted.length === 0) return;

    setPending(accepted.map((file) => file.name));
    let added = 0;
    for (let i = 0; i < accepted.length; i++) {
      const file = accepted[i];
      try {
        ws.apply(await api.uploadMaterial(ws.projectId, file));
        added += 1;
      } catch (error) {
        fail(file.name, errorMessage(error, '上传失败，请重试'));
      }
      setPending((prev) => prev.slice(1));
    }
    if (added > 0) toast.success(added > 1 ? `已添加 ${added} 份参考资料` : '已添加参考资料');
  };

  const remove = async (material: MaterialMeta) => {
    const ok = await confirm({
      title: '删除这份参考资料？',
      description: `《${material.name}》删除后，撰写时不会再引用它；已经写好的正文不受影响。`,
      confirmText: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    setRemoving(material.id);
    try {
      ws.apply(await api.deleteMaterial(ws.projectId, material.id));
      toast.success('已删除');
    } catch (error) {
      toast.error(errorMessage(error, '删除失败，请重试'));
    } finally {
      setRemoving(null);
    }
  };

  const empty = materials.length === 0 && pending.length === 0;

  return (
    <FileDropzone
      ref={dropRef}
      multiple
      label="上传参考资料"
      inputName="material-file"
      disabled={busy}
      onFiles={(files) => void upload(files)}
      className="h-full"
    >
      {({ dragging, open }) => (
        <section
          className={cx(
            'flex h-full flex-col overflow-hidden rounded-lg border bg-white shadow-card transition-colors',
            dragging ? 'border-primary-400 ring-2 ring-primary-500/20' : 'border-line'
          )}
        >
          <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold leading-6 text-ink-900">
              参考资料
              <span className="text-xs font-normal tabular-nums text-ink-400">
                {materials.length > 0 ? `${materials.length} 份` : '可选'}
              </span>
            </h3>
            <Button size="sm" icon={<ArrowUpTrayIcon />} loading={busy} onClick={open}>
              上传资料
            </Button>
          </header>

          <div className="flex flex-1 flex-col px-4 py-3">
            <p className="text-[13px] leading-6 text-ink-600">
              旧方案、企业介绍、产品说明等。撰写每一章时会从这些资料里检索相关片段，供模型改写引用；生成目录时也可以参考其中一份的目录结构。
            </p>

            {failures.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {failures.map((failure) => (
                  <li
                    key={failure.id}
                    role="alert"
                    className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs leading-5 text-rose-700"
                  >
                    <ExclamationCircleIcon className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="break-all font-medium">{failure.name} 没有添加成功</p>
                      <p className="break-words">{failure.message}</p>
                    </div>
                    <button
                      type="button"
                      aria-label="关闭提示"
                      title="关闭提示"
                      onClick={() => setFailures((prev) => prev.filter((item) => item.id !== failure.id))}
                      className="-mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-rose-500 transition-colors hover:bg-rose-100 hover:text-rose-700"
                    >
                      <XMarkIcon className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {empty ? (
              <button
                type="button"
                onClick={open}
                className={cx(
                  'mt-3 flex min-h-[7rem] flex-1 flex-col items-center justify-center rounded-md border border-dashed px-4 py-5 text-center transition-colors',
                  dragging
                    ? 'border-primary-400 bg-primary-50'
                    : 'border-line-strong hover:border-primary-300 hover:bg-primary-50/40'
                )}
              >
                <span className="text-[13px] font-medium text-ink-700">
                  {dragging ? '松开鼠标，添加这些文件' : '还没有参考资料。把文件拖到这里，或点击选择'}
                </span>
                <span className="mt-1 text-xs leading-5 text-ink-500">{formatHint(maxSize)}可以一次选多份。</span>
              </button>
            ) : (
              <ul className="-mx-1 mt-2 max-h-72 flex-1 space-y-0.5 overflow-y-auto">
                {materials.map((material) => (
                  <li key={material.id} className="group rounded-md px-1 py-1.5 hover:bg-subtle">
                    <div className="flex items-center gap-2.5">
                      <DocumentTextIcon className="h-5 w-5 shrink-0 text-ink-400" aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] leading-5 text-ink-900" title={material.name}>
                          {material.name}
                        </p>
                        <p className="text-xs leading-5 text-ink-500">
                          <span className="tabular-nums">{formatChars(material.char_count)}</span>
                          {material.uploaded_at ? ` · ${formatRelativeTime(material.uploaded_at)}` : ''}
                        </p>
                      </div>
                      <IconButton
                        size="sm"
                        variant="danger"
                        label={`删除 ${material.name}`}
                        icon={<TrashIcon />}
                        loading={removing === material.id}
                        disabled={removing !== null}
                        onClick={() => void remove(material)}
                      />
                    </div>
                    {material.warning && (
                      <p className="ml-[1.875rem] mt-1 flex items-start gap-1.5 rounded bg-amber-50 px-2 py-1 text-xs leading-5 text-amber-800">
                        <ExclamationTriangleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                        <span className="min-w-0 break-words">{material.warning}</span>
                      </p>
                    )}
                  </li>
                ))}
                {pending.map((name, index) => (
                  <li key={`pending-${name}`} className="flex items-center gap-2.5 rounded-md px-1 py-1.5">
                    {index === 0 ? (
                      <Spinner size="sm" className="mx-[3px]" label="正在上传" />
                    ) : (
                      <DocumentTextIcon className="h-5 w-5 shrink-0 text-ink-300" aria-hidden="true" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] leading-5 text-ink-700">{name}</p>
                      <p className="text-xs leading-5 text-ink-500">{index === 0 ? '正在上传并读取内容…' : '等待上传'}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {!empty && (
              <p className="mt-2 text-xs leading-5 text-ink-400">
                {dragging ? '松开鼠标，添加这些文件。' : `也可以把文件拖到这里。${formatHint(maxSize)}`}
              </p>
            )}
          </div>
        </section>
      )}
    </FileDropzone>
  );
}

export const MaterialsCard = memo(MaterialsCardImpl);
