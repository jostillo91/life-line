import { useEffect, useState } from 'react'
import App from './App'
import { db } from './db'
import { seed } from './seed'

// DEV-only, separate persistent database: allows refresh/ZIP checks without
// reading or modifying the user's life-line-diary database.
export function RevisionPlayground() {
  const [ready,setReady] = useState(false)
  const [generation,setGeneration] = useState(0)
  const [status,setStatus] = useState('Synthetic test archive · separate database · persists across refresh')
  const [busy,setBusy] = useState(false)
  useEffect(() => {
    let active = true
    void (async () => {
      if (!await db.entries.count()) await db.transaction('rw',[db.entries,db.people,db.places,db.tags,db.eras],async () => {
        await db.entries.bulkPut(seed.entries);await db.people.bulkPut(seed.people);await db.places.bulkPut(seed.places);await db.tags.bulkPut(seed.tags);await db.eras.bulkPut(seed.eras)
      })
      if (active) setReady(true)
    })()
    return () => {active = false}
  },[])
  async function roundtrip() {
    setBusy(true)
    try {
      const {createLifeLineArchive,inspectLifeLineArchive,restoreLifeLineArchive} = await import('./archiveService')
      const before = await db.memoryRevisions.toArray()
      const inspected = await inspectLifeLineArchive((await createLifeLineArchive()).blob)
      await restoreLifeLineArchive(inspected,'merge')
      const after = await db.memoryRevisions.toArray()
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Revision roundtrip changed history unexpectedly.')
      setStatus(`ZIP backup + Merge roundtrip passed · ${after.length} revisions preserved exactly`)
      setGeneration(value => value+1)
    } catch (error) {setStatus(error instanceof Error ? error.message : 'Roundtrip failed')}
    finally {setBusy(false)}
  }
  return <><div className="revision-fixture-banner"><strong>REVISION TEST FIXTURE</strong><span role="status">{status}</span><button disabled={!ready || busy} onClick={() => void roundtrip()}>Test ZIP backup + Merge roundtrip</button></div>{ready && <App key={generation}/>}</>
}
