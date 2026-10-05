# dsh-avatar

DSH（DeepSeek Harness）生态插件：住在侧边栏的 AI 数字人。

纯表现层——VRM 形象渲染 + 大模型通过工具驱动表情与动作，不涉及人格、记忆、字幕等业务逻辑。与 nuomi 项目思想对齐，但代码独立全新（nuomi 冻结不动）。

## 能力

- **侧边栏常驻**：打开 dsh web 任意会话后，右栏自动出现「数字人」tab（常驻区）。
- **表情**：大模型调用 `set_expression`（enum 来自当前 VRM 模型的 blend shapes），数字人 5 秒后自动复位。
- **动作**：大模型调用 `play_motion`（enum 来自 `assets/animations/` 目录动态扫描），播放 VRMA 动作，idle 循环待机。
- **手动导入动作**：往 `assets/animations/` 放入 `.vrma` 文件（重启插件后自动进入工具清单），即插即用。

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
    index.tsx       # client 插件：tab 注册与打开、session/event → 表情/动作事件
    AvatarPanel.tsx # 数字人面板（React）
    vrm.ts          # three.js + @pixiv/three-vrm(-animation) 渲染与播放控制器
    event-bus.ts    # 内部事件总线
assets/
  models/           # VRM 模型
  animations/       # VRMA 动作
```

## 实现要点（踩坑记录）

- client bundle 必须是 `__ModuleLoader__` CJS 格式（ESM 会被浏览器拒绝）。
- 右栏 tab 栏只显示「已打开」的 tab：注册类型后需调 `ctx.sidebarRight.openTab(kind)`，且要等会话 surface 挂载（轮询重试）。
- esbuild 需 `jsx: 'automatic'`（否则生成 `React.createElement` 而 bundle 里没有 React 全局）。
- VRMA 解析用 `gltf.userData.vrmAnimations[0]`（复数），不是 `vrmAnimation`。
