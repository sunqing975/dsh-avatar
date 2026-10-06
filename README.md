# dsh-avatar

DSH（DeepSeek Harness）生态插件：常驻 dsh 界面前层的 AI 数字人。

纯表现层——VRM 形象渲染 + 大模型通过工具驱动表情与动作，不涉及人格、记忆、字幕等业务逻辑。与 nuomi 项目思想对齐，但代码独立全新（nuomi 冻结不动）。

## 能力

- **前层常驻**：数字人悬浮在 dsh 界面右下角（`shell.overlay` 全局前层），所有页面/会话常驻可见，不占用任何 tab。
- **表情**：大模型调用 `set_expression`（enum 来自当前 VRM 模型的 blend shapes），数字人 5 秒后自动复位。
- **动作**：大模型调用 `play_motion`（enum 来自 `assets/animations/` 目录动态扫描），播放 VRMA 动作，idle 循环待机。
- **手动导入动作**：往 `assets/animations/` 放入 `.vrma` 文件（重启插件后自动进入工具清单），即插即用。

## 安装

### 从 GitHub 直接安装（推荐）

```bash
dsh plugin --profile <你的profile名> add github:sunqing975/dsh-avatar
```

例如使用默认的 web profile：

```bash
dsh plugin --profile web add github:sunqing975/dsh-avatar
```

首次安装时 dsh 的供应链安全策略会拦截 git 源包的构建脚本（`prepare`），报错会给出类似这样的提示：

```
[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] ... add the exact key pnpm printed above under allowBuilds in /Users/<你>/.dsh/profiles/<profile>/pnpm-workspace.yaml
```

按提示把报错中的完整条目加入 `~/.dsh/profiles/<profile>/pnpm-workspace.yaml`（参考格式）：

```yaml
allowBuilds:
  dsh-avatar@https://codeload.github.com/sunqing975/dsh-avatar/tar.gz/<commit>: true
```

保存后重新执行 `dsh plugin add github:sunqing975/dsh-avatar` 即可完成安装，然后重启 dsh web。

> 说明：`allowBuilds` 是 dsh 的正式安全机制（仅放行已确认来源的构建脚本），不是绕过限制。

### 本地开发（link 安装）

```bash
dsh plugin --profile web add link:/path/to/dsh-avatar
```

## 模型与动作

- 默认模型：`assets/models/nuomi.vrm`（女仆装 VRM，用户自有资产）
- 默认动作：`assets/animations/`（bow / idle / elbow_punch / Praying / sitting_laughing / Body Block，来自 nuomi 的 fbx2vrma 工具链产出）

## 开发

```bash
npm install
npm run build          # esbuild 构建 host(lib/index.js) + client(lib/client.js)
npm run typecheck      # 双 tsconfig 类型检查
npm run verify:bridge  # 端到端验证「工具调用 → /dsh-avatar/pose → 客户端」链路
```

`verify:bridge` 只依赖构建产物：它真的加载 `lib/index.js` 注册路由与工具、真的起一个 http 服务、
真的在最小 `window` 环境里执行 `lib/client.js` 的轮询代码，然后断言三次工具调用是否都被客户端按序收到。
改了 `pose.ts` / `tools.ts` / `client/index.tsx` 之后先跑它，比在浏览器里猜快得多。
（也可用 `PKG=file:///某个/dsh-avatar/ npm run verify:bridge` 去验证别的 profile 里装的那一份。）

### 本地接入 dsh web

```bash
npx @deepseek-ai/dsh plugin --profile web add link:/Users/superman/projects/code/dsh-avatar
npx -y @deepseek-ai/dsh web --no-open   # 启动后从日志取 token 打开页面
```

### 结构

```
src/
  index.ts          # host 插件：资产 HTTP 服务、/dsh-avatar/info、工具注册
  tools.ts          # set_expression / play_motion 工具定义
  model-info.ts     # GLB blend shapes 解析
  config.ts         # 配置 schema
  client/
    index.tsx       # client 插件：shell.overlay 注册、session/event → 表情/动作事件
    AvatarFloating.tsx # 数字人常驻浮层（React + canvas）
    vrm.ts          # three.js + @pixiv/three-vrm(-animation) 渲染与播放控制器
    event-bus.ts    # 内部事件总线
assets/
  models/           # VRM 模型
  animations/       # VRMA 动作
scripts/
  build.mjs         # esbuild 双产物构建
  verify-bridge.mjs # 工具调用 → 数字人 的端到端链路验证
```

## 实现要点（踩坑记录）

- client bundle 必须是 `__ModuleLoader__` CJS 格式（ESM 会被浏览器拒绝）。
- 数字人挂载在 `shell.overlay`（root scope 全局前层），无需会话即可显示；该层默认 click-through，组件需 `pointerEvents: auto`。
- esbuild 需 `jsx: 'automatic'`（否则生成 `React.createElement` 而 bundle 里没有 React 全局）。
- VRMA 解析用 `gltf.userData.vrmAnimations[0]`（复数），不是 `vrmAnimation`。
- **「工具能调、数字人不动」的根因通常是这条指令链路**。浏览器里的 client 插件收不到 Host 的
  `ctx.on('session/event')`（没有任何 client bundle 把它转发过来），所以客户端监听会话事件是死路；
  真正的通路是 `PoseHub`（Host）→ `GET /dsh-avatar/pose?since=<seq>` → client 轮询 → `avatarEvents`。
  排查顺序：
  1. 浏览器 console 若出现 `/dsh-avatar/pose 404`，说明 **Host 侧装的是旧版插件**（客户端新、Host 旧），
     此时 `curl -s -o /dev/null -w '%{http_code}' <dsh-web-url>/dsh-avatar/pose` 也能复现 404。
  2. `window.__dshAvatarLog` 里应有 `baseline seq=N`，之后每次工具调用出现 `pose seq=N ...`；
     有 `pose ...` 但没有 `floating:...` 说明事件总线/组件这一层断了。
- `/dsh-avatar/pose` **必须**始终返回当前水位线（无新指令时 `commands: []`）。早期版本用 `null`
  表示「无新指令」，导致客户端在空队列时永远建不起水位线，之后到达的**第一条**指令被当成水位线吞掉。
- 指令桥用**有序队列**而不是「最新表情 + 最新动作」两个粘滞字段：后者每轮快照都带着另一个通道的旧值，
  任何一条新指令都会顺手把另一通道重播一遍。
- 一次性动作（`LoopOnce`）播完必须手动切回 `idle`，否则数字人会僵在动作最后一帧。
- 自动取景（`vrm.ts` 的 `loadModel`）有两个坑：**横向也要拟合**（画布是 220x300 竖长条，
  只按高度算会切到手臂），**视线必须落在包围盒中心**。早期写成 `lookAt(center.y + size.y * 0.08)`，
  等于把相机抬起来看，人物整体下移约 13cm，正好吃掉下边距 —— 实测脚被裁掉 12px（4% 画面）。
  现在按 `max(竖向距离, 横向距离) * 1.12` 取景，四周各留 5%~8%。
