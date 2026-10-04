/**
 * 应用入口：按地址栏的 hash 分发到各个页面。
 *
 *   #/                         项目列表
 *   #/projects/:id/:stage?     项目工作台（招标解读 / 目录 / 写作计划 / 正文 / 审校 / 导出）
 *   #/classic                  经典模式（原来的三步向导）
 */
import React from 'react';
import { AppShell, AppShellProvider } from './app/AppShell';
import ClassicApp from './classic/ClassicApp';
import { Link, matchPath, useHashRoute } from './lib/router';
import ProjectsPage from './projects/ProjectsPage';
import { ConfirmProvider, EmptyState, ToastProvider } from './ui';
import ProjectWorkspace from './workspace/ProjectWorkspace';

function Routes() {
  const route = useHashRoute();

  if (route.path === '/classic') {
    return (
      <div className="relative">
        <ClassicApp />
        <Link
          to="/"
          className="fixed right-4 top-3 z-[70] rounded-md border border-line bg-white px-3 py-1.5 text-xs text-ink-600 shadow-card hover:bg-subtle"
        >
          返回项目工作台
        </Link>
      </div>
    );
  }

  const project = matchPath('/projects/:id/:stage?', route.path);
  if (project) {
    return <ProjectWorkspace key={project.id} projectId={project.id} stage={project.stage} />;
  }

  if (route.path === '/') {
    return (
      <AppShell>
        <ProjectsPage />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <EmptyState
        className="pt-24"
        title="页面不存在"
        description="地址可能输入有误。"
        action={
          <Link to="/" className="text-sm text-primary-600 hover:underline">
            回到项目列表
          </Link>
        }
      />
    </AppShell>
  );
}

function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <AppShellProvider>
          <Routes />
        </AppShellProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

export default App;
