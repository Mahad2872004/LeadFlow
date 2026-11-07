// Facts extracted from a page's HTML or from a crawler's normalized output. Pattern-based on purpose: Edge Functions have
// no DOM, and every value kept here is something a person could find in the page source. Nothing is rendered or run.
export type PageKind = 'home' | 'about' | 'services' | 'products' | 'contact' | 'pricing' | 'booking' | 'blog' | 'other'
export interface Link { url: string; text: string }
export interface Page {
  url: string; source: 'native' | 'apify'; kind: PageKind; status: number | null
  title: string; description: string; canonical: string; robotsMeta: string; lang: string; viewport: string
  h1: string[]; h2: string[]; headingOrderIssues: number
  openGraph: Record<string, string>; jsonLdTypes: string[]
  images: number; imagesMissingAlt: number
  internalLinks: Link[]; externalLinks: Link[]
  forms: number; formFields: string[]; tel: string[]; mailto: string[]; ctas: string[]
  text: string; wordCount: number
  /** Whether the HTML source was available (native fetch); crawler pages may have text only. */
  hasHtml: boolean
}

const decode = (value: string) => value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, code) => { const n = Number(code); return n > 31 && n < 65536 ? String.fromCharCode(n) : ' ' })
const clean = (value: string, max = 300) => decode(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, max)
const attr = (tag: string, name: string) => decode(tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(2).find(value => value !== undefined) ?? '').trim()
const tags = (html: string, name: string) => html.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) ?? []
function meta(html: string, key: string, by: 'name' | 'property' = 'name') {
  for (const tag of tags(html, 'meta')) if (attr(tag, by).toLowerCase() === key) return attr(tag, 'content').slice(0, 500)
  return ''
}

const kindRules: [PageKind, RegExp][] = [
  ['booking', /\b(book(ing)?|appointments?|schedul(e|ing)|reserv(e|ations?))\b/i], ['contact', /\b(contact|get-in-touch|locations?|find-us)\b/i],
  ['pricing', /\b(pricing|prices|rates|plans|fees|cost)\b/i], ['about', /\b(about|our-story|team|who-we-are)\b/i],
  ['services', /\b(services?|treatments?|what-we-do|solutions|practice-areas)\b/i], ['products', /\b(products?|shop|store|catalog|menu)\b/i],
  ['blog', /\b(blog|news|articles|insights)\b/i],
]
export function pageKind(url: string, title = ''): PageKind {
  let path = ''
  try { path = new URL(url).pathname.toLowerCase() } catch { /* not a URL */ }
  if (path === '/' || path === '' || /^\/(index\.(html?|php))?$/.test(path)) return 'home'
  const text = `${path.replace(/[/_]/g, '-')} ${title.toLowerCase().replace(/\s+/g, '-')}`
  return kindRules.find(([, pattern]) => pattern.test(text))?.[0] ?? 'other'
}
const ctaPattern = /\b(book( an?| your)? (appointment|consultation|now|online)|book now|schedule( a| an| your)? \w+|request( a| an)? (quote|appointment|consultation|call)|get( a| your)? (free )?(quote|estimate|consultation)|contact us|call (us|now|today)|free consultation|get started|buy now|shop now|order (now|online)|sign up|subscribe|start (your )?free trial)\b/i

/** Extracts page facts from HTML. Scripts, styles and comments are removed before reading text. */
export function parseHtml(html: string, pageUrl: string, status: number | null): Page {
  const base = (() => { try { return new URL(pageUrl) } catch { return null } })()
  const head = html.slice(0, 200_000)
  const body = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
  const headings = [...body.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map(match => ({ level: Number(match[1]), text: clean(match[2], 150) })).filter(heading => heading.text)
  let headingOrderIssues = 0
  headings.forEach((heading, index) => { if (index && heading.level > headings[index - 1].level + 1) headingOrderIssues++ })
  const internalLinks: Link[] = [], externalLinks: Link[] = [], tel: string[] = [], mailto: string[] = [], ctas = new Set<string>()
  const seen = new Set<string>()
  for (const match of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(`<a ${match[1]}>`, 'href'), text = clean(match[2], 120) || attr(`<a ${match[1]}>`, 'aria-label').slice(0, 120)
    if (ctaPattern.test(text)) ctas.add(text)
    if (/^tel:/i.test(href)) { const number = decodeURIComponent(href.slice(4)).replace(/[^\d+()\-\s.]/g, '').trim(); if (number && tel.length < 10 && !tel.includes(number)) tel.push(number); continue }
    if (/^mailto:/i.test(href)) { const email = decodeURIComponent(href.slice(7)).split('?')[0].trim().toLowerCase(); if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && mailto.length < 10 && !mailto.includes(email)) mailto.push(email); continue }
    if (!base || !href || /^(javascript:|#|data:)/i.test(href)) continue
    let resolved: URL
    try { resolved = new URL(href, base) } catch { continue }
    if (!/^https?:$/.test(resolved.protocol)) continue
    resolved.hash = ''
    if (seen.has(resolved.href)) continue
    seen.add(resolved.href)
    const sameSite = resolved.hostname.replace(/^www\./, '') === base.hostname.replace(/^www\./, '')
    const list = sameSite ? internalLinks : externalLinks
    if (list.length < (sameSite ? 150 : 60)) list.push({ url: resolved.href.slice(0, 400), text })
  }
  for (const match of body.matchAll(/<(button|input)\b([^>]*)>([\s\S]*?<\/button>)?/gi)) {
    const text = match[1].toLowerCase() === 'button' ? clean(match[3] ?? '', 80) : attr(match[0], 'value').slice(0, 80)
    if (ctaPattern.test(text)) ctas.add(text)
  }
  const forms = (body.match(/<form\b/gi) ?? []).length
  const formFields = [...new Set([...body.matchAll(/<(?:input|textarea|select)\b[^>]*>/gi)].map(match => {
    const tag = match[0], type = attr(tag, 'type').toLowerCase(), name = `${attr(tag, 'name')} ${attr(tag, 'id')} ${attr(tag, 'placeholder')}`.toLowerCase()
    if (type === 'email' || /e-?mail/.test(name)) return 'email'
    if (type === 'tel' || /phone|mobile/.test(name)) return 'phone'
    if (/^textarea/i.test(tag) || /message|comment|enquiry|inquiry/.test(name)) return 'message'
    if (type === 'date' || /date|time|appointment/.test(name)) return 'date'
    if (/name/.test(name)) return 'name'
    return ''
  }).filter(Boolean))]
  const images = tags(body, 'img')
  const jsonLdTypes = new Set<string>()
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const type of match[1].matchAll(/"@type"\s*:\s*(\[[^\]]*\]|"[^"]+")/g)) for (const value of type[1].matchAll(/"([^"]+)"/g)) if (jsonLdTypes.size < 20) jsonLdTypes.add(value[1].slice(0, 60))
  }
  const openGraph: Record<string, string> = {}
  for (const tag of tags(head, 'meta')) { const property = attr(tag, 'property').toLowerCase(); if (/^og:(title|description|image|type|site_name|url)$/.test(property)) openGraph[property] = attr(tag, 'content').slice(0, 300) }
  const canonical = tags(head, 'link').find(tag => attr(tag, 'rel').toLowerCase().split(/\s+/).includes('canonical'))
  const text = clean(body.replace(/<(header|nav|footer)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<(br|p|div|li|h[1-6])\b/gi, ' <$1'), 4000)
  const title = clean(head.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '', 300)
  return {
    url: pageUrl, source: 'native', kind: pageKind(pageUrl, title), status, title, description: meta(head, 'description'), canonical: canonical ? attr(canonical, 'href').slice(0, 400) : '',
    robotsMeta: meta(head, 'robots').toLowerCase(), lang: attr(html.match(/<html\b[^>]*>/i)?.[0] ?? '', 'lang').slice(0, 20), viewport: meta(head, 'viewport'),
    h1: headings.filter(heading => heading.level === 1).map(heading => heading.text).slice(0, 10), h2: headings.filter(heading => heading.level === 2).map(heading => heading.text).slice(0, 20),
    headingOrderIssues, openGraph, jsonLdTypes: [...jsonLdTypes], images: images.length, imagesMissingAlt: images.filter(tag => !/\balt\s*=/i.test(tag)).length,
    internalLinks, externalLinks, forms, formFields, tel, mailto, ctas: [...ctas].slice(0, 15), text, wordCount: text ? text.split(' ').length : 0, hasHtml: true,
  }
}

/** A crawler page (text and metadata, no HTML) in the same shape. Unknown values stay empty, never guessed. */
export function pageFromCrawler(item: { url: string; title: string; description: string; canonical: string; lang: string; openGraph: Record<string, string>; text: string; status: number | null }): Page {
  const text = item.text.replace(/\s+/g, ' ').trim().slice(0, 4000)
  return { url: item.url, source: 'apify', kind: pageKind(item.url, item.title), status: item.status, title: item.title.slice(0, 300), description: item.description.slice(0, 500),
    canonical: item.canonical.slice(0, 400), robotsMeta: '', lang: item.lang.slice(0, 20), viewport: '', h1: [], h2: [], headingOrderIssues: 0, openGraph: item.openGraph, jsonLdTypes: [],
    images: 0, imagesMissingAlt: 0, internalLinks: [], externalLinks: [], forms: 0, formFields: [], tel: [], mailto: [], ctas: [...new Set(text.match(new RegExp(ctaPattern.source, 'gi')) ?? [])].slice(0, 15),
    text, wordCount: text ? text.split(' ').length : 0, hasHtml: false }
}

// Technologies and communication tools, each recognized by a public signature in the HTML or response headers.
export interface Detection { name: string; category: 'cms' | 'ecommerce' | 'analytics' | 'marketing' | 'chat' | 'booking' | 'framework' | 'hosting' | 'messaging'; signature: string; url: string }
const signatures: [string, Detection['category'], RegExp][] = [
  ['WordPress', 'cms', /wp-content\/|wp-includes\/|<meta[^>]+generator[^>]+WordPress/i], ['Wix', 'cms', /static\.wixstatic\.com|wix-bolt|_wixCssImports/i],
  ['Squarespace', 'cms', /static1\.squarespace\.com|squarespace-cdn\.com/i], ['Webflow', 'cms', /data-wf-page|webflow\.js|assets\.website-files\.com/i],
  ['Drupal', 'cms', /Drupal\.settings|\/sites\/default\/files\/|<meta[^>]+generator[^>]+Drupal/i], ['Joomla', 'cms', /<meta[^>]+generator[^>]+Joomla|\/media\/jui\//i],
  ['Ghost', 'cms', /<meta[^>]+generator[^>]+Ghost/i], ['GoDaddy Website Builder', 'cms', /img\d*\.wsimg\.com/i], ['Duda', 'cms', /irp\.cdn-website\.com|dudaone/i],
  ['HubSpot CMS', 'cms', /hs-sites\.com|\.hubspotusercontent/i], ['Framer', 'cms', /framerusercontent\.com|framer\.com\/m\//i],
  ['Shopify', 'ecommerce', /cdn\.shopify\.com|Shopify\.theme/i], ['WooCommerce', 'ecommerce', /woocommerce/i], ['BigCommerce', 'ecommerce', /cdn\d*\.bigcommerce\.com/i],
  ['Magento', 'ecommerce', /Magento_|mage\/cookies/i], ['Square Online', 'ecommerce', /square\.site|squarecdn\.com/i],
  ['Google Tag Manager', 'analytics', /googletagmanager\.com\/gtm\.js/i], ['Google Analytics', 'analytics', /googletagmanager\.com\/gtag\/js|google-analytics\.com\/(analytics|ga)\.js/i],
  ['Meta Pixel', 'analytics', /connect\.facebook\.net\/[^"']+\/fbevents\.js/i], ['Hotjar', 'analytics', /static\.hotjar\.com/i], ['Microsoft Clarity', 'analytics', /clarity\.ms\/tag/i],
  ['HubSpot', 'marketing', /js\.hs-scripts\.com|js\.hsforms\.net|js\.hs-analytics\.net/i], ['Mailchimp', 'marketing', /chimpstatic\.com|list-manage\.com/i],
  ['Klaviyo', 'marketing', /static\.klaviyo\.com/i], ['ActiveCampaign', 'marketing', /trackcmp\.net|activehosted\.com/i], ['Salesforce Pardot', 'marketing', /pi\.pardot\.com/i],
  ['Intercom', 'chat', /widget\.intercom\.io|js\.intercomcdn\.com/i], ['Drift', 'chat', /js\.driftt\.com/i], ['Tawk.to', 'chat', /embed\.tawk\.to/i],
  ['Zendesk Chat', 'chat', /static\.zdassets\.com|v2\.zopim\.com/i], ['LiveChat', 'chat', /cdn\.livechatinc\.com/i], ['Crisp', 'chat', /client\.crisp\.chat/i],
  ['Tidio', 'chat', /code\.tidio\.co/i], ['HubSpot Chat', 'chat', /js\.usemessages\.com/i], ['Facebook Messenger chat', 'chat', /xfbml\.customerchat|facebook\.com\/[^"']*\/plugins\/customerchat/i],
  ['Calendly', 'booking', /calendly\.com\//i], ['Acuity Scheduling', 'booking', /acuityscheduling\.com/i], ['Square Appointments', 'booking', /squareup\.com\/appointments|book\.squareup\.com/i],
  ['Setmore', 'booking', /setmore\.com/i], ['SimplyBook.me', 'booking', /simplybook\.(me|it)/i], ['Booksy', 'booking', /booksy\.com/i], ['Fresha', 'booking', /fresha\.com/i],
  ['Zocdoc', 'booking', /zocdoc\.com/i], ['OpenTable', 'booking', /opentable\.com/i], ['Resy', 'booking', /resy\.com/i], ['Mindbody', 'booking', /mindbodyonline\.com/i],
  ['Vagaro', 'booking', /vagaro\.com/i], ['Jane App', 'booking', /janeapp\.com/i], ['NexHealth', 'booking', /nexhealth\.com/i],
  ['WhatsApp link', 'messaging', /wa\.me\/|api\.whatsapp\.com\/send|whatsapp:\/\/send/i],
  ['Next.js', 'framework', /__NEXT_DATA__|\/_next\/static\//], ['Nuxt', 'framework', /__NUXT__|\/_nuxt\//], ['Gatsby', 'framework', /___gatsby/], ['Angular', 'framework', /ng-version=/],
  ['React', 'framework', /data-reactroot|react-dom(\.production)?(\.min)?\.js/i], ['Vue.js', 'framework', /data-v-[0-9a-f]{8}|vue(\.runtime)?(\.min)?\.js/i], ['jQuery', 'framework', /jquery(-\d[\d.]*)?(\.min)?\.js/i],
]
export function detectTechnologies(html: string, url: string, headers: Record<string, string>): Detection[] {
  const found: Detection[] = []
  for (const [name, category, pattern] of signatures) {
    const match = html.match(pattern)
    if (match) found.push({ name, category, signature: match[0].slice(0, 80), url })
  }
  const server = headers.server ?? '', powered = headers['x-powered-by'] ?? ''
  if (/cloudflare/i.test(server)) found.push({ name: 'Cloudflare', category: 'hosting', signature: `server: ${server.slice(0, 60)}`, url })
  if (/^Vercel$/i.test(server)) found.push({ name: 'Vercel', category: 'hosting', signature: `server: ${server}`, url })
  if (/Netlify/i.test(server)) found.push({ name: 'Netlify', category: 'hosting', signature: `server: ${server}`, url })
  if (/PHP/i.test(powered)) found.push({ name: 'PHP', category: 'framework', signature: `x-powered-by: ${powered.slice(0, 60)}`, url })
  return found
}
const socialHosts: [string, RegExp][] = [['Facebook', /(^|\.)facebook\.com$/], ['Instagram', /(^|\.)instagram\.com$/], ['LinkedIn', /(^|\.)linkedin\.com$/], ['X (Twitter)', /(^|\.)(twitter|x)\.com$/],
  ['YouTube', /(^|\.)youtube\.com$|(^|\.)youtu\.be$/], ['TikTok', /(^|\.)tiktok\.com$/], ['Pinterest', /(^|\.)pinterest\.[a-z.]+$/], ['Google Business', /(^|\.)(g\.page|maps\.app\.goo\.gl)$|google\.com\/maps/]]
/** Social profile links found on the pages, by network. Share buttons ("sharer", "intent") are ignored. */
export function socialProfiles(pages: Page[]) {
  const found = new Map<string, string>()
  for (const page of pages) for (const link of page.externalLinks) {
    let host = ''
    try { host = new URL(link.url).hostname.toLowerCase() } catch { continue }
    if (/sharer|share\?|intent\/|\/share\b/i.test(link.url)) continue
    const network = socialHosts.find(([, pattern]) => pattern.test(host) || pattern.test(link.url))?.[0]
    if (network && !found.has(network)) found.set(network, link.url)
  }
  return [...found].map(([network, url]) => ({ network, url }))
}
