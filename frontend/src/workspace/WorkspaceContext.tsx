/**
 * 项目工作台的状态中心。
 *
 * 一个项目页面里所有阶段（招标解读、目录、写作计划、正文、审校、导出）共用这一份状态：
 *   const ws = useWorkspace();
 *   ws.data.project / ws.data.leaves / ws.data.chapters / ws.data.blueprint / ws.data.review ...
 *
 * 数据以后端为准：
 * - 进入页面时拉取一次完整状态；
 * - 有后台任务在跑时订阅它的事件流，章节的实时文本、完成、失败都由事件驱动；
 * - 刷新页面或断线重连后，先拿快照再从快照的序号往后续传，不丢不重；
 * - 窗口重新获得焦点时核对一次任务：别的标签页里开始或结束的任务，这里也能接上。
 *
 * 各阶段页面修改数据的统一做法：调用 api.xxx 得到新的 ProjectState 后交给 ws.apply(state)。
 * 晚到的旧响应不会把新的数据换回去：
 * - 整份状态按 state_at（服务端读取的时刻）取新：更早读出的那份只并入更新的章节，计划、审校结果等保留本页已有的；
 * - 同一章以 updated_at 较新的一份为准（一样新时以新拿到的为准）：不会把刚写完的章节换回旧稿。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ApiError, api, errorMessage, subscribeJob } from '../api/client';
import type {
  ChapterView,
  JobEvent,
  JobKind,
  JobRecord,
  JobSnapshot,
  LeafInfo,
  ProjectState,
  ReviewReport,
  ReviewResponse,
} from '../api/types';

/** 章节在界面上的状态（比落盘的状态多了“排队中”“写作中”） */
export type ChapterUiStatus = 'empty' | 'queued' | 'writing' | 'done' | 'failed' | 'cancelled';

interface Store {
  server: ProjectState | null;
  job: JobRecord | null;
  /** 正在写的章节的实时文本 */
  live: Record<string, string>;
  writing: Record<string, true>;
  queued: Record<string, true>;
  loadError: string | null;
  /** 加载失败的原因是连不上服务（或服务端出错），过一会儿再试有可能成功 */
  loadErrorRetryable: boolean;
}

type Action =
  | { type: 'loaded'; state: ProjectState }
  | { type: 'merged'; state: ProjectState }
  | { type: 'job'; snapshot: JobSnapshot }
  | { type: 'event'; event: JobEvent }
  | { type: 'chapter'; chapter: ChapterView }
  | { type: 'review'; review: ReviewReport | ReviewResponse }
  | { type: 'error'; message: string; retryable: boolean }
  | { type: 'reset' };

const EMPTY: Store = { server: null, job: null, live: {}, writing: {}, queued: {}, loadError: null, loadErrorRetryable: false };

/** 打不开项目、事件流被服务端拒绝后的重试间隔：1 秒起，每次翻倍，最长 15 秒（与外壳一致） */
const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 15000;

function isActive(job: JobRecord | null): boolean {
  return job !== null && (job.status === 'running' || job.status === 'pending');
}

function keysToFlags(source: Record<string, unknown>): Record<string, true> {
  const flags: Record<string, true> = {};
  Object.keys(source).forEach((key) => {
    flags[key] = true;
  });
  return flags;
}

function listToFlags(list: string[] | undefined): Record<string, true> {
  const flags: Record<string, true> = {};
  (list || []).forEach((key) => {
    flags[key] = true;
  });
  return flags;
}

/**
 * 合并章节：同一章取 updated_at 较新的一份（一样新时以新拿到的为准）。
 * 修改类接口的响应、刷新拿到的快照都可能晚于事件流到达；只按目录里现有的章节合并。
 */
function mergeChapters(
  current: Record<string, ChapterView>,
  incoming: Record<string, ChapterView>,
  leaves: LeafInfo[]
): Record<string, ChapterView> {
  const merged: Record<string, ChapterView> = {};
  leaves.forEach((leaf) => {
    const next = incoming[leaf.uid];
    const mine = current[leaf.uid];
    if (next && mine) merged[leaf.uid] = (mine.updated_at || '') > (next.updated_at || '') ? mine : next;
    else if (next) merged[leaf.uid] = next;
    else if (mine) merged[leaf.uid] = mine; // 快照里还没有：这一章是快照之后才写出来的
  });
  return merged;
}

function without<T>(source: Record<string, T>, key: string): Record<string, T> {
  if (!(key in source)) return source;
  const next = { ...source };
  delete next[key];
  return next;
}

/**
 * 写入一章（保存、恢复的响应，冲突时取回的最新内容，任务事件里的章节）。
 * 比已有的更早（updated_at 更小）就不要：晚到的旧响应不能把更新的正文换回去。
 * 一样新或更新的才替换——后端只改状态、没改正文时 updated_at 不变，这种也必须能换上。
 */
function putChapter(server: ProjectState | null, chapter: ChapterView): ProjectState | null {
  if (!server) return server;
  const current = server.chapters[chapter.uid];
  if (current && (chapter.updated_at || '') < (current.updated_at || '')) return server;
  return { ...server, chapters: { ...server.chapters, [chapter.uid]: chapter } };
}

/** incoming 是否比 current 更早从服务端读出（同一项目内按 state_at 比较；缺时刻时不算更早） */
function isOlderState(current: ProjectState, incoming: ProjectState): boolean {
  return Boolean(
    current.project.id === incoming.project.id &&
      current.state_at &&
      incoming.state_at &&
      incoming.state_at < current.state_at
  );
}

/**
 * 把一份整份状态并入本页已有的状态（换了项目时整体替换）。
 * - 不比本页的旧（state_at 一样或更晚）：以它为准，章节逐章取 updated_at 较新的；
 * - 比本页的旧（晚到的响应，或者在别的请求之前读出的快照）：项目设置、目录、写作计划、审校结果、
 *   篇幅分配等都保留本页已有的，只按 updated_at 并入更新的章节。
 */
function mergeState(previous: ProjectState | null, incoming: ProjectState): ProjectState {
  if (!previous || previous.project.id !== incoming.project.id) return incoming;
  if (isOlderState(previous, incoming)) {
    return { ...previous, chapters: mergeChapters(previous.chapters, incoming.chapters, previous.leaves) };
  }
  let next = incoming;
  // 审校接口的响应先到、这份整份状态却是在那次审校保存之前读出的：审校结果保留本页的
  if (previous.review_at && incoming.state_at && incoming.state_at < previous.review_at) {
    next = {
      ...next,
      review: previous.review,
      review_outline_changed: previous.review_outline_changed,
      review_at: previous.review_at,
    };
  }
  // 目录没变时沿用原来的数组引用，避免依赖它的界面（章节树、默认选中项）无谓地重算
  if (JSON.stringify(previous.leaves) === JSON.stringify(next.leaves)) next = { ...next, leaves: previous.leaves };
  // 不论有没有任务在跑，都逐章取较新的：响应可能是在事件流写入新正文之前算好的
  return { ...next, chapters: mergeChapters(previous.chapters, incoming.chapters, next.leaves) };
}

/**
 * 审校接口返回的结果：带着 outline_changed 时一并更新“审校之后目录变过”的标记；
 * 带着 state_at 时记下来，之后晚到的、比它早读出的整份状态不会把审校结果换回旧的
 */
function putReview(server: ProjectState, incoming: ReviewReport | ReviewResponse): ProjectState {
  if ('outline_changed' in incoming) {
    const meta = incoming as ReviewResponse;
    // 本页已经有一份在这次审校保存之后才读出的整份状态：它里面的审校结果不会比这份旧，保留本页的
    if (meta.state_at && server.state_at && meta.state_at < server.state_at) return server;
    const review: Partial<ReviewResponse> = { ...meta };
    delete review.outline_changed;
    delete review.state_at;
    return {
      ...server,
      review: review as ReviewReport,
      review_outline_changed: Boolean(meta.outline_changed),
      review_at: meta.state_at || server.review_at,
    };
  }
  return { ...server, review: incoming };
}

function reducer(store: Store, action: Action): Store {
  switch (action.type) {
    case 'loaded': {
      const snapshot = action.state.job;
      const job = snapshot ? snapshot.job : null;
      const active = snapshot !== null && isActive(job);
      const live = snapshot && active ? snapshot.live : {};
      // 排队中的章节：快照之前的 write_plan 事件不会重放，以快照里的 queued 为准
      const queued = snapshot && active ? listToFlags(snapshot.queued) : {};
      return {
        server: mergeState(store.server, action.state),
        job,
        live,
        writing: keysToFlags(live),
        queued,
        loadError: null,
        loadErrorRetryable: false,
      };
    }
    case 'merged':
      // 修改类接口返回的状态、静默刷新：任务相关的部分以事件流为准，这里不覆盖
      return { ...store, server: mergeState(store.server, action.state), loadError: null, loadErrorRetryable: false };
    case 'job': {
      const job = action.snapshot.job;
      if (!isActive(job)) return { ...store, job, live: {}, writing: {}, queued: {} };
      return {
        ...store,
        job,
        live: action.snapshot.live,
        writing: keysToFlags(action.snapshot.live),
        queued: listToFlags(action.snapshot.queued),
      };
    }
    case 'chapter': {
      const server = putChapter(store.server, action.chapter);
      return server === store.server ? store : { ...store, server };
    }
    case 'review':
      return store.server ? { ...store, server: putReview(store.server, action.review) } : store;
    case 'error':
      return { ...store, loadError: action.message, loadErrorRetryable: action.retryable };
    case 'reset':
      return EMPTY;
    case 'event': {
      const event = action.event;
      switch (event.type) {
        case 'job_start':
          return { ...store, job: event.job };
        case 'job_stage':
          return store.job ? { ...store, job: { ...store.job, stage: event.stage, message: event.message } } : store;
        case 'job_progress':
          return store.job ? { ...store, job: { ...store.job, progress: event.progress } } : store;
        case 'job_end':
          return { ...store, job: event.job, live: {}, writing: {}, queued: {} };
        case 'write_plan': {
          const queued: Record<string, true> = {};
          event.uids.forEach((uid) => {
            queued[uid] = true;
          });
          return { ...store, queued };
        }
        case 'chapter_start':
          return {
            ...store,
            live: { ...store.live, [event.uid]: '' },
            writing: { ...store.writing, [event.uid]: true },
            queued: without(store.queued, event.uid),
          };
        case 'chapter_delta':
          return { ...store, live: { ...store.live, [event.uid]: (store.live[event.uid] || '') + event.text } };
        case 'chapter_reset':
          return { ...store, live: { ...store.live, [event.uid]: event.text } };
        case 'chapter_done':
        case 'chapter_failed':
        case 'chapter_stopped':
          return {
            ...store,
            server: putChapter(store.server, event.chapter),
            live: without(store.live, event.uid),
            writing: without(store.writing, event.uid),
            queued: without(store.queued, event.uid),
          };
        default:
          return store;
      }
    }
    default:
      return store;
  }
}

export interface Workspace {
  projectId: string;
  /** 项目的全部数据（章节随任务事件实时更新） */
  data: ProjectState;
  /** 当前或最近一次的后台任务 */
  job: JobRecord | null;
  /** 是否有后台任务在跑（此时不能改目录、不能再启动别的任务） */
  running: boolean;
  /** 正在启动任务（请求已发出、还没有结果）：开始类按钮应当一并禁用，防止连点 */
  starting: boolean;
  /** 正在写的章节的实时文本：uid → 已写出的原始文本 */
  live: Record<string, string>;
  leafByUid: Record<string, LeafInfo>;
  /** 章节在界面上的状态 */
  chapterStatus: (uid: string) => ChapterUiStatus;
  /** 重新拉取项目状态 */
  reload: () => Promise<void>;
  /** 把修改类接口返回的 ProjectState 并入当前状态（比本页已有的更早读出的，只并入更新的章节） */
  apply: (state: ProjectState) => void;
  /** 更新一章（手动保存、恢复历史版本之后调用）；比本页已有的这一章更早的会被忽略 */
  setChapter: (chapter: ChapterView) => void;
  /**
   * 换上新的审校结果。请传审校接口的完整响应（ReviewResponse）：
   * 它带着 outline_changed，“审校之后目录变过”的标记会一并更新
   */
  setReview: (review: ReviewReport | ReviewResponse) => void;
  /**
   * 启动后台任务。成功返回 true；失败返回 false，并把原因放在 Promise 的结果之外——
   * 调用方通过 onError 拿到可以直接展示的文案。
   * 上一次启动还没有结果时再调用（双击、连点）直接返回 false，不发请求也不报错。
   * 后端说已有任务在运行（409）时会重新同步，页面上随即出现那个任务的进度和“停止”。
   */
  startJob: (kind: JobKind, params?: Record<string, unknown>, onError?: (message: string) => void) => Promise<boolean>;
  cancelJob: () => Promise<void>;
}

const WorkspaceContext = createContext<Workspace | null>(null);

export function useWorkspace(): Workspace {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace 必须在 WorkspaceProvider 里使用');
  return value;
}

interface ProviderProps {
  projectId: string;
  /** 加载中、加载失败时显示的内容 */
  fallback: (status: { loading: boolean; error: string | null; retry: () => void }) => React.ReactNode;
  children: React.ReactNode;
}

export function WorkspaceProvider({ projectId, fallback, children }: ProviderProps) {
  const [store, dispatch] = useReducer(reducer, EMPTY);
  // 本页已经处理到的事件序号，以及它属于哪个任务（序号只在同一个任务内可比）
  const seqRef = useRef(0);
  const seqJobRef = useRef<string | null>(null);
  const [subscribeKey, setSubscribeKey] = useState(0);
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const jobRef = useRef<JobRecord | null>(store.job);
  jobRef.current = store.job;
  const retryableRef = useRef(store.loadErrorRetryable);
  retryableRef.current = store.loadErrorRetryable;
  // 请求代次：完整加载每发起一次加一；本页每启动一个任务加一。
  // 响应回来时代次已经变了，说明这份快照过时了，不能再拿它覆盖任务状态
  const loadGenRef = useRef(0);
  const jobGenRef = useRef(0);
  const startingRef = useRef(false);
  const [starting, setStarting] = useState(false);
  // 事件流被服务端拒绝（非 200）后重新订阅的次数：收到事件就清零，用来拉长重试间隔
  const lostRef = useRef<{ jobId: string | null; count: number }>({ jobId: null, count: 0 });

  const loadFull = useCallback(async () => {
    const id = projectRef.current;
    loadGenRef.current += 1;
    const loadGen = loadGenRef.current;
    const jobGen = jobGenRef.current;
    try {
      const state = await api.getProject(id);
      // 之后又发起了完整加载：以那一次为准
      if (projectRef.current !== id || loadGen !== loadGenRef.current) return;
      const snapshot = state.job;
      // 快照里的任务还在跑，而本页经事件流处理过的序号比它新（这次读取在服务端早于那几条事件）：
      // 不能把序号和实时文本退回去，那几条事件不会再补发，正在写的章节会少一段
      const behind =
        snapshot !== null &&
        isActive(snapshot.job) &&
        snapshot.job.id === seqJobRef.current &&
        snapshot.last_seq < seqRef.current;
      if (jobGen !== jobGenRef.current || behind) {
        // 请求发出后本页又启动了新任务，或者快照落后于事件流：只合并数据，任务以事件流为准
        dispatch({ type: 'merged', state });
        return;
      }
      seqRef.current = snapshot ? snapshot.last_seq : 0;
      seqJobRef.current = snapshot ? snapshot.job.id : null;
      dispatch({ type: 'loaded', state });
    } catch (error) {
      if (projectRef.current === id && loadGen === loadGenRef.current) {
        // 连不上服务、服务端出错时过一会儿再试有可能成功；项目不存在之类的再试也没用
        const retryable = !(error instanceof ApiError) || error.status === 0 || error.status >= 500;
        dispatch({ type: 'error', message: errorMessage(error, '项目加载失败'), retryable });
      }
    }
  }, []);

  const loadQuiet = useCallback(async () => {
    const id = projectRef.current;
    const loadGen = loadGenRef.current;
    try {
      const state = await api.getProject(id);
      // 期间发起过完整加载：它带回的数据更新，这份不用了
      if (projectRef.current === id && loadGen === loadGenRef.current) dispatch({ type: 'merged', state });
    } catch {
      // 静默刷新失败不打扰使用者，下一次操作会再同步
    }
  }, []);

  useEffect(() => {
    dispatch({ type: 'reset' });
    seqRef.current = 0;
    seqJobRef.current = null;
    void loadFull();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // 项目没打开（“项目打不开”）：窗口重新获得焦点、联网时立刻再试；连不上服务时还会隔一会儿自动再试，
  // 后端恢复后不用手动点“重试”
  const openFailed = store.server === null && store.loadError !== null;
  useEffect(() => {
    if (!openFailed) return undefined;
    let stopped = false;
    let inFlight = false;
    let timer: number | undefined;
    let delay = RETRY_FIRST_MS;

    const schedule = () => {
      if (stopped || !retryableRef.current) return;
      timer = window.setTimeout(attempt, delay);
      delay = Math.min(delay * 2, RETRY_MAX_MS);
    };
    function attempt() {
      timer = undefined;
      if (stopped || inFlight) return;
      inFlight = true;
      void loadFull().then(() => {
        inFlight = false;
        // 打开了的话这个 effect 随即被清理，计时器也会一起清掉
        schedule();
      });
    }
    const retryNow = () => {
      if (stopped || inFlight || document.visibilityState === 'hidden') return;
      if (timer !== undefined) window.clearTimeout(timer);
      delay = RETRY_FIRST_MS;
      attempt();
    };

    schedule();
    window.addEventListener('focus', retryNow);
    window.addEventListener('online', retryNow);
    document.addEventListener('visibilitychange', retryNow);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener('focus', retryNow);
      window.removeEventListener('online', retryNow);
      document.removeEventListener('visibilitychange', retryNow);
    };
  }, [openFailed, loadFull]);

  const activeJobId = isActive(store.job) && store.job ? store.job.id : null;

  useEffect(() => {
    if (!activeJobId) return undefined;
    // 序号只在同一个任务内可比：记着的是别的任务的序号时，从头订阅（宁可重放也不要漏）
    if (seqJobRef.current !== activeJobId) {
      seqRef.current = 0;
      seqJobRef.current = activeJobId;
    }
    if (lostRef.current.jobId !== activeJobId) lostRef.current = { jobId: activeJobId, count: 0 };
    let disposed = false;
    let retryTimer: number | undefined;
    const subscription = subscribeJob(projectId, activeJobId, seqRef.current, {
      onEvent: (seq, event) => {
        lostRef.current.count = 0;
        // 完整重载之后，仍在路上的旧事件已经包含在快照里了，不能再应用一遍
        if (seq && seq <= seqRef.current) return;
        if (seq) seqRef.current = seq;
        dispatch({ type: 'event', event });
        if (event.type === 'blueprint_ready' || event.type === 'review_ready' || event.type === 'job_end') {
          void loadQuiet();
        }
      },
      onResync: () => {
        void loadFull().then(() => setSubscribeKey((key) => key + 1));
      },
      onLost: () => {
        // 服务端拒绝了事件流（例如代理返回 5xx）：先重新同步。任务还在跑时过一会儿重新订阅，
        // 否则页面会一直停在“运行中”、收不到之后的事件；连续被拒时逐步拉长间隔，免得一直打服务。
        // 任务已经结束（或换了任务）时，重新同步后这个 effect 会被清理，计时器随之取消
        const lost = lostRef.current;
        const delay = Math.min(RETRY_FIRST_MS * Math.pow(2, lost.count), RETRY_MAX_MS);
        lost.count += 1;
        void loadFull().then(() => {
          if (disposed) return;
          retryTimer = window.setTimeout(() => setSubscribeKey((key) => key + 1), delay);
        });
      },
    });
    return () => {
      disposed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      subscription.close();
    };
  }, [projectId, activeJobId, subscribeKey, loadFull, loadQuiet]);

  const apply = useCallback((state: ProjectState) => dispatch({ type: 'merged', state }), []);
  const setChapter = useCallback((chapter: ChapterView) => dispatch({ type: 'chapter', chapter }), []);
  const setReview = useCallback((review: ReviewReport | ReviewResponse) => dispatch({ type: 'review', review }), []);

  const startJob = useCallback(
    async (kind: JobKind, params: Record<string, unknown> = {}, onError?: (message: string) => void) => {
      // 双击、连点：上一次启动还没有结果，不再发第二个请求（否则会撞上后端的单任务锁，报一个误导人的错）
      if (startingRef.current) return false;
      startingRef.current = true;
      setStarting(true);
      const id = projectRef.current;
      try {
        const snapshot = await api.startJob(id, kind, params);
        if (projectRef.current !== id) return false;
        seqRef.current = 0; // 从头订阅：任务刚启动，事件很少，宁可重放也不要漏
        seqJobRef.current = snapshot.job.id;
        jobGenRef.current += 1;
        dispatch({ type: 'job', snapshot: { ...snapshot, live: {} } });
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 409 && projectRef.current === id) {
          // 多半是别的标签页里已经开始了任务：重新同步，页面上就能看到它的进度和“停止”
          void loadFull();
        }
        if (onError) onError(errorMessage(error, '任务启动失败'));
        return false;
      } finally {
        startingRef.current = false;
        setStarting(false);
      }
    },
    [loadFull]
  );

  // 窗口重新获得焦点时核对一次任务：别的标签页里开始、结束的任务，或者事件流断掉没收到的结尾，
  // 都在这里接上。只比对任务，不动正在编辑的内容
  useEffect(() => {
    let checking = false;
    let lastCheck = 0;
    const check = () => {
      if (document.visibilityState === 'hidden' || checking || startingRef.current) return;
      const now = Date.now();
      if (now - lastCheck < 2000) return;
      lastCheck = now;
      checking = true;
      const id = projectRef.current;
      api
        .currentJob(id)
        .then((snapshot) => {
          if (projectRef.current !== id || !snapshot) return;
          const known = jobRef.current;
          const remote = snapshot.job;
          const same = known !== null && known.id === remote.id && isActive(known) === isActive(remote);
          if (!same) void loadFull();
        })
        .catch(() => undefined)
        .then(() => {
          checking = false;
        });
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [loadFull]);

  const cancelJob = useCallback(async () => {
    const job = store.job;
    if (!job || !isActive(job)) return;
    try {
      await api.cancelJob(projectRef.current, job.id);
    } finally {
      await loadFull();
    }
  }, [store.job, loadFull]);

  const server = store.server;
  const leaves = server ? server.leaves : null;
  const leafByUid = useMemo(() => {
    const map: Record<string, LeafInfo> = {};
    if (leaves) {
      leaves.forEach((leaf) => {
        map[leaf.uid] = leaf;
      });
    }
    return map;
  }, [leaves]);

  const running = isActive(store.job);
  const { writing, queued } = store;
  const chapters = server ? server.chapters : null;
  const chapterStatus = useCallback(
    (uid: string): ChapterUiStatus => {
      if (writing[uid]) return 'writing';
      if (running && queued[uid]) return 'queued';
      const chapter = chapters ? chapters[uid] : undefined;
      if (!chapter) return 'empty';
      if (chapter.status === 'done' && chapter.chars <= 0) return 'empty';
      return chapter.status;
    },
    [writing, queued, running, chapters]
  );

  const value = useMemo<Workspace | null>(() => {
    if (!server) return null;
    return {
      projectId,
      data: server,
      job: store.job,
      running,
      starting,
      live: store.live,
      leafByUid,
      chapterStatus,
      // 任务运行期间只做合并式刷新，实时文本以事件流为准
      reload: running ? loadQuiet : loadFull,
      apply,
      setChapter,
      setReview,
      startJob,
      cancelJob,
    };
  }, [server, projectId, store.job, store.live, running, starting, leafByUid, chapterStatus, loadFull, loadQuiet, apply, setChapter, setReview, startJob, cancelJob]);

  if (!value) {
    return <>{fallback({ loading: !store.loadError, error: store.loadError, retry: () => void loadFull() })}</>;
  }
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
