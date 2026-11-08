// 隔离验证：node tests/host-loader.mjs <官方 SDK 目录> <安装包.tgz> <新的验证目录>
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [sdkArg, bundleArg, workArg] = process.argv.slice(2)
if (!sdkArg || !bundleArg || !workArg) throw Error('需要 SDK 目录、安装包及新的隔离目录')
const sdk = resolve(sdkArg), bundle = resolve(bundleArg), work = resolve(workArg)
const sdkRequire = createRequire(sdk + '/package.json')
const load = name => import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/' + name)))
const { boot, loadProfileDirectory, evaluatePluginCompatibility, getDshRuntimeVersion } = await load('dsh-app-boot')
assert.equal(getDshRuntimeVersion(), '0.2.2-rc.1')
mkdirSync(work) // 不覆盖已有验证目录，更不接触日常 profile。
symlinkSync(sdk + '/node_modules', work + '/node_modules', 'dir')
execFileSync('/usr/bin/tar', ['-xzf', bundle, '-C', work])
const manifest = JSON.parse(readFileSync(work + '/package/package.json', 'utf8'))
const profile = work + '/profile'
mkdirSync(profile + '/node_modules/@missher', { recursive: true })
symlinkSync(work + '/package', profile + '/node_modules/@missher/dsh-focus', 'dir')
writeFileSync(profile + '/package.json', JSON.stringify({ name: 'focus-compatibility-test', private: true,
  dependencies: { '@missher/dsh-focus': 'file:../package' }, dsh: { profile: { bundles: ['@missher/dsh-focus'] } } }))
writeFileSync(profile + '/cordis.yml', '[]\n')
const admitted = loadProfileDirectory('focus-compat', profile, sdk + '/package.json', { userLayer: false })
const report = { runtime: getDshRuntimeVersion(), version: manifest.version,
  skipped: admitted.skippedBundles, layers: admitted.layers.map(layer => layer.packageName) }
const save = () => { writeFileSync(work + '/result.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2)) }
save()
assert.deepEqual(admitted.skippedBundles, [], '安装包被真实宿主准入逻辑跳过')
assert.equal(evaluatePluginCompatibility(manifest, {}, '0.2.1-rc.4'), undefined)
assert.equal(evaluatePluginCompatibility(manifest, {}, '0.2.2-rc.1'), undefined)
assert.ok(evaluatePluginCompatibility(manifest, {}, '0.2.2-rc.2'), '未经验证的版本仍应受准入限制')

const [Sessions, Projections, Prompt, Tools, Native, Skills, Todo, Scope, Llm] = await Promise.all([
  'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-tool-executor-native',
  'dsh-skill', 'dsh-tool-todo', 'dsh-scope', 'dsh-llm',
].map(load))
const ctx = await boot('focus-compat', profile + '/cordis.yml', admitted.layers.flatMap(layer => layer.patches), async ctx => {
  await ctx.plugin(Sessions.default)
  await ctx.plugin(Projections.SessionProjectionRegistry)
  await ctx.plugin(Prompt.default)
  await ctx.plugin(Tools.default)
  await ctx.plugin(Native)
  await ctx.plugin(Skills.SkillRegistry)
  await ctx.plugin(Todo, { allowParallelInProgress: false })
}, pathToFileURL(profile + '/package.json').href)
try {
  const entry = [...ctx.loader.entries()].find(entry => entry.options.name === '@missher/dsh-focus')
  assert.equal(entry?.fiber?.state, 2, 'Cordis 4.1 的 ACTIVE 状态为 2')
  assert.equal((await ctx.skills.list()).filter(skill => skill.name.startsWith('dsh-focus-')).length, 6)
  const session = ctx.sessions.create(Sessions.SessionId('focus-isolated'))
  const agent = { id: session.id, session }
  agent.ctx = Scope.createScope(ctx, agent).ctx
  const assemble = () => ctx.systemPrompt.assemble({ agent, scope: agent })
  const note = async () => (await assemble()).contexts.find(item => item.name === 'missher-focus-progress')?.text ?? ''
  assert.ok((await assemble()).sections.some(section => section.name === 'missher-focus-guidance' && section.text.includes(manifest.version)))
  // 只给技能工具做薄适配；正文来自实际注册表，其他服务和执行管线均为官方 SDK。
  ctx.tools.register({ name: 'skill', description: '读取已注册技能',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async args => (await ctx.skills.get(args.name)).content })
  ctx.tools.register({ name: 'focus_failure', description: '隔离的失败观察验证',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { throw Error('隔离失败') } })
  let sequence = 0
  async function call(name, args) {
    const callId = Llm.ToolCallId('focus-' + ++sequence), signal = new AbortController().signal
    session.append('tool/call', { turn: 1, step: sequence, callId, name, arguments: JSON.stringify(args) })
    const toolSet = await ctx.tools.resolve({ agent, modelSelection: {}, signal })
    try {
      const batch = await ctx.tools.execute({ agent, signal, toolSet,
        calls: [{ type: 'tool-call', name, id: callId, arguments: JSON.stringify(args) }] })
      const result = batch.results[0].result
      session.append('tool/result', { turn: 1, step: sequence, message: {
        id: 'result-' + sequence, role: 'tool', source: { kind: 'tool', callId },
        toolCallId: callId, content: result.content, isError: result.isError,
      } }, { surfaceOp: 'append' })
      return result
    } finally { toolSet.dispose() }
  }
  assert.equal((await call('skill', { name: 'dsh-focus-planning' })).isError, false)
  assert.equal((await call('todo_write', { todos: [
    { content: '读取资料', status: 'in_progress' }, { content: '核对结果', status: 'pending' },
  ] })).isError, false)
  assert.match(await note(), /dsh-focus-execution/)
  await call('skill', { name: 'dsh-focus-execution' })
  await call('todo_write', { todos: [
    { content: '读取资料', status: 'completed' }, { content: '核对结果', status: 'completed' },
  ] })
  assert.match(await note(), /dsh-focus-review/)
  await call('skill', { name: 'dsh-focus-review' })
  assert.match(await note(), /dsh-focus-delivery/)
  await call('skill', { name: 'dsh-focus-delivery' })
  assert.equal(await note(), '')
  assert.equal((await call('focus_failure', {})).isError, true)
  assert.match(await note(), /dsh-focus-debugging/)
  await call('skill', { name: 'dsh-focus-debugging' })
  assert.equal(await note(), '')
  await ctx.loader.update(entry.id, { disabled: true })
  await ctx.loader.await()
  assert.equal((await ctx.skills.list()).filter(skill => skill.name.startsWith('dsh-focus-')).length, 0)
  assert.ok(!(await assemble()).sections.some(section => section.name === 'missher-focus-guidance'))
  Object.assign(report, { loaderActive: true, skills: 6, prompt: true, workflow: true, finalResultHook: true, unload: true })
  save()
} finally { await ctx.fiber.dispose() }
