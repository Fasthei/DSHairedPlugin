// Production Host adapter. The legacy report engine remains an isolated closure
// inside workspace-runtime; this is the only global Tool/RPC registration layer.
import { rptCreateWorkspaceRuntime } from './workspace-runtime.js'
import { rptCollectWorkspaceFiles, rptRedactEvidence, rptEvidenceFingerprint } from './workspace-evidence.js'

export async function rptInstallWorkspaceReports(ctx, harness, sources) {
  const runtime = await rptCreateWorkspaceRuntime(ctx, {
    hostSource: sources.hostSource,
    docxSource: sources.docxSource,
    helpers: { rptCollectWorkspaceFiles, rptRedactEvidence, rptEvidenceFingerprint },
    console,
  })
  ctx.effect(() => () => runtime.dispose())
  const methods = ['activate', 'snapshot', 'saveSettings', 'collect', 'generate', 'saveDraft', 'select', 'create', 'remove', 'preview', 'export', 'importToMemory', 'logClear']
  for (const method of methods) harness.handle(method, async args => {
    try { return await runtime.call(method, args || {}) }
    catch (error) { return { ok: false, error: String(error && error.message || error) } }
  })
  harness.handle('__health', () => runtime.activity())
  const output = { schema: { type: 'json' }, render(args, value) { return [{ type: 'text', text: JSON.stringify(value) }] } }
  const workspaceField = { type: 'string', description: '工作区 ID；省略时使用调用会话所属工作区，绝不回退到其他工作区。' }
  harness.registerTool(ctx, harness.defineTool({
    name: 'report_generate',
    description: '收集当前工作区文件、会话、矩阵和参考知识并生成隔离报告；等待生成完成。',
    parameters: { workspaceId: workspaceField, title: { type: 'string' }, instruction: { type: 'string' } }, output,
    async execute(args, exec) {
      try { return await runtime.generate(args || {}, exec) }
      catch (error) { return { ok: false, error: String(error.message || error) } }
    },
  }))
  harness.registerTool(ctx, harness.defineTool({
    name: 'report_list', description: '只列出指定工作区的报告；默认使用调用会话所属工作区。',
    parameters: { workspaceId: workspaceField }, output,
    async execute(args, exec) {
      try { const r = await runtime.call('snapshot', args || {}, exec); return { ok: true, workspace: r.snapshot.workspace, reports: r.snapshot.reports } }
      catch (error) { return { ok: false, error: String(error.message || error) } }
    },
  }))
  harness.registerTool(ctx, harness.defineTool({
    name: 'report_export', description: '将当前工作区报告导出为 md/html/docx；拒绝其他工作区的报告 ID。',
    parameters: { workspaceId: workspaceField, reportId: { type: 'string' }, format: { type: 'string', enum: ['md', 'html', 'docx'] } }, output,
    async execute(args, exec) {
      try {
        const a = args || {}
        const r = await runtime.call('export', { workspaceId: a.workspaceId, id: a.reportId || '', format: a.format || 'docx' }, exec)
        return { ok: r.ok === true && !!r.path && !r.writeError, path: r.path || null, name: r.name || null, format: r.format || a.format || 'docx', bytes: r.bytes || 0, error: r.error || r.writeError || null }
      } catch (error) { return { ok: false, error: String(error.message || error) } }
    },
  }))
  harness.registerTool(ctx, harness.defineTool({
    name: 'redteam_report_status', description: '检查当前工作区报告与自动任务；wait=true 只等待现有任务，不触发新生成。',
    parameters: { workspaceId: workspaceField, wait: { type: 'boolean' } }, output,
    async execute(args, exec) {
      if (args && args.wait) await runtime.waitIdle()
      try { return { ok: true, ...await runtime.call('status', args || {}, exec), activity: runtime.activity() } }
      catch (error) { return { ok: false, error: String(error.message || error), activity: runtime.activity() } }
    },
  }))
  return runtime
}
