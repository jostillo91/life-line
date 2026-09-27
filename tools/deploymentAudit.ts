import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Report only rule names and paths, never matched credentials or diary content.
export function secretRules(text:string,testFixture=false):string[] {
  const rules:string[]=[]
  if(/\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16})\b/.test(text)) rules.push('credential-shaped token')
  if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\r\n]+[A-Za-z0-9+/=\s]{40,}/.test(text)) rules.push('private key material')
  if(!testFixture) {
    const assignments=/\b(?:OPENAI_API_KEY|LIFE_LINE_AI_ACCESS_PASSWORD|[A-Z_]*(?:PRIVATE_TOKEN|ACCESS_TOKEN|CLIENT_SECRET))\b["']?\s*[:=]\s*["']([^"'\r\n]+)["']/g
    for(const match of text.matchAll(assignments)) if(!/^(?:replace-|your-|example|test|synthetic|dummy|\$|process\.|env\.)/i.test(match[1])) rules.push('literal secret assignment')
  }
  return [...new Set(rules)]
}

export function privateArtifact(path:string):boolean {
  const normalized=path.replaceAll('\\','/')
  if(/(?:^|\/)\.env(?:\..*)?$/.test(normalized) && !normalized.endsWith('.env.example')) return true
  return /(?:^|\/)(?:backups?|exports?|archive-exports|indexeddb|cookies)(?:\/|\.)/i.test(normalized)
    || /\.(?:zip|encrypted|sqlite3?|db|pem|key|jpg|jpeg|heic|heif|webp|gif|mp4|mov|mp3|m4a|wav|ogg)$/i.test(normalized)
    || /(?:^|\/)life-line-archive.*\.json$/i.test(normalized)
    || (/\.png$/i.test(normalized) && !/^public\/icons\/(?:apple-touch-icon|icon-192|icon-512|icon-maskable-512)\.png$/.test(normalized))
}

export function archiveJson(text:string):boolean {
  try {
    const value=JSON.parse(text)
    return typeof value?.format==='string' && /life-line.*archive/.test(value.format)
      || Array.isArray(value?.entries) && Array.isArray(value?.people)
      || value?.type==='FeatureCollection'
  } catch {return false}
}

function filesUnder(root:string):string[] {
  return readdirSync(root).flatMap(name=>{const path=join(root,name);return statSync(path).isDirectory() ? filesUnder(path) : [path]})
}

function auditRepository() {
  const paths=[...new Set(execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{encoding:'utf8'}).split('\0').filter(Boolean))]
  const findings:string[]=[]
  for(const path of paths) {
    let bytes:Buffer
    try {bytes=readFileSync(path)} catch {continue} // Locally deleted source is not published.
    if(privateArtifact(path)) findings.push(`${path}: private/environment/archive artifact`)
    if(/\.(?:png|woff2?)$/i.test(path)) continue
    const text=bytes.toString('utf8')
    for(const rule of secretRules(text,/\.test\.[cm]?[jt]sx?$/.test(path) || path.endsWith('.env.example'))) findings.push(`${path}: ${rule}`)
    if(path.endsWith('.json') && archiveJson(text)) findings.push(`${path}: archive/location export`)
  }
  if(findings.length) throw new Error(`Publication audit failed (values withheld):\n${findings.join('\n')}`)
  console.log(`Repository audit passed: ${paths.length} source/configuration candidates; no detected credentials or private archive artifacts.`)
}

function auditBundle() {
  const root=resolve('dist'),files=filesUnder(root),findings:string[]=[]
  for(const path of files) {
    const name=relative(root,path).replaceAll('\\','/')
    if(!/^(?:index\.html|manifest\.webmanifest|sw\.js|workbox-[\w-]+\.js|favicon\.svg|CNAME|icons\/(?:apple-touch-icon|icon-192|icon-512|icon-maskable-512)\.png|assets\/[\w.-]+\.(?:js|css|woff2?))$/.test(name)) findings.push(`${name}: unexpected deployment artifact`)
    if(/\.(?:png|woff2?)$/.test(name)) continue
    const text=readFileSync(path,'utf8')
    for(const rule of secretRules(text)) findings.push(`${name}: ${rule}`)
    if(/life-line-revision-fixture|First day at a new school|Grandma Rosa|m-first-day|RevisionPlayground|TimelinePlayground/.test(text)) findings.push(`${name}: development/example archive leaked into production`)
    if(/OPENAI_API_KEY|LIFE_LINE_AI_ACCESS_PASSWORD/.test(text)) findings.push(`${name}: server-only configuration leaked into production`)
    if(name.endsWith('.json') && archiveJson(text)) findings.push(`${name}: archive export`)
  }
  if(findings.length) throw new Error(`Static artifact audit failed (values withheld):\n${findings.join('\n')}`)
  console.log(`Static artifact audit passed: ${files.length} application-only files; no detected credentials, personal exports or starter/test archives.`)
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if(!process.argv.includes('--bundle-only')) auditRepository()
    if(!process.argv.includes('--repo-only')) auditBundle()
  } catch(error) {console.error(error instanceof Error ? error.message : 'Deployment audit failed; details withheld.');process.exitCode=1}
}
