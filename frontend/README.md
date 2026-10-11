# 前端

React 19 + TypeScript + Tailwind，Create React App 脚手架。

```bat
npm install
npm start        :: 开发服务器 http://localhost:3000 ，接口请求打到 http://localhost:8000
npm run build    :: 生产构建，输出到 build/
```

把 `.env.example` 复制成 `.env` 后，开发服务器改用其中的 `PORT=3002`（后端放行了本机 3000~3004 端口，不影响使用）。

日常使用不需要单独构建：在仓库根目录运行 `python build_frontend.py`（或直接 `single_port.bat`），会构建并复制到 `backend/static`，由后端同端口托管。

## 目录

```
src/
├── App.tsx            # 入口：按地址栏 hash 分发页面
├── api/               # 后端接口封装（client.ts）与数据类型（types.ts）
├── app/               # 应用外壳（顶栏）、模型服务设置
├── lib/               # hash 路由、Markdown 渲染、格式化函数
├── ui/                # 基础组件（Button、Modal、Tabs…），Gallery.tsx 是视觉验收页（没有接入路由，需要时在入口临时渲染）
├── projects/          # 项目列表
├── workspace/         # 项目工作台
│   ├── WorkspaceContext.tsx   # 状态中心：项目数据 + 后台任务事件流
│   ├── ProjectWorkspace.tsx   # 阶段导航与任务状态条
│   ├── dismissedJobs.ts       # 关掉过的“任务被中断 / 失败”提示（各页面共用）
│   ├── stages/                # 招标解读 / 目录 / 写作计划 / 正文 / 审校 / 导出
│   ├── tender/、outline/、plan/、review/   # 对应阶段页用到的组件
│   └── write/                 # 正文页的章节树、文稿区、侧栏
└── classic/、pages/、components/、hooks/、services/、types/、utils/   # 经典模式（原三步向导）
```

## 约定

- 数据以后端为准：项目工作台的页面不在浏览器里保存稿件（localStorage 只存界面偏好，例如导出选项、关掉过的提示；经典模式的草稿除外）。修改项目数据的接口大多返回完整的项目状态，交给 `ws.apply(state)`；保存或恢复单章返回这一章，交给 `ws.setChapter`；审校接口返回审校结果，交给 `ws.setReview`。
- 整份项目状态带服务端的快照时刻 `state_at`：晚到的旧响应不会把更新的数据换回去（见 `WorkspaceContext.tsx` 里的 `mergeState`）。
- 长时间运行的操作（规划、撰写、修订、深度审校）是后端的后台任务，页面通过事件流（SSE）跟随；刷新或断线后从快照的序号续传。
- `tsconfig` 的编译目标是 es5：不要对 Set / Map 直接用展开或 `for...of`。
- 环境变量 `REACT_APP_API_URL` 可以指定后端地址；不设时开发模式连 `http://localhost:8000`，生产构建走同源。
