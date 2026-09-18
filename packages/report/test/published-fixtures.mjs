// Test-only realistic filesystem and recursively rendered React tree helpers.
// These mocks never touch a real business file, HTTP endpoint, or model provider.
import path from 'node:path'

export function publishedHostFixture() {
  const files = new Map([
    ['/data/.redteam-report.json', JSON.stringify({settings:{model:{provider:'test',model:'model'},instruction:'legacy defaults'}})],
    ['/work/A/evidence.md', '# A evidence\nOnly workspace A fixture.'],
    ['/work/B/evidence.md', '# B evidence\nOnly workspace B fixture.'],
  ])
  const directories = new Set(['/data','/work','/work/A','/work/B'])
  const fileReads = [], writes = [], modelCalls = []
  const normalize = (value, opts) => path.posix.resolve(opts?.cwd || '/data', value)
  const info = p => directories.has(p) ? {type:'directory',size:0} : files.has(p) ? {type:'file',size:Buffer.byteLength(files.get(p)),version:'mock-v1'} : undefined
  const fs = {
    async resolve(p,opts){return {targetKey:normalize(p,opts),displayPath:p}},
    processPath:t=>t.targetKey,
    contains:(a,b)=>a.targetKey===b.targetKey||b.targetKey.startsWith(a.targetKey+'/'),
    async stat(t){return info(t.targetKey)},
    async lstat(p,opts){return info(normalize(p,opts))},
    async listDir(t){
      const base=t.targetKey.replace(/\/$/,'')+'/';const names=new Set()
      for(const p of [...directories,...files.keys()]) if(p.startsWith(base)&&p!==base) names.add(p.slice(base.length).split('/')[0])
      return [...names].sort().map(name=>({name}))
    },
    async readText(t){fileReads.push(t.targetKey);if(!files.has(t.targetKey))throw new Error('ENOENT');return files.get(t.targetKey)},
    async readBytes(t,signal,max){const b=Buffer.from(await fs.readText(t));if(max&&b.length>max)throw new Error('read bound exceeded');return new Uint8Array(b)},
    async readByteRange(t,range){const bytes=Buffer.from(await fs.readText(t));return new Uint8Array(bytes.subarray(range.offset,range.offset+range.length))},
    async writeText(t,text){files.set(t.targetKey,String(text));writes.push(t.targetKey);return {operation:'update',version:'mock-v2'}},
  }
  const workspaces=['A','B'].map(id=>({id,path:'/work/'+id,title:'Workspace '+id,sessionIds:[id+'-session']}))
  const sessions = new Map(workspaces.map(w=>[w.id+'-session',{
    id:w.id+'-session',header:{cwd:w.path,createdAt:'2026-09-01T00:00:00.000Z'},seq:1,inheritedEventCount:0,
    snapshotEvents:()=>[{type:'user/message',seq:0,time:1788000000000,data:{source:{kind:'user'},content:[{type:'text',text:'Verify only workspace '+w.id}]}}],
  }]))
  const services={
    fs,
    workspaceRegistry:{get:id=>workspaces.find(w=>w.id===id),list:()=>workspaces},
    sessions:{get:id=>sessions.get(id)},
    sessionTitle:{get:s=>({title:s.id})},
    agents:{currentInitiator:()=>undefined},
    agentDefaultModel:{currentSelection:()=>({provider:'test',model:'model'})},
    shell:{resolve:s=>s,run:async()=>({exitCode:0,stdout:{text:''},stderr:{text:''}})},
    llm:{listProviders:()=>[{id:'test'}],async *stream(request){
      modelCalls.push(request)
      const text=request.messages[0].content[0].text
      const scope=text.includes('/work/B')?'B':'A'
      yield {type:'text-delta',text:'# Published '+scope+' report\n\nEvidence for '+scope+'.'}
      yield {type:'usage',usage:{inputTokens:12,outputTokens:15}}
      yield {type:'finish',reason:{kind:'stop'}}
    }},
  }
  return {files,services,workspaces,fileReads,writes,modelCalls}
}

export function fakeReactRuntime() {
  let current = null
  const React = {
    createElement(type,props,...children){return {type,key:props?.key,props:{...(props||{}),children:children.length===1?children[0]:children}}},
    Fragment:'fragment',
    useState(initial){
      const c=current;if(!c)throw new Error('hook outside function component')
      const index=c.cursor++
      if(!(index in c.states))c.states[index]=typeof initial==='function'?initial():initial
      return [c.states[index],value=>{const next=typeof value==='function'?value(c.states[index]):value;if(!Object.is(next,c.states[index])){c.states[index]=next;c.owner.dirty=true}}]
    },
    useRef(initial){const c=current,index=c.cursor++;if(!(index in c.states))c.states[index]={current:initial};return c.states[index]},
    useEffect(fn,deps){
      const c=current,index=c.cursor++,prev=c.effects[index]
      if(!prev||deps===undefined||prev.deps===undefined||deps.length!==prev.deps.length||deps.some((v,i)=>!Object.is(v,prev.deps[i]))){
        c.effects[index]={deps:deps?.slice(),cleanup:prev?.cleanup,pending:fn}
        c.owner.pendingEffects.push(()=>{const e=c.effects[index];if(e.cleanup)e.cleanup();e.cleanup=e.pending?.();e.pending=null})
      }
    },
    useMemo(fn,deps){const c=current,index=c.cursor++,prev=c.states[index];if(!prev||!deps||deps.some((v,i)=>!Object.is(v,prev.deps?.[i])))c.states[index]={deps:deps?.slice(),value:fn()};return c.states[index].value},
    useCallback(fn,deps){return React.useMemo(()=>fn,deps)},
  }
  function renderer(Component,initialProps={}) {
    const records = new Map()
    const result = {dirty:true,pendingEffects:[],tree:null,props:initialProps,root:Component,
      run(props=result.props){
        result.props=props;result.dirty=false;result.pendingEffects=[]
        const visited=new Set()
        function walk(node,address){
          if(node===null||node===undefined||typeof node!=='object')return node
          if(Array.isArray(node))return node.map((n,i)=>walk(n,address+'/'+i))
          if(typeof node.type==='function'){
            const key=address+':'+String(node.key??'')
            let record=records.get(key)
            if(record&&record.type!==node.type){disposeRecord(record);records.delete(key);record=null}
            if(!record){record={type:node.type,states:{},effects:{},cursor:0,owner:result};records.set(key,record)}
            record.cursor=0;visited.add(key);const previous=current;current=record
            let inner;try{inner=node.type(node.props)}finally{current=previous}
            return walk(inner,key+'/render')
          }
          return {...node,props:{...node.props,children:walk(node.props?.children,address+'/children')}}
        }
        result.tree=walk(React.createElement(result.root,result.props),'root')
        for(const [key,record] of records)if(!visited.has(key)){disposeRecord(record);records.delete(key)}
        for(const effect of result.pendingEffects)effect()
        return result.tree
      },
      unmount(){for(const record of records.values())disposeRecord(record);records.clear();result.dirty=false},
    }
    return result
  }
  function disposeRecord(record){for(const effect of Object.values(record.effects))if(typeof effect.cleanup==='function')effect.cleanup()}
  return {React,renderer}
}

export function textOf(node) {
  if(node==null||node===false)return ''
  if(typeof node==='string'||typeof node==='number')return String(node)
  if(Array.isArray(node))return node.map(textOf).join(' ')
  return textOf(node.props?.children)
}
export function findAll(node,predicate) {
  if(!node||typeof node!=='object')return []
  if(Array.isArray(node))return node.flatMap(n=>findAll(n,predicate))
  return [...(predicate(node)?[node]:[]),...findAll(node.props?.children,predicate)]
}
export function button(tree,label) {return findAll(tree,n=>n.type==='button'&&textOf(n).trim()===label)[0]}
