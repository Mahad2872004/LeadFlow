import { activity, today, type Data, type Status } from './model'
export function sampleData(): Data {
  const people: [string,string,string,Status,string][] = [
    ['Olivia Bennett','Juniper Studio','Website design','New','Referral'],
    ['Ethan Park','Northstar Goods','Web development','Qualified','Website'],
    ['Amara Okafor','Bloom & Co.','Brand identity','Contacted','LinkedIn'],
    ['Noah Rivera','Forma Architecture','Website design','Converted','Referral'],
    ['Sofia Chen','Kindred Coffee','Web development','New','Website'],
    ['Luca Martin','Fieldwork Labs','Consulting','Qualified','LinkedIn'],
    ['Isla Brooks','Papertrail Press','Brand identity','Lost','Other'],
    ['Arjun Mehta','Evergreen Supply','Website design','Contacted','Website'],
  ]
  const leads=people.map(([name,company,service,status,source],i)=>({id:`sample-${i}`,name,company,service,status,source,email:`${name.split(' ')[0].toLowerCase()}@example.com`,phone:'',message:'Fictional demo inquiry. Interested in discussing a project and next steps.',createdAt:new Date(Date.now()-i*86400000).toISOString()}))
  return {version:1,leads,tasks:[{id:'task-1',leadId:'sample-1',due:today(),notes:'Share the website proposal and project timeline',completed:false},{id:'task-2',leadId:'sample-2',due:today(),notes:'Check in on the brand discovery brief',completed:false},{id:'task-3',leadId:'sample-5',due:today(),notes:'Schedule a discovery call',completed:false}],activities:leads.map(l=>activity(l.id,'Fictional sample lead added'))}
}

