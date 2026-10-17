import {test,expect} from '@playwright/test'
import {isData,loadData,STORAGE_KEY} from '../src/lib/storage'
import {sampleData} from '../src/lib/seed'
import {dateLabel} from '../src/lib/format'

test('invalid stored identities, relationships and field values are rejected without writes',()=>{
 const sample=sampleData()
 expect(isData(sample)).toBe(true)
 const invalid=[
  {...sample,leads:[...sample.leads,sample.leads[0]]},
  {...sample,tasks:[...sample.tasks,sample.tasks[0]]},
  {...sample,activities:[...sample.activities,sample.activities[0]]},
  {...sample,activities:[{...sample.activities[0],leadId:'missing'}]},
  {...sample,tasks:[{...sample.tasks[0],leadId:'missing'}]},
  {...sample,tasks:[{...sample.tasks[0],notes:' '}]},
  {...sample,leads:[{...sample.leads[0],name:' '}]},
  {...sample,leads:[{...sample.leads[0],status:'Unknown'}]},
  {...sample,leads:[{...sample.leads[0],createdAt:'Oct 18, 2026'}]},
 ]
 for(const data of invalid){
  expect(isData(data)).toBe(false)
  const raw=JSON.stringify(data)
  let writes=0
  const result=loadData({getItem:key=>key===STORAGE_KEY?raw:null,setItem:()=>{writes++}})
  expect(result.error).toContain('has not been overwritten')
  expect(writes).toBe(0)
 }
 expect(dateLabel('2027-01-02')).toContain('2027')
})

test('short mobile viewport supports editing long content, validation, and persisted completion',async({page})=>{
 await page.setViewportSize({width:320,height:568})
 await page.goto('/')
 await page.getByLabel('View Olivia Bennett').click()
 await page.getByRole('button',{name:'Edit lead',exact:true}).click()
 await page.getByLabel('Company (optional)').fill('X'.repeat(150))
 await page.getByLabel('Message (optional)').fill('M'.repeat(2000))
 await page.getByRole('button',{name:'Save changes'}).click()
 await expect(page.getByRole('dialog')).toContainText('X'.repeat(150))
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
 await page.getByRole('button',{name:'Add follow-up',exact:false}).click()
 await page.getByLabel('Notes *').fill('Mobile audit follow-up')
 await page.getByRole('button',{name:'Schedule follow-up'}).click()
 await page.getByRole('dialog').getByLabel('Complete Mobile audit follow-up').check()
 await page.getByLabel('Close dialog').click()
 await page.reload()
 await page.getByLabel('View Olivia Bennett').click()
 await expect(page.getByRole('dialog').getByLabel('Reopen Mobile audit follow-up')).toBeChecked()
 await expect(page.getByRole('dialog')).toContainText('Follow-up completed: Mobile audit follow-up')
 await page.screenshot({path:'test-results/audit-mobile-detail.png',fullPage:true})
})

test('contact links, timeline navigation, skip link and form backdrop behavior',async({page})=>{
 await page.goto('/')
 await expect(page.getByRole('heading',{name:'Pipeline snapshot'})).toBeVisible()
 await page.keyboard.press('Tab')
 await expect(page.getByRole('link',{name:'Skip to content'})).toBeFocused()
 await page.keyboard.press('Enter')
 await expect(page.locator('#main-content')).toBeFocused()
 await page.getByRole('navigation').getByRole('button',{name:'Activity',exact:true}).click()
 await page.getByRole('list',{name:'Activity timeline'}).getByRole('button',{name:'Ethan Park',exact:true}).click()
 await expect(page.getByRole('dialog',{name:'Ethan Park',exact:true})).toBeVisible()
 await expect(page.getByRole('link',{name:'ethan@example.com'})).toHaveAttribute('href','mailto:ethan@example.com')
 await page.getByRole('button',{name:'Edit lead',exact:true}).click()
 await page.getByLabel('Phone (optional)').fill('+1 555 010 1234')
 await page.getByRole('button',{name:'Save changes'}).click()
 await expect(page.getByRole('link',{name:'+1 555 010 1234',exact:true})).toHaveAttribute('href','tel:+1 555 010 1234')
 await page.getByLabel('Close dialog').click()
 await page.getByRole('button',{name:'Add lead',exact:false}).click()
 const form=page.getByRole('dialog',{name:'Capture a new lead'})
 await form.click({position:{x:4,y:4}})
 await expect(form).toBeVisible()
 await page.mouse.click(2,2)
 await expect(form).toHaveCount(0)
})

