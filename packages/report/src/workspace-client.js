// Transforms the original report UI without changing its stored source or RPC identity.
export function rptBuildWorkspaceClientSource(input) {
  let source = input;
  function once(old, value) {
    if (source.split(old).length !== 2) throw new Error('报告客户端源码锚点不唯一：' + old.slice(0, 80));
    source = source.replace(old, value);
  }
  once("['set', '设置'], ", '');
  once('  const slots = ctx.slots', `  const slots = ctx.slots;
  const reportHost = host;
  let selection = { id:'', path:'', title:'', sessionId:'' };
  let activationError = '';
  let switchSequence = 0;
  const subscribers = new Set();
  const viewId = 'report-view-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  function publish(next) {
    if (selection.id === next.id && selection.path === next.path && selection.title === next.title && selection.sessionId === next.sessionId) return;
    selection = next;
    activationError = '';
    for (const notify of subscribers) notify();
  }
  function useWorkspace() {
    const [value, setValue] = React.useState(() => selection);
    React.useEffect(() => {
      const notify = () => setValue(selection);
      subscribers.add(notify); notify();
      return () => subscribers.delete(notify);
    }, []);
    return value;
  }
  function WorkspaceObserver(props) {
    const sessionId = props.useSessions(s => s.current || '');
    const workspaceId = props.useWorkspaces(s => {
      const w = s.items.find(item => item.sessionIds.includes(sessionId));
      return w ? w.workspaceId : '';
    });
    const path = props.useWorkspaces(s => {
      const w = s.items.find(item => item.workspaceId === workspaceId);
      return w ? w.path : '';
    });
    const title = props.useWorkspaces(s => {
      const w = s.items.find(item => item.workspaceId === workspaceId);
      return w ? w.title : '';
    });
    React.useEffect(() => { publish({id:workspaceId,path:path,title:title,sessionId:sessionId}); }, [workspaceId,path,title,sessionId]);
    React.useEffect(() => {
      let live = true;
      const sequence = ++switchSequence;
      reportHost.call('activate', {workspaceId:'', viewId:viewId, sequence:sequence}).catch(() => {});
      const cancel = ctx.timeout(() => {
        reportHost.call('activate', {workspaceId:workspaceId, viewId:viewId, sequence:sequence}).then(result => {
          if (live && result && result.ok === false) activationError = result.error || '自动报告启动失败';
        }).catch(error => { if (live) activationError = String(error.message || error); });
      }, 1200);
      return () => { live = false; cancel(); };
    }, [workspaceId]);
    return null;
  }
  function ScopedPanel(props) {
    const current = useWorkspace();
    if (!current.id) return el('div', {className:'rtr-root'}, props && props.settingsOnly ? '报告设置：请先选择工作区' : '请先选择工作区；报告不会回退到其他工作区。');
    return el(Panel, {key:current.id, workspaceId:current.id, workspacePath:current.path, workspaceTitle:current.title, settingsOnly:!!(props && props.settingsOnly)});
  }
  ctx.effect(() => slots.inject('shell.overlay', () => slots.register({name:'shell.overlay',id:'redteam-report-workspace-observer',order:0}, WorkspaceObserver)));
  ctx.effect(() => settingsHub.register(function ReportSettings() { return el(ScopedPanel, {settingsOnly:true}); }));
  ctx.effect(() => () => { subscribers.clear(); reportHost.call('activate', {workspaceId:'',viewId:viewId,sequence:++switchSequence}).catch(() => {}); });`);
  once('function Panel() {', `function Panel(props) {
    const settingsOnly = !!(props && props.settingsOnly);
    const workspaceId = props.workspaceId;
    const host = { call(method, args) { return reportHost.call(method, Object.assign({}, args || {}, {workspaceId:workspaceId})); } };`);
  once("      const timer = ctx.get('timer')", "      if (settingsOnly) return undefined;\n      const timer = ctx.get('timer')");
  once("      if (typeof ctx.interval !== 'function') return undefined", "      if (settingsOnly || typeof ctx.interval !== 'function') return undefined");
  once('        if (!liveRef.current.generating) return', '        // Always poll this scoped panel: automatic jobs can start while it is open.');
  once("      snap && tab === 'set' ? setTab_() : null,", '');
  once("    return el('div', { className: 'rtr-root' },", `    if (settingsOnly) return el('section', {className:'rtr-root', style:{borderTop:'1px solid var(--dsw-alias-border-l1)'}},
      el('h2',{className:'rtr-brand'},'报告设置 · ' + (props.workspaceTitle || props.workspacePath)),
      hint('以下配置仅用于当前工作区；报告库按工作区隔离。'),
      error ? el('div',{className:'rtr-errbar'},error) : null,
      toast ? el('div',{className:'rtr-ok'},toast) : null,
      snap && draft ? setTab_() : el('div',{className:'rtr-dim'},'加载报告设置…'));
    return el('div', { className: 'rtr-root' },`);
  once('      head(),', `      head(),
      activationError ? el('div',{className:'rtr-warn'},activationError) : null,
      st && st.queued ? hint('等待自动报告任务…') : null,
      st && st.lastError ? el('div',{className:'rtr-warn'},st.lastError) : null,`);
  once("btn('保存设置'", "btn('保存报告设置'");
  once("          card('撰写模型', '报告由它写', [", `          card('工作区自动报告', '切换触发', [
            el('label',{className:'rtr-f'},
              el('span',null,'启用此工作区的自动报告'),
              el('input',{type:'checkbox',checked:draft.autoGenerate !== false,onChange:e=>setField('autoGenerate',e.target.checked)})),
            hint('先保存配置。快速切换只保留最后一个待处理工作区；已开始的报告完成后只写回原工作区。'),
            hint('文件枚举有数量、深度与摘录预算；跳过凭据、依赖、二进制和符号链接。采集边界写入报告。')
          ]),
          card('撰写模型', '报告由它写', [`);
  once("value: draft.storePath || '', onChange: function (e) { setField('storePath', e.target.value) }", "value: (st && st.storePath) || '', readOnly: true");
  once('本机实测落在 /home/kali/桌面', '实际路径见下方');
  once("          card('digest',", `          evidence.files ? card('工作区文件采集', '清单与限制', [
            hint(JSON.stringify(evidence.files.stats)),
            el('div',{className:'rtr-hint'},evidence.files.notes.join('；')),
            el('pre',{className:'rtr-pre'},evidence.files.inventory.map(f=>f.path+' ['+f.status+']'+(f.reason?' '+f.reason:'')).join('\\n'))
          ]) : null,
          card('digest',`);
  once("}, Panel)", "}, ScopedPanel)");
  return source;
}
