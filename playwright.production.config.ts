import { defineConfig } from '@playwright/test'
import base from './playwright.config'
export default defineConfig({
  ...base,
  webServer: {
    command:'npm run preview -- --host 127.0.0.1 --port 4175 --strictPort',
    url:'http://127.0.0.1:4175',
    reuseExistingServer:false,
  },
  use:{...base.use,baseURL:'http://127.0.0.1:4175'},
})
