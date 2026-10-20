import { useEffect } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { VoiceAgent } from '../accessibility/VoiceAgent'
import { Icon, type IconName } from './Icon'

const LINKS: { to: string; label: string; icon: IconName }[] = [
  { to: '/', label: 'My books', icon: 'book' },
  { to: '/help', label: 'Help', icon: 'help' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
]

export function Layout() {
  const { pathname } = useLocation()

  // In a single-page app nothing announces a page change. Move focus to the new page's
  // heading so screen-reader and keyboard users start from the top of the new content.
  useEffect(() => {
    const heading = document.querySelector<HTMLElement>('main h1')
    if (heading) {
      heading.tabIndex = -1
      heading.focus({ preventScroll: true })
      document.title = `${heading.textContent} - Accessible Audiobook`
    }
    window.scrollTo(0, 0)
  }, [pathname])

  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-4 sm:px-6">
      <a className="skip-link" href="#main">Skip to main content</a>
      <header className="flex flex-wrap items-center justify-between gap-3 py-4">
        <NavLink to="/" className="flex items-center gap-2 text-xl font-bold text-fg no-underline">
          <span className="text-accent"><Icon name="book" size="1.8rem" /></span>
          Accessible Audiobook
        </NavLink>
        <nav aria-label="Main">
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            {LINKS.map((link) => (
              <li key={link.to}>
                <NavLink to={link.to} end className={({ isActive }) => `btn btn-quiet ${isActive ? 'border-accent' : ''}`}>
                  <Icon name={link.icon} />
                  {link.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main id="main" tabIndex={-1} className="flex-1 pb-10 outline-none">
        <VoiceAgent><Outlet /></VoiceAgent>
      </main>
      <footer className="border-t-2 border-line py-4 text-muted">
        HCI research prototype. <NavLink to="/evaluation">Researcher evaluation dashboard</NavLink>
      </footer>
    </div>
  )
}
