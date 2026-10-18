import { createRetryHandler } from './handler.ts'
Deno.serve(createRetryHandler({env:name=>Deno.env.get(name),fetch}))
