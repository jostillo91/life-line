import { useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import type { Map as LibreMap, Marker } from 'maplibre-gl'
import { validCoordinates } from './locationDomain'
import { lifeMapStyle, mapProviderName } from './mapProvider'
import { reverseGeocoder, type AddressSuggestion } from './reverseGeocoder'
import type { Place } from './types'
import 'maplibre-gl/dist/maplibre-gl.css'
import './maplibreSetup'
import { useOnline } from './networkState'

export function PlaceLocationFields({ place, onCoordinate, onAddress }: {
  place: Place
  onCoordinate: (key: 'latitude' | 'longitude', value: string) => void
  onAddress: (value: string) => void
}) {
  const online = useOnline()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [confirmLookup, setConfirmLookup] = useState(false)
  const [lookingUp, setLookingUp] = useState(false)
  const [suggestion, setSuggestion] = useState<AddressSuggestion>()
  const [message, setMessage] = useState('')
  const mapElement = useRef<HTMLDivElement>(null)
  const map = useRef<LibreMap | undefined>(undefined)
  const marker = useRef<Marker | undefined>(undefined)
  const coordinates = validCoordinates({ latitude: place.latitude, longitude: place.longitude })
    ? { latitude: place.latitude!, longitude: place.longitude! } : undefined

  useEffect(() => {
    if (!online || !pickerOpen || !mapElement.current || map.current) return
    const initial = coordinates ?? { latitude: 0, longitude: 0 }
    let instance: LibreMap
    try {
      instance = new maplibregl.Map({ container: mapElement.current, style: lifeMapStyle(),
        center: [initial.longitude, initial.latitude], zoom: coordinates ? 11 : 1.5 })
      map.current = instance
      instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
      instance.on('error', () => setMessage('Map tiles may be unavailable; latitude and longitude fields still work.'))
      instance.on('click', event => {
        onCoordinate('latitude', String(event.lngLat.lat))
        onCoordinate('longitude', String(event.lngLat.lng))
      })
      if (coordinates) {
        const pin = new maplibregl.Marker({ draggable: true }).setLngLat([coordinates.longitude, coordinates.latitude]).addTo(instance)
        marker.current = pin
        pin.on('dragend', () => {
          const position = pin.getLngLat()
          onCoordinate('latitude', String(position.lat))
          onCoordinate('longitude', String(position.lng))
        })
      }
    } catch { setMessage('Map interaction is unavailable; use latitude and longitude fields instead.') }
    return () => { instance?.remove(); map.current = undefined; marker.current = undefined }
  }, [pickerOpen,online])

  useEffect(() => {
    if (!coordinates || !map.current) return
    if (!marker.current) {
      marker.current = new maplibregl.Marker({ draggable: true }).setLngLat([coordinates.longitude, coordinates.latitude]).addTo(map.current)
      marker.current.on('dragend', () => {
        const position = marker.current?.getLngLat()
        if (position) { onCoordinate('latitude', String(position.lat)); onCoordinate('longitude', String(position.lng)) }
      })
    } else marker.current.setLngLat([coordinates.longitude, coordinates.latitude])
  }, [place.latitude, place.longitude, pickerOpen])

  async function lookup() {
    if (!online) {setMessage('Address lookup is unavailable offline. Coordinates still work.');return}
    if (!coordinates) return
    setConfirmLookup(false)
    setLookingUp(true)
    setMessage('')
    try {
      const result = await reverseGeocoder.lookup(coordinates)
      if (result) setSuggestion(result)
      else setMessage('No address suggestion was found for this location.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Address lookup failed.') }
    finally { setLookingUp(false) }
  }

  return <div className="place-location-fields">
    <label>Latitude (optional)<input type="number" min="-90" max="90" step="any" value={place.latitude ?? ''} onChange={event => onCoordinate('latitude', event.target.value)}/></label>
    <label>Longitude (optional)<input type="number" min="-180" max="180" step="any" value={place.longitude ?? ''} onChange={event => onCoordinate('longitude', event.target.value)}/></label>
    <button type="button" className="quiet" onClick={() => setPickerOpen(value => !value)}>{pickerOpen ? 'Hide map picker' : 'Adjust on map'}</button>
    {!online && <p role="status">Offline · map tiles and address lookup are unavailable. Stored coordinates and local editing still work.</p>}
    {pickerOpen && online && <><p>Click or tap to choose a draft position, or drag its marker. Coordinates change only when you save this Place. Map tiles come from {mapProviderName}.</p><div className="place-coordinate-map" ref={mapElement} aria-label="Choose Place coordinates"/></>}
    <label>Address (optional; separate from personal name)<input value={place.address ?? ''} onChange={event => onAddress(event.target.value)}/></label>
    {reverseGeocoder.status === 'available'
      ? <button type="button" className="quiet" disabled={!coordinates || lookingUp} onClick={() => setConfirmLookup(true)}>Look up this location</button>
      : <p>Address lookup is not configured. Coordinates and map editing still work locally.</p>}
    {confirmLookup && coordinates && <div className="geocode-consent" role="group" aria-label="Confirm external location lookup"><p>Looking up this location will send these coordinates to {reverseGeocoder.providerName}. No Place name, story, photo, or caption is sent. Continue?</p><button type="button" className="primary" onClick={lookup}>Continue</button><button type="button" className="quiet" onClick={() => setConfirmLookup(false)}>Cancel</button></div>}
    {suggestion && <div className="geocode-suggestion"><strong>Suggested location</strong><p>{suggestion.label}</p><button type="button" className="quiet" onClick={() => { onAddress(suggestion.address ?? suggestion.label); setSuggestion(undefined) }}>Use as address only</button><small>Your Place name stays unchanged until you edit it yourself.</small></div>}
    {message && <p role="status">{message}</p>}
  </div>
}
