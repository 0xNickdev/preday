import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Shell } from './components/Shell'
import { Dashboard } from './pages/Dashboard'
import { Landing } from './pages/Landing'
import { Pay } from './pages/Pay'
import { Pool } from './pages/Pool'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route element={<Shell />}>
          <Route path="/app" element={<Dashboard />} />
          <Route path="/pool" element={<Pool />} />
          <Route path="/:handle" element={<Pay />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
