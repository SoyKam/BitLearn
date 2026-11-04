import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createPinia, setActivePinia, disposePinia } from 'pinia'
import ts from 'typescript'

const modules = new Map()
async function moduleUrl(url) {
  if (modules.has(url.href)) return modules.get(url.href)
  const source = await readFile(url, 'utf8')
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
  for (const match of [...outputText.matchAll(/from '([^']+)'/g)]) {
    const specifier = match[1]
    const target = specifier.startsWith('.') ? await moduleUrl(new URL(`${specifier}.ts`, url)) : import.meta.resolve(specifier)
    outputText = outputText.replaceAll(`from '${specifier}'`, `from '${target}'`)
  }
  const result = `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
  modules.set(url.href, result)
  return result
}
const load = async path => import(await moduleUrl(new URL(`../src/${path}.ts`, import.meta.url)))

const { dashboardService, decodeRetention, decodeDashboard } = await load('services/dashboard.service')
const { useDashboardStore } = await load('stores/dashboard.store')
const { useAuthStore } = await load('stores/auth.store')
const { loginDestination } = await load('router/auth.guard')
const stats = {summary:{totalLessons:9,completedLessons:4,completionPercent:44.44,studiedFlashcards:2,dueReviews:3,totalReviews:12},courses:[]}
const empty = {asOf:'2026-11-04T12:00:00.000Z',modeledCards:0,averageRetentionNowPercent:null,nextScheduledReviewAt:null,points:[]}
const projection = {...empty,modeledCards:1,averageRetentionNowPercent:100,nextScheduledReviewAt:'2026-11-05T12:00:00.000Z',
 points:[0,1,3,7,14,30].map((daysAhead,i)=>({daysAhead,estimatedRetentionPercent:100-i*10}))}
const success=data=>({success:true,data})
function setup(t) {
 const pinia=createPinia();setActivePinia(pinia);t.after(()=>disposePinia(pinia))
 const auth=useAuthStore()
 const signIn=(id=1)=>{auth.user={id,name:'Test',email:'test@example.com'};auth.accessToken='jwt';auth.expiresAt=Date.now()+900000;auth.status='authenticated'}
 signIn();return {auth,signIn,store:useDashboardStore()}
}
test('servicios GET y JWT, vacío, proyección, contratos y destino cerrado',async t=>{
 const calls=[]
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});return Response.json(success(url.endsWith('/retention')?projection:stats))})
 assert.deepEqual(await dashboardService.getDashboard('jwt'),stats)
 assert.deepEqual(await dashboardService.getRetention('jwt'),projection)
 assert.equal(calls.length,2);assert.ok(calls.every(c=>c.options.headers.Authorization==='Bearer jwt'))
 assert.deepEqual(decodeRetention(success(empty)),empty)
 assert.equal(loginDestination('/dashboard'),'/dashboard')
 assert.equal(loginDestination('//evil.test'),'/perfil')
 for(const bad of [-1,101,NaN,Infinity,null]) {
  assert.throws(()=>decodeDashboard(success({...stats,summary:{...stats.summary,completionPercent:bad}})))
  assert.throws(()=>decodeRetention(success({...projection,averageRetentionNowPercent:bad})))
 }
 for(const change of [{asOf:'invalid'},{points:[]},{modeledCards:0},{nextScheduledReviewAt:empty.asOf}]) assert.throws(()=>decodeRetention(success({...projection,...change})))
})
test('estado inicial, carga, respuesta tardía, cambio de usuario y logout',async t=>{
 let resolve;const gate=new Promise(done=>{resolve=done});let delayed=true
 t.mock.method(globalThis,'fetch',async url=>{if(delayed)await gate;return Response.json(success(url.endsWith('/retention')?empty:stats))})
 const {store,auth,signIn}=setup(t)
 assert.equal(store.statistics,null)
 const old=store.loadDashboard();assert.equal(store.loading,true)
 auth.clearSession();assert.equal(store.retention,null);signIn(2);delayed=false
 await store.loadDashboard();resolve();await old
 assert.equal(store.ownerId,2);assert.equal(store.isEmpty,true)
 auth.clearSession();assert.equal(store.statistics,null);assert.equal(store.retention,null)
})
test('error de red, reintento GET limitado y recuperación manual',async t=>{
 let calls=0,fail=true
 t.mock.method(globalThis,'fetch',async url=>{calls++;if(fail)throw Error('offline');return Response.json(success(url.endsWith('/retention')?empty:stats))})
 const {store}=setup(t);await store.loadDashboard();assert.ok(store.error);assert.ok(calls<=6)
 fail=false;await store.reloadDashboard();assert.equal(store.error,null);assert.ok(store.statistics)
})
test('401 renueva sesión una sola vez por GET y token próximo a expirar',async t=>{
 t.mock.method(globalThis,'fetch',async(url,options)=>options.headers.Authorization==='Bearer renewed'?Response.json(success(url.endsWith('/retention')?empty:stats)):new Response('{}',{status:401}))
 const {store,auth}=setup(t);const refresh=t.mock.method(auth,'refreshSession',async()=> 'renewed')
 await store.loadDashboard();assert.ok(store.statistics);assert.ok(refresh.mock.callCount()<=2)
 auth.expiresAt=0;await store.reloadDashboard();assert.ok(store.statistics)
})
test('vista usa fecha Intl, tabla accesible y aviso; no calcula SM-2 ni retención',async()=>{
 const view=await readFile(new URL('../src/views/DashboardView.vue',import.meta.url),'utf8')
 assert.match(view,/Intl.DateTimeFormat/);assert.match(view,/<table/);assert.match(view,/No representa una medición real de tu memoria/)
 for(const path of ['views/DashboardView.vue','services/dashboard.service.ts','stores/dashboard.store.ts']) {
  const source=await readFile(new URL('../src/'+path,import.meta.url),'utf8')
  assert.doesNotMatch(source,/Math.exp|Math.LN2|calculateSm2|localStorage|sessionStorage/)
 }
})
for (const status of [500,503]) test('HTTP '+status+' seguro y reintentos acotados',async t=>{
 let calls=0
 t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('SQL secret',{status})})
 await assert.rejects(dashboardService.getRetention('jwt'),cause=>cause.status===status&&!/SQL|secret/.test(cause.message))
 assert.equal(calls,status===503?2:1)
})
