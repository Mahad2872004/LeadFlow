import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** True when the person asked their system for less motion. Read at call time, so a change applies to the next animation. */
export function prefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Fades and lifts an element in whenever `key` changes (a page, an opened record).
 * It runs before paint, so the content never flashes in its final place first. It animates
 * only opacity and a few pixels of movement, and does nothing under reduced motion.
 */
export function useEnterMotion(ref: RefObject<HTMLElement | null>, key: unknown, distance = 8) {
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || prefersReducedMotion() || typeof element.animate !== 'function') return
    const animation = element.animate(
      [{ opacity: 0, transform: `translateY(${distance}px)` }, { opacity: 1, transform: 'none' }],
      { duration: 280, easing: 'cubic-bezier(.2, .8, .2, 1)' },
    )
    return () => animation.cancel()
  }, [ref, key, distance])
}

/**
 * Counts a whole number up (or down) to `value` with an ease-out curve. Fractions and
 * reduced motion show the value directly. The first render counts up from zero.
 */
export function useCountUp(value: number, duration = 700) {
  const animated = Number.isInteger(value) && !prefersReducedMotion()
  const [shown, setShown] = useState(animated ? 0 : value)
  const current = useRef(shown)
  useEffect(() => {
    if (!animated) return
    const start = current.current
    if (start === value) return
    const began = performance.now()
    let frame = requestAnimationFrame(function step(now) {
      const progress = Math.min(1, (now - began) / duration)
      const next = Math.round(start + (value - start) * (1 - (1 - progress) ** 3))
      current.current = next
      setShown(next)
      if (progress < 1) frame = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(frame)
  }, [animated, value, duration])
  return animated ? shown : value
}
