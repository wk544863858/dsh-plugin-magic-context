/**
 * baseline 缓存前缀稳定性 —— mc-acceptance 的 `delta.byteStable` 的唯一实现。
 *
 * 判据要回答的问题是：同载荷的两次 baseline，前缀字节为什么会变？只有**没有解释的**
 * 字节漂移才算不稳定（FAIL）。实证（2026-10-15，552 条 baseline / 518 对相邻事件）
 * 补全了三类解释，缺任何一条都会在真实运维里给出假 FAIL：
 *
 *  1. **mode 不同**（hard rebuild / soft refresh）。两种 mode 组装的 m[0] block 不是
 *     同一个东西：`rendered` / `newRows` 随 hard 归零（src/dsh/management-pass.ts:620、
 *     :626），即 hard 渲染全量、soft 只渲染增量；`bytes` 又是 block 的长度
 *     （management-pass.ts:630）。跨 mode 比字节等于比两种渲染，不是比"同载荷稳定"。
 *     2026-10-15 16:00:00→18:00:01（35231≠31410，reason=route-changed，载荷四段全等）
 *     就是这一形态 —— 它让 gate 红了一个窗口期。
 *  2. 期间有 `newRows>0` 的 memory-recall：载荷本身被新记忆改写。
 *  3. 期间有 `drop-landed`：落地 drop 是记录在案的、有意的前缀重写。窗口必须是
 *     **闭区间 [prev.at, b.at]** —— 落地与 HARD rebuild 常在同一秒（2026-10-15
 *     16:00:00 九条 drop 与 baseline 同秒），开区间会漏掉这条解释。
 *
 * 载荷比对含 `profile` 段：soft refresh 只渲染**新增**画像行，漏比 profile 会把
 * "画像渲染变了"误判成无解释漂移（同一份 24h 窗口里就有这种对）。
 */

/** The payload segments a baseline freezes. `profile` was missing until 2026-10-15. */
const PAYLOAD_KEYS = ['memories', 'memoryUpdates', 'compartments', 'profile']

/** True when two baseline events froze the same payload (field-by-field JSON equality). */
export function sameBaselinePayload(a, b) {
  return PAYLOAD_KEYS.every(key => JSON.stringify(a?.[key]) === JSON.stringify(b?.[key]))
}

/**
 * Compare every pair of *adjacent* baselines inside one session.
 *
 * @param {{ baselines: readonly BaselineRow[], recalls?: readonly RecallRow[], drops?: readonly DropRow[] }} input
 *   `baselines` in time order; `recalls` carry the `newRows` count of a memory-recall
 *   row; `drops` are `drop-landed` journal rows (both session-scoped).
 * @returns {{ pairs: number, violations: readonly Violation[] }} pairs = 相邻对总数（判据覆盖面）
 */
export function findByteInstabilities(input) {
  const baselines = input.baselines ?? []
  const recalls = input.recalls ?? []
  const drops = input.drops ?? []

  const bySession = new Map()
  for (const row of baselines) {
    if (!bySession.has(row.sid)) bySession.set(row.sid, [])
    bySession.get(row.sid).push(row)
  }

  const violations = []
  let pairs = 0
  for (const [sid, list] of bySession) {
    let prev
    for (const row of list) {
      if (prev !== undefined) {
        pairs += 1
        const sameMode = (prev.d?.mode ?? null) === (row.d?.mode ?? null)
        const recalled = recalls.some(r => r.sid === sid && Number(r.newRows) > 0 && r.at > prev.at && r.at <= row.at)
        const landed = drops.some(d => d.sid === sid && d.at >= prev.at && d.at <= row.at)
        const fromBytes = Number(prev.d?.bytes)
        const toBytes = Number(row.d?.bytes)
        if (sameMode && !recalled && !landed && sameBaselinePayload(prev.d, row.d) && fromBytes !== toBytes) {
          violations.push({ sessionId: sid, fromAt: prev.at, toAt: row.at, fromBytes, toBytes, mode: row.d?.mode ?? null })
        }
      }
      prev = row
    }
  }
  return { pairs, violations }
}
