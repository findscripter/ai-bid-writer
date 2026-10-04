/**
 * 项目卡片：项目列表里的一格。
 *
 * 整张卡片都能点（标题是一个链接，用伪元素铺满整张卡片），右上角的菜单浮在链接上面，
 * 点菜单不会进入项目。菜单的弹出层挂在页面最外层，不受卡片和滚动区域的裁剪。
 */
import React from 'react';
import { Menu, MenuButton, MenuItem, MenuItems, MenuSeparator } from '@headlessui/react';
import { CheckCircleIcon } from '@heroicons/react/20/solid';
import {
  ArrowDownTrayIcon,
  DocumentTextIcon,
  EllipsisHorizontalIcon,
  PencilSquareIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import type { ProjectSummary } from '../api/types';
import { formatChars, formatRelativeTime } from '../lib/format';
import { Link } from '../lib/router';
import { Badge, ProgressBar, Skeleton, Spinner, cx } from '../ui';
import type { BadgeTone } from '../ui';

/** 卡片上正在进行的操作：导出备份、删除 */
export type CardPending = 'archive' | 'delete';

interface ProjectCardProps {
  project: ProjectSummary;
  pending: CardPending | null;
  onRename: (project: ProjectSummary) => void;
  onArchive: (project: ProjectSummary) => void;
  onDelete: (project: ProjectSummary) => void;
}

/** 项目走到哪一步了：用“接下来要做什么”来说 */
function nextStep(project: ProjectSummary): { label: string; tone: BadgeTone } {
  const { leaf_total: total, leaf_done: done } = project;
  if (!project.tender_filename) return { label: '待上传招标文件', tone: 'neutral' };
  if (total === 0) {
    // 上传了招标文件但还没解析完（项目概述和技术评分要求缺一样），下一步是解析而不是生成目录
    return project.has_analysis === false ? { label: '待解析招标文件', tone: 'neutral' } : { label: '待生成目录', tone: 'neutral' };
  }
  if (done >= total) {
    // 结尾被截断的章节算写完（与正文页一致），但要提醒去看一眼
    return project.leaf_truncated > 0
      ? { label: `已写完，${project.leaf_truncated} 章结尾可能不完整`, tone: 'warning' }
      : { label: '正文已写完', tone: 'success' };
  }
  if (done > 0) return { label: `还差 ${total - done} 章`, tone: 'neutral' };
  return { label: project.has_blueprint ? '待撰写正文' : '待制定写作计划', tone: 'neutral' };
}

const MENU_ITEM =
  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-ink-700 data-[focus]:bg-ink-900/[0.06] data-[focus]:text-ink-900';

export function ProjectCard({ project, pending, onRename, onArchive, onDelete }: ProjectCardProps) {
  const { leaf_total: total, leaf_done: done, busy } = project;
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const complete = total > 0 && done >= total;
  const step = nextStep(project);
  const updated = formatRelativeTime(project.updated_at);
  const deleting = pending === 'delete';

  return (
    <li
      className={cx(
        'group relative flex min-w-0 flex-col rounded-lg border bg-white p-4 shadow-card transition-colors',
        busy ? 'border-primary-300 ring-2 ring-primary-100' : 'border-line hover:border-ink-300',
        deleting && 'pointer-events-none opacity-60'
      )}
    >
      <div className="flex h-7 items-center justify-between gap-2">
        {busy ? (
          <Badge tone="primary">
            <Spinner size="sm" tone="current" label="正在生成" className="h-3 w-3" />
            正在生成
          </Badge>
        ) : (
          <Badge tone={step.tone}>{step.label}</Badge>
        )}

        {/* 菜单浮在整卡链接之上：点它不会进入项目 */}
        <div className="relative z-10 -mr-1.5">
          <Menu>
            <MenuButton
              disabled={pending !== null}
              aria-label={`“${project.name}”的更多操作`}
              title="更多操作"
              className={cx(
                'inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-500 transition-colors',
                'hover:bg-ink-900/[0.06] hover:text-ink-900 data-[open]:bg-ink-900/[0.06] data-[open]:text-ink-900',
                'disabled:cursor-wait disabled:hover:bg-transparent'
              )}
            >
              {pending !== null ? (
                <Spinner size="sm" tone="muted" label={pending === 'archive' ? '正在导出备份' : '正在删除'} />
              ) : (
                <EllipsisHorizontalIcon className="h-5 w-5" />
              )}
            </MenuButton>
            <MenuItems
              anchor={{ to: 'bottom end', gap: 4 }}
              transition
              className={cx(
                'z-30 w-40 origin-top-right rounded-lg border border-line bg-white p-1 shadow-pop focus:outline-none',
                'transition duration-100 ease-out data-[closed]:scale-95 data-[closed]:opacity-0'
              )}
            >
              <MenuItem>
                <button type="button" className={MENU_ITEM} onClick={() => onRename(project)}>
                  <PencilSquareIcon className="h-4 w-4 shrink-0 text-ink-400" />
                  重命名
                </button>
              </MenuItem>
              <MenuItem>
                <button type="button" className={MENU_ITEM} onClick={() => onArchive(project)}>
                  <ArrowDownTrayIcon className="h-4 w-4 shrink-0 text-ink-400" />
                  导出备份
                </button>
              </MenuItem>
              <MenuSeparator className="my-1 h-px bg-line" />
              <MenuItem>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-rose-600 data-[focus]:bg-rose-50 data-[focus]:text-rose-700"
                  onClick={() => onDelete(project)}
                >
                  <TrashIcon className="h-4 w-4 shrink-0" />
                  删除
                </button>
              </MenuItem>
            </MenuItems>
          </Menu>
        </div>
      </div>

      <h2 className="mt-2.5 line-clamp-2 break-words text-[15px] font-semibold leading-6 text-ink-900 group-hover:text-primary-700">
        <Link
          to={`/projects/${project.id}`}
          title={project.name}
          className="focus-visible:outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-primary-500 focus-visible:after:ring-offset-2"
        >
          {project.name}
        </Link>
      </h2>

      <p className="mt-1 flex items-center gap-1.5 text-xs leading-5 text-ink-500">
        <DocumentTextIcon className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />
        <span className="min-w-0 truncate">{project.tender_filename || '还没有上传招标文件'}</span>
      </p>

      <div className="mt-auto pt-5">
        <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
          <span className="text-ink-500">章节进度</span>
          {total > 0 ? (
            <span className="tabular-nums text-ink-700">
              已完成 {done} / {total} 章
            </span>
          ) : (
            <span className="text-ink-500">还没有目录</span>
          )}
        </div>
        <ProgressBar value={percent} size="sm" tone={complete ? 'success' : 'primary'} />
      </div>

      <div className="mt-3.5 flex items-center justify-between gap-3 border-t border-line pt-3 text-xs leading-5 text-ink-500">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 tabular-nums">{formatChars(project.total_chars)}</span>
          <span className="text-ink-300" aria-hidden="true">
            ·
          </span>
          {project.has_blueprint ? (
            <span className="flex min-w-0 items-center gap-1 text-ink-600">
              <CheckCircleIcon className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden="true" />
              <span className="truncate">已有写作计划</span>
            </span>
          ) : (
            <span className="truncate">还没有写作计划</span>
          )}
        </div>
        {updated ? <span className="shrink-0">{updated}更新</span> : null}
      </div>
    </li>
  );
}

/** 加载时的占位卡片，轮廓和真卡片一致 */
export function ProjectCardSkeleton() {
  return (
    <li className="flex flex-col rounded-lg border border-line bg-white p-4 shadow-card" aria-hidden="true">
      <div className="flex h-7 items-center">
        <Skeleton className="h-[22px] w-24 rounded-full" />
      </div>
      <Skeleton className="mt-3.5 h-4 w-4/5" />
      <Skeleton className="mt-3 h-3 w-3/5" />
      <div className="pt-6">
        <div className="mb-2 flex justify-between">
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-3 w-20" />
        </div>
        <Skeleton className="h-1 w-full rounded-full" />
      </div>
      <div className="mt-3.5 flex justify-between border-t border-line pt-3.5">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-3 w-16" />
      </div>
    </li>
  );
}
