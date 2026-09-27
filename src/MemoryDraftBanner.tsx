import { clearRecoverableDraft, recoverableDraft } from './MemoryEditorView'
import type { Entry } from './types'

export function MemoryDraftBanner({ onResume }: { onResume: (entry: Entry) => void }) {
  const draft = recoverableDraft()
  if (!draft) return null

  return (
    <button className="draft-banner" onClick={() => onResume(draft)}>
      Resume unfinished memory
      <i onClick={event => { event.stopPropagation(); clearRecoverableDraft() }}>Discard</i>
    </button>
  )
}

