# 项目架构

划词解读由 DSH 宿主服务、浏览器界面和 macOS 原生探针组成。

## 目录与职责

| 路径 | 职责 |
| --- | --- |
| `src/index.ts` | 公共插件入口和兼容导出 |
| `src/host/plugin.ts` | 创建服务、注册 HTTP 路由和生命周期清理 |
| `src/host/models.ts`、`sessions.ts` | 模型选择、推理能力清单、会话模型与背景缓存 |
| `src/host/settings-store.ts`、`history-store.ts` | 设置覆盖、历史条目和界面位置/尺寸的持久化 |
| `src/host/analyze.ts`、`promote.ts`、`speech.ts` | 流式解读、升格和语音识别接口 |
| `src/host/filters.ts`、`effort.ts`、`context.ts`、`tools.ts` | 可独立测试的处理规则及宿主工具适配 |
| `src/config-values.ts` | 配置类型、默认值和数值边界 |
| `src/settings.ts` | 设置控件元数据与补丁归一化 |
| `src/prompts.ts` | 提示词文本 |
| `src/client/index.js` | 创建界面节点、装配控制器、绑定事件和卸载 |
| `src/client/*` | 设置、面板、选区、语音卡、引用、预览、历史、对话及录音控制器；样式与渲染辅助 |
| `native/mic-probe.c` | macOS 麦克风占用探针源码 |
| `skills/web-design/` | 网页回答时由宿主读取的设计规范 |
| `tests/unit/`、`integration/`、`browser/` | 规则测试、隔离宿主集成、真实浏览器验证 |
| `tests/client/`、`tests/fixtures/` | 共用客户端环境、顺序场景和原生测试夹具 |
| `scripts/` | 构建、测试调度、提示词导出和设计开发工具 |
| `lib/` | 可重新生成的发布产物，不纳入版本控制 |

## 装配与状态

宿主入口只负责公开 DSH 需要的 `name`、`inject`、`Config`、`apply`。`apply` 创建各服务工厂，再注册原有 `/selection-explain/api/*` 路由。服务通过参数接收 `ctx`、配置和所需的其他服务。配置对象在实例内共享，设置更新立即对后续请求生效；模型缓存、历史和会话缓存由对应服务持有。

浏览器入口创建 DOM，向控制器传递节点、回调和必要的状态访问器。可变状态通过访问器读取当前值，避免复制布尔状态或模型缓存造成界面不同步。控制器之间不直接导入彼此；连接关系集中在入口。纯渲染、音频编码、图标和预览桥使用普通模块导出。

客户端通过 esbuild 打包为一个 CommonJS 工厂，并由 `window.__ModuleLoader__.load` 注册。模块求值发生在工厂 materialize 时，DOM 挂载和监听仍由 `apply` 执行；停用时通过已有 effect/slot 清理资源。

## 数据和发布资源

用户数据位于 `${DSH_HOME}/selection-explain`，未设置 `DSH_HOME` 时使用 `~/.dsh/selection-explain`。本次整理保留各 JSON 文件格式和 HTTP 路径。

发布内容仅包含 `lib/`、原生探针源码、装配清单、运行时 skill、README 和许可证。Linux 构建不会产生 macOS 二进制；Mac 上首次使用可按源码 hash 在数据目录中编译并缓存。因此 `native/mic-probe.c` 必须保留。宿主文件移动后的资源路径相对于 `lib/host/` 解析。

README 截图使用仓库中的版本链接，不随运行时包复制。`assets/` 仍在仓库中。公开架构和贡献说明纳入版本控制，其余本机资料与设计实验继续忽略。
