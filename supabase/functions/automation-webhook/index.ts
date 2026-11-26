import { createAutomationWebhookHandler } from './handler.ts'
Deno.serve(createAutomationWebhookHandler({env:name=>Deno.env.get(name),fetch}))
