import { useState } from 'react'
import { db, removeEntity } from './db'
import { referencesFor } from './domain'
import { EntityManager } from './EntityManager'
import { PlaceSuggestions } from './PlaceSuggestions'
import type { Coordinates } from './locationDomain'
import type { Archive, LifeEra, Person, Place, Tag } from './types'

export type EntityViewName = 'people' | 'places' | 'tags' | 'eras'
type Entity = Person | Place | Tag | LifeEra
type Props = {
  data: Archive
  onChanged: () => Promise<void>
  onOpenEntries: (field: 'peopleIds' | 'placeIds' | 'tagIds', id: string) => void
  onViewOnMap?: (place: Place) => void
  onViewCluster?: (coordinates: Coordinates) => void
  focusedPlace?: { id: string; nonce: number }
}

function EntityView({ kind, data, onChanged, onOpenEntries, onPlaceSuggestions, onViewOnMap, focusedPlace }: Props & { kind: EntityViewName; onPlaceSuggestions?: () => void }) {
  async function saveEntity(entityKind: EntityViewName, item: Entity) {
    await db.table(entityKind).put(item)
    await onChanged()
  }

  async function deleteEntity(entityKind: EntityViewName, item: Entity) {
    const field = entityKind === 'people'
      ? 'peopleIds'
      : entityKind === 'places'
        ? 'placeIds'
        : entityKind === 'tags'
          ? 'tagIds'
          : null
    const count = field ? referencesFor(data.entries, field, item.id).length : 0
    const mediaCount = entityKind === 'places' ? (data.media ?? []).filter(media => media.placeId === item.id).length : 0
    if ((count || mediaCount) && !confirm(`This removes ${item.name} from ${count} memories and ${mediaCount} media items. The memories and files stay safe. Continue?`)) return
    await removeEntity(entityKind, item.id)
    await onChanged()
  }

  return <EntityManager kind={kind} data={data} onSave={saveEntity} onDelete={deleteEntity} onOpenEntries={onOpenEntries} onPlaceSuggestions={onPlaceSuggestions} onViewOnMap={onViewOnMap} focusedPlace={focusedPlace} />
}

export function PeopleView(props: Props) {
  return <EntityView kind="people" {...props} />
}

export function PlacesView(props: Props) {
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  return <>
    <EntityView kind="places" {...props} onPlaceSuggestions={() => setSuggestionsOpen(true)}/>
    {suggestionsOpen && <PlaceSuggestions media={props.data.media ?? []} places={props.data.places} onChanged={props.onChanged} onClose={() => setSuggestionsOpen(false)} onViewCluster={props.onViewCluster}/>}
  </>
}

export function TagsView(props: Props) {
  return <EntityView kind="tags" {...props} />
}

export function LifeErasView(props: Props) {
  return <EntityView kind="eras" {...props} />
}

export function EntityViews({ view, ...props }: Props & { view: EntityViewName }) {
  if (view === 'people') return <PeopleView {...props} />
  if (view === 'places') return <PlacesView {...props} />
  if (view === 'tags') return <TagsView {...props} />
  return <LifeErasView {...props} />
}
