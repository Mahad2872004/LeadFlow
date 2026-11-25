import { useId } from 'react'
import { Icon, type IconName } from './Icon'
import { useCountUp } from '../hooks/useMotion'

interface MetricCardProps {
  label: string; value: number; hint: string; icon: IconName; accent?: boolean
  /** Values to draw as a sparkline, oldest first. */
  trend?: number[]
  /** A share between 0 and 1, drawn as a meter. */
  meter?: number
  onClick: () => void
}

function Sparkline({ values }: { values: number[] }) {
  const id = `spark${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const width = 120, height = 34, max = Math.max(1, ...values)
  const points = values.map((value, index) => [index * (width / Math.max(1, values.length - 1)), height - 3 - (value / max) * (height - 8)])
  const line = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  return <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <defs><linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".28"/><stop offset="1" stopColor="currentColor" stopOpacity="0"/></linearGradient></defs>
    <path d={`${line} L${width} ${height} L0 ${height} Z`} fill={`url(#${id})`}/>
    <path d={line} fill="none" stroke="currentColor" strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round"/>
  </svg>
}

export function MetricCard({ label, value, hint, icon, accent = false, trend, meter, onClick }: MetricCardProps) {
  const shown = useCountUp(value)
  return <button className={`stat-card${accent ? ' stat-4' : ''}`} onClick={onClick} aria-label={`${label}: ${value}. View ${label.toLowerCase()}`}>
    <span className="stat-head">{label}<span className="stat-icon"><Icon name={icon} size={18}/></span></span>
    <span className="stat-body">
      <strong>{shown}</strong>
      {trend && trend.length > 1 && <Sparkline values={trend}/>}
      {meter !== undefined && <span className="stat-meter" aria-hidden="true"><i style={{ width: `${Math.round(Math.min(1, Math.max(0, meter)) * 100)}%` }}/></span>}
    </span>
    <small>{hint}</small>
  </button>
}
