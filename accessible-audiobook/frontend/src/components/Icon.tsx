/** Decorative icons. They are always hidden from assistive technology: the text label carries the meaning. */
const PATHS = {
  play: <path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none" />,
  pause: <><rect x="5.5" y="4.5" width="4.5" height="15" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="4.5" width="4.5" height="15" rx="1" fill="currentColor" stroke="none" /></>,
  stop: <rect x="5.5" y="5.5" width="13" height="13" rx="2" fill="currentColor" stroke="none" />,
  mic: <><rect x="9" y="2.5" width="6" height="11.5" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5M8.5 21.5h7" /></>,
  micOff: <><path d="M9 9V5.5a3 3 0 0 1 6 0V11M15 14a3 3 0 0 1-5.2-.2M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.4 2.3M12 18v3.5M8.5 21.5h7M3 3l18 18" /></>,
  back: <><path d="M11.5 18.5 3 12l8.5-6.5zM21 18.5 12.5 12 21 5.5z" fill="currentColor" stroke="none" /></>,
  forward: <><path d="M12.5 18.5 21 12l-8.5-6.5zM3 18.5 11.5 12 3 5.5z" fill="currentColor" stroke="none" /></>,
  repeat: <path d="M4 12a8 8 0 0 1 13.7-5.7L20 8.5M20 3.5v5h-5M20 12a8 8 0 0 1-13.7 5.7L4 15.5M4 20.5v-5h5" />,
  book: <path d="M12 6.5C10 5 7 4.5 3.5 4.5v14c3.5 0 6.5.5 8.5 2 2-1.5 5-2 8.5-2v-14c-3.5 0-6.5.5-8.5 2zM12 6.5v14" />,
  bookmark: <path d="M6.5 3.5h11v17L12 16.5l-5.5 4z" />,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.3 9.3a2.8 2.8 0 0 1 5.4 1c0 2-2.7 2.3-2.7 4.2M12 17.6v.2" /></>,
  settings: <><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2.2" /><circle cx="8" cy="17" r="2.2" /></>,
  upload: <path d="M12 16V4.5M7 9.5l5-5 5 5M4.5 15.5v4h15v-4" />,
  download: <path d="M12 4.5V16M7 11l5 5 5-5M4.5 15.5v4h15v-4" />,
  note: <path d="M5 19.5h3.5L19 9l-3.5-3.5L5 16zM13.5 7.5 17 11" />,
  moon: <path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z" />,
  list: <path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11M4.5 6.5h.1M4.5 12h.1M4.5 17.5h.1" />,
  undo: <path d="M8.5 5 4 9.5 8.5 14M4 9.5h10a5.5 5.5 0 0 1 0 11H10" />,
  skim: <path d="M4 6.5h16M4 12h8M4 17.5h16M15.5 9.5l3 2.5-3 2.5" />,
  alert: <><path d="M12 3.5 2.5 20h19z" /><path d="M12 10v4.5M12 17.3v.2" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></>,
  spark: <path d="M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6-5.6-1.9 5.6-1.9zM18.5 16l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />,
  speech: <path d="M4.5 5.5h15v11h-8l-4.5 3.5v-3.5h-2.5z" />,
  check: <path d="m4.5 12.5 5 5 10-11" />,
  arrowLeft: <path d="M19.5 12h-15M10.5 6l-6 6 6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  trash: <path d="M4.5 6.5h15M9.5 6.5v-3h5v3M6.5 6.5l1 14h9l1-14M10 10.5v6M14 10.5v6" />,
  chart: <path d="M4 20.5V10M10 20.5V4M16 20.5v-8M21.5 20.5h-19" />,
  keyboard: <><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6.5 10h.1M10 10h.1M13.5 10h.1M17 10h.1M7 14h10" /></>,
  close: <path d="M5.5 5.5l13 13M18.5 5.5l-13 13" />,
  skipNext: <><path d="M5 5.5 14.5 12 5 18.5z" fill="currentColor" stroke="none" /><path d="M18 5v14" /></>,
  skipPrev: <><path d="M19 5.5 9.5 12l9.5 6.5z" fill="currentColor" stroke="none" /><path d="M6 5v14" /></>,
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = '1.5em' }: { name: IconName; size?: string }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}>
      {PATHS[name]}
    </svg>
  )
}
