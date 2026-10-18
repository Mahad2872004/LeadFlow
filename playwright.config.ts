import { defineConfig, devices } from '@playwright/test'
export default defineConfig({testDir:'./tests',testMatch:'m2.spec.ts',workers:1,fullyParallel:true,use:{baseURL:'http://127.0.0.1:5175',...devices['Desktop Chrome'],channel:'msedge'},webServer:{command:'npm run dev -- --host 127.0.0.1 --port 5175 --strictPort',url:'http://127.0.0.1:5175',reuseExistingServer:false,env:{VITE_SUPABASE_URL:'http://127.0.0.1:54329',VITE_SUPABASE_PUBLISHABLE_KEY:'test-public-key'}},reporter:'list'})

