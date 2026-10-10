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
9. **浮层拖拽要按「人物本体」夹取，不是按画布方框**（2026-10-06 修两次）：`position: fixed`
   的坐标就是视口像素。第一版写成 `left ∈ [-WIDTH+60, innerWidth-60]`，能把人推出窗口；
   改成按方框贴边后又太紧 —— 画布 220×300 而站立人物只有约 74px 宽（取景要竖着装下 1.68m，
   横向必然留大片透明），方框贴边时人看着还差 70 多像素。现在：`AvatarController` 在待机姿势
   生效后把蒙皮包围盒投影到画布像素，量出透明边距 `padding`（注意 SkinnedMesh 的 `boundingBox`
   有缓存，量之前要置 null 才会按当前姿势重算），`src/client/drag.ts` 的 `clampToViewport()`
   据此允许空画布溢出、但保证人物本体不出视口；`resize` 后重新夹取。verify 有对应断言
   （人可贴四边 + 人物本体永不越界，padding=0 时退化为整框留内）。
10. **待机素材要单独先加载**：内置动作合计约 3.6MB，其中 `Body Block.vrma` 2.6MB（还是
   FBX2glTF 产的 JSON glTF，buffer 是 base64 data-URI，比二进制更胖）且排在清单第一个；
   早年 `loadAnimations` 串行全下完才播待机 —— 每次打开页面/切资产，人物先在 bind pose
   举着手站几秒。现在：待机素材（`pickIdleMotion` 选出的）阻塞加载并立刻播，其余动作走
   `planMotionLoad()` 拆出来并行后台拉；网络并行、`createVRMAnimationClip` 排串行队列
   （它会往 `vrm.scene` 里加 `VRMLookAtQuaternionProxy`，并发绑定会打架）。
   后台加载期间到达的 play_motion 靠 `pendingMotion` 补播，判据从「clips 为空」改成
   「这个 clip 还没到」（`motionsLoading`）。日志：`controller:idle:…:ms=`、
   `controller:motions:loaded=n/N:ms=`。
11. **待机素材的表情通道会和工具表情抢**：`idle_stand` 自带 `blink` / `blinkLeft` / `oh` / `sad`
   权重轨道（外加 lookAt 轨道，所以眨眼/视线本来就是素材给的，别再写第二个眨眼驱动器），
   mixer 每帧都会把这些通道写回素材的值 → `set_expression('sorrow'|'blink'|'oh')` 下一帧就被
   静默覆盖（VRM1↔VRM0 名字重叠：sad↔sorrow、oh↔o、blinkLeft↔blink_l）。渲染顺序因此改成
   `mixer.update → reassertExpression() → vrm.update`：工具表情永远压得住素材表情，
   顺带消掉了「表情慢一帧」。verify 会交叉校验素材的表情通道在模型上都有对应 blend shape。

## 验证

`npm run verify:bridge` 是权威验证：真实加载 lib/index.js + lib/client.js、真实 HTTP、真实工具
注册，断言覆盖：pose 链路三条 + 资产导入/切换/删除 → enum 热更新 + 右栏 tab 两阶段注册
（含「宿主无 sidebarRightTabs 时静默降级」与「apply 全程无 console.error」）+ 动作 URL 形状契约
（info 发 `{name,builtin}`、`assetNames`/`motionUrl` 归一、真实 200、旧写法 404）+ 待机素材阈值
（循环接缝/胯部位移）+ 拖拽夹取不越界 + 待机素材的表情通道在模型上可绑 + 动作加载计划
（待机单独先加载）。改 `pose.ts`/`tools.ts`/`client/*` 之后必跑。CI（.github/workflows/ci.yml）
在 push/PR 上跑 `npm ci && build && typecheck && verify:bridge`。client 侧的
ctx 替身（`makeClientCtx`）刻意复刻了 Cordis proxy 的两条语义（未 inject 直读抛错、
`ctx.inject` 回调拿到子 ctx），改动莫削弱它，否则第 6 条那个 bug 在验证里就看不出来了。

## 遗留/注意

- 桌面端 profile 与 web profile 各有一份 link 安装；改完 lib/ 两个宿主都要重启才生效。
  **只改了 client 半部（lib/client.js）时可先刷新页面/重开窗口**，宿主仍缓存旧 client bundle 时才重启。
- 管理页 tab 不会自动弹出：右栏引导页（座位条上的「+」/guide tab）里点「数字人资产管理」才打开。
- 待机动作看不着时先看 `window.__dshAvatarLog`：`controller:idle:source=<素材|procedural>:tracks=N:unbound=M:face=…:faceUnbound=K:ms=T`
  —— `unbound>0` 模型缺骨骼、`faceUnbound>0` 模型的 blend shape 对不上素材的表情通道、
  `source=procedural` 说明待机素材没加载成功；`controller:motions:loaded=n/N` 是后台动作的进度。
- 本机跑 `npm ci` 会失败（`~/.npm` 里有 root 属主的缓存文件，旧版 npm 遗留）：用
  `npm ci --cache "$TMPDIR/npm-cache"` 绕过，或 `sudo chown -R $(id -u):$(id -g) ~/.npm`。
  GitHub Runner 上是干净缓存，CI 不受影响。
  **注意 `npm ci` 会先删掉整个 `node_modules/`，装失败就留下「零依赖」状态**：本项目是 link 安装，
  两个宿主都按真实路径解析依赖（`lib/index.js` 的 `@deepseek-ai/schemastery` 之类），
  项目里没有 `node_modules` 时插件会直接 import 失败 → 桌面端/web 端表现为「插件打不开」、
  右栏 tab 与浮层全无。修法就是在项目里重新装依赖（`npm ci --cache "$TMPDIR/npm-cache"`），
  然后重启宿主；`node -e "import('./lib/index.js')"` 能在装完后自检是否已恢复。
- verify 每次 mkdtemp 一个临时数据目录（OS 自动清理，无残留污染）。
- 上传端点读原始 body（无 multipart）；VRMA 文件仅校验魔数，播放失败由客户端 console.warn 兜底。
- `package.json` 的 `dsh.client.inject` 只列了 locale / ui-slots（sidebar-right 由 dsh web 自带，
  不列为硬依赖）：靠 `ctx.inject` 做软依赖，缺了也只是没有管理页 tab。
