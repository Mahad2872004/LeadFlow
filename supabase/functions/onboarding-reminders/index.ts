import { createReminderHandler } from './handler.ts'
Deno.serve(createReminderHandler({env:name=>Deno.env.get(name),fetch}))
