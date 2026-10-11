/**
 * 项目列表：应用的首页。
 *
 * 一个项目对应一份投标技术文件。这里能新建、导入、打开、重命名、导出备份、删除项目，
 * 每张卡片上能看到项目走到了哪一步、写了多少。有项目正在生成时，列表会自己定时刷新。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUpTrayIcon,
  ExclamationTriangleIcon,
  ListBulletIcon,
  PencilSquareIcon,
  PlusIcon,
  ShieldExclamationIcon,
} from '@heroicons/react/24/outline';
import { api, errorMessage } from '../api/client';
import type { ProjectState, ProjectSummary } from '../api/types';
import { useAppShell } from '../app/AppShell';
import { AnimatedLogo } from '../brand/BrandArt';
import { navigate } from '../lib/router';
import { Button, EmptyState, useConfirm, useToast } from '../ui';
import { ProjectCard, ProjectCardSkeleton } from './ProjectCard';
import type { CardPending } from './ProjectCard';
import { RenameProjectModal } from './RenameProjectModal';

/** 有项目正在生成时，每隔这么久刷新一次列表 */
const POLL_MS = 3000;
/** 备份文件一般只有几 MB；远大于这个数的肯定不是 */
const MAX_IMPORT_BYTES = 200 * 1024 * 1024;

const GRID = 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3';
const NOT_A_BACKUP = '这个文件不是项目备份。请选择在项目菜单里点“导出备份”得到的 .json 文件。';

const STEPS = [
  {
    icon: ArrowUpTrayIcon,
    title: '上传招标文件',
    text: '上传招标文件，自动解析出项目概述和评分要求。',
  },
  {
    icon: ListBulletIcon,
    title: '生成目录与写作计划',
    text: '生成目录，再定一份写作计划：统一全书口径，给每章分好要点和篇幅。',
  },
  {
    icon: PencilSquareIcon,
    title: '撰写、审校、导出',
    text: '逐章撰写正文，审校查出漏项和前后矛盾，最后导出 Word。',
  },
];

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('文件读取失败，请确认文件没有被移动或删除后重试。'));
    reader.readAsText(file);
  });
}

/** 和后端的排序一致：最近更新的在前 */
function byUpdatedDesc(a: ProjectSummary, b: ProjectSummary): number {
  if (a.updated_at === b.updated_at) return 0;
  return a.updated_at < b.updated_at ? 1 : -1;
}

export default function ProjectsPage() {
  const shell = useAppShell();
  const toast = useToast();
  const confirm = useConfirm();

  /** null 表示还没加载出来 */
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pending, setPending] = useState<Record<string, CardPending>>({});
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ProjectSummary | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  /** 每发起一次加载、每做一次本地修改就加一：晚到的旧结果不再采用 */
  const ticketRef = useRef(0);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const load = useCallback(async (quiet: boolean) => {
    ticketRef.current += 1;
    const ticket = ticketRef.current;
    try {
      const list = await api.listProjects();
      if (!aliveRef.current || ticket !== ticketRef.current) return;
      setProjects(list);
      setLoadError('');
    } catch (error) {
      if (!aliveRef.current || ticket !== ticketRef.current) return;
      // 静默刷新失败不打扰使用者，保留已经显示的列表
      if (!quiet) setLoadError(errorMessage(error, '项目列表加载失败，请重试'));
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  // 有项目正在生成：等上一次刷新回来之后再排下一次，进度和“正在生成”的标记会自己更新
  const anyBusy = projects !== null && projects.some((project) => project.busy);
  useEffect(() => {
    if (!anyBusy) return undefined;
    let stopped = false;
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(() => {
        void load(true).then(() => {
          if (!stopped) schedule();
        });
      }, POLL_MS);
    };
    schedule();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [anyBusy, load]);

  // 从别的标签页切回来时刷新一次（可能在那边写了正文、删了项目）
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const retry = () => {
    setLoadError('');
    setProjects(null);
    void load(false);
  };

  const setCardPending = (id: string, value: CardPending | null) => {
    setPending((prev) => {
      const next = { ...prev };
      if (value) next[id] = value;
      else delete next[id];
      return next;
    });
  };

  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const state = await api.createProject('');
      navigate(`/projects/${state.project.id}/tender`);
    } catch (error) {
      toast.error(errorMessage(error, '新建项目失败，请重试'));
      if (aliveRef.current) setCreating(false);
    }
  };

  const pickFile = () => {
    if (fileRef.current) fileRef.current.click();
  };

  const importFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const file = input.files && input.files[0];
    input.value = ''; // 清空之后，再选同一个文件也能触发
    if (!file || importing) return;
    setImporting(true);
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error(NOT_A_BACKUP);
      let archive: unknown;
      try {
        archive = JSON.parse((await readFileText(file)).replace(/^﻿/, ''));
      } catch (error) {
        throw new Error(error instanceof SyntaxError ? NOT_A_BACKUP : errorMessage(error, NOT_A_BACKUP));
      }
      if (!archive || typeof archive !== 'object' || Array.isArray(archive)) throw new Error(NOT_A_BACKUP);
      const state = await api.importProject(archive);
      toast.success(`已导入“${state.project.name}”`);
      navigate(`/projects/${state.project.id}`);
    } catch (error) {
      toast.error(errorMessage(error, '导入失败，请重试'), { title: `没能导入 ${file.name}` });
      if (aliveRef.current) setImporting(false);
    }
  };

  const openRename = (project: ProjectSummary) => {
    setRenameTarget(project);
    setRenameOpen(true);
  };

  const onRenamed = (state: ProjectState) => {
    const { id, name, updated_at: updatedAt } = state.project;
    ticketRef.current += 1;
    setProjects((prev) => {
      if (!prev) return prev;
      return prev.map((item) => (item.id === id ? { ...item, name, updated_at: updatedAt } : item)).sort(byUpdatedDesc);
    });
  };

  const archive = async (project: ProjectSummary) => {
    setCardPending(project.id, 'archive');
    try {
      await api.downloadArchive(project.id);
      toast.success('备份文件已下载，在浏览器的下载目录里。换电脑或误删后，用“导入项目”可以恢复。', {
        title: project.name,
      });
    } catch (error) {
      toast.error(errorMessage(error, '导出备份失败，请重试'), { title: project.name });
    } finally {
      if (aliveRef.current) setCardPending(project.id, null);
    }
  };

  const remove = async (project: ProjectSummary) => {
    const ok = await confirm({
      title: '删除这个项目？',
      description: (
        <>
          <span className="font-medium text-ink-900">{project.name}</span>
          <span className="mt-1.5 block">
            会删除该项目的招标文件、正文与全部历史版本，且无法恢复。
            {project.busy ? '这个项目正在生成，删除时会先停掉。' : ''}
          </span>
          <span className="mt-1.5 block text-ink-500">需要留底的话，先用菜单里的“导出备份”存一份。</span>
        </>
      ),
      confirmText: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    setCardPending(project.id, 'delete');
    try {
      await api.deleteProject(project.id);
      if (!aliveRef.current) return;
      ticketRef.current += 1;
      setProjects((prev) => (prev ? prev.filter((item) => item.id !== project.id) : prev));
      toast.success(`已删除“${project.name}”`);
    } catch (error) {
      toast.error(errorMessage(error, '删除失败，请重试'), { title: project.name });
      void load(true); // 也可能是已经在别处删掉了，刷新一下以实际为准
    } finally {
      if (aliveRef.current) setCardPending(project.id, null);
    }
  };

  const needSetup = shell.settings !== null && !shell.modelReady && !shell.settings.demo;
  const busyCount = projects ? projects.filter((project) => project.busy).length : 0;
  const empty = projects !== null && projects.length === 0;

  let body: React.ReactNode;
  if (projects === null && loadError) {
    body = (
      <div className="rounded-lg border border-line bg-white">
        <EmptyState
          className="py-16"
          icon={<ExclamationTriangleIcon className="text-amber-500" />}
          title="项目列表加载不出来"
          description={loadError}
          action={<Button onClick={retry}>重试</Button>}
        />
      </div>
    );
  } else if (projects === null) {
    body = (
      <ul className={GRID} aria-busy="true" aria-label="正在加载项目">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <ProjectCardSkeleton key={index} />
        ))}
      </ul>
    );
  } else if (empty) {
    body = (
      <section className="rounded-lg border border-line bg-white px-6 py-12 text-center sm:px-10">
        <AnimatedLogo size={64} className="mx-auto" />
        <h2 className="mt-4 text-base font-semibold text-ink-900">还没有项目</h2>
        <p className="mt-1 text-[13px] text-ink-500">一个项目对应一份投标技术文件。从招标文件到 Word，分三步：</p>

        <ol className="mx-auto mt-7 grid max-w-4xl grid-cols-1 gap-3 text-left md:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className="rounded-lg border border-line bg-subtle p-4">
              <div className="flex items-center gap-2.5">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-600 text-xs font-semibold tabular-nums text-white">
                  {index + 1}
                </span>
                <h3 className="text-sm font-semibold text-ink-900">{step.title}</h3>
                <step.icon className="ml-auto h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />
              </div>
              <p className="mt-2 text-[13px] leading-6 text-ink-600">{step.text}</p>
            </li>
          ))}
        </ol>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
          <Button variant="primary" size="lg" loading={creating} icon={<PlusIcon />} onClick={() => void create()}>
            新建项目
          </Button>
          <button
            type="button"
            className="rounded text-[13px] text-ink-500 underline decoration-line-strong underline-offset-4 hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={importing}
            onClick={pickFile}
          >
            有备份文件？导入项目
          </button>
        </div>
      </section>
    );
  } else {
    body = (
      <ul className={GRID}>
        {projects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            pending={pending[project.id] || null}
            onRename={openRename}
            onArchive={(target) => void archive(target)}
            onDelete={(target) => void remove(target)}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-6xl flex-col px-6 pb-6 pt-8">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="flex min-w-0 items-baseline gap-3">
            <h1 className="text-xl font-semibold leading-8 text-ink-900">项目</h1>
            {projects !== null && projects.length > 0 && (
              <p className="text-[13px] text-ink-500">
                共 <span className="tabular-nums">{projects.length}</span> 个
                {busyCount > 0 && (
                  <span className="text-primary-700">
                    ，<span className="tabular-nums">{busyCount}</span> 个正在生成
                  </span>
                )}
              </p>
            )}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => void importFile(event)}
            />
            <Button
              loading={importing}
              icon={<ArrowUpTrayIcon />}
              title="选择用“导出备份”得到的 .json 文件"
              onClick={pickFile}
            >
              导入项目
            </Button>
            <Button
              variant={empty ? 'secondary' : 'primary'}
              loading={creating}
              icon={<PlusIcon />}
              onClick={() => void create()}
            >
              新建项目
            </Button>
          </div>
        </header>

        {needSetup && (
          <div
            role="status"
            className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3"
          >
            <ExclamationTriangleIcon className="h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-amber-900">还没有配置模型服务</p>
              <p className="mt-0.5 text-[13px] leading-5 text-amber-800">
                要先填好 API Key、接口地址和模型名称，才能解析招标文件、生成目录和撰写正文。
              </p>
            </div>
            <Button size="sm" onClick={shell.openSettings}>
              去配置
            </Button>
          </div>
        )}

        <div className="mt-6">{body}</div>

        <p className="mt-auto flex items-start justify-center gap-1.5 pt-10 text-xs leading-5 text-ink-500">
          <ShieldExclamationIcon className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />
          生成内容必须人工审阅后再用于投标；模型可能编造业绩、资质和指标。
        </p>
      </div>

      <RenameProjectModal
        open={renameOpen}
        project={renameTarget}
        onClose={() => setRenameOpen(false)}
        onRenamed={onRenamed}
      />
    </div>
  );
}
