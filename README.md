# AI写标书助手

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.9+-blue.svg" alt="Python">
  <img src="https://img.shields.io/badge/React-19-61dafb.svg" alt="React">
  <img src="https://img.shields.io/badge/FastAPI-0.116-009688.svg" alt="FastAPI">
  <img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License">
</p>

本地运行的 AI 标书写作助手：上传招标文件，解析项目概述与评分要求，生成三级目录和章节正文，支持多份差异化草稿，一键导出 Word。

任意 OpenAI 兼容接口均可使用，推荐 DeepSeek。API Key、招标原文和生成草稿只保存在本机。

## 功能

- **文档解析**：上传 Word / PDF，流式提取项目概述和技术评分要求，结果可手改
- **目录生成**：自由目录，或与评分项一一对应；支持上传旧方案做扩写
- **正文生成**：叶子章节并发生成，按目标页数分配字数，不足则自动续写
- **多份草稿**：一次最多 5 份，轮转写作风格和模型，目录结构可变体
- **响应章节**：可在目录末尾追加采购公告 / 评审办法 / 合同 / 采购人要求 / 资格响应
- **技术插图**：导出时可选为合适章节生成架构图、流程图（Mermaid / PlantUML / 内置框图）
- **Word 导出**：叶子章节未写完会拦截；多份导出时排版参数略有差异

## 界面

1. 配置 API Key 与模型

   ![](./screenshots/1.png)

2. 上传招标文件

   ![](./screenshots/2.png)

3. 解析项目概述与技术评分要求

   ![](./screenshots/3.png)

4. 生成并编辑目录

   ![](./screenshots/4.png)

5. 生成正文

   ![](./screenshots/5.png)

6. 导出 Word

   ![](./screenshots/6.png)

## 快速开始

### 环境

- Windows 10/11，Python 3.9+，Node.js 18+
- 一个 OpenAI 兼容的 API Key（DeepSeek / 其他网关均可）

### 一键启动

```bat
git clone https://github.com/findscripter/ai-bid-writer.git
cd ai-bid-writer
pip install -r backend/requirements.txt
cd frontend && npm install && cd ..
single_port.bat
```

浏览器打开 http://localhost:8000 。首次会构建前端并复制到 `backend/static`。

分开跑也可以：

```bat
cd backend
python run.py
```

```bat
cd frontend
npm start
```

前端开发服务器默认 `http://localhost:3000`，请求打到 `http://localhost:8000`。

API 文档：http://localhost:8000/docs

### 打包 exe

```bat
python build.py
```

产物在 `dist/ai-bid-writer.exe`。

## 使用流程

1. 左侧填入 API Key、Base URL（可选）、模型名称并保存
2. 上传招标文件（`.docx` / `.pdf`，最大 10MB）
3. 点击解析，检查并修改项目概述、技术评分要求
4. 生成目录；可选「与技术评分项一一对应」，或上传旧方案扩写
5. 生成正文：单份按目标页数，或多份轮转风格 / 模型
6. 导出 Word；需要插图时勾选并确保本机已装绘图依赖

## 技术插图（可选）

导出勾选「插入技术插图」时，需要：

```bat
set PUPPETEER_SKIP_DOWNLOAD=1
npm install -g @mermaid-js/mermaid-cli
```

以及 JRE 11+。将 [PlantUML jar](https://repo1.maven.org/maven2/net/sourceforge/plantuml/plantuml/) 放到 `backend/tools/plantuml.jar`。详见 [`backend/tools/README.md`](backend/tools/README.md)。

## 项目结构

```
ai-bid-writer/
├── backend/                 # FastAPI
│   ├── app/
│   │   ├── main.py
│   │   ├── routers/         # 配置 / 文档 / 目录 / 正文 / 扩写
│   │   ├── services/        # 解析、生成、配图、Word 导出
│   │   └── utils/           # 提示词、persona、字数预算
│   ├── tools/               # mermaid / plantuml 配置
│   └── requirements.txt
├── frontend/                # React + TypeScript + Tailwind
│   └── src/pages/           # 解析 / 目录 / 正文 三步
├── screenshots/             # README 演示图
├── single_port.bat          # 单端口启动
└── build.py                 # PyInstaller 打包
```

配置文件写在 `~/.ai_write_helper/user_config.json`。草稿缓存在浏览器 localStorage。

## 说明

- 招标文件默认只在本机解析。若设置环境变量 `IMAGE_UPLOAD_URL`，才会把文档内插图传到外部图床。
- 生成内容必须人工审阅后再用于投标。模型会编造业绩、证书和指标，导出前请逐条对照招标原文。
- 本仓库不包含任何真实招标原件或已投出的标书。

## 致谢

核心流程基于 [FB208/OpenBidKit_Yibiao](https://github.com/FB208/OpenBidKit_Yibiao)（易标极速版，MIT）。本仓库在其基础上增加了多份生成、响应章节、技术插图和 Word 导出增强，并作为独立项目继续维护。

## 许可证

[MIT License](LICENSE)
