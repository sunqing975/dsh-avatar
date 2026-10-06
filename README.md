# dsh-avatar

[![CI](https://github.com/sunqing975/dsh-avatar/actions/workflows/ci.yml/badge.svg)](https://github.com/sunqing975/dsh-avatar/actions/workflows/ci.yml)

DSH（DeepSeek Harness）生态插件：常驻 dsh 界面前层的 AI 数字人。

纯表现层——VRM 形象渲染 + 大模型通过工具驱动表情与动作，不涉及人格、记忆、字幕等业务逻辑。与 nuomi 项目思想对齐，但代码独立全新（nuomi 冻结不动）。

后续待办与想法见 [TODO.md](TODO.md)；已踩过的坑与当前状态见 [AGENT.md](AGENT.md)。

## 能力

- **前层常驻**：数字人悬浮在 dsh 界面右下角（`shell.overlay` 全局前层），所有页面/会话常驻可见，不占用任何 tab。
- **表情**：大模型调用 `set_expression`（enum 来自当前 VRM 模型的 blend shapes），数字人 5 秒后自动复位。
  待机素材自带的五官通道（`idle_stand` 有 `blink` / `blinkLeft` / `oh` / `sad` + lookAt 轨道）负责
  眨眼与视线，**工具表情优先**：mixer 写完权重后会再把工具表情压回 1，不会被素材的
  `blink`/`sad`/`oh` 静默覆盖（通道名重叠：sorrow↔sad、o↔oh、blink_l↔blinkLeft）。
- **动作**：大模型调用 `play_motion`（enum 来自动作清单动态扫描），播放 VRMA 动作，idle 循环待机。
- **待机先加载、不等人**：内置动作合计约 3.6MB（`Body Block.vrma` 一个就 2.6MB 且排在清单第一个），
  早年是串行全下完才播待机 —— 打开页面/切换资产时要先举着手站好几秒。现在**待机素材单独阻塞加载
  并立刻播**，其余动作并行扔后台（网络并行、绑定骨骼串行，避免并发动 vrm），期间到达的
  `play_motion` 指令先挂起、加载完补播。日志：`controller:idle:…:ms=` 与 `controller:motions:loaded=n/N:ms=`。
- **待机用真实动作，且不会「飘」**：待机优先使用内置的 `idle_stand.vrma`
  （真实录制的站立待机，51 骨骼 / 12.1s / 循环接缝 0.68°，来源见
  [assets/animations/ATTRIBUTION.md](assets/animations/ATTRIBUTION.md)），按
  `idle_stand → idle → 程序化兜底` 的顺序挑素材，**原样播放**（默认 `gain: 1`，不做程序化加减）。
  - 早先的做法（程序化给胯部加位移/摆动）已废弃：没有 IK 补偿时胯部一动整条腿连脚一起动，
    看起来就是「整个人在地上飘」。现在默认**锁掉素材的胯部位移轨道**（只保留旋转），
    角色必然站在原处。
  - 素材全部缺失时才退化为纯程序化待机：只驱动上半身（呼吸/点头/重心左右摆）+ 手臂垂下，
    **完全不碰胯部**。
  - console 调参（刷新生效）：
    ```js
    window.__dshAvatarIdle = { motion: ['idle_stand'], gain: 1.5, lockHipsTranslation: true, procedural: false }
    ```
    想看诊断：`window.__dshAvatarLog` 里的 `controller:idle:source=…:tracks=…:unbound=…`。
- **可拖拽，且拖到边就是「人」贴边**：浮层按住即可拖。夹取按**人物本体**算，而不是按
  220×300 的画布方框 —— 站立的人物只有约 74px 宽（其余是透明空边），若按方框贴边，
  看上去会「离边框还差 70 多像素就拖不动了」。运行时会把当前姿势的蒙皮包围盒投影到画布，
  量出透明边距（`controller:padding:l=…:r=…:t=…:b=…`），据此允许空画布溢出视口、
  但人物本体始终完整留在窗口内；窗口缩放后会重新夹取。
- **资产管理页（右侧边栏 tab「数字人」）**：
  - 导入 VRM 模型 / VRMA 动作（文件直传，即传即用）；
  - 多模型列表 + 一键切换，导入的模型自动成为当前模型；
  - 删除用户导入的资产（内置资产不可删）；
  - 任何变更后工具参数（`set_expression` / `play_motion` 的 enum）**运行时热更新**，无需重启；
  - 数字人浮层自动重载新模型/动作，拖拽位置不重置。
- **手动导入动作（旧方式）**：往 `assets/animations/` 放入 `.vrma` 文件（重启插件后自动进入工具清单），即插即用。新方式（管理页导入）写入用户数据目录，升级插件不丢失。

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
  index.ts          # host 插件：HTTP 端点（模型/动作/info/pose/upload/select-model/delete）+ 工具热更新
  tools.ts          # set_expression / play_motion 工具定义
  assets-registry.ts# 资产注册表：内置 assets/ + 用户数据目录合并、当前模型持久化、导入/删除
  model-info.ts     # GLB blend shapes 解析
  config.ts         # 配置 schema
  client/
    index.tsx       # client 插件：shell.overlay 注册、右栏管理页 tab、session/event → 表情/动作事件
    AvatarFloating.tsx # 数字人常驻浮层（React + canvas），资产变更自动重载
    AssetManagerPanel.tsx # 管理页（右栏 tab）：导入/切换/删除 VRM 与 VRMA
    vrm.ts          # three.js + @pixiv/three-vrm(-animation) 渲染与播放控制器
    event-bus.ts    # 内部事件总线
assets/
  models/           # 内置 VRM 模型
  animations/       # 内置 VRMA 动作
scripts/
  build.mjs         # esbuild 双产物构建
  verify-bridge.mjs # 工具调用 → 数字人 的端到端链路验证（含资产导入/热更新）
```

### HTTP 端点

| 端点 | 方法 | 说明 |
|---|---|---|
| `/dsh-avatar/model.vrm` | GET | 当前生效的模型（用户目录优先于内置） |
| `/dsh-avatar/animations/<name>.vrma` | GET | 动作文件（用户目录优先于内置） |
| `/dsh-avatar/assets/<rel>` | GET | 内置 assets 静态资源（防路径穿越） |
| `/dsh-avatar/info` | GET | 资产清单 + 当前模型 + blend shapes + 带版本戳的 modelUrl |
| `/dsh-avatar/pose?since=<seq>` | GET | 指令桥水位线（表情/动作指令增量） |
| `/dsh-avatar/upload?kind=model\|motion&name=<文件名>` | POST | 上传 VRM/VRMA（body 为原始 GLB 字节），成功后工具热更新 |
| `/dsh-avatar/select-model` | POST | 切换当前模型，body `{"name":"<模型名>"}` |
| `/dsh-avatar/delete?kind=model\|motion&name=<资产名>` | POST | 删除用户导入资产 |

### 用户数据目录

导入的资产与当前模型状态存在 dsh 用户数据目录（GitHub/npm 安装也可写，升级不丢）：

```
<dshHome>/dsh-avatar/
  models/        # 用户导入的 VRM
  animations/    # 用户导入的 VRMA
  state.json     # 当前模型名
```

`<dshHome>` 默认 `~/.dsh`（可用 `DSH_HOME` 覆盖）；测试/开发可用 `DSH_AVATAR_DATA_DIR` 指到任意目录。
同名冲突：用户文件优先于内置文件，删除用户文件后内置资产自动恢复。

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
- **工具参数热更新**：`ctx.tools.register()` 返回「恰好卸载该工具的 disposer」——先调用旧
  disposer 再用新 enum 重新注册即可，无需重启。同层同名重复注册会 throw，所以必须先卸载再注册。
  卸载在插件 dispose 时同样生效（`ctx.effect(() => () => {...})`）。
- **同一 canvas 重载数字人不能 new 新 AvatarController**：`dispose()` 里 `renderer.forceContextLoss()`
  会永久丢弃该 canvas 的 WebGL context，之后新 renderer 拿到的是坏 context。资产变更后应调用
  `controller.reload()`（保留 renderer/camera/灯光，只重建模型与动作，见 `vrm.ts` 的 `resetResources`）。
- **defineTool 编译后 parameters 是标准 JSON Schema**：enum 在 `parameters.properties.<name>.enum`，
  不是 `parameters.<name>.enum`（调试工具清单时按前者取）。
- **client 插件读别的插件提供的服务必须用 `ctx.inject([...], cb)`**：Cordis 只把「本插件 inject
  过的名字」解析进 fiber，未 inject 的属性读会被 proxy 直接 `throw`（`cannot get property "X"
  without inject`），**可选链 `?.` 挡不住 throw**。直读 `ctx.sidebarRightTabs` 曾导致右栏 tab
  不出现，而且异常被 apply 的大 try/catch 吞掉后连 pose 轮询也没注册（症状：tab 没有 + 工具能调、
  数字人不动）。现在 `apply()` 拆成浮层/指令链路/管理页三段各自兜底，tab 走 `ctx.inject` 软依赖，
  宿主没装 sidebar-right 时静默降级。
- **`/dsh-avatar/info` 的 `animations` 是 `[{name, builtin}]`，不是字符串数组**：浮层若直接
  `encodeURIComponent(entry)` 会把对象变成 `%5Bobject%20Object%5D`，每个动作 URL 都 404，
  `clips` 全空（连 idle 都没有）→ 数字人停在 bind pose、双臂平举发僵，工具动作也一并失效。
  归一化集中在 `src/client/assets.ts`（`assetNames` / `motionUrl`），改 info 字段形状记得同步。
- **上传文件校验**：VRM/VRMA 都是 GLB 容器，仅校验前 4 字节 `glTF` 魔数与大小上限
  （模型 128MB / 动作 64MB）；模型 blend shapes 解析失败时 `set_expression` 不注册并告警。
  上传端点读原始 body（`req` 流拼接），不引入 multipart 解析。
