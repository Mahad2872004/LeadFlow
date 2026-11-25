import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'

// Small motion helpers for the marketing site. Everything here respects prefers-reduced-motion: callers get the final,
// static state and no timers run.

export const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** True while the element is at least `threshold` visible. Without IntersectionObserver it is always true. */
export function useInView(ref: RefObject<Element | null>, threshold = 0.3) {
  const [inView, setInView] = useState(() => typeof window === 'undefined' || !('IntersectionObserver' in window))
  useEffect(() => {
    const node = ref.current
    if (!node || !('IntersectionObserver' in window)) return
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold })
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref, threshold])
  return inView
}

const spotTargets = '.mk-card, .mk-use, .mk-method, .mk-demo, .mk-sec-grid article, .mk-index a, .mk-solution, .mk-fact'

/** A soft light that follows the pointer across cards. Only on devices that hover, and never with reduced motion. */
export function useSpotlight(root: RefObject<HTMLElement | null>, path: string) {
  useLayoutEffect(() => {
    const element = root.current
    if (!element || !window.matchMedia?.('(hover: hover) and (prefers-reduced-motion: no-preference)').matches) return
    let frame = 0
    let last: PointerEvent | null = null
    const paint = () => {
      frame = 0
      const target = last && (last.target as Element | null)?.closest?.<HTMLElement>(spotTargets)
      if (!last || !target) return
      const box = target.getBoundingClientRect()
      target.style.setProperty('--mx', `${last.clientX - box.left}px`)
      target.style.setProperty('--my', `${last.clientY - box.top}px`)
    }
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return
      last = event
      if (!frame) frame = requestAnimationFrame(paint)
    }
    element.addEventListener('pointermove', onMove, { passive: true })
    return () => { element.removeEventListener('pointermove', onMove); cancelAnimationFrame(frame) }
  }, [root, path])
}
