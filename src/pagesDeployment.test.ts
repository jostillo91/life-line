import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createPwaOptions, githubProjectBase, normalizeBase } from '../pwa.config'
import { archiveJson, privateArtifact, secretRules } from '../tools/deploymentAudit'
import { archive, db, initializeArchive } from './db'
import { seed } from './seed'

describe('frontend-only GitHub Pages deployment',()=>{
  it('derives project paths from HTTPS/SSH remotes and supports user sites',()=>{
    expect(githubProjectBase('https://github.com/jostillo91/life-line.git')).toBe('/life-line/')
    expect(githubProjectBase('git@github.com:owner/different-project.git')).toBe('/different-project/')
    expect(githubProjectBase('https://github.com/Owner/owner.github.io.git')).toBe('/')
    expect(()=>githubProjectBase('https://example.com/owner/repo')).toThrow('GitHub')
  })
  it('supports project/custom-domain roots but rejects ambiguous or external base paths',()=>{
    expect(normalizeBase('/life-line')).toBe('/life-line/')
    expect(normalizeBase('')).toBe('/');expect(normalizeBase('/')).toBe('/')
    for(const path of ['life-line','https://example.com/','/../','/life-line/?x','//']) expect(()=>normalizeBase(path)).toThrow('absolute directory')
  })
  it('scopes launch/identity/worker/fallback to the project without caching arbitrary deep links or APIs',()=>{
    const options=createPwaOptions('/life-line/')
    expect(options).toMatchObject({base:'/life-line/',scope:'/life-line/',registerType:'prompt',manifest:{id:'/life-line/',scope:'/life-line/',start_url:'/life-line/'},workbox:{navigateFallback:'/life-line/index.html',skipWaiting:false,runtimeCaching:[]}})
    const allowed=options.workbox!.navigateFallbackAllowlist![0]
    expect(allowed.test('/life-line/')).toBe(true);expect(allowed.test('/life-line/?revisionFixture')).toBe(true)
    for(const path of ['/','/life-line/editor/','/life-line/api/memory-assistant','/life-line/backup.zip','/another-app/']) expect(allowed.test(path)).toBe(false)
    expect(createPwaOptions('/').workbox!.navigateFallbackAllowlist![0].test('/')).toBe(true)
  })
  it('publishes only dist after tests and audits, with least-privilege separate deployment',()=>{
    const workflow=readFileSync(new URL('../.github/workflows/pages.yml',import.meta.url),'utf8')
    expect(workflow).toContain('branches: [main]');expect(workflow).toContain('workflow_dispatch:')
    for(const text of ['--frozen-lockfile','pnpm test','pnpm build:pages','pnpm check:pwa','--repo-only','--bundle-only','path: dist','pages: write','id-token: write','needs: build','github-pages']) expect(workflow).toContain(text)
    expect(workflow).not.toContain('dev:api');expect(workflow).not.toContain('contents: write')
    const config=readFileSync(new URL('../vite.config.ts',import.meta.url),'utf8')
    expect(config).toContain("JSON.stringify('disabled')")
  })
  it('keeps new production archives empty and does not overwrite existing local records',async()=>{
    db.close();await db.delete();await db.open()
    try {
      await initializeArchive({entries:[],people:[],places:[],tags:[],eras:[]})
      expect((await archive()).entries).toEqual([]);expect(await db.people.count()).toBe(0)
      expect(await db.archiveSettings.get('initialized')).toBeDefined()
      await db.entries.put(seed.entries[0]);await db.archiveSettings.delete('initialized')
      await initializeArchive({entries:[],people:[],places:[],tags:[],eras:[]})
      expect((await archive()).entries).toEqual([seed.entries[0]])
      expect(readFileSync(new URL('./App.tsx',import.meta.url),'utf8')).toContain('import.meta.env.DEV ? seed')
    } finally {db.close()}
  })
  it('flags real-shaped credentials without returning values and leaves test/documentation vocabulary alone',()=>{
    expect(secretRules('sk-proj-'+'Z'.repeat(55))).toEqual(['credential-shaped token'])
    expect(secretRules('ghp_'+'A'.repeat(36))).toEqual(['credential-shaped token'])
    expect(secretRules('OPENAI_API_KEY="'+'credential-value'+'"')).toEqual(['literal secret assignment'])
    expect(secretRules('LIFE_LINE_AI_ACCESS_PASSWORD="replace-with-a-long-password"')).toEqual([])
    expect(secretRules('Password confirmation; process.env.OPENAI_API_KEY')).toEqual([])
    expect(secretRules('LIFE_LINE_AI_ACCESS_PASSWORD:"synthetic-test-password"',true)).toEqual([])
  })
  it('rejects personal archive/environment/media artifacts, not branding or source tests',()=>{
    for(const path of ['.env','server/.env.production','backups/diary.json','life-line-archive.json','photos/private.jpg','archive.encrypted','cookies.json']) expect(privateArtifact(path)).toBe(true)
    for(const path of ['server/.env.example','src/encryptedArchive.test.ts','public/icons/icon-192.png','docs/ARCHITECTURE.md']) expect(privateArtifact(path)).toBe(false)
    expect(archiveJson(JSON.stringify({format:'life-line-archive',data:{}}))).toBe(true)
    expect(archiveJson(JSON.stringify({entries:[],people:[]}))).toBe(true)
    expect(archiveJson('{"name":"life-line-diary"}')).toBe(false)
  })
})
