import type { AnchorHTMLAttributes } from 'react'
import { navigate } from '../lib/navigation'
/** A link to another private route that switches screens without reloading the page. */
export function AppLink({href,onClick,...props}:AnchorHTMLAttributes<HTMLAnchorElement>&{href:string}){
  return <a href={href} {...props} onClick={event=>{onClick?.(event);if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();navigate(href)}}/>
}
