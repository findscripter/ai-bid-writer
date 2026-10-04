/**
 * 应用外壳：顶栏 + 全局信息（应用信息、模型服务设置）。
 *
 * 页面里这样用：
 *   const shell = useAppShell();
 *   shell.meta          应用信息（是否演示模式、风格预设等），加载完成前为 null
 *   shell.settings      模型服务设置（密钥是否已配置等），加载完成前为 null
 *   shell.modelReady    模型服务是否可用（已配置密钥，或处于演示模式）；还没读到设置时为 false，
 *                       需要拦截时请写成 settings !== null && !modelReady，没读到就交给后端判断
 *   shell.openSettings()        打开设置抽屉
 *   shell.refreshSettings()     重新读取设置
 *
 * 应用信息和设置读取失败（例如页面打开时后端正在重启）会自动重试，直到读到为止。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Cog6ToothIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { api } from '../api/client';
import type { AppMeta, AppSettings } from '../api/types';
import { Link } from '../lib/router';
import { Badge, Button, IconButton, Tooltip } from '../ui';
import SettingsDrawer from './SettingsDrawer';

export interface AppShellValue {
  meta: AppMeta | null;
  settings: AppSettings | null;
  modelReady: boolean;
  openSettings: () => void;
  refreshSettings: () => Promise<void>;
}

const AppShellContext = createContext<AppShellValue | null>(null);

export function useAppShell(): AppShellValue {
  const value = useContext(AppShellContext);
  if (!value) throw new Error('useAppShell 必须在 AppShell 里使用');
  return value;
}

function LogoMark() {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-ink-900">
      <svg className="h-4 w-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14 3v4a1 1 0 0 0 1 1h4" />
        <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
        <path d="M9 13h6" stroke="#90B0FF" />
        <path d="M9 17h4" stroke="#90B0FF" />
      </svg>
    </span>
  );
}

interface AppShellProps {
  /** 顶栏中间的面包屑（项目页会放项目名） */
  breadcrumb?: React.ReactNode;
  children: React.ReactNode;
}

/** 读取失败后的重试间隔：1 秒起，每次翻倍，最长 15 秒 */
const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 15000;

export function AppShellProvider({ children }: { children: React.ReactNode }) {
  const [meta, setMeta] = useState<AppMeta | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const metaRef = useRef<AppMeta | null>(null);
  const settingsRef = useRef<AppSettings | null>(null);
  metaRef.current = meta;
  settingsRef.current = settings;

  const refreshSettings = useCallback(async () => {
    try {
      setSettings(await api.getSettings());
    } catch {
      // 后端没起来时保持原样，页面会提示连接不上
    }
  }, []);

  // 启动时读应用信息和设置；没读到的（后端还没起来、正在重启）隔一会儿再试，直到读到为止。
  // 窗口重新获得焦点、网络恢复时立刻再试一次
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let inFlight = false;
    let delay = RETRY_FIRST_MS;

    const attempt = async () => {
      timer = undefined;
      if (stopped || inFlight) return;
      inFlight = true;
      const pending: Array<Promise<unknown>> = [];
      if (!metaRef.current) {
        pending.push(
          api.meta().then((value) => {
            if (stopped) return;
            metaRef.current = value;
            setMeta(value);
          })
        );
      }
      if (!settingsRef.current) {
        pending.push(
          api.getSettings().then((value) => {
            if (stopped) return;
            settingsRef.current = value;
            setSettings(value);
          })
        );
      }
      await Promise.all(pending.map((item) => item.catch(() => undefined)));
      inFlight = false;
      if (stopped || (metaRef.current && settingsRef.current)) return;
      timer = window.setTimeout(() => void attempt(), delay);
      delay = Math.min(delay * 2, RETRY_MAX_MS);
    };

    const retryNow = () => {
      if (stopped || inFlight || (metaRef.current && settingsRef.current)) return;
      if (timer !== undefined) window.clearTimeout(timer);
      delay = RETRY_FIRST_MS;
      void attempt();
    };

    void attempt();
    window.addEventListener('focus', retryNow);
    window.addEventListener('online', retryNow);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener('focus', retryNow);
      window.removeEventListener('online', retryNow);
    };
  }, []);

  const value = useMemo<AppShellValue>(
    () => ({
      meta,
      settings,
      modelReady: Boolean((meta && meta.demo) || (settings && (settings.api_key_set || settings.demo))),
      openSettings: () => setSettingsOpen(true),
      refreshSettings,
    }),
    [meta, settings, refreshSettings]
  );

  return (
    <AppShellContext.Provider value={value}>
      {children}
      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSaved={(next) => setSettings(next)}
        onLoaded={(next) => setSettings((prev) => prev || next)}
      />
    </AppShellContext.Provider>
  );
}

export function AppShell({ breadcrumb, children }: AppShellProps) {
  const shell = useAppShell();
  const { meta, settings, modelReady } = shell;
  // 与各页面的拦截口径一致：读到了设置、模型确实不可用才提示（应用信息还没读到时，设置里的 demo 也算演示模式）
  const needsSetup = settings !== null && !modelReady;
  const demo = Boolean((meta && meta.demo) || (settings && settings.demo));

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas text-ink-900">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-white px-4">
        <Link to="/" className="flex items-center gap-2 rounded-md pr-1 text-ink-900 hover:opacity-80">
          <LogoMark />
          <span className="text-[15px] font-semibold tracking-tight">AI写标书助手</span>
        </Link>
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm text-ink-500">{breadcrumb}</div>
        <div className="flex shrink-0 items-center gap-2">
          {demo && (
            <Tooltip content="演示模式：不调用真实模型，生成的是示意文本" side="bottom">
              <Badge tone="warning">演示模式</Badge>
            </Tooltip>
          )}
          {needsSetup && (
            <Button
              size="sm"
              variant="subtle"
              icon={<ExclamationTriangleIcon className="h-4 w-4 text-amber-600" />}
              onClick={shell.openSettings}
            >
              模型服务未配置
            </Button>
          )}
          <Link to="/classic" className="rounded-md px-2 py-1 text-xs text-ink-500 hover:bg-subtle hover:text-ink-700">
            经典模式
          </Link>
          <IconButton label="模型服务设置" icon={<Cog6ToothIcon className="h-5 w-5" />} onClick={shell.openSettings} />
        </div>
      </header>
      <main className="min-h-0 flex-1">{children}</main>
    </div>
  );
}
