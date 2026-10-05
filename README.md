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
dsh plugin add github:sunqing975/dsh-avatar
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
npm run build        # esbuild 构建 host(lib/index.js) + client(lib/client.js)
npm run typecheck    # 双 tsconfig 类型检查
```

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
```

## 实现要点（踩坑记录）

- client bundle 必须是 `__ModuleLoader__` CJS 格式（ESM 会被浏览器拒绝）。
- 数字人挂载在 `shell.overlay`（root scope 全局前层），无需会话即可显示；该层默认 click-through，组件需 `pointerEvents: auto`。
- esbuild 需 `jsx: 'automatic'`（否则生成 `React.createElement` 而 bundle 里没有 React 全局）。
- VRMA 解析用 `gltf.userData.vrmAnimations[0]`（复数），不是 `vrmAnimation`。
