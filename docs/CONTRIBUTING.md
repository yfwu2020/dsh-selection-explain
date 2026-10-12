# 开发与验证

需要 Node.js 22.14 或更新版本。使用 npm 和已提交的 `package-lock.json`：

```bash
npm ci
npm test
npm run typecheck
```

`npm test` 会先重新构建，再按顺序运行单元、隔离宿主集成和浏览器测试。构建清空旧的 `lib/`，避免残留模块或旧 bundle 让测试误通过。宿主使用严格 TypeScript 检查；客户端所有 JavaScript 模块使用 `checkJs` 和浏览器环境检查。

## 按范围验证

```bash
npm run test:unit
npm run test:integration
npm run test:browser
```

这些命令同样先构建。`tests/client/run.mjs` 中的场景共享一个界面生命周期，必须由隔离宿主入口 `tests/integration/client.test.mjs` 按顺序运行，不能单独加载一个中间场景。默认测试使用临时数据目录和模型/识别夹具，不连接用户正在使用的 DSH。

浏览器测试需要 Chrome/Chromium；可通过 `CHROME` 指定可执行文件。开发机没有浏览器时会明确跳过；CI 设置 `REQUIRE_BROWSER=1`，缺少浏览器会失败。原生探针测试在 macOS 上执行，其余平台明确跳过。

默认语音浏览器测试使用带静音间隔的合成音频，验证真实录音、编码、停顿和输入框编排。需要验证实际宿主的识别服务时单独运行：

```bash
SEL_ORIGIN=http://127.0.0.1:3080 SPEECH_WAV=/absolute/path/sample.wav npm run test:online
```

语音样本需为 16kHz、单声道、PCM16 WAV。在线测试会向指定宿主发出识别请求，不属于默认离线验证。

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
- 配置默认值和数值边界只修改 `src/config-values.ts`；控件展示放在 `src/settings.ts`。
- 规则测试直接导入实际模块，接口测试验证请求与响应，界面几何交给真实浏览器。
- 本机记录和设计实验继续放在被忽略的 `docs/` 中；公共架构变化同步更新本目录两份公开说明。
