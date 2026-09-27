import { readFileSync, readdirSync, existsSync } from 'node:fs'
import assert from 'node:assert/strict'
import { join } from 'node:path'

const root=new URL('../dist/',import.meta.url)
const manifest=JSON.parse(readFileSync(new URL('manifest.webmanifest',root),'utf8'))
assert.equal(manifest.name,'Life Line');assert.equal(manifest.display,'standalone')
const base=process.env.LIFE_LINE_BASE_PATH === undefined ? manifest.scope : `${process.env.LIFE_LINE_BASE_PATH.replace(/\/$/,'')}/`
assert.ok(/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(base),'Invalid deployment base')
assert.equal(manifest.start_url,base);assert.equal(manifest.scope,base);assert.equal(manifest.id,base)
for(const icon of manifest.icons) {
  const path=new URL(icon.src,`https://app.invalid${base}manifest.webmanifest`).pathname
  assert.ok(path.startsWith(base),`Icon escapes application base: ${icon.src}`)
  assert.ok(existsSync(new URL(path.slice(base.length),root)),`Missing icon ${icon.src}`)
}
const sw=readFileSync(new URL('sw.js',root),'utf8')
const workboxFiles=readdirSync(root).filter(file=>/^workbox-.*\.js$/.test(file))
assert.ok(workboxFiles.some(file=>sw.includes(file.replace(/\.js$/,''))),'Generated Workbox runtime missing')
const urls=[...new Set([...sw.matchAll(/"?url"?\s*:\s*["']([^"']+)["']/g)].map(match=>match[1]))]
assert.ok(urls.includes('index.html'),'HTML shell missing from precache')
for(const file of readdirSync(new URL('assets/',root))) {
  if(/\.(js|css|woff2)$/.test(file)) assert.ok(urls.includes(join('assets',file).replaceAll('\\','/')),`Missing lazy/static asset ${file}`)
}
assert.ok(urls.every(url=>url==='index.html'||url==='manifest.webmanifest'||url==='favicon.svg'||/^icons\/[^/]+\.png$/.test(url)||/^assets\/[^/]+\.(js|css|woff2)$/.test(url)),`Unexpected cached resource: ${urls}`)
const html=readFileSync(new URL('index.html',root),'utf8')
assert.ok(html.includes(`href="${base}manifest.webmanifest"`),'Manifest link has wrong base')
assert.ok(html.includes(`href="${base}icons/apple-touch-icon.png"`),'Apple icon has wrong base')
for(const match of html.matchAll(/\b(?:src|href)="([^"#]+)"/g)) {
  if(/^https?:/.test(match[1])) continue
  const path=new URL(match[1],`https://app.invalid${base}`).pathname
  assert.ok(path.startsWith(base),`HTML asset escapes application base: ${match[1]}`)
  assert.ok(existsSync(new URL(path.slice(base.length),root)),`Missing HTML resource ${match[1]}`)
}
const js=readdirSync(new URL('assets/',root)).filter(file=>file.endsWith('.js')).map(file=>readFileSync(new URL(`assets/${file}`,root),'utf8'))
assert.ok(js.some(text=>text.includes(`${base}sw.js`) && text.includes(`scope:"${base}"`)),'Worker registration URL/scope has wrong base')
assert.ok(sw.includes(`${base}index.html`),'Navigation fallback has wrong base')
if(base!=='/') for(const text of [html,...js]) assert.ok(!/["']\/(?:assets\/|icons\/|favicon\.svg|manifest\.webmanifest|sw\.js)/.test(text),'Build expects an application resource at the domain root')
console.log(`PWA output verified at ${base}: manifest, ${manifest.icons.length} icons, scoped worker and ${urls.length} application-only precache entries; HTML/JS asset paths valid.`)
