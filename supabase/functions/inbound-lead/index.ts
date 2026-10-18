import { createWebhookHandler } from './handler.ts'
Deno.serve(createWebhookHandler({env:name=>Deno.env.get(name),fetch}))
