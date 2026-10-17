import { defineConfig, devices } from '@playwright/test'
export default defineConfig({testDir:'./tests',fullyParallel:true,use:{baseURL:'http://127.0.0.1:5175',...devices['Desktop Chrome'],channel:'msedge'},webServer:{command:'npm run dev -- --host 127.0.0.1 --port 5175 --strictPort',url:'http://127.0.0.1:5175',reuseExistingServer:!process.env.CI},reporter:'list'})

