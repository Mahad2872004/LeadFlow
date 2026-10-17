import { useEffect, useState } from 'react'
import { localDate } from '../lib/dates'
/** Refresh at local midnight and on return from a sleeping/background tab. */
export function useLocalDay() {
  const [day,setDay]=useState(localDate)
  useEffect(()=>{
    let timer:ReturnType<typeof setTimeout>
    function refresh(){
      setDay(localDate())
      clearTimeout(timer)
      const now=new Date()
      const midnight=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1)
      timer=setTimeout(refresh,midnight.getTime()-now.getTime()+25)
    }
    refresh()
    window.addEventListener('focus',refresh)
    document.addEventListener('visibilitychange',refresh)
    return ()=>{clearTimeout(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh)}
  },[])
  return day
}
