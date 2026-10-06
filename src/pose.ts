/**
 * Server → Client 指令桥。
 *
 * 为什么需要它：`session/event` 是 Host 侧 Session 服务上的 Cordis 事件，浏览器里的
 * 客户端插件**收不到**——扫遍所有 client bundle，没有任何一个把它转发到浏览器。
 * 因此「工具调用 → 数字人反应」不能靠监听会话事件，必须由插件自己建一条通路。
 *
 * 形态：工具 execute 时把指令追加进队列（每条指令一个自增 seq），浏览器侧轻量轮询、
 * 按 seq 取增量。服务端**永远**返回当前水位线，不会因为「没有新指令」而返回 null——
 * 这一点是必须的：客户端要靠首次响应里的 seq 建立水位线，如果空队列也返回 null，
 * 客户端就永远建不起水位线，之后到达的第一条指令会被当成水位线吃掉（此前已踩过）。
 *
 * 为什么是队列而不是「最新快照」：早期实现保存「最新表情 + 最新动作」两个粘滞字段，
 * 于是客户端每次轮询拿到的快照里都带着**另一个通道上次的值**，任何一条新指令都会
 * 顺手把另一通道再播一遍（例：先 bow 再 set_expression，会把 bow 重播）。
 * 队列天然没有这个副作用，也不会丢事件。
 *
 * 为什么不做会话区分：工具执行上下文里的 agent 身份并不保证可用，而客户端也不一定能
 * 读到自己的会话 id——两边一旦取到不同的键，指令就会静默丢失（这类失败已经出现过两次）。
 * 所以这里只保存一条全局指令流：客户端首次轮询只记录水位线、不重放历史，
 * 之后只要 seq 前进就按序播放。代价是多开标签页时会一起反应，对本插件的使用场景可以接受。
 */

/** 一条待播放的指令。表情与动作走同一条有序流，因此先后顺序得以保留。 */
export type PoseCommand =
  | { seq: number; kind: 'expression'; value: string }
  | { seq: number; kind: 'motion'; value: string }

/** 一次增量读取的结果：`seq` 是当前水位线（恒有值），`commands` 是水位线之后的指令。 */
export interface PoseFeed {
  /** 服务端当前最大序号；无任何指令时为 0。 */
  seq: number
  /** seq 大于请求水位线的指令，按 seq 升序。 */
  commands: PoseCommand[]
}

/** 队列保留的最大指令数；只影响「页面停留在很久以前」的极端情况。 */
const MAX_KEPT = 128

/**
 * 保存指令流并维护单调递增序号。
 *
 * 序号从 1 开始；客户端以首次读到的 seq 为水位线，因此挂载前产生的旧指令不会被重放。
 */
export class PoseHub {
  private seq = 0
  private commands: PoseCommand[] = []

  /** 记录一次指令；同一次调用里 expression / motion 各自可选，按 expression → motion 顺序入队。 */
  deliver(patch: { expression?: string; motion?: string }): void {
    if (patch.expression !== undefined) this.push('expression', patch.expression)
    if (patch.motion !== undefined) this.push('motion', patch.motion)
  }

  /**
   * 按水位线取增量。**任何情况下都返回当前水位线**（即使没有新指令），
   * 这样客户端总能在第一轮建立水位线。
   */
  read(sinceSeq: number): PoseFeed {
    return {
      seq: this.seq,
      commands: this.commands.filter(command => command.seq > sinceSeq),
    }
  }

  private push(kind: 'expression' | 'motion', value: string): void {
    this.seq += 1
    this.commands.push(kind === 'expression'
      ? { seq: this.seq, kind: 'expression', value }
      : { seq: this.seq, kind: 'motion', value })
    if (this.commands.length > MAX_KEPT) {
      this.commands.splice(0, this.commands.length - MAX_KEPT)
    }
  }
}
