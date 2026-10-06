# TODO — 待办与后续想法

> 由 2026-10-06 的几轮迭代整理。**每条都写了「为什么做 / 怎么做 / 验收标准」**，验收标准尽量落在
> `npm run verify:bridge` 的断言上，避免又出现「改完看不见效果」。
> 优先级：**P1 = 建议下一步做**，P2 = 体验/工程债，P3 = 锦上添花。
> 已有的坑与决策见 [AGENT.md](AGENT.md)，机制见 [README.md](README.md)。

---

## P1 — 建议下一步做

### 1. 「说话」口型（lip sync）
- **现状**：表情全靠大模型手动调 `set_expression`，5 秒后复位；助手在回答时嘴是不动的。
- **为什么做**：这是「AI 数字人」体感提升最大的一步 —— 让人感觉是它在说话。
- **怎么做**：
  - Host 侧确认能否拿到 assistant 的**流式文本增量**（本轮没验证，先做技术验证再动手）；
  - 把文本节奏转成口型包络（按字符/音节给 `a/i/u/e/o` 权重，句读处归零），走 PoseHub 新通道；
  - 客户端在渲染循环里驱动口型（模型有 `a,i,u,e,o` 五个口型 blend shape；注意别和
    `idle_stand` 自带的 `oh` 通道打架 —— 工具/口型优先级要高于素材，见 AGENT 第 11 条的做法）；
  - config 加开关，默认开；不可用时静默降级。
- **验收**：`verify` 断言口型通道可达 + 模拟一次「说话」后端到端收到；人工看：说话时嘴在动、停下回中性。

### 2. 状态反应（思考中 / 工具执行 / 报错）
- **现状**：只有大模型主动调工具才有反应；跑长工具时数字人毫无变化。
- **怎么做**：Host 把「工具开始 / 结束 / 报错」映射成轻量表情或动作，复用现有 expression/motion 通道；
  做成可关的开关（避免吵）。
- **验收**：跑一次带工具调用的回合，数字人有对应反应且待机不被破坏；关掉开关后无反应。

### 3. 显示/隐藏开关 + 位置记忆
- **现状**：位置 `pos` 只在内存里，**刷新就回右下角**；也没有隐藏数字人的入口。
- **怎么做**：位置写 localStorage（键带模型名）；隐藏状态也持久化；入口放在右栏管理页
  （「显示数字人」开关）+ 浮层双击回默认位置。
- **验收**：拖动后刷新位置保持；隐藏后刷新仍隐藏。

---

## P2 — 体验与工程债

### 4. 交互区收到「人」身上（现在透明区会吃点击）
- **现状**：浮层 `pointerEvents: 'auto'` 覆盖整块 220×300 画布，压在界面上的大片透明区会挡住下层按钮。
- **条件**：我们**已经量出人物本体的像素矩形**（`controller:padding:l=…:r=…:t=…:b=…`，见
  [src/client/vrm.ts](src/client/vrm.ts) 的 `measurePadding()`），只差拿来做命中测试。
- **怎么做**：外层 `pointer-events: none`，只在人物本体内（由 padding 算出的矩形）开启；顺带双击复位。
- **验收**：点透明区不拦下层 UI，点人能拖；verify 里对「由 padding 推出的命中矩形」加纯函数断言。

### 5. 待机动作可选 + 持久化
- **现状**：只能靠 `window.__dshAvatarIdle = { motion, gain, … }` 在 console 调，刷新即失效。
- **怎么做**：右栏管理页加「待机动作」下拉（列出所有 idle* 素材）+ 幅度滑杆，写 `state.json`；
  客户端从 `/dsh-avatar/info` 读配置。
- **验收**：管理页切换后立即生效、重启后仍生效。

### 6. 配置面收口
- **现状**：[src/config.ts](src/config.ts) 只有 `modelPath` / `modelUrl`；画布尺寸 (220×300)、
  MARGIN、默认角落、表情复位时间 (5s)、调试日志都硬编码。
- **怎么做**：用 schemastery 定义完整 schema（尺寸/角落/待机素材/复位时间/debug），
  在 dsh 的插件配置里可改；`window.__dshAvatar*` 只留作调试逃生口。
- **验收**：改 dsh 配置能生效；README 记录各字段。

### 7. 调试日志开关 + 日志不无限增长
- **现状**：`playMotion` / `playExpression` 每次都 `console.log`；`window.__dshAvatarLog` 是**无上限数组**。
- **怎么做**：加 `debug` 开关（默认关）；`__dshAvatarLog` 改成环形缓冲（如最近 200 条）。
- **验收**：默认控制台干净；开启后能看到完整链路。

### 8. 组件级测试（jsdom）
- **现状**：verify 覆盖协议层与纯函数；[AssetManagerPanel.tsx](src/client/AssetManagerPanel.tsx) 与
  [AvatarFloating.tsx](src/client/AvatarFloating.tsx) 的交互没有测试。
- **怎么做**：加 jsdom 测试：管理页导入/切换/删除会打对端点、失败会显示错误；浮层拖拽夹取走 padding。
- **验收**：`npm test` 在 CI 里跟着 verify 一起跑。

### 9. 轮询 → 事件推送
- **现状**：客户端 **400ms 轮询** `/dsh-avatar/pose?since=<seq>`，永久轮询。
- **怎么做**：换成 SSE（dsh web 本身有 SSE 通路），指令到达即推；保留轮询做降级。
- **验收**：指令延迟 < 100ms；无指令时不再有周期性请求。

### 10. verify 覆盖面补齐
- **现状**：4 个内置动作（`Body Block` / `Praying` / `elbow_punch` / `sitting_laughing`）是
  **FBX2glTF 产的 JSON glTF**（buffer 是 base64 data-URI），只被列入清单，没做解析/绑定校验；
  现在只校验了 GLB 形式的 `idle_stand.vrma`。
- **怎么做**：把 JSON 形式的 VRMA 也纳入「骨骼数 / 循环接缝 / 胯部位移」那组断言。
- **验收**：四种素材格式任一损坏都会让 verify 失败。

---

## P3 — 锦上添花

### 11. 视线跟随鼠标
- **现状**：`idle_stand` 自带 lookAt 轨道，但 nuomi.vrm 的 VRM 扩展里**没有 lookAt 段**。
- **怎么做**：先实测（three-vrm 会给默认 applier）；不行就给模型补 lookAt 配置或走骨骼方案。
- **验收**：鼠标移动时视线跟随且不扭曲脖子。

### 12. 待机多样性
- **现状**：待机是 `idle_stand` 的 12.1s 循环，长时间看会看出是循环。
- **怎么做**：在 `idle_stand` / `idle` 之间随机切换，或每隔 N 轮插一次小动作
  （可从 GitHub 再取 1–2 条待机/张望类素材，**务必按 [ATTRIBUTION.md](assets/animations/ATTRIBUTION.md) 记录来源与许可**）。
- **验收**：连续观察 2 分钟不出现明显重复节拍。

### 13. 「说话口型」的进阶：情绪 + 语气
- 在第 1 条之上，按回答情绪（`joy` / `sorrow` / `angry`）叠加表情，不做也不影响主链路。

---

## 已知限制 / 需要确认

- `Body Block.vrma` **2.6MB**（JSON + base64 data-URI）：转成二进制 GLB 能瘦约 25%（base64 → 二进制），
  属于素材优化，不影响逻辑。
- 上游待机素材的**原始 mocap 出处**仓库未注明（Beerware 覆盖仓库本身），商业再分发前需核实。
- 本机 `npm ci` 会因 `~/.npm` 存在 root 属主缓存文件而失败：用
  `npm ci --cache "$TMPDIR/npm-cache"` 绕过。GitHub Runner 不受影响。

---

## 已完成（对照，别重复提）

- **右栏 tab 不生效** → 服务改用 `ctx.inject` 软依赖；`apply()` 拆三段各自兜底。
- **动作全 404** → `/dsh-avatar/info` 的 `animations` 形状归一（`src/client/assets.ts`）。
- **待机「呆」** → 换真实素材 `idle_stand.vrma`，原样播放。
- **待机「飘」** → 锁胯部位移，不再程序化驱动胯部。
- **拖拽越界 / 拖不到边** → 按「人物本体」（运行时量出的透明边距）夹取。
- **待机迟到** → 待机素材单独先加载并立刻播，其余动作并行后台拉。
- **工具表情被素材表情覆盖** → 渲染顺序 `mixer → reassertExpression → vrm.update`。
- **回归防护** → `verify:bridge` 断言 + GitHub Actions CI。
