import { defineConfig } from '@playwright/test'
import base from './playwright.config'
// Visual review of every app screen (tests/screens.spec.ts). Uses its own port so it never clashes with `npm test`.
const port = process.env.SCREENS_PORT ?? '5176'
export default defineConfig({
  ...base,
  testMatch: ['screens.spec.ts'],
  outputDir: `test-results/screens-${port}`,
  use: { ...base.use, baseURL: `http://127.0.0.1:${port}`, actionTimeout: 10000 },
  webServer: { ...(base.webServer as object), command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}` },
})
