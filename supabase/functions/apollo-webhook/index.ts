import { createApolloWebhookHandler } from './handler.ts'
Deno.serve(createApolloWebhookHandler({env:name=>Deno.env.get(name),fetch}))
