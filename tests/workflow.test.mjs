import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflowProjection, renderWorkflow } from '../src/workflow.ts'

function scenario() {
  let state = workflowProjection.init(), sequence = 0
  const append = (type, data) => { state = workflowProjection.apply(state, { type, data }) }
  const complete = (callId, isError = false) => append('tool/result', { message: { toolCallId: callId, isError } })
  const call = (name, args = {}, isError = false) => {
    const callId = `call-${++sequence}`
    append('tool/call', { name, arguments: JSON.stringify(args), callId })
    complete(callId, isError)
  }
  return { append, complete, call, note: () => renderWorkflow(state), state: () => state }
}

test('有计划时提示实施，修改后提示检查，读取检查后提示交付', () => {
  const flow = scenario()
  flow.call('skill', { name: 'dsh-focus-planning' })
  assert.equal(flow.note(), '')
  flow.append('todo/write', { todos: [{ content: '实现', status: 'in_progress' }, { content: '验证', status: 'pending' }] })
  assert.match(flow.note(), /dsh-focus-execution/)
  flow.call('skill', { name: 'dsh-focus-execution' })
  assert.equal(flow.note(), '')
  flow.call('edit', { file_path: '/sample/app.mjs' })
  assert.match(flow.note(), /dsh-focus-review/)
  flow.call('bash', { command: 'node --test' })
  assert.match(flow.note(), /dsh-focus-review/)
  flow.call('skill', { name: 'dsh-focus-review' }, true)
  assert.match(flow.note(), /dsh-focus-review/)
  flow.call('skill', { name: 'dsh-focus-review' })
  assert.match(flow.note(), /dsh-focus-delivery/)
  flow.call('skill', { name: 'dsh-focus-delivery' })
  assert.equal(flow.note(), '')
})

test('普通小改不触发阶段流程，失败与取消不假装推进，新轮次和会话互不干扰', () => {
  const flow = scenario(), other = scenario()
  flow.call('edit', { file_path: '/sample/readme.md' })
  assert.equal(flow.note(), '')
  flow.call('skill', { name: 'dsh-focus-debugging' })
  flow.call('edit', {}, true)
  flow.append('tool/call', { callId: 'cancelled', name: 'edit', arguments: '{}' })
  flow.complete('cancelled', true)
  flow.complete('unrelated-success')
  assert.equal(flow.note(), '')
  flow.call('edit')
  assert.match(flow.note(), /dsh-focus-review/)
  assert.equal(other.note(), '')
  flow.append('turn/start', { turn: 2 })
  flow.complete('cancelled')
  assert.equal(flow.note(), '')
})

test('读取检查和交付后继续修改代码，会重新提示核对最新变更', () => {
  const flow = scenario()
  flow.call('skill', { name: 'dsh-focus-debugging' })
  flow.call('edit')
  flow.call('skill', { name: 'dsh-focus-review' })
  flow.call('skill', { name: 'dsh-focus-delivery' })
  flow.call('edit')
  assert.match(flow.note(), /再次修改/)
  assert.match(flow.note(), /最新变更/)
  assert.match(flow.note(), /不必.*重跑全部/)
  flow.call('skill', { name: 'dsh-focus-delivery' })
  assert.equal(flow.note(), '')
})

test('长会话沿用方法时仍提示本轮检查，不复用上一轮完成状态', () => {
  const flow = scenario()
  flow.call('skill', { name: 'dsh-focus-debugging' })
  flow.call('edit')
  flow.call('skill', { name: 'dsh-focus-review' })
  flow.call('skill', { name: 'dsh-focus-delivery' })
  flow.append('turn/start', { turn: 2 })
  assert.equal(flow.note(), '')
  flow.call('edit')
  assert.match(flow.note(), /dsh-focus-review/)
  assert.doesNotMatch(flow.note(), /已读取结果检查方法/)
})

test('只保存有界调用标识，不存文件内容，无关事件不制造状态更新', () => {
  const flow = scenario()
  flow.call('skill', { name: 'dsh-focus-debugging' })
  for (let i = 0; i < 40; i++) {
    flow.append('tool/call', { callId: `edit-${i}`, name: 'edit', arguments: 'private-source-content' })
  }
  assert.equal(flow.state().pending.length, 32)
  assert.ok(!JSON.stringify(flow.state()).includes('private-source-content'))
  const before = flow.state()
  flow.append('tool/call', { callId: 'bad-json', name: 'skill', arguments: '{' })
  flow.append('assistant/message', {})
  assert.equal(flow.state(), before)
  flow.complete('edit-0')
  assert.equal(flow.state(), before)
  flow.complete('edit-39')
  assert.match(flow.note(), /dsh-focus-review/)
})

test('只读资料的清单进展也提示结果检查，更新完成清单不会制造重查循环', () => {
  const flow = scenario()
  flow.call('skill', { name: 'dsh-focus-planning' })
  const todos = [{ content: '提取三份报价', status: 'in_progress' }, { content: '核对条件并给出建议', status: 'pending' }]
  flow.append('todo/write', { todos })
  flow.call('skill', { name: 'dsh-focus-execution' })
  flow.call('read', { file_path: '/sample/报价.md' })
  assert.equal(flow.note(), '')
  flow.append('todo/write', { todos: [{ ...todos[0], status: 'completed' }, { ...todos[1], status: 'in_progress' }] })
  assert.match(flow.note(), /dsh-focus-review/)
  flow.call('skill', { name: 'dsh-focus-review' })
  assert.match(flow.note(), /dsh-focus-delivery/)
  flow.call('skill', { name: 'dsh-focus-delivery' })
  flow.append('todo/write', { todos: todos.map(item => ({ ...item, status: 'completed' })) })
  assert.equal(flow.note(), '')
  flow.append('turn/start', { turn: 2 })
  assert.equal(flow.note(), '')
})
