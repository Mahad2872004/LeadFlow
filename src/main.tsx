import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import './index.css'
import Routes from './Routes'
createRoot(document.getElementById('root')!).render(<StrictMode><Routes/></StrictMode>)
