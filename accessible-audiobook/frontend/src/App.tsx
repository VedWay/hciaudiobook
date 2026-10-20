import { useEffect, useState } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AnnouncerProvider } from './accessibility/Announcer'
import { GestureGate } from './components/GestureGate'
import { Layout } from './components/Layout'
import { syncEarconSettings, unlockAudio } from './core/audio'
import { useSettings } from './core/settings'
import Evaluation from './pages/Evaluation'
import Help from './pages/Help'
import Library from './pages/Library'
import Player from './pages/Player'
import SettingsPage from './pages/Settings'

export default function App() {
  const settings = useSettings()
  // A reload keeps the gate; a hot-reload or an already-activated page skips it.
  const [unlocked, setUnlocked] = useState(() => navigator.userActivation?.hasBeenActive ?? false)

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = settings.theme
    root.dataset.motion = settings.motion
    root.style.setProperty('--font-scale', String(settings.fontScale))
    syncEarconSettings()
  }, [settings])

  useEffect(() => {
    if (unlocked) unlockAudio()
  }, [unlocked])

  return (
    <AnnouncerProvider>
      {unlocked ? (
        <BrowserRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Library />} />
              <Route path="read/:bookId" element={<Player />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="help" element={<Help />} />
              <Route path="evaluation" element={<Evaluation />} />
              <Route path="*" element={<Library />} />
            </Route>
          </Routes>
        </BrowserRouter>
      ) : (
        <GestureGate onStart={() => { unlockAudio(); setUnlocked(true) }} />
      )}
    </AnnouncerProvider>
  )
}
