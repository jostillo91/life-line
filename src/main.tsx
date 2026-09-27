import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
const root = createRoot(document.getElementById('root')!)
if (import.meta.env.DEV && new URLSearchParams(location.search).has('revisionFixture')) {
  void import('./RevisionPlayground').then(({ RevisionPlayground }) => root.render(<StrictMode><RevisionPlayground /></StrictMode>))
} else if (import.meta.env.DEV && ['empty', 'small', 'large'].includes(new URLSearchParams(location.search).get('timelineFixture') ?? '')) {
  void import('./TimelinePlayground').then(({ TimelinePlayground }) => root.render(<StrictMode><TimelinePlayground /></StrictMode>))
} else {
  root.render(<StrictMode><App /></StrictMode>)
}
