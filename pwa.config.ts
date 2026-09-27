import type { VitePWAOptions } from 'vite-plugin-pwa'

export function normalizeBase(value:string) {
  const base=value ? `${value.replace(/\/$/,'')}/` : '/'
  if(!/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(base) || base.split('/').some(part=>part==='.' || part==='..')) throw new Error('Life Line base must be an absolute directory path, such as /life-line/.')
  return base
}

export function githubProjectBase(remote:string) {
  const match=remote.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
  if(!match) throw new Error('Pages build requires a GitHub origin remote or LIFE_LINE_BASE_PATH.')
  return match[2].toLowerCase()===`${match[1].toLowerCase()}.github.io` ? '/' : normalizeBase(`/${match[2]}`)
}

export function createPwaOptions(value='/'):Partial<VitePWAOptions> {
const base=normalizeBase(value)
const escapedBase=base.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
return {
  base,scope:base,
  registerType:'prompt',
  injectRegister:false,
  devOptions:{enabled:false},
  includeAssets:['favicon.svg','icons/apple-touch-icon.png'],
  manifest:{
    id:base,name:'Life Line',short_name:'Life Line',description:'A private, local-first life archive.',
    start_url:base,scope:base,display:'standalone',lang:'en',
    theme_color:'#2f5d50',background_color:'#f4f1e9',
    icons:[
      {src:'icons/icon-192.png',sizes:'192x192',type:'image/png',purpose:'any'},
      {src:'icons/icon-512.png',sizes:'512x512',type:'image/png',purpose:'any'},
      {src:'icons/icon-maskable-512.png',sizes:'512x512',type:'image/png',purpose:'maskable'},
    ],
  },
  workbox:{
    // Only build-owned resources: never personal JSON, backups or media URLs.
    globPatterns:['index.html','assets/*.{js,css,woff2}','favicon.svg','icons/*.png'],
    maximumFileSizeToCacheInBytes:2 * 1024 * 1024,
    navigateFallback:`${base}index.html`,
    navigateFallbackAllowlist:[new RegExp(`^${escapedBase}(?:\\?.*)?$`)],
    navigateFallbackDenylist:[/^\/api\//,new RegExp(`^${escapedBase}api/`)],
    runtimeCaching:[],
    cleanupOutdatedCaches:true,
    skipWaiting:false,
    clientsClaim:true,
  },
}
}
export const pwaOptions=createPwaOptions()
