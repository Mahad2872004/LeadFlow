import { createDiscoveryHandler } from './handler.ts'
Deno.serve(createDiscoveryHandler({env:name=>Deno.env.get(name),fetch}))
