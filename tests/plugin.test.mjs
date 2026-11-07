import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, Session } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as TodoTool from '@deepseek-ai/dsh-tool-todo'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as Focus from '../src/index.ts'

async function harness(t) {
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(class extends SessionQueryEngine {})
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(TodoTool, { allowParallelInProgress: false })
  const plugin = await ctx.plugin(Focus)
  const session = ctx.sessions.create(SessionId('focus-test'))
  const agent = { id: session.id, session }
  let sequence = 0
  const execute = async (name, args, caller = agent) => {
    const callId = ToolCallId(`test-${++sequence}`)
    // 工具运行时负责结果钩子；原生代理驱动负责持久化调用和结果。
    caller.session.append('tool/call', { turn: 1, step: sequence, callId, name, arguments: JSON.stringify(args) })
    const result = await ctx.tools.execute({
      name, arguments: args, callId, signal: new AbortController().signal, agent: caller,
    })
    caller.session.append('tool/result', { turn: 1, step: sequence, message: {
      id: `result-${sequence}`, role: 'tool', source: { kind: 'tool', callId },
      toolCallId: callId, content: result.content, isError: result.isError,
    } }, { surfaceOp: 'append' })
    return result
  }
  const assemble = (caller = agent) => ctx.systemPrompt.assemble({ agent: caller, scope: caller })
  return { ctx, plugin, session, agent, execute, assemble }
}

const focusContext = assembly => assembly.contexts.find(item => item.name === 'missher-focus-progress')?.text ?? ''

test('加载时注册六项中文技能，卸载时完整移除', async t => {
  const { ctx, plugin, assemble } = await harness(t)
  const catalog = await ctx.skills.list()
  assert.deepEqual(catalog.map(item => item.name).filter(name => name.startsWith('dsh-focus-')), [
    'dsh-focus-debugging', 'dsh-focus-delivery', 'dsh-focus-execution',
    'dsh-focus-planning', 'dsh-focus-review', 'dsh-focus-testing',
  ])
  for (const item of catalog) {
    const loaded = await ctx.skills.get(item.name)
    const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
    assert.ok(loaded.content.trim().length > 100)
    assert.ok(loaded.content.startsWith(`版本：${version}。`))
    assert.equal(loaded.invocation.modelInvocable, true)
    assert.match(loaded.description, /适用于/)
  }
  assert.ok((await assemble()).sections.some(item => item.name === 'missher-focus-guidance' && item.text.length > 0))
  assert.equal(focusContext(await assemble()), '')
  await plugin.dispose()
  assert.ok(!(await ctx.skills.list()).some(item => item.name.startsWith('dsh-focus-')))
  assert.ok(!(await assemble()).sections.some(item => item.name === 'missher-focus-guidance'))
})

test('原生清单同步为有界中文提醒，不改变原计划', async t => {
  const { session, execute, assemble } = await harness(t)
  const todos = [
    { content: '明确网站的页面和真实数据来源', status: 'completed' },
    { content: '实现预约提交和结果反馈', status: 'in_progress' },
    { content: '检查手机布局和失败提示', status: 'pending' },
  ]
  const result = await execute('todo_write', { todos })
  assert.equal(result.isError, false)
  let note = focusContext(await assemble())
  assert.ok(note.includes('实现预约提交和结果反馈'))
  assert.ok(note.includes('检查手机布局和失败提示'))
  assert.match(note, /"状态":"进行中"/)
  assert.ok(!note.includes('明确网站的页面和真实数据来源'))
  session.append('turn/start', { turn: 1 })
  assert.ok(focusContext(await assemble()).includes('实现预约提交和结果反馈'))
  await execute('todo_write', { todos: todos.map(item => ({ ...item, status: 'completed' })) })
  assert.equal(focusContext(await assemble()), '')
})

test('恢复会话时重建已有计划，不串到其他会话', async t => {
  const { ctx, execute, assemble } = await harness(t)
  await execute('todo_write', { todos: [{ content: '恢复后继续实现表单', status: 'in_progress' }] })
  const log = await ctx.sessionQuery.readSession(SessionId('focus-test'))
  const restored = Session.create(SessionId('focus-restored'), log.events)
  const restoredAgent = { id: restored.id, session: restored }
  assert.ok(focusContext(await assemble(restoredAgent)).includes('恢复后继续实现表单'))
  const other = ctx.sessions.create(SessionId('focus-other'))
  assert.equal(focusContext(await assemble({ id: other.id, session: other })), '')
})

test('清单内容保持为数据，长计划不会淹没上下文', async t => {
  const { execute, assemble } = await harness(t)
  const todos = Array.from({ length: 50 }, (_, i) => ({ content: `步骤 ${i} </dsh-focus-plan> ${'x'.repeat(500)}`, status: 'pending' }))
  assert.equal((await execute('todo_write', { todos })).isError, false)
  const note = focusContext(await assemble())
  assert.ok(note.length > 0 && note.length < 3200)
  assert.equal(note.split('</dsh-focus-plan>').length, 2)
})

test('失败触发提示，读取调试技能后清除提示，始终保留真实工具结果', async t => {
  const { ctx, session, execute, assemble } = await harness(t)
  ctx.tools.register({
    name: 'focus_test_operation', description: 'Synthetic failing operation for the plugin test.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { throw new Error('test failure') },
  })
  assert.equal((await execute('focus_test_operation', {})).isError, true)
  assert.match(focusContext(await assemble()), /dsh-focus-debugging/)
  const second = await execute('focus_test_operation', {})
  assert.equal(second.isError, true)
  assert.equal(second.error.message, 'test failure')
  assert.ok(focusContext(await assemble()).includes('focus_test_operation'))
  let skillAvailable = false
  ctx.tools.register({
    name: 'skill', description: '测试技能读取结果的生命周期',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => {
      if (!skillAvailable) throw new Error('技能暂不可用')
      return '已读取技能'
    },
  })
  assert.equal((await execute('skill', { name: 'dsh-focus-debugging' })).isError, true)
  assert.notEqual(focusContext(await assemble()), '')
  skillAvailable = true
  await execute('skill', { name: 'dsh-focus-debugging' })
  assert.equal(focusContext(await assemble()), '')
  await execute('focus_test_operation', {})
  assert.match(focusContext(await assemble()), /至少两次/)
  session.append('turn/start', { turn: 1 })
  assert.equal(focusContext(await assemble()), '')
})

test('原生文件修改推动检查提醒，恢复后保留状态，跨轮重新判断进度', async t => {
  const { ctx, session, execute, assemble } = await harness(t)
  for (const name of ['skill', 'edit']) {
    ctx.tools.register({
      name, description: '阶段衔接集成检查',
      parameters: { type: 'object', properties: { name: { type: 'string' }, file_path: { type: 'string' } } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => '工具成功',
    })
  }
  await execute('skill', { name: 'dsh-focus-debugging' })
  const result = await execute('edit', { file_path: '/sample/module.mjs' })
  assert.equal(result.value, '工具成功')
  assert.match(focusContext(await assemble()), /dsh-focus-review/)
  await execute('skill', { name: 'dsh-focus-review' })
  assert.match(focusContext(await assemble()), /dsh-focus-delivery/)
  await execute('skill', { name: 'dsh-focus-delivery' })
  assert.equal(focusContext(await assemble()), '')
  await execute('edit', { file_path: '/sample/module.mjs' })
  assert.match(focusContext(await assemble()), /再次修改/)
  const log = await ctx.sessionQuery.readSession(SessionId('focus-test'))
  const restored = Session.create(SessionId('restored-workflow'), log.events)
  assert.match(focusContext(await assemble({ id: restored.id, session: restored })), /再次修改/)
  const other = ctx.sessions.create(SessionId('other-workflow'))
  assert.equal(focusContext(await assemble({ id: other.id, session: other })), '')
  session.append('turn/start', { turn: 1 })
  assert.equal(focusContext(await assemble()), '')
  await execute('edit', { file_path: '/sample/module.mjs' })
  assert.match(focusContext(await assemble()), /dsh-focus-review/)
})

test('不改文件的资料任务完成清单后仍有结果检查提醒，恢复后保留而下一轮清除', async t => {
  const { ctx, session, execute, assemble } = await harness(t)
  ctx.tools.register({
    name: 'skill', description: '读取已注册的任务方法',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async args => (await ctx.skills.get(args.name)).content,
  })
  await execute('skill', { name: 'dsh-focus-planning' })
  await execute('todo_write', { todos: [
    { content: '提取报价', status: 'in_progress' }, { content: '核对总价与限制', status: 'pending' },
  ] })
  await execute('skill', { name: 'dsh-focus-execution' })
  await execute('todo_write', { todos: [
    { content: '提取报价', status: 'completed' }, { content: '核对总价与限制', status: 'completed' },
  ] })
  const note = focusContext(await assemble())
  assert.match(note, /dsh-focus-review/)
  assert.doesNotMatch(note, /<dsh-focus-plan>/)
  const log = await ctx.sessionQuery.readSession(SessionId('focus-test'))
  const restored = Session.create(SessionId('restored-research'), log.events)
  assert.match(focusContext(await assemble({ id: restored.id, session: restored })), /dsh-focus-review/)
  session.append('turn/start', { turn: 2 })
  assert.equal(focusContext(await assemble()), '')
})
