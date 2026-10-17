import { Icon, type IconName } from './Icon'
interface MetricCardProps {label:string;value:number;hint:string;icon:IconName;accent?:boolean;onClick:()=>void}
export function MetricCard({label,value,hint,icon,accent=false,onClick}:MetricCardProps) {
  return <button className={`stat-card${accent?' stat-4':''}`} onClick={onClick} aria-label={`${label}: ${value}. View ${label.toLowerCase()}`}>
    <span>{label}<span className="stat-icon"><Icon name={icon} size={18}/></span></span>
    <strong>{value.toString().padStart(2,'0')}</strong><small>{hint}</small>
  </button>
}
