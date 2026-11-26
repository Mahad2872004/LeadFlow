import { createClientHubHandler } from './handler.ts'
Deno.serve(createClientHubHandler({env:(name:string)=>Deno.env.get(name),fetch}))
