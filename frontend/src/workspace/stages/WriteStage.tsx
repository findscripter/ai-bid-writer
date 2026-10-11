/**
 * 正文阶段：三栏工作台。
 * 左：章节树（状态、字数）；中：当前章节的文稿；右：本章计划、问题、待补充信息。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AdjustmentsHorizontalIcon, ArrowPathIcon, PlayIcon } from '@heroicons/react/24/outline';
import type { ReviewIssue } from '../../api/types';
import { useAppShell } from '../../app/AppShell';
import { estimatePages, formatChars } from '../../lib/format';
import { matchPath, navigate, useHashRoute, useUnsavedChangesGuard } from '../../lib/router';
import { Button, EmptyState, ProgressBar, Tabs, useConfirm, useToast } from '../../ui';
import type { ChapterUiStatus } from '../WorkspaceContext';
import { useWorkspace } from '../WorkspaceContext';
import { endMaybeCut, rewriteFailed } from '../write/chapterFlags';
import { ChapterPane } from '../write/ChapterPane';
import { ChapterSide } from '../write/ChapterSide';
import { ChapterTree } from '../write/ChapterTree';
import type { TreeFilter } from '../write/ChapterTree';
import WritingSettingsModal from '../write/WritingSettingsModal';

/** 有哪些修改还没保存，用在确认框里 */
function unsavedText(editorDirty: boolean, noteDirty: boolean): string {
  if (editorDirty && noteDirty) return '当前章节的正文和补充要求都有修改还没有保存，离开后会丢失。';
  if (noteDirty) return '当前章节的补充要求还没有保存，离开后会丢失。';
  return '当前章节的正文有修改还没有保存，离开后会丢失。';
}

/** 界面此刻是不是还停在这个项目的正文页（确认框开着时可能已经后退到别处了） */
function isWritePage(path: string, projectId: string): boolean {
  const match = matchPath('/projects/:id/:stage', path);
  return Boolean(match && match.id === projectId && match.stage === 'write');
}

type LaunchKey = 'retry' | 'missing' | 'all';

export default function WriteStage() {
  const ws = useWorkspace();
  const shell = useAppShell();
  const toast = useToast();
  const confirm = useConfirm();
  const route = useHashRoute();
  const { data, running, chapterStatus } = ws;
  const { leaves, chapters, budget, blueprint, review } = data;
  // 设置已经读到、确实没配好时才拦；还没读到（例如后端刚重启）就交给后端判断
  const modelNeedsSetup = shell.settings !== null && !shell.modelReady;

  const [filter, setFilter] = useState<TreeFilter>('all');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reviseRequest, setReviseRequest] = useState<{ instruction: string; nonce: number } | null>(null);
  const [launching, setLaunching] = useState<LaunchKey | null>(null);
  // 正文编辑框、补充要求有没有还没保存的修改：切换章节、离开正文页、刷新页面前都要确认
  const [editorDirty, setEditorDirty] = useState(false);
  const [noteDirty, setNoteDirty] = useState(false);
  const [editing, setEditing] = useState(false);
  const editorDirtyRef = useRef(false);
  const noteDirtyRef = useRef(false);
  useUnsavedChangesGuard(editorDirty || noteDirty, `${unsavedText(editorDirty, noteDirty)}确定要离开吗？`);
  // 换章前的确认框开着时，正文页可能已经被卸载、或者界面已经换到别的页面（例如按了浏览器后退）：
  // 回应之后不能再把人拉回来
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const routePathRef = useRef(route.path);
  routePathRef.current = route.path;

  const statusByUid = useMemo(() => {
    const map: Record<string, ChapterUiStatus> = {};
    leaves.forEach((leaf) => {
      map[leaf.uid] = chapterStatus(leaf.uid);
    });
    return map;
  }, [leaves, chapterStatus]);

  const charsByUid = useMemo(() => {
    const map: Record<string, number> = {};
    leaves.forEach((leaf) => {
      const chapter = chapters[leaf.uid];
      map[leaf.uid] = chapter ? chapter.chars : 0;
    });
    return map;
  }, [leaves, chapters]);

  const openIssues = useMemo(() => {
    if (!review) return [] as ReviewIssue[];
    return review.issues.filter((issue) => review.dismissed.indexOf(issue.id) < 0);
  }, [review]);

  const issueUids = useMemo(() => {
    const map: Record<string, number> = {};
    openIssues.forEach((issue) => {
      issue.chapter_uids.forEach((uid) => {
        map[uid] = (map[uid] || 0) + 1;
      });
    });
    return map;
  }, [openIssues]);

  const stats = useMemo(() => {
    let done = 0;
    let totalChars = 0;
    let targetChars = 0;
    // 要重试的章节：没写成的，加上重新生成没有成功、保留了原来正文的（它们算写完了，但这次没写成）
    const failedUids: string[] = [];
    const rewriteFailedUids: Record<string, true> = {};
    // 写完了、但结尾可能不完整的章节：仍算写完，单独提示
    const truncatedUids: string[] = [];
    leaves.forEach((leaf) => {
      const status = statusByUid[leaf.uid];
      const chapter = chapters[leaf.uid];
      if (status === 'done') {
        done += 1;
        if (rewriteFailed(chapter)) {
          failedUids.push(leaf.uid);
          rewriteFailedUids[leaf.uid] = true;
        }
        if (endMaybeCut(chapter)) truncatedUids.push(leaf.uid);
      }
      if (status === 'failed') failedUids.push(leaf.uid);
      totalChars += charsByUid[leaf.uid] || 0;
      targetChars += budget[leaf.uid] || 0;
    });
    return {
      done,
      failed: failedUids.length,
      failedUids,
      rewriteFailedUids,
      truncatedUids,
      totalChars,
      targetChars,
      missing: leaves.length - done,
    };
  }, [leaves, chapters, statusByUid, charsByUid, budget]);

  const requested = route.query.get('chapter');
  const requestedValid = Boolean(requested && ws.leafByUid[requested]);
  // 地址里没有指定章节时选第一个没写完的，并立刻写进地址——之后写作状态怎么变，选中项都不会自己跳走
  const fallbackUid = useMemo(() => {
    if (requestedValid) return null;
    const firstTodo = leaves.find((leaf) => statusByUid[leaf.uid] !== 'done');
    return (firstTodo || leaves[0] || { uid: null }).uid;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedValid, leaves]);
  const selectedUid = requestedValid ? requested : fallbackUid;

  useEffect(() => {
    if (!requestedValid && fallbackUid) {
      // 只是把地址补全成具体的章节，不算离开，不必经过未保存修改的确认
      navigate(`/projects/${ws.projectId}/write?chapter=${encodeURIComponent(fallbackUid)}`, { replace: true, force: true });
    }
  }, [requestedValid, fallbackUid, ws.projectId]);

  const select = useCallback(
    async (uid: string) => {
      if (uid === selectedUid) return;
      if (editorDirtyRef.current || noteDirtyRef.current) {
        const ok = await confirm({
          title: '放弃未保存的修改？',
          description: unsavedText(editorDirtyRef.current, noteDirtyRef.current),
          confirmText: '放弃修改',
          tone: 'danger',
        });
        if (!ok) return;
        // 对话框开着时已经离开了正文页（例如按了浏览器后退）：不能再把人拉回来
        if (!mountedRef.current || !isWritePage(routePathRef.current, ws.projectId)) return;
      }
      // 上面已经用自己的对话框确认过了，跳过离开前的守卫，免得再问一遍
      navigate(`/projects/${ws.projectId}/write?chapter=${encodeURIComponent(uid)}`, { replace: true, force: true });
    },
    [selectedUid, confirm, ws.projectId]
  );

  const onDirtyChange = useCallback((dirty: boolean) => {
    editorDirtyRef.current = dirty;
    setEditorDirty(dirty);
  }, []);

  const onNoteDirtyChange = useCallback((dirty: boolean) => {
    noteDirtyRef.current = dirty;
    setNoteDirty(dirty);
  }, []);

  const onEditingChange = useCallback((value: boolean) => {
    setEditing(value);
  }, []);

  const needModel = useCallback(() => {
    toast.info('请先配置模型服务（API Key、接口地址、模型）。');
    shell.openSettings();
  }, [toast, shell]);

  const start = async (params: Record<string, unknown>, key: LaunchKey) => {
    if (ws.starting || launching) return;
    if (modelNeedsSetup) {
      needModel();
      return;
    }
    setLaunching(key);
    try {
      await ws.startJob('write', params, (message) => toast.error(message));
    } finally {
      setLaunching(null);
    }
  };

  const rewriteAll = async () => {
    const ok = await confirm({
      title: '全部重写？',
      description: `会重新撰写全部 ${leaves.length} 章。现有正文会各自保存到历史版本。`,
      confirmText: '全部重写',
      tone: 'danger',
    });
    if (ok) await start({ mode: 'all' }, 'all');
  };

  const startBlocked = running || ws.starting;

  const selectedIssues = useMemo(
    () => (selectedUid ? openIssues.filter((issue) => issue.chapter_uids.indexOf(selectedUid) >= 0) : []),
    [openIssues, selectedUid]
  );

  const onFix = useCallback((issue: ReviewIssue) => {
    setReviseRequest({ instruction: issue.fix_instruction, nonce: Date.now() });
  }, []);

  /** 依次跳到结尾可能不完整的章节：从当前这一章往后找，到头再从第一章开始 */
  const gotoTruncated = () => {
    const list = stats.truncatedUids;
    if (list.length === 0) return;
    // 按目录顺序从当前这一章往后找下一个，到头再从第一个开始；当前章本身不在列表里也一样
    const position = selectedUid ? leaves.findIndex((leaf) => leaf.uid === selectedUid) : -1;
    const next = leaves.find((leaf, index) => index > position && list.indexOf(leaf.uid) >= 0);
    void select(next ? next.uid : list[0]);
  };

  if (leaves.length === 0) {
    return (
      <div className="h-full overflow-y-auto">
        <EmptyState
          className="pt-24"
          title="还没有目录"
          description="先生成目录，再来撰写正文。"
          action={
            <Button variant="primary" onClick={() => navigate(`/projects/${ws.projectId}/outline`)}>
              去生成目录
            </Button>
          }
        />
      </div>
    );
  }

  const index = leaves.findIndex((leaf) => leaf.uid === selectedUid);
  const leaf = index >= 0 ? leaves[index] : leaves[0];
  const percent = stats.targetChars > 0 ? Math.min(100, Math.round((stats.totalChars / stats.targetChars) * 100)) : 0;
  const wordsPerPage = data.project.settings.words_per_page;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-white px-4 py-2">
        <div className="flex shrink-0 items-center gap-3 whitespace-nowrap text-sm">
          <span className="font-medium text-ink-900 tabular-nums">
            {stats.done}/{leaves.length} 章
          </span>
          <ProgressBar value={percent} size="sm" tone={stats.done === leaves.length ? 'success' : 'primary'} className="w-28" />
          <span className="text-xs text-ink-500 tabular-nums">
            {formatChars(stats.totalChars)} / 目标 {formatChars(stats.targetChars)}（约 {estimatePages(stats.totalChars, wordsPerPage)} 页）
          </span>
        </div>
        {stats.truncatedUids.length > 0 && (
          <button
            type="button"
            className="min-w-0 truncate rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 hover:bg-amber-100"
            title={`模型写到了输出上限，这些章节算写完了，但结尾可能缺了一截：${stats.truncatedUids
              .map((uid) => (ws.leafByUid[uid] ? `${ws.leafByUid[uid].id} ${ws.leafByUid[uid].title}` : uid))
              .join('、')}。点一下依次跳到这些章节，看一眼结尾，必要时重写。`}
            onClick={gotoTruncated}
          >
            其中 {stats.truncatedUids.length} 章结尾可能不完整 →
          </button>
        )}
        {!blueprint && (
          <button
            type="button"
            className="min-w-0 truncate rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 hover:bg-amber-100"
            onClick={() => navigate(`/projects/${ws.projectId}/plan`)}
          >
            还没有写作计划：各章不共享统一口径，建议先制定 →
          </button>
        )}
        {data.blueprint_stale && (
          <button
            type="button"
            className="min-w-0 truncate rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 hover:bg-amber-100"
            onClick={() => navigate(`/projects/${ws.projectId}/plan?tab=chapters`)}
          >
            目录改过了，有章节还没有写作计划 →
          </button>
        )}
        {data.budget_note && <span className="text-xs text-amber-700">{data.budget_note}</span>}
        <div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap">
          <Button size="sm" variant="ghost" icon={<AdjustmentsHorizontalIcon className="h-4 w-4" />} onClick={() => setSettingsOpen(true)}>
            写作设置
          </Button>
          {stats.failed > 0 && (
            <Button
              size="sm"
              disabled={startBlocked}
              loading={launching === 'retry'}
              icon={<ArrowPathIcon className="h-4 w-4" />}
              title={
                Object.keys(stats.rewriteFailedUids).length > 0
                  ? `其中 ${Object.keys(stats.rewriteFailedUids).length} 章是重新生成没有成功、保留了原来正文的，会再重写一次（现在的正文会存进历史版本）`
                  : undefined
              }
              onClick={() => void start({ uids: stats.failedUids }, 'retry')}
            >
              重试失败章节（{stats.failed}）
            </Button>
          )}
          {stats.missing > 0 ? (
            <Button
              size="sm"
              variant="primary"
              disabled={startBlocked}
              loading={launching === 'missing'}
              icon={<PlayIcon className="h-4 w-4" />}
              onClick={() => void start({ mode: 'missing' }, 'missing')}
            >
              {stats.done === 0 ? '开始撰写全部章节' : `继续撰写（剩余 ${stats.missing} 章）`}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={startBlocked}
              loading={launching === 'all'}
              icon={<ArrowPathIcon className="h-4 w-4" />}
              onClick={() => void rewriteAll()}
            >
              全部重写
            </Button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-white">
          <div className="shrink-0 border-b border-line px-2 py-1.5">
            <Tabs
              size="sm"
              variant="pill"
              value={filter}
              onChange={(key) => setFilter(key as TreeFilter)}
              tabs={[
                { key: 'all', label: '全部' },
                { key: 'todo', label: '未完成', badge: stats.missing > 0 ? stats.missing : undefined },
                { key: 'issue', label: '有问题', badge: Object.keys(issueUids).length || undefined },
              ]}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ChapterTree
              outline={data.project.outline}
              statusByUid={statusByUid}
              charsByUid={charsByUid}
              budget={budget}
              issueUids={issueUids}
              rewriteFailedUids={stats.rewriteFailedUids}
              selectedUid={leaf.uid}
              filter={filter}
              onSelect={(uid) => void select(uid)}
            />
          </div>
        </aside>

        <section className="min-w-0 flex-1">
          <ChapterPane
            leaf={leaf}
            chapter={chapters[leaf.uid]}
            status={statusByUid[leaf.uid] || 'empty'}
            liveText={ws.live[leaf.uid]}
            target={budget[leaf.uid]}
            running={running}
            modelReady={!modelNeedsSetup}
            hasPrev={index > 0}
            hasNext={index < leaves.length - 1}
            onPrev={() => index > 0 && void select(leaves[index - 1].uid)}
            onNext={() => index < leaves.length - 1 && void select(leaves[index + 1].uid)}
            onNeedModel={needModel}
            onDirtyChange={onDirtyChange}
            onEditingChange={onEditingChange}
            reviseRequest={reviseRequest}
          />
        </section>

        <aside className="hidden w-80 shrink-0 border-l border-line xl:block">
          <ChapterSide
            leaf={leaf}
            chapter={chapters[leaf.uid]}
            plan={blueprint ? blueprint.plans[leaf.uid] : undefined}
            hasBlueprint={blueprint !== null}
            requirements={data.requirements}
            issues={selectedIssues}
            running={running || ws.starting}
            editing={editing}
            onFix={onFix}
            onNoteDirtyChange={onNoteDirtyChange}
          />
        </aside>
      </div>

      <WritingSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
