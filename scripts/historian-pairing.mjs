/**
 * historian-pairing.mjs — historian start/terminal 配对判据（纯函数，只读）
 *
 * 为什么单独成文件而不是写在 acceptance 里：本仓纪律 ④「判据先自证」——
 * 一条判据只有在"人为破坏后确实报警"时才成立（tests/historian-pairing.spec.ts
 * 做正负样本对照），acceptance 只负责打印。
 *
 * 2026-10-10 22:00 巡检的教训：§6 曾用「start 后 180s 无终局 = 静默蒸发」，
 * 但真实 run 合法耗时 4-6 分钟（2 chunk × ~90s + merge LLM ~3 分钟），
 * 验收只要撞上一个正在进行的 run 就会把活 run 误报成孤儿（实测：§C6
 * start 22:00:00、done 22:05:21，验收在 22:03-22:05 之间执行 ⇒ 2 FAIL）。
 *
 * 现在的判据：**该会话最后一条 historian 行起 QUIET_GRACE 内没有任何新行**
 * 才算孤儿候选——chunk/merge 行本身就是"还在干活"的证据；merge 的单次
 * LLM 调用是最长合法安静段（实测 ≈3 分钟），15 分钟留 3 倍余量，仍在
 * 一次巡检周期内出结果。配对规则不变：同会话新 start 挤掉旧 start
 * （supersede-close，进程边界产物），done/failed 关闭；进程重启豁免
 * （start 后 15s 内有 boot）由消费方叠加。
 */

/** 孤儿候选的安静阈值：同会话最后一条 historian 行起过了这个毫秒数。 */
export const HISTORIAN_QUIET_GRACE_MS = 15 * 60_000

/**
 * 扫描 id 序 historian 行，返回每个会话仍然打开的 start。
 * 每个条目在 start 自身字段外多一个 `lastActivity`：该 run 已落盘的最后
 * 一行（start/chunk/merge）的时间戳——孤儿判定看它，不看 start.at。
 */
export function scanHistorianStarts(hist) {
  const openStarts = new Map()
  for (const h of hist) {
    const key = h.sid ?? '-'
    if (h.phase === 'start') {
      openStarts.delete(key)
      openStarts.set(key, { ...h, lastActivity: Number(h.at) })
    } else if (h.phase === 'done' || h.phase === 'failed') {
      openStarts.delete(key)
    } else if (openStarts.has(key)) {
      openStarts.get(key).lastActivity = Number(h.at)
    }
  }
  return openStarts
}

/** 安静超过 grace 的打开 start = 孤儿候选（boot 豁免由消费方叠加）。 */
export function staleOpenStarts(openStarts, now = Date.now()) {
  return [...openStarts.values()].filter((h) => now - h.lastActivity > HISTORIAN_QUIET_GRACE_MS)
}
