# 前端

React 19 + TypeScript + Tailwind，Create React App 脚手架。

```bat
npm install
npm start        :: 开发服务器 http://localhost:3000 ，接口请求打到 http://localhost:8000
npm run build    :: 生产构建，输出到 build/
```

日常使用不需要单独构建：在仓库根目录运行 `python build_frontend.py`（或直接 `single_port.bat`），会构建并复制到 `backend/static`，由后端同端口托管。

## 目录

```
src/
├── App.tsx            # 入口：按地址栏 hash 分发页面
├── api/               # 后端接口封装（client.ts）与数据类型（types.ts）
├── app/               # 应用外壳（顶栏）、模型服务设置
├── lib/               # hash 路由、Markdown 渲染、格式化函数
├── ui/                # 基础组件（Button、Modal、Tabs…），Gallery.tsx 是视觉验收页
├── projects/          # 项目列表
├── workspace/         # 项目工作台
│   ├── WorkspaceContext.tsx   # 状态中心：项目数据 + 后台任务事件流
│   ├── ProjectWorkspace.tsx   # 阶段导航与任务状态条
│   ├── stages/                # 招标解读 / 目录 / 写作计划 / 正文 / 审校 / 导出
│   └── write/                 # 正文页的章节树、文稿区、侧栏
└── classic/、pages/、components/、hooks/、services/   # 经典模式（原三步向导）
```

## 约定

- 数据以后端为准：页面不在浏览器里保存稿件。修改类接口返回完整的项目状态，交给 `ws.apply(state)`。
- 长时间运行的操作（规划、撰写、修订、深度审校）是后端的后台任务，页面通过事件流（SSE）跟随；刷新或断线后从快照的序号续传。
- `tsconfig` 的编译目标是 es5：不要对 Set / Map 直接用展开或 `for...of`。
- 环境变量 `REACT_APP_API_URL` 可以指定后端地址；不设时开发模式连 `http://localhost:8000`，生产构建走同源。
