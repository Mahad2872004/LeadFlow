import { createInquiryHandler } from './handler.ts'
Deno.serve(createInquiryHandler({env:name=>Deno.env.get(name),fetch}))
