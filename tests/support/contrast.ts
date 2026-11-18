/**
 * In-page audit for visual review (tests/screens.spec.ts with SCREENS_AUDIT=1): finds text whose contrast against the
 * background actually rendered behind it is below 3:1, and large light surfaces (useful when checking dark mode).
 * Backgrounds are composited through translucent layers; gradients are approximated by the average of their colours.
 */
export function auditContrast(minimum = 3) {
  type RGBA = { r: number; g: number; b: number; a: number }
  const parse = (value: string): RGBA | null => {
    if (!value || value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
    const srgb = value.match(/^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)/)
    if (srgb) return { r: +srgb[1] * 255, g: +srgb[2] * 255, b: +srgb[3] * 255, a: srgb[4] === undefined ? 1 : +srgb[4] }
    const n = value.match(/[\d.]+/g)
    if (!n || n.length < 3) return null
    return { r: +n[0], g: +n[1], b: +n[2], a: n.length > 3 ? +n[3] : 1 }
  }
  const over = (top: RGBA, bottom: RGBA): RGBA => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 })
  const lum = ({ r, g, b }: RGBA) => [r, g, b].map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
  const ratio = (a: RGBA, b: RGBA) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05) }
  const gradientColour = (image: string): RGBA | null => {
    const colours = (image.match(/rgba?\([^)]*\)|color\(srgb[^)]*\)/g) ?? []).map(parse).filter((c): c is RGBA => !!c && c.a > 0)
    if (!colours.length) return null
    const avg = colours.reduce((s, c) => ({ r: s.r + c.r, g: s.g + c.g, b: s.b + c.b, a: s.a + c.a }), { r: 0, g: 0, b: 0, a: 0 })
    return { r: avg.r / colours.length, g: avg.g / colours.length, b: avg.b / colours.length, a: Math.min(1, avg.a / colours.length) }
  }
  const backgroundBehind = (element: Element): RGBA => {
    const layers: RGBA[] = []
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      const colour = parse(style.backgroundColor)
      const gradient = style.backgroundImage !== 'none' ? gradientColour(style.backgroundImage) : null
      for (const layer of [gradient, colour]) if (layer && layer.a > 0) layers.push(layer)
      if (layers.some(layer => layer.a >= .99)) break
    }
    return layers.reverse().reduce((bottom, top) => over(top, bottom), { r: 255, g: 255, b: 255, a: 1 })
  }
  const describe = (element: Element) => {
    const parts: string[] = []
    for (let node: Element | null = element; node && parts.length < 3; node = node.parentElement) parts.unshift(node.tagName.toLowerCase() + [...node.classList].slice(0, 2).map(c => '.' + c).join(''))
    return parts.join(' > ')
  }
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) return false
    let opacity = 1
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (style.visibility === 'hidden' || style.display === 'none') return false
      opacity *= +style.opacity
    }
    return opacity > .3
  }
  const lowContrast: { where: string; text: string; ratio: number; fg: string; bg: string }[] = []
  const lightSurfaces: { where: string; size: string; bg: string }[] = []
  for (const element of document.querySelectorAll('body *')) {
    if (['SCRIPT', 'STYLE', 'OPTION', 'svg', 'path'].includes(element.tagName)) continue
    const text = [...element.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent ?? '').join('').trim()
    const style = getComputedStyle(element)
    if (text.length >= 2 && visible(element)) {
      const fg = parse(style.color)
      if (fg) {
        const bg = backgroundBehind(element)
        const value = ratio(over(fg, bg), bg)
        if (value < minimum) lowContrast.push({ where: describe(element), text: text.slice(0, 40), ratio: Math.round(value * 100) / 100, fg: style.color, bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})` })
      }
    }
    const own = parse(style.backgroundColor)
    const rect = element.getBoundingClientRect()
    if (own && own.a > .5 && lum(own) > .45 && rect.width * rect.height > 4000 && visible(element)) lightSurfaces.push({ where: describe(element), size: `${Math.round(rect.width)}×${Math.round(rect.height)}`, bg: style.backgroundColor })
  }
  return { lowContrast, lightSurfaces }
}
