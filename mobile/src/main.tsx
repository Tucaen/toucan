import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installServiceWorker } from './install-support'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)

// After mounting, and never awaited: the worker only buys installability and a shell the app can
// reopen from, so a browser that cannot have one - which includes every plain-HTTP tailnet address,
// since a service worker demands a secure context - must still get the whole app. A *failure* is
// reported, unlike a skip: "Chrome never offers to install" is a question the setup guide sends
// people to debug, and an unlogged rejection makes it indistinguishable from an insecure origin.
void installServiceWorker(window).then((outcome) => {
  if (outcome.kind === 'failed') console.warn(`Toucan: service worker registration failed - ${outcome.message}`)
})
