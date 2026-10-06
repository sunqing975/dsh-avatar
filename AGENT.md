# dsh-avatar 项目记忆（AGENT）

面向未来接手此项目的 agent。README 讲机制，本文件讲「当前状态 + 决策 + 坑」的增量记录。

## 项目定位

DSH 生态插件（`dsh plugin add` 安装）：常驻 dsh 界面前层的 AI 数字人，纯表现层。
宿主机型：**DeepSeek Harness 桌面端（desktop profile）与 dsh web（web profile）都 link 安装本项目**
（`~/.dsh/profiles/{desktop,web}/node_modules/dsh-avatar` → `/Users/superman/projects/code/dsh-avatar`），
改动代码后**必须重启宿主进程**才能加载新 lib/。

## 当前架构（2026-10-06 状态）

- Host（`src/index.ts`）：7 个 HTTP 端点（model.vrm / animations / assets / info / pose / upload /
  select-model / delete）+ 2 个工具（set_expression / play_motion），启动时与资产变更时热注册工具。
- 资产注册表（`src/assets-registry.ts`）：内置 `assets/` + 用户数据目录 `<dshHome>/dsh-avatar/`
  （默认 `~/.dsh/dsh-avatar`，`DSH_AVATAR_DATA_DIR` 可覆盖，verify 用它指临时目录）。
  用户文件优先于内置；state.json 持久化当前模型；上传仅校验 GLB 魔数 + 大小上限。
- Client（`src/client/`）：shell.overlay 浮层（常驻）+ 右侧边栏 tab「数字人」管理页
  （`sidebarRightTabs` 类型注册 + `sidebar.right.pane.tab` 正文 slot，id=`dsh-avatar-assets`）。
  资产变更经 event-bus 的 `assets-changed` 触发浮层 `controller.reload()`。
- 待机动作（`src/client/idle-motion.ts`）：优先用真实素材 `assets/animations/idle_stand.vrma`
  （来自 darkkaze/ai-librarian-avatar 的 `idle2.vrma`，Beerware，见 assets/animations/ATTRIBUTION.md），
  顺序 `idle_stand → idle → 程序化兜底`；**原样播放**（默认 `gain: 1`），默认**锁掉胯部位移轨道**
  （`lockHipsTranslation`）防「飘」；素材全缺时才退化为纯程序化上半身待机（不碰胯部）。
  console 调参：`window.__dshAvatarIdle = { motion, gain, lockHipsTranslation, procedural, amp }`。

## 关键决策与坑（新增）

1. **工具参数热更新** = `ctx.tools.register()` 的 disposer 先卸载再重注册；同层同名重复注册 throw。
2. **同 canvas 重载数字人必须走 `AvatarController.reload()`**（保留 renderer/camera/灯光，只重建
   模型/动作）：`dispose()` 的 `forceContextLoss()` 会永久弄坏该 canvas 的 WebGL context，
   new 新 controller 会拿到坏 context。
3. defineTool 编译后 parameters 是标准 JSON Schema，enum 在 `parameters.properties.<name>.enum`。
4. 模型 URL 带 mtime 版本戳（`/dsh-avatar/model.vrm?v=<mtimeMs>`）防浏览器缓存旧模型。
5. 管理页写操作成功后先 `emitAssetsChanged()` 再刷新清单，顺序不能反（否则浮层重载拉到旧 info）。
6. **client 侧读「别的插件提供的服务」必须走 `ctx.inject([...], cb)`，不能直读**
   （2026-10-06 修「右栏 tab 不生效」时踩到）：Cordis 只会把**本插件 inject 过**的服务解析进
   fiber 的 store，未 inject 的属性读取会被 context proxy 的 get trap 直接
   `throw new Error('cannot get property "X" without inject')`——**可选链 `?.` 挡不住 throw**。
   `ctx.sidebarRightTabs?.register(...)` 因此必然抛错，而当时的 apply 只有一个大 try/catch，
   异常被吞掉后**后面注册的 pose 轮询也一起没跑**，症状是「tab 没出现 + 工具能调、数字人不动」。
   正确写法见 `registerAssetTab()`：`ctx.inject(['sidebarRightTabs'], (tabCtx) => …)`，
   服务可用才跑回调、宿主没装该服务时回调永不执行（天然降级），回调里的 ctx 才直读得到服务。
   另外 `apply()` 已拆成三段各自 `safe()` 兜底，任何一段失败不再拖垮另外两段。
7. **`/dsh-avatar/info` 的 `animations` 是 `AssetRef[]`（`{name, builtin}`），不是字符串数组**
   （2026-10-06 修「数字人没有待机动作、双臂平举发僵」时踩到）：资产注册表上线后 Host 改了形状，
   浮层仍按裸字符串 `encodeURIComponent(entry)` → URL 变成
   `/dsh-avatar/animations/%5Bobject%20Object%5D.vrma` → **每个动作都 404**，`clips` 全空
   （含 idle）→ 模型停在 bind pose，工具动作也一并失效。归一化集中在 `src/client/assets.ts`
   （`assetName/assetNames/motionUrl`），`vrm.ts` 的 `loadAnimations`/`reload` 是唯一入口，
   返回 `AssetEntry` 容错类型；verify 固化了这条契约：info 形状 + 动作 URL 真实 200 +
   旧写法复现 404。**改 info 的字段形状必跑 verify。**
8. **待机不要程序化驱动胯部**（2026-10-06 修「整个人飘起来」时踩到）：没有 IK/脚部补偿时，
   胯部的位移或摆动会带着整条腿和脚一起动 —— ±12mm 上下 + ±3° roll 就足以让角色看起来
   在地面飘/滑。现在的原则：待机**直接用真实素材**（真实待机自带脚部补偿），并默认
   `lockHipsTranslation` 丢掉胯部位移轨道；纯程序化兜底只驱动上半身。verify 有对应断言
   （默认 clip 不得含 `hips.position`；兜底 clip 不得含任何 hips 轨道；`idle_stand.vrma`
   自身循环接缝 <1.5°、胯部起伏 <2cm、水平位移 <5cm）。
9. **浮层拖拽要夹在视口内**（2026-10-06 修「能拖到窗口外」）：`position: fixed` 的坐标就是视口
   像素，边界要按「整个浮层完整可见」算 —— 早先写成 `left ∈ [-WIDTH+60, innerWidth-60]`、
   `top ∈ [0, innerHeight-60]`，等于允许大半个人被推出窗口。现在统一走
   `src/client/drag.ts` 的 `clampToViewport()`（`0 ≤ left ≤ max(0, innerWidth - WIDTH)`，
   视口比浮层小时退化为贴左上），并在 `resize` 后重新夹取。verify 有纯函数断言。

## 验证

`npm run verify:bridge` 是权威验证：真实加载 lib/index.js + lib/client.js、真实 HTTP、真实工具
注册，断言覆盖：pose 链路三条 + 资产导入/切换/删除 → enum 热更新 + 右栏 tab 两阶段注册
（含「宿主无 sidebarRightTabs 时静默降级」与「apply 全程无 console.error」）+ 动作 URL 形状契约
（info 发 `{name,builtin}`、`assetNames`/`motionUrl` 归一、真实 200、旧写法 404）+ 待机素材阈值
（循环接缝/胯部位移）+ 拖拽夹取不越界。改 `pose.ts`/`tools.ts`/`client/*` 之后必跑。client 侧的
ctx 替身（`makeClientCtx`）刻意复刻了 Cordis proxy 的两条语义（未 inject 直读抛错、
`ctx.inject` 回调拿到子 ctx），改动莫削弱它，否则第 6 条那个 bug 在验证里就看不出来了。

## 遗留/注意

- 桌面端 profile 与 web profile 各有一份 link 安装；改完 lib/ 两个宿主都要重启才生效。
  **只改了 client 半部（lib/client.js）时可先刷新页面/重开窗口**，宿主仍缓存旧 client bundle 时才重启。
- 管理页 tab 不会自动弹出：右栏引导页（座位条上的「+」/guide tab）里点「数字人资产管理」才打开。
- 待机动作看不着时先看 `window.__dshAvatarLog` 的 `controller:idle:base=vrma|procedural:tracks=N:unbound=M`：
  `unbound>0` 说明模型缺骨骼/轨道名不匹配；`base=procedural` 说明 idle.vrma 没加载成功。
- verify 每次 mkdtemp 一个临时数据目录（OS 自动清理，无残留污染）。
- 上传端点读原始 body（无 multipart）；VRMA 文件仅校验魔数，播放失败由客户端 console.warn 兜底。
- `package.json` 的 `dsh.client.inject` 只列了 locale / ui-slots（sidebar-right 由 dsh web 自带，
  不列为硬依赖）：靠 `ctx.inject` 做软依赖，缺了也只是没有管理页 tab。
