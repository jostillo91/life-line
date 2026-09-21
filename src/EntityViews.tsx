import { db, removeEntity } from './db'
import { referencesFor } from './domain'
import { EntityManager } from './EntityManager'
import type { Archive, LifeEra, Person, Place, Tag } from './types'

export type EntityViewName = 'people' | 'places' | 'tags' | 'eras'
type Entity = Person | Place | Tag | LifeEra
type Props = {
  data: Archive
  onChanged: () => Promise<void>
  onOpenEntries: (field: 'peopleIds' | 'placeIds' | 'tagIds', id: string) => void
}

function EntityView({ kind, data, onChanged, onOpenEntries }: Props & { kind: EntityViewName }) {
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
    if (count && !confirm(`This removes ${item.name} from ${count} memories. The memories stay safe. Continue?`)) return
    await removeEntity(entityKind, item.id)
    await onChanged()
  }

  return <EntityManager kind={kind} data={data} onSave={saveEntity} onDelete={deleteEntity} onOpenEntries={onOpenEntries} />
}

export function PeopleView(props: Props) {
  return <EntityView kind="people" {...props} />
}

export function PlacesView(props: Props) {
  return <EntityView kind="places" {...props} />
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
