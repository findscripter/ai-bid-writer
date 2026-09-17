# 插图渲染依赖（diagram_service 用）

正文导出勾选「插入技术插图」时，后端调用以下外部工具把 LLM 生成的图表 DSL 渲染成 PNG。

## 引擎与图型分工
- **mermaid**（mmdc CLI，经本机 Chrome 无头渲染）：流程图、时序图、甘特图、状态图
- **plantuml**（java -jar，纯 Java 渲染）：系统架构、部署图、网络拓扑、组织架构、C4

## 部署清单（Windows）

1. **Node.js + mermaid-cli**
   ```
   set PUPPETEER_SKIP_DOWNLOAD=1
   npm install -g @mermaid-js/mermaid-cli
   ```
   不下载 Chromium，改用本机 Chrome——见同目录 `puppeteer-config.json`（指向
   `C:\Program Files\Google\Chrome\Application\chrome.exe`，按实际路径改）。

2. **Java（JRE 11+）** + **plantuml.jar**
   - 将 jar 放到本目录，命名为 `plantuml.jar`（推荐 1.2026.x，约 28MB）：
     `https://repo1.maven.org/maven2/net/sourceforge/plantuml/plantuml/<版本>/plantuml-<版本>.jar`
   - 仓库不跟踪该 jar。Maven 的 `<release>` 标签会错误指向 2017 年的旧版本号 8059，必须手动选 `1.20xx.x` 版本线。

## 路径覆盖（可选环境变量）
- `DIAGRAM_MMDC_PATH`：mmdc 可执行文件路径
- `DIAGRAM_JAVA_PATH`：java 路径
- `DIAGRAM_PLANTUML_JAR`：plantuml.jar 路径

未配置时自动探测（PATH / npm 全局前缀 / 本目录）。

## 中文
- mermaid 走 Chrome 系统字体，开箱即用。
- plantuml 自动注入 `skinparam defaultFontName "Microsoft YaHei"` + `-charset UTF-8`。

## 健康检查
`DiagramRenderer.availability()` 返回各引擎依赖是否就绪。
