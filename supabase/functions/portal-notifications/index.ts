import { createPortalNotificationsHandler } from './handler.ts'
Deno.serve(createPortalNotificationsHandler({env:(name:string)=>Deno.env.get(name),fetch}))
