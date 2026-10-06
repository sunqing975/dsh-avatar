# 动作素材来源与许可（ATTRIBUTION）

内置 VRMA 动作里，有一部分来自第三方开源仓库，许可以下逐条列明。**重新分发本项目时请保留本文件。**

| 内置文件 | 来源 | 许可 |
|---|---|---|
| `idle_stand.vrma` | [darkkaze/ai-librarian-avatar](https://github.com/darkkaze/ai-librarian-avatar) → `animation_service/animations/idle2.vrma` | Beerware License (Revision 42) |
| `idle.vrma` / `bow.vrma` / `Praying.vrma` / `Body Block.vrma` / `elbow_punch.vrma` / `sitting_laughing.vrma` | 项目早期自带（来源见 git 历史） | 待确认；若要再分发请自行核实 |

## idle_stand.vrma 的用途

数字人待机循环（`src/client/idle-motion.ts` 的默认素材，优先级 `idle_stand → idle → 程序化兜底`）。
它在运行时被**锁掉胯部位移轨道**（只保留旋转），避免整个人连同脚一起平移造成「飘」。

## Beerware License (Revision 42)

```
THE BEER-WARE LICENSE (Revision 42)

Kaze (https://ko-fi.com/darkkaze) created this project. As long as you
retain this notice you can do whatever you want with this stuff. If we
meet some day, and you think this stuff is worth it, you can buy me a
beer (or a coffee) in return.
```

> 说明：该仓库以 Beerware 授权整个项目（含 `animation_service/animations/` 下的 VRMA）。
> 上游动画素材的原始出处（是否来自 Mixamo 等 mocap 库）仓库中未注明；如需商业再分发请自行评估。
