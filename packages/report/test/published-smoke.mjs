// Release gate: executes the ACTUAL published Host module and browser bundle.
// The 102/75 legacy regressions intentionally live in different tests.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { testDependency } from './legacy-fixture.mjs'
import { publishedHostFixture, fakeReactRuntime, textOf, findAll, button } from './published-fixtures.mjs'

const {Context, Service} = await testDependency('@deepseek-ai/cordis')
const Host = await import('../lib/host.js')
const bundle = readFileSync(new URL('../lib/client.js',import.meta.url),'utf8')
let count=0
const check=(value,label)=>{count++;assert.ok(value,label);console.log('  ✓ '+label)}
const equal=(a,b,label)=>{count++;assert.deepEqual(a,b,label);console.log('  ✓ '+label)}
const fixture=publishedHostFixture()
const root=new Context()
const tools=new Map(), routes=new Map(), slots=new Map(), timers=new Set()
let sharedSettings=null
const pendingRequests=new Set(), requests=[]
const fibers=[]
const renderers=[]
const {React,renderer}=fakeReactRuntime()
const documentValue=tree=>findAll(tree,n=>n.type==='textarea').map(n=>String(n.props.value||'')).join('\n')

class Tools extends Service {
  constructor(ctx){super(ctx,'tools')}
  register(tool){
    if(tools.has(tool.name))throw new Error('duplicate tool '+tool.name)
    return this.ctx.effect(()=>{tools.set(tool.name,tool);return()=>tools.delete(tool.name)})
  }
}
class WebServer extends Service {
  constructor(ctx){super(ctx,'webServer')}
  register(route){
    if(routes.has(route.path))throw new Error('duplicate route '+route.path)
    return this.ctx.effect(()=>{routes.set(route.path,route);return()=>routes.delete(route.path)})
  }
}
class Slots extends Service {
  constructor(ctx){super(ctx,'slots')}
  inject(name,callback){return this.ctx.effect(callback)}
  register(options,Component){
    const key=options.name+':'+(options.key||options.id||'')
    if(slots.has(key))throw new Error('duplicate slot '+key)
    return this.ctx.effect(()=>{slots.set(key,{options,Component});return()=>slots.delete(key)})
  }
}
class Timer extends Service {
  constructor(ctx){super(ctx,'timer');ctx.mixin('timer',['timeout','interval'])}
  timeout(fn,delay){
    const record={fn,delay,repeat:false}
    return this.ctx.effect(()=>{timers.add(record);return()=>timers.delete(record)})
  }
  interval(fn,delay){
    const record={fn,delay,repeat:true}
    return this.ctx.effect(()=>{timers.add(record);return()=>timers.delete(record)})
  }
}
for(const [name,value] of Object.entries(fixture.services))root.provide(name,value)
new WebServer(root);new Slots(root);new Timer(root)
async function settled(fiber){for(let i=0;i<20;i++){await Promise.resolve();if(fiber.inertia)await fiber.inertia;else return}throw new Error('fiber did not settle')}
async function request(method,args,httpMethod='POST') {
  const route=routes.get('/dsh-redteam-report/rpc')
  if(!route)throw new Error('published HTTP route missing')
  const body=JSON.stringify({method,args})
  return new Promise((resolve,reject)=>{
    const req={method:httpMethod,async *[Symbol.asyncIterator](){yield Buffer.from(body)}}
    const res={statusCode:200,setHeader(){},end(text){let payload=null;try{payload=text?JSON.parse(text):null}catch(error){reject(error);return}resolve({status:res.statusCode,payload})}}
    Promise.resolve(route.handler(req,res)).catch(reject)
  })
}
async function rpc(method,args){const r=await request(method,args);assert.equal(r.status,200);assert.equal(r.payload.ok,true);return r.payload.result}
function fakeFetch(url,init){
  const body=JSON.parse(init.body);requests.push({url,method:body.method,args:body.args})
  const task=request(body.method,body.args,init.method).then(r=>({ok:r.status>=200&&r.status<300,status:r.status,json:async()=>r.payload}))
  pendingRequests.add(task);task.finally(()=>pendingRequests.delete(task)).catch(()=>{})
  return task
}
async function flush(list=renderers){
  for(let round=0;round<80;round++){
    if(pendingRequests.size)await Promise.all([...pendingRequests])
    await new Promise(resolve=>setImmediate(resolve))
    let dirty=false
    for(const render of list)if(render.dirty){render.run();dirty=true}
    if(!dirty&&!pendingRequests.size)return
  }
  throw new Error('fake React/request tree did not settle')
}
async function fireTimers(delay){
  for(const record of [...timers])if(record.delay===delay){if(!record.repeat)timers.delete(record);record.fn()}
  await flush()
}
const exec={agent:{id:'A-session'}}
try {
  console.log('PUBLISHED HOST: direct import of lib/host.js in a real Cordis Context')
  check(Context.is(root),'uses real Cordis Context, not a permissive plain ctx')
  check(Array.isArray(Host.inject)&&Host.inject.includes('tools'),'Host explicitly injects tools')
  check(Host.inject.includes('workspaceRegistry'),'Host explicitly injects workspaceRegistry')
  const hostFiber=root.plugin(Host);fibers.push(hostFiber);await hostFiber
  equal(hostFiber.state,0,'Host waits while tools is unavailable')
  equal(routes.size,0,'waiting Host contributes no HTTP route')
  new Tools(root);await settled(hostFiber)
  equal(hostFiber.state,2,'Host activates through real Cordis dependency injection')
  equal([...tools.keys()].sort(),['redteam_report_status','report_export','report_generate','report_list'],'published Host registers exactly four tools')
  equal([...routes.keys()],['/dsh-redteam-report/rpc'],'published Host uses its package HTTP namespace')
  check([...tools.values()].every(t=>t.parameters.type==='object'),'all four tools use real compiled schemas')
  equal((await request('snapshot',{workspaceId:'A'},'GET')).status,405,'HTTP route rejects GET')
  equal((await request('not-a-method',{})).status,404,'HTTP route rejects unknown methods')
  const a=(await rpc('snapshot',{workspaceId:'A'})).snapshot
  const b=(await rpc('snapshot',{workspaceId:'B'})).snapshot
  equal(a.workspace.id,'A','published RPC uses explicit workspace A')
  equal(b.workspace.id,'B','published RPC uses explicit workspace B')
  check(a.status.storePath!==b.status.storePath,'published runtime uses distinct workspace report stores')
  check(!(await rpc('snapshot',{})).ok,'agentless RPC never falls back to the first workspace')
  const first=await tools.get('report_generate').execute({workspaceId:'A',title:'Published A'},exec)
  check(first.ok,'published report_generate actually generates through workspace runtime')
  equal(fixture.modelCalls.length,1,'one actual mocked model request')
  const prompt=fixture.modelCalls[0].messages[0].content[0].text
  check(prompt.includes('Only workspace A fixture.'),'published generation includes real collector output for A')
  check(!prompt.includes('Only workspace B fixture.'),'published generation excludes B evidence')
  check(fixture.fileReads.includes('/work/A/evidence.md'),'published entry invokes filesystem evidence collection')
  equal((await tools.get('report_list').execute({workspaceId:'B'},exec)).reports.length,0,'published report_list isolates B from A')
  equal((await tools.get('report_list').execute({},exec)).workspace.id,'A','tool default uses caller membership rather than roots[0]')
  check(!(await tools.get('report_export').execute({workspaceId:'B',reportId:first.reportId,format:'md'},exec)).ok,'published export rejects a foreign report ID')
  check(!(await rpc('remove',{workspaceId:'B',ids:[first.reportId]})).ok,'published RPC rejects cross-workspace deletion')
  const exported=await tools.get('report_export').execute({workspaceId:'A',reportId:first.reportId,format:'md'},exec)
  check(exported.ok&&fixture.files.has(exported.path),'published export writes the right report in the mock filesystem')
  check(fixture.files.get(exported.path).includes('Evidence for A.')&&!fixture.files.get(exported.path).includes('Evidence for B.'),'exported content belongs to A')
  await rpc('saveSettings',{workspaceId:'B',instruction:'B-only instruction',autoGenerate:true})
  equal((await rpc('snapshot',{workspaceId:'A'})).snapshot.settings.instruction,'legacy defaults','published settings remain workspace-local')

  console.log('PUBLISHED CLIENT: real lib/client.js + recursive fake React + real Host HTTP handler')
  let registration
  new Function('window','document','fetch',bundle)({__ModuleLoader__:{load(value){registration=value}}},undefined,fakeFetch)
  equal(registration.id,'dsh-redteam-report','published browser bundle registers the correct package ID')
  const Client=registration.factory(name=>{if(name==='react')return React;throw new Error('unexpected client require '+name)})
  for(const name of ['slots','timer','redteamSettingsUI'])check(Client.inject.includes(name),'Client injects '+name)
  const clientFiber=root.plugin(Client);fibers.push(clientFiber);await clientFiber
  equal(clientFiber.state,0,'Client waits for the shared redteamSettingsUI provider')
  equal(slots.size,0,'waiting Client contributes no slots')
  const hub={register(Component){if(sharedSettings)throw new Error('duplicate report settings');sharedSettings=Component;return()=>{if(sharedSettings===Component)sharedSettings=null}}}
  const provider=root.plugin({name:'test-settings-provider',apply(ctx){ctx.provide('redteamSettingsUI',hub)}});fibers.push(provider);await provider;await settled(clientFiber)
  equal(clientFiber.state,2,'Client starts after actual ctx.provide publication')
  check(root.get('redteamSettingsUI')!==undefined,'shared settings service is visible while provider is live')
  check(typeof sharedSettings==='function','report settings register into the shared settingsHub')
  check(slots.has('shell.overlay:redteam-report-workspace-observer'),'published Client registers an always-mounted workspace observer')
  check(slots.has('main:redteam-report')&&slots.has('sidebar.panellist:redteam-report'),'published Client registers panel and sidebar glyph')
  check(![...slots.values()].some(s=>s.options.name==='settings.section'),'report does not create a competing settings page')
  let selectedSession='A-session'
  const workspaceItems=fixture.workspaces.map(w=>({workspaceId:w.id,path:w.path,title:w.title,sessionIds:w.sessionIds}))
  const standardProps={useSessions:selector=>selector({current:selectedSession,phase:'ready'}),useWorkspaces:selector=>selector({items:workspaceItems,phase:'ready'})}
  const Observer=slots.get('shell.overlay:redteam-report-workspace-observer').Component
  const observation=renderer(Observer,standardProps);renderers.push(observation);observation.run();await flush()
  equal(observation.tree,null,'permanent observer renders no blocking visual overlay')
  await fireTimers(1200)
  check(requests.some(r=>r.method==='activate'&&r.args.workspaceId==='A'),'observer maps current session to A and activates via published HTTP route')
  // The report panel and shared settings are not mounted yet. The root observer
  // must still generate B; a main-only listener would fail this release gate.
  selectedSession='B-session';observation.run();await flush();await fireTimers(1200)
  const backgroundStatus=await tools.get('redteam_report_status').execute({workspaceId:'B',wait:true},exec)
  check(backgroundStatus.ok&&backgroundStatus.reportCount===1,'permanent observer generates B even with no report panel mounted')
  equal(fixture.modelCalls.length,2,'background observer makes exactly one B model call')
  selectedSession='A-session';observation.run();await flush();await fireTimers(1200)
  const Panel=slots.get('main:redteam-report').Component
  const panel=renderer(Panel,{});renderers.push(panel);panel.run();await flush();await fireTimers(400)
  let tree=panel.run()
  check(textOf(tree).includes('Workspace A'),'ScopedPanel -> Panel renders actual current workspace A')
  check(documentValue(tree).includes('Evidence for A.'),'recursive React renderer reaches the report document textarea')
  check(!findAll(tree,n=>n.type==='button'&&/rtr-tab/.test(n.props.className||'')).some(n=>textOf(n)==='设置'),'published report panel no longer has legacy settings tab')
  const settings=renderer(sharedSettings,{});renderers.push(settings);settings.run();await flush()
  check(textOf(settings.tree).includes('报告设置 · Workspace A'),'shared settings render the scoped report settings subtree')
  check(button(settings.tree,'保存报告设置'),'published unified settings retain their save action')
  button(settings.tree,'保存报告设置').props.onClick();await flush()
  check(requests.some(r=>r.method==='saveSettings'&&r.args.workspaceId==='A'),'settings save sends explicit workspaceId A')

  // Switch while retaining the permanent observer: A child must be unmounted,
  // and B must never show A's report even before the next model response.
  selectedSession='B-session';observation.run();await flush()
  check(textOf(panel.tree).includes('Workspace B'),'switch rerenders ScopedPanel for B')
  check(!documentValue(panel.tree).includes('Evidence for A.'),'workspace key change does not retain the old document')
  check(textOf(settings.tree).includes('报告设置 · Workspace B'),'unified settings follow the same workspace switch')
  await fireTimers(1200)
  const bStatus=await tools.get('redteam_report_status').execute({workspaceId:'B',wait:true},exec)
  check(bStatus.ok&&bStatus.reportCount===1,'switch to B automatically generates exactly one B report')
  equal(fixture.modelCalls.length,2,'auto generation calls model once for the new workspace')
  check(fixture.modelCalls[1].messages[0].content[0].text.includes('Only workspace B fixture.'),'automatic B report uses B file evidence')
  check(!fixture.modelCalls[1].messages[0].content[0].text.includes('Only workspace A fixture.'),'automatic B report never receives A file evidence')
  await fireTimers(2500);await flush();await fireTimers(400);panel.run()
  check(documentValue(panel.tree).includes('Evidence for B.'),'B panel refresh displays completed automatic report')
  const scopedCalls=requests.filter(r=>['snapshot','preview','saveSettings','collect','generate','export','saveDraft','remove','importToMemory','select','create'].includes(r.method))
  check(scopedCalls.length>0&&scopedCalls.every(r=>r.args&&['A','B'].includes(r.args.workspaceId)),'all UI business RPCs carry explicit workspace IDs')
  check(requests.every(r=>r.url==='/dsh-redteam-report/rpc'),'actual browser fetches use only the report HTTP namespace')
  equal((await rpc('snapshot',{workspaceId:'A'})).snapshot.reports.length,1,'A remains unchanged after B automatic generation')
  selectedSession='';observation.run();await flush();await fireTimers(1200)
  check(/请(?:先)?选择工作区/.test(textOf(panel.tree)),'clearing selection shows empty state rather than first-workspace fallback')

  for(const render of renderers)render.unmount()
  await flush([])
  await provider.dispose();await settled(clientFiber);await flush([])
  equal(root.get('redteamSettingsUI'),undefined,'ctx.provide service disappears when its provider is disposed')
  equal(sharedSettings,null,'dependent Client removes its shared settings registration')
  equal(slots.size,0,'dependent Client removes observer, main panel and sidebar slots')
  equal(timers.size,0,'Client timers are owned and disposed with the actual Cordis fiber')
  await clientFiber.dispose();await hostFiber.dispose()
  equal(tools.size,0,'published Host unregisters all four tools on disposal')
  equal(routes.size,0,'published Host unregisters its HTTP route on disposal')
} finally {
  for(const render of renderers)render.unmount()
  for(const fiber of fibers.reverse())await Promise.resolve(fiber.dispose()).catch(()=>{})
  await Promise.resolve(root.fiber.dispose()).catch(()=>{})
}
console.log('\nPASS published report smoke: '+count+' assertions; real Cordis lifecycle, actual lib files, no network/model/disk writes.')
