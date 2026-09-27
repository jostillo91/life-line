import { useEffect, useMemo, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, Map as LibreMap } from 'maplibre-gl'
import type { FeatureCollection, Point } from 'geojson'
import { deriveLifeMapPoints, memoryMapLabel, type LifeMapPoint, type MapTimeFilter, type MapVisibility, type PlaceMapPoint } from './lifeMapDomain'
import { lifeMapStyle, mapProviderName } from './mapProvider'
import { PlaceSuggestions } from './PlaceSuggestions'
import type { Archive, Entry, Media, Place } from './types'
import { useMediaUrl } from './useMediaUrl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './maplibreSetup'
import { useOnline } from './networkState'

interface MapFocus { coordinates: { latitude: number; longitude: number }; pointId?: string; nonce: number }
interface Props {
  data: Archive
  onChanged: () => Promise<void>
  onOpenPlace: (place: Place) => void
  onOpenMemory: (entry: Entry) => void
  onOpenMedia: (media: Media) => void
  focus?: MapFocus
}

const session: { center?: [number, number]; zoom?: number; filter: MapTimeFilter; visibility: MapVisibility } = {
  filter: { kind: 'all' }, visibility: { places: true, memories: true, unassigned: false },
}

function featuresFor(points: LifeMapPoint[]): FeatureCollection<Point, { pointId: string; kind: string }> {
  return { type: 'FeatureCollection', features: points.map(point => ({
    type: 'Feature', properties: { pointId: point.id, kind: point.kind },
    geometry: { type: 'Point', coordinates: [point.coordinates.longitude, point.coordinates.latitude] },
  })) }
}

export function LifeMapView({ data, onChanged, onOpenPlace, onOpenMemory, onOpenMedia, focus }: Props) {
  const online = useOnline()
  const [filter, setFilter] = useState<MapTimeFilter>(() => session.filter)
  const [visibility, setVisibility] = useState<MapVisibility>(() => session.visibility)
  const [selectedId, setSelectedId] = useState<string>()
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [mapProblem, setMapProblem] = useState('')
  const [mapOpened, setMapOpened] = useState(false)
  const mapElement = useRef<HTMLDivElement>(null)
  const map = useRef<LibreMap | undefined>(undefined)
  const points = useMemo(() => deriveLifeMapPoints(data, filter, visibility), [data, filter, visibility])
  const pointsRef = useRef(points)
  pointsRef.current = points
  const selected = points.find(point => point.id === selectedId)
  const years = useMemo(() => [...new Set([
    ...data.entries.flatMap(item => [item.eventDate.start?.slice(0, 4), item.eventDate.end?.slice(0, 4)]),
    ...(data.media ?? []).map(item => item.captureDate?.slice(0, 4)),
  ].filter((year): year is string => Boolean(year)))].sort().reverse(), [data])

  useEffect(() => { session.filter = filter }, [filter])
  useEffect(() => { session.visibility = visibility }, [visibility])
  useEffect(() => { if (selectedId && !selected) setSelectedId(undefined) }, [selectedId, selected])

  useEffect(() => {
    if (!online) {setMapOpened(false);return}
    if (!mapElement.current || map.current || !pointsRef.current.length) return
    setMapProblem('')
    let instance: LibreMap | undefined
    try {
      instance = new maplibregl.Map({
        container: mapElement.current, style: lifeMapStyle(),
        center: session.center ?? [pointsRef.current[0].coordinates.longitude, pointsRef.current[0].coordinates.latitude],
        zoom: session.zoom ?? 4,
      })
      map.current = instance
      setMapOpened(true)
      const activeMap = instance
      activeMap.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
      activeMap.on('load', () => {
        activeMap.addSource('life-points', { type: 'geojson', data: featuresFor(pointsRef.current), cluster: true, clusterMaxZoom: 12, clusterRadius: 48 })
        activeMap.addLayer({ id: 'life-clusters', type: 'circle', source: 'life-points', filter: ['has', 'point_count'], paint: {
          'circle-color': '#355d4d', 'circle-radius': ['step', ['get', 'point_count'], 18, 10, 24, 50, 30], 'circle-stroke-width': 2, 'circle-stroke-color': '#fffdf8',
        } })
        activeMap.addLayer({ id: 'life-cluster-count', type: 'symbol', source: 'life-points', filter: ['has', 'point_count'], layout: {
          'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12,
        }, paint: { 'text-color': '#ffffff' } })
        activeMap.addLayer({ id: 'life-individual', type: 'circle', source: 'life-points', filter: ['!', ['has', 'point_count']], paint: {
          'circle-color': ['match', ['get', 'kind'], 'place', '#ad713f', '#4e7d9b'],
          'circle-radius': 10, 'circle-stroke-width': 2, 'circle-stroke-color': '#fffdf8',
        } })
        activeMap.on('click', 'life-individual', event => {
          const id = event.features?.[0]?.properties?.pointId
          if (typeof id === 'string') setSelectedId(id)
        })
        activeMap.on('click', 'life-clusters', event => {
          const geometry = event.features?.[0]?.geometry
          if (geometry?.type === 'Point') activeMap.easeTo({ center: geometry.coordinates as [number, number], zoom: Math.min(16, activeMap.getZoom() + 2) })
        })
        activeMap.on('mouseenter', 'life-individual', () => { activeMap.getCanvas().style.cursor = 'pointer' })
        activeMap.on('mouseleave', 'life-individual', () => { activeMap.getCanvas().style.cursor = '' })
        if (!session.center && !focus) fitToPoints(activeMap, pointsRef.current)
      })
      activeMap.on('moveend', () => {
        const center = activeMap.getCenter()
        session.center = [center.lng, center.lat]
        session.zoom = activeMap.getZoom()
      })
      activeMap.on('error', () => setMapProblem('Base map tiles may be unavailable. Your Places and GPS data remain safely stored; use the location list or try again later.'))
    } catch {
      setMapProblem('Map rendering is unavailable in this browser. Your location data remains available in Places and Media Library.')
    }
    return () => { instance?.remove(); map.current = undefined }
  }, [online, points.length > 0 || mapOpened])

  useEffect(() => {
    const source = map.current?.getSource('life-points') as GeoJSONSource | undefined
    source?.setData(featuresFor(points))
  }, [points])

  useEffect(() => {
    if (!focus) return
    setFilter({ kind: 'all' })
    if (focus.pointId?.startsWith('media:')) setVisibility(current => ({ ...current, unassigned: true }))
    if (focus.pointId?.startsWith('place:')) setVisibility(current => ({ ...current, places: true }))
    if (focus.pointId) setSelectedId(focus.pointId)
  }, [focus])
  useEffect(() => {
    if (focus && map.current) map.current.flyTo({ center: [focus.coordinates.longitude, focus.coordinates.latitude], zoom: Math.max(map.current.getZoom(), 12) })
  }, [focus, mapOpened])

  const setKind = (kind: MapTimeFilter['kind']) => {
    if (kind === 'all') setFilter({ kind })
    else if (kind === 'year') setFilter({ kind, year: Number(years[0]) || new Date().getFullYear() })
    else if (kind === 'range') setFilter({ kind, start: Number(years.at(-1)) || new Date().getFullYear(), end: Number(years[0]) || new Date().getFullYear() })
    else if (data.eras[0]) setFilter({ kind, id: data.eras[0].id })
  }

  return <section className="manager life-map-view">
    <div className="manager-head"><div><span className="eyebrow">LOCAL LIFE GEOGRAPHY</span><h2>Life Map</h2></div><button className="quiet" onClick={() => setSuggestionsOpen(true)}>Place Suggestions</button></div>
    <p className="life-map-disclosure">Place and GPS records stay in this browser. Opening the map requests tiles from {mapProviderName}, which can reveal the area in view; no stories, names, captions, or photos are sent.</p>
    <div className="life-map-filters">
      <label>Time<select aria-label="Map time filter" value={filter.kind} onChange={event => setKind(event.target.value as MapTimeFilter['kind'])}>
        <option value="all">All time</option><option value="year">Year</option><option value="range">Year range</option>{data.eras.length > 0 && <option value="era">Life Era</option>}
      </select></label>
      {filter.kind === 'year' && <label>Year<select value={filter.year} onChange={event => setFilter({ kind: 'year', year: Number(event.target.value) })}>{years.map(year => <option key={year}>{year}</option>)}</select></label>}
      {filter.kind === 'range' && <><label>From<input type="number" aria-label="Map start year" value={filter.start} onChange={event => setFilter({ ...filter, start: Number(event.target.value) })}/></label><label>To<input type="number" aria-label="Map end year" value={filter.end} onChange={event => setFilter({ ...filter, end: Number(event.target.value) })}/></label></>}
      {filter.kind === 'era' && <label>Life Era<select value={filter.id} onChange={event => setFilter({ kind: 'era', id: event.target.value })}>{data.eras.map(era => <option key={era.id} value={era.id}>{era.name}</option>)}</select></label>}
      <fieldset><legend>Show</legend>{(['places', 'memories', 'unassigned'] as const).map(key => <label key={key}><input type="checkbox" checked={visibility[key]} onChange={event => setVisibility(current => ({ ...current, [key]: event.target.checked }))}/>{key === 'unassigned' ? 'Unassigned GPS media' : key[0].toUpperCase() + key.slice(1)}</label>)}</fieldset>
    </div>
    {!points.length && !mapOpened ? <p className="empty life-map-empty">No visible locations match this view yet. Add coordinates to a Place, enable Unassigned GPS media, or review Place Suggestions. Life Line never requests your device location.</p> : <>
      <div className="life-map-layout">
        {online ? <div className="life-map-canvas" ref={mapElement} aria-label="Life Map"/> : <div className="life-map-canvas offline-map" role="status">Offline · base-map tiles are unavailable. Choose a location below to view its stored coordinates, Memories and media.</div>}
        {selected && <MapPointCard point={selected} onOpenPlace={onOpenPlace} onOpenMemory={onOpenMemory} onOpenMedia={onOpenMedia} onSuggestions={() => setSuggestionsOpen(true)}/>}
      </div>
      {mapProblem && <p className="capacity-warning" role="status">{mapProblem}</p>}
      <div className="life-map-list"><h3>Locations in this view</h3>{!points.length && <p>No locations match these filters.</p>}{points.map(point => <button key={point.id} className={selectedId === point.id ? 'active' : ''} onClick={() => { setSelectedId(point.id); map.current?.flyTo({ center: [point.coordinates.longitude, point.coordinates.latitude], zoom: Math.max(map.current.getZoom(), 11) }) }}>{point.kind === 'place' ? point.place.name : point.media.title || point.media.filename}</button>)}</div>
    </>}
    {suggestionsOpen && <PlaceSuggestions media={data.media ?? []} places={data.places} onChanged={onChanged} onClose={() => setSuggestionsOpen(false)} onViewCluster={coordinates => { setSuggestionsOpen(false); setFilter({ kind: 'all' }); setVisibility(current => ({ ...current, unassigned: true })); map.current?.flyTo({ center: [coordinates.longitude, coordinates.latitude], zoom: 13 }) }}/>} 
  </section>
}

function fitToPoints(map: LibreMap, points: LifeMapPoint[]) {
  if (!points.length) return
  if (points.length === 1) { map.jumpTo({ center: [points[0].coordinates.longitude, points[0].coordinates.latitude], zoom: 11 }); return }
  const bounds = new maplibregl.LngLatBounds()
  points.forEach(point => bounds.extend([point.coordinates.longitude, point.coordinates.latitude]))
  map.fitBounds(bounds, { padding: 55, maxZoom: 12, duration: 0 })
}

function MapPointCard({ point, onOpenPlace, onOpenMemory, onOpenMedia, onSuggestions }: {
  point: LifeMapPoint
  onOpenPlace: (place: Place) => void
  onOpenMemory: (entry: Entry) => void
  onOpenMedia: (media: Media) => void
  onSuggestions: () => void
}) {
  const media = point.kind === 'place' ? point.representative : point.media
  const preview = useMediaUrl(media, 'thumbnail', media?.mediaType === 'image')
  if (point.kind === 'unassigned') return <aside className="life-map-card">
    <span className="eyebrow">UNASSIGNED GPS MEDIA</span><h3>{point.media.title || point.media.filename}</h3>
    <p>{point.coordinates.latitude.toFixed(5)}, {point.coordinates.longitude.toFixed(5)}</p>
    {preview.url && <img className="life-map-thumb" src={preview.url} alt=""/>}
    {point.media.captureDate && <p>{point.media.captureDate.slice(0, 10)}</p>}
    <div className="portable-actions"><button className="quiet" onClick={() => onOpenMedia(point.media)}>Open in Media Library</button><button className="primary" onClick={onSuggestions}>Review Place Suggestions</button></div>
  </aside>
  const placePoint: PlaceMapPoint = point
  return <aside className="life-map-card">
    <span className="eyebrow">PLACE</span><h3>{placePoint.place.name}</h3>
    <p>{point.coordinates.latitude.toFixed(5)}, {point.coordinates.longitude.toFixed(5)}</p>
    {placePoint.place.description && <p>{placePoint.place.description}</p>}
    {placePoint.coordinateSource === 'associated-media' && <p>Shown near an associated photo’s GPS location; this Place has no saved coordinates yet.</p>}
    {preview.url && <img className="life-map-thumb" src={preview.url} alt=""/>}
    <p>{placePoint.memories.length} {placePoint.memories.length === 1 ? 'memory' : 'memories'} · {placePoint.media.length} media {placePoint.media.length === 1 ? 'item' : 'items'}</p>
    {placePoint.dateRange && <p>{placePoint.dateRange[0]}{placePoint.dateRange[1] !== placePoint.dateRange[0] && ` – ${placePoint.dateRange[1]}`}</p>}
    <button className="quiet" onClick={() => onOpenPlace(placePoint.place)}>Open Place details / edit</button>
    {placePoint.memories.length > 0 && <div className="life-map-card-list"><h4>Memories</h4>{placePoint.memories.map(entry => <button key={entry.id} onClick={() => onOpenMemory(entry)}>{memoryMapLabel(entry)}</button>)}</div>}
    {placePoint.media.length > 0 && <div className="life-map-card-list"><h4>Media</h4>{placePoint.media.map(item => <button key={item.id} onClick={() => onOpenMedia(item)}>{item.title || item.filename}</button>)}</div>}
  </aside>
}

export type { MapFocus }
