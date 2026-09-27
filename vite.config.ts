import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createPwaOptions, githubProjectBase, normalizeBase } from './pwa.config'
export default defineConfig(({mode}) => {
  const pages=mode==='pages'
  // Actions supplies the actual Pages path, including custom-domain root hosting.
  // Local Pages builds derive the project name from the existing GitHub remote.
  const base=normalizeBase(process.env.LIFE_LINE_BASE_PATH ?? (pages ? existsSync('public/CNAME') ? '/' : githubProjectBase(execFileSync('git',['remote','get-url','origin'],{encoding:'utf8'})) : '/'))
  return {base,plugins:[react(),VitePWA(createPwaOptions(base))],
    ...(pages ? {define:{'import.meta.env.VITE_LIFE_LINE_AI_MODE':JSON.stringify('disabled'),'import.meta.env.VITE_LIFE_LINE_AI_ENDPOINT':JSON.stringify(''),'import.meta.env.VITE_LIFE_MAP_GEOCODER_KEY':JSON.stringify('')}} : {}),
    optimizeDeps:{exclude:['maplibre-gl']},server:{proxy:{'/api/memory-assistant':'http://127.0.0.1:8787'}}}
})
