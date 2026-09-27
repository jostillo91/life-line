import { createServer } from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { resolve, extname, sep } from 'node:path'

// A strict local static preview: unlike Vite preview, no arbitrary SPA fallback.
const root=resolve('dist')
const base=JSON.parse(readFileSync(resolve(root,'manifest.webmanifest'),'utf8')).scope
const port=Number(process.env.PORT || 4177)
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'}
createServer((request,response)=>{
  if(!['GET','HEAD'].includes(request.method)){response.writeHead(405);response.end();return}
  try {
    const path=decodeURIComponent(new URL(request.url,'http://localhost').pathname)
    if(base!=='/' && path===base.slice(0,-1)){response.writeHead(301,{Location:base});response.end();return}
    if(!path.startsWith(base)) throw Error('Outside app')
    const file=resolve(root,path===base ? 'index.html' : path.slice(base.length))
    if(!file.startsWith(`${root}${sep}`) || !statSync(file).isFile()) throw Error('Not a static file')
    response.writeHead(200,{'Content-Type':mime[extname(file)] || 'application/octet-stream','Cache-Control':'no-cache'})
    response.end(request.method==='HEAD' ? undefined : readFileSync(file))
  } catch {response.writeHead(404,{'Content-Type':'text/plain'});response.end('Not found')}
}).listen(port,'127.0.0.1',()=>console.log(`Strict Pages preview: http://127.0.0.1:${port}${base}`))
