import { createClientFilesHandler } from './handler.ts'
Deno.serve(createClientFilesHandler({env:(name:string)=>Deno.env.get(name),fetch}))
