/**
 * Fence 余量不变量：本构建"创建的语料版本"与"能理解的上限"必须同号。
 *
 * WHY：doctor §1 报"已在上限（余量 0）"本身是稳态，不是缺陷——真正的危险是
 * **只改一边**：把 `CORPUS_SCHEMA_VERSION` 提到 96 并写迁移，却把
 * `MEMORY_SCHEMA_MAX_VERSION` 留在 95。新装机（或已迁移的库）schema 变 v96 后，
 * fence 会把整条写路径降级为只读（memory-write.ts `corpusFenced` 分支），
 * 而且是**静默的**：没有 error 行，只在每次写调用返回 ok:false。
 *
 * 这条用例把这个不变量钉在 CI 上，所以 doctor 的那行提示可以只作信息行——
 * "下一次迁移会让写路径降级只读"不再依赖人记得同步。
 */
import { describe, expect, it } from 'vitest'
import { CORPUS_SCHEMA_VERSION } from '../src/core/corpus-store.ts'
import { MEMORY_SCHEMA_MAX_VERSION } from '../src/core/memory-bridge.ts'

describe('corpus fence invariant', () => {
  it('pins create-version === understand-ceiling so a one-sided bump cannot silently fence the writer', () => {
    expect(CORPUS_SCHEMA_VERSION).toBe(MEMORY_SCHEMA_MAX_VERSION)
  })

  it('keeps the own-lineage base: a corpus this build knows is never older than the store it creates', () => {
    // 反向断言：上限低于创建版本会让"刚建的库自己就超限"——那是最荒诞的一种失配。
    expect(MEMORY_SCHEMA_MAX_VERSION).toBeGreaterThanOrEqual(CORPUS_SCHEMA_VERSION)
  })
})
