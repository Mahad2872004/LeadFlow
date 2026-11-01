import { createApolloHandler } from './handler.ts'
Deno.serve(createApolloHandler({env:name=>Deno.env.get(name),fetch}))
