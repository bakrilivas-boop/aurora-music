import { createRoot } from 'react-dom/client'
import MobileApp from './MobileApp'
import { initializeMobile } from './native'
import './mobile.css'

initializeMobile()
createRoot(document.getElementById('root')!).render(<MobileApp />)
