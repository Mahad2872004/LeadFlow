import { useEffect, useId, useRef, type ReactNode } from 'react'
export function Modal({title,children,onClose,id}:{title:string;children:ReactNode;onClose:()=>void;id?:string}) {
  const ref=useRef<HTMLDialogElement>(null)
  const opener=useRef<HTMLElement|null>(null)
  const titleId=useId()
  useEffect(()=>{
    const dialog=ref.current
    if(!opener.current&&document.activeElement instanceof HTMLElement)opener.current=document.activeElement
    dialog?.showModal()
    return ()=>{dialog?.close();if(opener.current?.isConnected)opener.current.focus()}
  },[])
  return <dialog id={id} aria-labelledby={titleId} ref={ref} onCancel={event=>{event.preventDefault();onClose()}} onKeyDown={event=>{
    if(event.key!=='Tab')return
    const elements=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]')).filter(element=>element.getClientRects().length>0)
    const first=elements[0],last=elements[elements.length-1]
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}
  }} onClick={event=>{
    if(event.target!==event.currentTarget) return
    const bounds=event.currentTarget.getBoundingClientRect()
    if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom) onClose()
  }}><div className="modal-head"><h2 id={titleId}>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog">✕</button></div>{children}</dialog>
}
