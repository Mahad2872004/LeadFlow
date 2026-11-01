import { useId, useRef, useState } from 'react'
interface TagSelectProps {
  label: string
  values: string[]
  onChange: (values: string[]) => void
  /** Fixed choices: only these can be picked. */
  options?: { value: string; label: string }[]
  /** Suggestions for free text: anything else can be typed and added with Enter or a comma. */
  suggestions?: string[]
  max?: number
  placeholder?: string
  describedBy?: string
}
/** A searchable multi-select (fixed options) or tag input (free text with suggestions), usable with the keyboard. */
export function TagSelect({label,values,onChange,options,suggestions=[],max=25,placeholder,describedBy}:TagSelectProps){
  const [query,setQuery]=useState(''),[open,setOpen]=useState(false),[active,setActive]=useState(0)
  const input=useRef<HTMLInputElement>(null),listId=useId()
  const labelOf=(value:string)=>options?.find(option=>option.value===value)?.label??value
  const pool=options??suggestions.map(value=>({value,label:value}))
  const typed=query.trim().toLowerCase()
  const matches=pool.filter(option=>!values.includes(option.value)&&(!typed||option.label.toLowerCase().includes(typed)||option.value.toLowerCase().includes(typed))).slice(0,30)
  const full=values.length>=max
  function add(value:string){
    const clean=value.trim().replace(/\s+/g,' ')
    if(!clean||full||values.includes(clean))return
    if(options&&!options.some(option=>option.value===clean))return
    onChange([...values,clean]);setQuery('');setActive(0)
  }
  const remove=(value:string)=>onChange(values.filter(item=>item!==value))
  return <div className="tag-select">
    <div className="tag-select-box" onClick={()=>input.current?.focus()}>
      {values.map(value=><span key={value} className="tag-chip">{labelOf(value)}<button type="button" aria-label={`Remove ${labelOf(value)} from ${label}`} onClick={event=>{event.stopPropagation();remove(value)}}>×</button></span>)}
      <input ref={input} role="combobox" aria-label={label} aria-expanded={open&&matches.length>0} aria-controls={listId} aria-autocomplete="list" aria-describedby={describedBy}
        aria-activedescendant={open&&matches[active]?`${listId}-${active}`:undefined} value={query} disabled={full} placeholder={full?`Up to ${max}`:values.length?'':placeholder??(options?'Search…':'Type and press Enter')}
        onFocus={()=>setOpen(true)} onBlur={()=>{setOpen(false);if(!options&&query.trim())add(query)}}
        onChange={event=>{const text=event.target.value;if(!options&&text.includes(',')&&!/\d,\d/.test(text)){text.split(',').forEach(add);return}setQuery(text);setOpen(true);setActive(0)}}
        onKeyDown={event=>{
          if(event.key==='ArrowDown'){event.preventDefault();setOpen(true);setActive(index=>Math.min(index+1,matches.length-1))}
          else if(event.key==='ArrowUp'){event.preventDefault();setActive(index=>Math.max(index-1,0))}
          else if(event.key==='Enter'){event.preventDefault();if(open&&matches[active]&&(options||typed&&matches[active].label.toLowerCase().startsWith(typed)))add(matches[active].value);else if(!options)add(query)}
          else if(event.key==='Escape'){setOpen(false)}
          else if(event.key==='Backspace'&&!query&&values.length)remove(values[values.length-1])
        }}/>
    </div>
    {open&&matches.length>0&&<ul className="tag-select-list" role="listbox" id={listId} aria-label={`${label} options`}>
      {matches.map((option,index)=><li key={option.value} id={`${listId}-${index}`} role="option" aria-selected={index===active} className={index===active?'active':undefined}
        onMouseDown={event=>{event.preventDefault();add(option.value)}} onMouseEnter={()=>setActive(index)}>{option.label}</li>)}
    </ul>}
  </div>
}
