# 开发与验证

需要 Node.js 22.14 或更新版本。使用 npm 和已提交的 `package-lock.json`：

```bash
npm ci
npm test
npm run typecheck
```

`npm test` 会先重新构建，再按顺序运行单元、隔离宿主集成和浏览器测试。构建清空旧的 `lib/`，避免残留模块或旧 bundle 让测试误通过。宿主使用严格 TypeScript 检查；客户端所有 JavaScript 模块使用 `checkJs` 和浏览器环境检查。

测试运行器为每个测试进程分配独立的临时 `DSH_HOME`，不能继承用户真实数据目录。存储实例在创建时固定目录，延迟写入也不会跟随环境变量变化；夹具应等待保存完成后再恢复环境和清理目录。

## 按范围验证

```bash
npm run test:unit
npm run test:integration
npm run test:browser
```

这些命令同样先构建。客户端场景由 `tests/integration/client.test.mjs` 调度，每个场景使用独立进程、临时宿主、数据目录和界面生命周期，并在结束时清理。DOM、接口和 SSE 响应夹具位于 `tests/client/fixtures/`，场景不应依赖前一场景留下的档位、设置或消息。默认测试不连接用户正在使用的 DSH。

构建后可运行全部客户端场景，或指定任意一个场景：

```bash
node tests/integration/client.test.mjs
SEL_CLIENT_SCENARIO=rendering node tests/integration/client.test.mjs
SEL_CLIENT_SCENARIO=memory node tests/integration/client.test.mjs
```

场景名见 `tests/client/scenario-list.mjs`。`context` 验证进度落盘、重开、原文尾部发送和附件索引；`cleanup` 验证卸载释放资源。不要直接执行内部 `tests/client/run.mjs`，它要求隔离宿主入口提供环境。

浏览器测试需要 Chrome/Chromium；可通过 `CHROME` 指定可执行文件。开发机没有浏览器时会明确跳过；CI 设置 `REQUIRE_BROWSER=1`，缺少浏览器会失败。面板测试驱动位于 `tests/browser/panel.test.mjs`，页面骨架与场景分别位于 `fixtures/panel.html` 和 `scenarios/`，保留同一浏览器页面内的交互顺序。原生探针测试在 macOS 上执行，其余平台明确跳过。截图服务测试注入平台夹具，不触发真实框选；另行进行人工截图验证时应明确记录。

默认语音浏览器测试使用带静音间隔的合成音频，验证真实录音、编码、停顿和输入框编排。需要验证实际宿主的识别服务时单独运行：

```bash
SEL_ORIGIN=http://127.0.0.1:3080 SPEECH_WAV=/absolute/path/sample.wav npm run test:online
```

语音样本需为 16kHz、单声道、PCM16 WAV。在线测试会向指定宿主发出识别请求，不属于默认离线验证。

## 升格的真实宿主回归

默认集成测试使用锁定依赖中的真实 Session 与关系校验器，验证 seed、系统首节点、来源、附件、项目归属和旧宿主回退。另有真实 DSH v4 运行时测试，需要提供已安装宿主中包含 `@deepseek-ai/*` 包的 `node_modules` 目录：

```bash
npm run build
node tests/runtime/promote.test.mjs /absolute/path/to/dsh/node_modules
```

该测试把已构建插件复制到临时目录，使用指定宿主的同一套依赖，避免将旧版消息工厂与 v4 会话服务混用。测试使用真实 agent factory、提示词投影、完整 step 与 Zstandard JSONL 存储，只有外部模型适配器替换为离线流。验证升格后立即重开、完整回复后重开、冷恢复后继续回复、系统提示词变更与清空、再次恢复后轮号续接，以及导入历史仍在模型请求中。每次重开都新建服务容器与存储后端，不访问外部模型或用户数据。默认 `npm test` 不包含这项需要完整宿主的测试；`check.yml` 在 Node 24 的 Linux 和 macOS 检查中另行安装锁定版本的 v4 核心运行时并执行；Windows 云端任务在 Node 22.14.0 和 24 上编译宿主模块并执行相同的完整回复与冷恢复测试，覆盖 Windows 原生路径、目录 junction 和文件读写。此任务验证本问题涉及的内核与日志恢复链路，不启动桌面界面。

## 构建与打包

```bash
npm run build
npm pack --dry-run
```

`npm pack`/`npm publish` 的 `prepack` 自动重建。DSH 依赖由锁文件固定用于构建，运行时仍通过 `peerDependencies` 由宿主提供。已有 DSH 开发环境可以继续使用 `DSH_CHECKOUT` 回退，但提交前应使用干净安装验证锁定版本。

普通提交和 PR 由 `check.yml` 在 Linux 的最低 Node 版本及 Node 24、macOS 的 Node 24 上验证；`publish.yml` 负责版本标签发布。测试失败、真实宿主不可达或检查跳过均应明确记录。

## 修改约定

- 新宿主逻辑放到对应职责模块，通过服务参数连接。
- 新客户端逻辑放到对应控制器，依赖从入口传入；减少跨控制器可变字段。
- 控制器依赖更新时同步修改 `controller-contracts.d.ts`；实例状态由工厂创建，避免模块级可变对象。
- 截图系统操作通过平台接口注入；活动命令必须响应任务取消，插件停用须等待清理完成。
- 配置默认值和数值边界只修改 `src/config-values.ts`；控件展示放在 `src/settings.ts`。
- 规则测试直接导入实际模块，接口测试验证请求与响应，界面几何交给真实浏览器。
- 本机记录和设计实验继续放在被忽略的 `docs/` 中；公共架构变化同步更新本目录两份公开说明。
