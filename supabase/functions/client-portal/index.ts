import { createPortalHandler } from './handler.ts'
Deno.serve(createPortalHandler({env:name=>Deno.env.get(name),fetch}))
