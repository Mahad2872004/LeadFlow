import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import '@fontsource/instrument-serif/latin-400-italic.css'
import { marketingPages, type MarketingPath } from './content'
import { Glyph } from './Glyph'
import { Brand, CTA, FAQs, FinalCTA, Intro, TextLink } from './shared'
import { primaryLabel } from './access'
import { useSpotlight } from './motion'
import { ThemeToggle } from '../components/ThemeToggle'
import Home from './Home'
import { Features, Integrations, Pricing, Solutions } from './Pages'
import { Resources, Security } from './Guides'
import './Marketing.css'

const copyrightYear = new Date().getFullYear()
const nav = [['/features', 'Features'], ['/integrations', 'Integrations'], ['/solutions', 'Solutions'], ['/pricing', 'Pricing'], ['/resources', 'Resources']]

/** Fades sections in as they scroll into view. Skipped entirely when the visitor prefers reduced motion. */
function useReveal(root: RefObject<HTMLDivElement | null>, path: string) {
  useLayoutEffect(() => {
    const element = root.current
    if (!element || !('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const targets = element.querySelectorAll<HTMLElement>('[data-reveal]')
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target) }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 })
    element.classList.add('mk-motion')
    targets.forEach(target => observer.observe(target))
    return () => { observer.disconnect(); element.classList.remove('mk-motion') }
  }, [root, path])
}

function FaqPage() {
  return <>
    <Intro eyebrow="FAQ" title={<>Before you begin. <em>Here’s what to know.</em></>} text="What LeadFlow does today, how to get access, and what is still ahead." />
    <section className="mk-wrap mk-section mk-section-flush">
      <div className="mk-faq-page">
        <FAQs />
        <div className="mk-faq-contact">
          <div><strong>Still have a question?</strong><p>Send it through the inquiry form and we’ll answer directly.</p></div>
          <TextLink href="/inquiry">Ask us</TextLink>
        </div>
      </div>
    </section>
  </>
}

function NotFound() {
  return (
    <Intro eyebrow="404 · PAGE NOT FOUND" title="A small detour." text="This page does not exist. Let’s get you back to the right place.">
      <div className="mk-actions mk-center"><CTA href="/">Back to LeadFlow</CTA></div>
    </Intro>
  )
}

export default function Marketing({ path }: { path: string }) {
  const [menu, setMenu] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const known = Object.hasOwn(marketingPages, path)
  const meta = known ? marketingPages[path as MarketingPath] : { title: 'Page not found — LeadFlow', description: 'Find your way back to LeadFlow.' }
  useReveal(root, path)
  useSpotlight(root, path)
  useEffect(() => {
    document.title = meta.title
    document.querySelector('meta[name="description"]')?.setAttribute('content', meta.description)
    if (window.location.hash) requestAnimationFrame(() => document.getElementById(window.location.hash.slice(1))?.scrollIntoView())
  }, [meta.title, meta.description])
  const closeMenu = () => { setMenu(false); toggle.current?.focus() }
  const page = path === '/' ? <Home /> : path === '/features' ? <Features /> : path === '/integrations' ? <Integrations /> : path === '/solutions' ? <Solutions />
    : path === '/pricing' ? <Pricing /> : path === '/resources' ? <Resources /> : path === '/security' ? <Security /> : path === '/faq' ? <FaqPage /> : <NotFound />
  return (
    <div className="marketing" ref={root}>
      <a className="mk-skip" href="#marketing-content">Skip to content</a>
      <header className="mk-header">
        <div className="mk-wrap mk-header-inner">
          <Brand />
          <button ref={toggle} type="button" className="mk-menu-toggle" aria-expanded={menu} aria-controls="marketing-navigation"
            aria-label={menu ? 'Close navigation' : 'Open navigation'} onClick={() => setMenu(!menu)}>
            <Glyph name={menu ? 'close' : 'menu'} size={20} />
          </button>
          <nav id="marketing-navigation" className={menu ? 'is-open' : ''} aria-label="Website navigation"
            onKeyDown={event => { if (event.key === 'Escape') closeMenu() }}>
            <div className="mk-nav-links">
              {nav.map(([href, label]) => <a aria-current={path === href ? 'page' : undefined} href={href} key={href}>{label}</a>)}
            </div>
            <div className="mk-nav-actions">
              <a href="/login" className="mk-signin">Sign in</a>
              <CTA small />
            </div>
          </nav>
          <ThemeToggle className="mk-theme-toggle" />
        </div>
      </header>
      <main id="marketing-content" tabIndex={-1}>
        {page}
        {known && <FinalCTA />}
      </main>
      <footer className="mk-footer">
        <div className="mk-wrap">
          <div className="mk-footer-top">
            <div className="mk-footer-brand">
              <Brand />
              <p>AI-assisted prospecting and delivery for agencies and service businesses. Find the right leads, win the work, and deliver it.</p>
            </div>
            <div className="mk-footer-col"><strong>Product</strong><a href="/features">Features</a><a href="/integrations">Integrations</a><a href="/solutions">Solutions</a><a href="/pricing">Proposed pricing</a></div>
            <div className="mk-footer-col"><strong>Learn</strong><a href="/resources">Resources</a><a href="/faq">FAQ</a><a href="/security">Security</a><a href="/inquiry">Contact</a></div>
            <div className="mk-footer-col"><strong>Your next step</strong><a href="/signup">{primaryLabel}</a><a href="/login">Sign in</a><a href="/app">Open workspace</a></div>
          </div>
          <div className="mk-footer-bottom">
            <span>© {copyrightYear} LeadFlow</span>
            <span>Product illustrations use fictional businesses and records.</span>
            <a href="#marketing-content">Back to top ↑</a>
          </div>
        </div>
      </footer>
    </div>
  )
}
