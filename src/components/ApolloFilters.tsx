import { filterGroups, filtersFor, unsupportedFilters, type FilterDefinition, type FilterValue, type FilterValues, type SearchKind } from '../lib/apollo'
import { describeValue, isEmptyFilter as isEmpty } from '../lib/apolloFilters'
import { TagSelect } from './TagSelect'
type Range = { min?: number | string; max?: number | string }
interface FiltersProps { kind: SearchKind; filters: FilterValues; onChange: (filters: FilterValues) => void }
export function ApolloFilters({kind,filters,onChange}:FiltersProps){
  const definitions=filtersFor(kind)
  const set=(key:string,value:FilterValue|undefined)=>{const next={...filters};if(value===undefined||isEmpty(value))delete next[key];else next[key]=value;onChange(next)}
  const chosen=definitions.filter(definition=>!isEmpty(filters[definition.key]))
  const countIn=(group:string)=>definitions.filter(definition=>definition.group===group&&!isEmpty(filters[definition.key])).length
  return <div className="ap-filters">
    <div className="ap-filters-head"><h3>Filters</h3>{chosen.length>0&&<button type="button" className="text-button" onClick={()=>onChange({})}>Clear all</button>}</div>
    {chosen.length>0&&<ul className="ap-chips" aria-label="Selected filters">{chosen.map(definition=><li key={definition.key} className="tag-chip"><span><strong>{definition.label}:</strong> {describeValue(definition,filters[definition.key])}</span>
      <button type="button" aria-label={`Remove ${definition.label} filter`} onClick={()=>set(definition.key,undefined)}>×</button></li>)}</ul>}
    {filterGroups.filter(group=>definitions.some(definition=>definition.group===group)).map((group,index)=><details key={group} className="ap-group" open={index===0||countIn(group)>0||undefined}>
      <summary>{group}{countIn(group)>0&&<span className="number-tag">{countIn(group)}</span>}</summary>
      {definitions.filter(definition=>definition.group===group).map(definition=><Field key={definition.key} definition={definition} value={filters[definition.key]} onChange={value=>set(definition.key,value)}/>)}
    </details>)}
    <details className="ap-group ap-unsupported"><summary>Not available through Apollo’s API</summary>
      <ul>{unsupportedFilters[kind].map(item=><li key={item.label}><strong>{item.label}</strong> — {item.reason}</li>)}</ul></details>
  </div>
}
function Field({definition,value,onChange}:{definition:FilterDefinition;value:FilterValue|undefined;onChange:(value:FilterValue|undefined)=>void}){
  const help=`ap-help-${definition.key}`
  const range=(value??{}) as Range
  const setSide=(side:'min'|'max',raw:string)=>{const next={...range};if(raw==='')delete next[side];else next[side]=definition.type==='dateRange'?raw:Number(raw);onChange(next)}
  return <div className="ap-field">
    {definition.type==='boolean'?<label className="dv-check"><input type="checkbox" checked={value===true} aria-describedby={help} onChange={event=>onChange(event.target.checked||undefined)}/>{definition.label}</label>
      :<span className="ap-label" id={`${help}-label`}>{definition.label}{definition.unit&&<span className="muted"> ({definition.unit})</span>}</span>}
    {(definition.type==='list'||definition.type==='options')&&<TagSelect label={definition.label} values={(value as string[]|undefined)??[]} onChange={values=>onChange(values)} options={definition.options}
      suggestions={definition.suggestions} max={definition.max??(definition.options?.length??25)} describedBy={help}/>}
    {definition.type==='text'&&<input className="ap-input" aria-labelledby={`${help}-label`} aria-describedby={help} maxLength={200} value={(value as string|undefined)??''} onChange={event=>onChange(event.target.value)}/>}
    {definition.type==='select'&&<select className="ap-input" aria-labelledby={`${help}-label`} aria-describedby={help} value={(value as string|undefined)??''} onChange={event=>onChange(event.target.value||undefined)}><option value="">Any</option>{definition.options!.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select>}
    {(definition.type==='range'||definition.type==='dateRange')&&<div className="ap-range">
      <input className="ap-input" type={definition.type==='dateRange'?'date':'number'} inputMode={definition.type==='range'?'numeric':undefined} aria-label={`${definition.label} from`} aria-describedby={help} placeholder="From" value={range.min??''} onChange={event=>setSide('min',event.target.value)}/>
      <span aria-hidden="true">–</span>
      <input className="ap-input" type={definition.type==='dateRange'?'date':'number'} inputMode={definition.type==='range'?'numeric':undefined} aria-label={`${definition.label} to`} aria-describedby={help} placeholder="To" value={range.max??''} onChange={event=>setSide('max',event.target.value)}/>
    </div>}
    <small id={help} className="ap-help">{definition.help}</small>
  </div>
}
