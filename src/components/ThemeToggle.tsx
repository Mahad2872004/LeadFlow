import { Icon } from './Icon'
import { setPreference, useTheme } from '../lib/theme'

/** Switches between light and dark. The command menu also offers "Match system theme". */
export function ThemeToggle({ className = 'theme-toggle' }: { className?: string }) {
  const { theme } = useTheme()
  const next = theme === 'dark' ? 'light' : 'dark'
  return <button type="button" className={className} aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`} onClick={() => setPreference(next)}>
    <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17}/>
  </button>
}
