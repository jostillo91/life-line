import type { StyleSpecification } from 'maplibre-gl'

const configuredStyle = import.meta.env.VITE_LIFE_MAP_STYLE_URL?.trim()

export const mapProviderName = configuredStyle ? 'configured map provider' : 'OpenStreetMap'

export function lifeMapStyle(): string | StyleSpecification {
  if (configuredStyle) return configuredStyle
  return {
    version: 8,
    name: 'Life Line · OpenStreetMap',
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors',
        maxzoom: 19,
      },
    },
    layers: [{ id: 'base', type: 'raster', source: 'osm' }],
  }
}
