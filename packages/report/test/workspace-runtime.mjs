import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { rptCreateWorkspaceRuntime } from '../src/workspace-runtime.js';
import { rptBuildWorkspaceClientSource } from '../src/workspace-client.js';

const hostSource = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
const docxSource = readFileSync(new URL('../src/docx.js', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');
let assertions = 0;
function check(condition, label) { assertions++; assert.ok(condition, label); }
function equal(actual, expected, label) { assertions++; assert.deepEqual(actual, expected, label); }
const disk = new Map([['/data/.redteam-report.json', JSON.stringify({settings:{model:{provider:'test',model:'model'},instruction:'preserved'}})]]);
const writes = [];
const fs = {
  async resolve(p, opts) { return {targetKey:path.posix.resolve(opts?.cwd || '/data',p),displayPath:p}; },
  processPath:t=>t.targetKey,
  contains:(a,b)=>b.targetKey===a.targetKey||b.targetKey.startsWith(a.targetKey+'/'),
  async stat(t){return disk.has(t.targetKey)?{type:'file',size:disk.get(t.targetKey).length,version:'v1'}:undefined},
  async lstat(p,opts){return fs.stat(await fs.resolve(p,opts))},
  async readText(t){if(!disk.has(t.targetKey))throw new Error('ENOENT');return disk.get(t.targetKey)},
  async readBytes(t,signal,max){const b=new TextEncoder().encode(await fs.readText(t));if(b.length>max)throw new Error('too large');return b},
  async writeText(t,text){writes.push(t.targetKey);disk.set(t.targetKey,text);return {operation:'update',version:'v2'}}
};
const workspaces = ['A','B','C'].map(id=>({id,path:'/work/'+id,title:'Workspace '+id,sessionIds:[id+'-live',id+'-cold']}));
function event(id,seq,text){return {type:'user/message',seq,time:100+seq,data:{source:{kind:'user'},content:[{type:'text',text:id+' '+text}]}};}
const sessions = new Map(workspaces.map(w=>[w.id+'-live',{id:w.id+'-live',header:{cwd:w.path,createdAt:1000},seq:2,snapshotEvents:()=>[event(w.id,0,'scope requirement'),event(w.id,1,'verification evidence')]}]));
const llmCalls=[];
let gate=null;
let entered=null;
let time=1000000;
let coldClosed=0;
let failLlm=false;
let contentVersion=1;
const services={
  fs,
  workspaceRegistry:{get:id=>workspaces.find(w=>w.id===id),list:()=>workspaces},
  sessions:{get:id=>sessions.get(id)},
  sessionTitle:{get:s=>({title:s.id})},
  sessionPersistence:{
    stat:async id=>({header:{cwd:'/work/'+id[0],createdAt:500},eventCount:1}),
    open:async id=>({header:{cwd:'/work/'+id[0]},read:async()=>({events:[event(id[0],0,'cold persisted evidence')]}),close:async()=>{coldClosed++}})
  },
  agents:{currentInitiator:()=>({id:'A-live'})},
  agentDefaultModel:{currentSelection:()=>({provider:'default',model:'model'})},
  llm:{listProviders:()=>[{id:'test'}],async *stream(request){
    llmCalls.push(request);if(entered)entered();if(gate)await gate;
    if(failLlm){yield {type:'finish',reason:{kind:'error',failure:{message:'test model error'}}};return}
    yield {type:'text-delta',text:'# Generated report\n\n## Findings\nEvidence only.'};
    yield {type:'usage',usage:{inputTokens:5,outputTokens:8,privateObject:{shouldNotPersist:true}}};
    yield {type:'finish',reason:{kind:'stop'}};
  }}
};
const helpers={
  rptRedactEvidence:s=>String(s).replace(/secret-value/g,'[REDACTED]'),
  rptEvidenceFingerprint:s=>{let h=2166136261;for(const c of s){h=Math.imul(h^c.charCodeAt(0),16777619)}return (h>>>0).toString(16)},
  async rptCollectWorkspaceFiles(fs,root){return {files:[{path:'evidence.txt',bytes:10,text:root+' file evidence version '+contentVersion,truncated:false}],inventory:[{path:'evidence.txt',bytes:10,status:'read'}],skipped:[],stats:{enumerated:1,read:1},fingerprint:'files-'+contentVersion,notes:['bounded and redacted']}}
};
const opts={hostSource,docxSource,helpers,now:()=>time,console:{log(){},error(){}}};
const ctx={get:name=>services[name]};
let runtime=await rptCreateWorkspaceRuntime(ctx,opts);
const A=await runtime.call('snapshot',{workspaceId:'A'});
equal(A.snapshot.workspace.id,'A','workspace explicit');
equal(A.snapshot.settings.instruction,'preserved','legacy config inherited');
check(A.snapshot.status.storePath.includes('.redteam-report-ws-'),'scoped store');
check(A.snapshot.reports.length===0,'legacy unscoped reports not reattributed');
const first=await runtime.generate({workspaceId:'A'});
check(first.ok,'manual generation succeeds');
equal(llmCalls.length,1,'one model request');
const prompt=llmCalls[0].messages[0].content[0].text;
check(prompt.includes('/work/A file evidence'),'file evidence included');
check(prompt.includes('cold persisted evidence'),'cold session evidence included');
check(!prompt.includes('/work/B'),'other workspace excluded');
check(coldClosed>0,'cold handles closed');
const aState=(await runtime.call('snapshot',{workspaceId:'A'})).snapshot;
check(aState.current.markdown.includes('自动采集范围与限制'),'coverage appendix');
check(!JSON.stringify(aState.current.meta).includes('privateObject'),'usage copied as scalar fields');
const B=(await runtime.call('snapshot',{workspaceId:'B'})).snapshot;
equal(B.reports.length,0,'B never sees A reports');
check(B.status.storePath!==aState.status.storePath,'distinct store paths');
check(!(await runtime.call('export',{workspaceId:'B',id:first.reportId,format:'md'})).ok,'foreign export rejected');
check(!(await runtime.call('remove',{workspaceId:'B',ids:[first.reportId]})).ok,'foreign delete rejected');
await runtime.call('saveSettings',{workspaceId:'B',model:{provider:'test',model:'b-model'},storePath:aState.status.storePath,instruction:'B only'});
equal((await runtime.call('snapshot',{workspaceId:'A'})).snapshot.settings.instruction,'preserved','settings isolated');
equal((await runtime.call('snapshot',{workspaceId:'B'})).snapshot.status.storePath,B.status.storePath,'cannot rebind store path');
// Automatic repeat and stable evidence do not charge again.
await runtime.activate({workspaceId:'A',viewId:'one'});await runtime.waitIdle();equal(llmCalls.length,1,'cooldown suppresses repeat');
time+=310000;
await runtime.activate({workspaceId:'',viewId:'one'});await runtime.activate({workspaceId:'A',viewId:'one'});await runtime.waitIdle();equal(llmCalls.length,1,'same fingerprint reuses report');
time+=310000;contentVersion++;
await runtime.activate({workspaceId:'',viewId:'one'});await runtime.activate({workspaceId:'A',viewId:'one'});await runtime.waitIdle();equal(llmCalls.length,2,'changed evidence generates');
// A single worker, latest queued workspace per view, and captured workspace ownership.
let release;gate=new Promise(resolve=>{release=resolve});let start;const started=new Promise(resolve=>{start=resolve});entered=start;
await runtime.activate({workspaceId:'B',viewId:'two'});await started;
check(!(await runtime.generate({workspaceId:'C'})).ok,'manual cannot overlap automatic');
await runtime.activate({workspaceId:'C',viewId:'two'});
await runtime.activate({workspaceId:'A',viewId:'two'});
release();gate=null;entered=null;await runtime.waitIdle();
equal((await runtime.call('snapshot',{workspaceId:'B'})).snapshot.reports.length,1,'running B writes to B after switch');
equal((await runtime.call('snapshot',{workspaceId:'C'})).snapshot.reports.length,0,'superseded queue C not generated');
check(llmCalls.at(-1).messages[0].content[0].text.includes('/work/B'),'B owns in-flight prompt');
// Opt-out persists and failed generations have readable state/backoff.
await runtime.call('saveSettings',{workspaceId:'C',autoGenerate:false});
const before=llmCalls.length;await runtime.activate({workspaceId:'C',viewId:'three'});await runtime.waitIdle();equal(llmCalls.length,before,'opt out respected');
await runtime.call('saveSettings',{workspaceId:'C',autoGenerate:true});failLlm=true;
await runtime.activate({workspaceId:'',viewId:'three'});await runtime.activate({workspaceId:'C',viewId:'three'});await runtime.waitIdle();
check((await runtime.call('status',{workspaceId:'C'})).lastError.includes('test model error'),'auto failures visible');
const afterFailure=llmCalls.length;await runtime.activate({workspaceId:'',viewId:'three'});await runtime.activate({workspaceId:'C',viewId:'three'});await runtime.waitIdle();equal(llmCalls.length,afterFailure,'failure retry storm prevented');failLlm=false;
await runtime.dispose();runtime=await rptCreateWorkspaceRuntime(ctx,opts);
equal((await runtime.call('snapshot',{workspaceId:'A'})).snapshot.reports.length,2,'workspace reports survive runtime reload');
equal((await runtime.call('snapshot',{workspaceId:'B'})).snapshot.settings.instruction,'B only','workspace settings survive reload');
check(disk.has('/data/.redteam-report.json'),'legacy library preserved');
await assert.rejects(()=>runtime.call('snapshot',{workspaceId:'unknown'}));assertions++;
const inferred=await runtime.call('status',{});equal(inferred.workspace.id,'A','tool caller inference, no first-root fallback');
await runtime.activate({workspaceId:'',viewId:'ordered',sequence:10});
const stale=await runtime.activate({workspaceId:'C',viewId:'ordered',sequence:9});
check(stale.skipped.includes('过期'),'out-of-order browser requests rejected');
let unblock;gate=new Promise(resolve=>{unblock=resolve});
const rpcStart=await runtime.call('generate',{workspaceId:'C'});
check(rpcStart.ok && rpcStart.started,'UI generate returns without waiting for model');
check((await runtime.call('snapshot',{workspaceId:'C'})).snapshot.status.generating,'scoped UI sees running task');
unblock();gate=null;await runtime.waitIdle();
check((await runtime.call('snapshot',{workspaceId:'C'})).snapshot.reports.length===1,'UI generation settles in correct workspace');
await runtime.dispose();
// UI source shape, real JS parse, scoped RPC and always-mounted observer.
const client=rptBuildWorkspaceClientSource(clientSource);
check(typeof new Function('React','host','styles','console','settingsHub',client)==='function','client compiles');
check(client.includes("name:'shell.overlay',id:'redteam-report-workspace-observer'"),'root observer registered');
check(client.includes('workspaceId:workspaceId'),'RPC explicitly scoped');
check(client.includes('key:current.id'),'old workspace component unmounted');
check(!client.includes("['set', '设置']"),'settings stays unified');
check(client.includes("btn('保存报告设置'"),'report settings save retained');
check(client.includes('maxEntries')===false,'UI does not invent file collector API');
console.log('PASS workspace runtime/client: '+assertions+' checks');
