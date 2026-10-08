import { expect, it } from 'vitest'
import { resolveDefineTool } from '../src/dsh/tool-bridge.ts'

// Loading-mode probe: the adapter resolves @deepseek-ai/dsh-tools dynamically,
// which vite only serves through the explicit vitest alias. Cold-transforming
// that package can take seconds under a full parallel run, hence the timeout.
it('dynamic defineTool resolves via the vitest alias', async () => {
  const defineTool = await resolveDefineTool()
  expect(typeof defineTool).toBe('function')
}, 60_000)
