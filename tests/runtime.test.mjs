import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FailureTracker } from '../src/runtime.ts'

const failed = message => ({ isError: true, error: { message }, content: [{ type: 'text', text: message }] })
const succeeded = { isError: false, value: 'ok', content: [{ type: 'text', text: 'ok' }] }

test('首次失败提示调试，重复失败加强提醒，同一操作成功后清除', () => {
  const tracker = new FailureTracker()
  const session = {}
  const args = { command: 'npm test', cwd: '/project' }
  tracker.observe(session, 'bash', args, failed('missing package'))
  assert.match(tracker.reminder(session), /dsh-focus-debugging/)
  assert.doesNotMatch(tracker.reminder(session), /至少两次/)
  tracker.observe(session, 'bash', { cwd: '/project', command: 'npm test' }, failed('missing package'))
  assert.ok(tracker.reminder(session).includes('bash'))
  const note = tracker.reminder(session)
  tracker.observe(session, 'bash', args, failed('missing package'))
  assert.equal(tracker.reminder(session), note)
  tracker.observe(session, 'bash', args, succeeded)
  assert.equal(tracker.reminder(session), '')
})

test('不同参数、原因或会话不会被误判为重复失败', () => {
  const tracker = new FailureTracker()
  const first = {}, second = {}
  tracker.observe(first, 'read', { path: 'a' }, failed('missing'))
  tracker.observe(first, 'read', { path: 'b' }, failed('missing'))
  tracker.observe(first, 'read', { path: 'a' }, failed('denied'))
  tracker.observe(second, 'read', { path: 'a' }, failed('denied'))
  assert.doesNotMatch(tracker.reminder(first), /至少两次/)
  assert.doesNotMatch(tracker.reminder(second), /至少两次/)
  tracker.observe(first, 'read', { path: 'a' }, failed('denied'))
  assert.match(tracker.reminder(first), /至少两次/)
  assert.doesNotMatch(tracker.reminder(second), /至少两次/)
})

test('无关的读取成功不会掩盖失败操作', () => {
  const tracker = new FailureTracker(), session = {}
  tracker.observe(session, 'bash', { command: 'npm test' }, failed('missing package'))
  tracker.observe(session, 'read', { path: 'package.json' }, succeeded)
  tracker.observe(session, 'bash', { command: 'npm test' }, failed('missing package'))
  assert.notEqual(tracker.reminder(session), '')
  tracker.clear(session)
  assert.equal(tracker.reminder(session), '')
})

test('读取调试技能后消除已有提示，新失败仍会重新提示', () => {
  const tracker = new FailureTracker(), session = {}, other = {}
  tracker.observe(session, 'bash', { command: 'npm test' }, failed('assertion failed'))
  assert.match(tracker.reminder(session), /dsh-focus-debugging/)
  tracker.acknowledge(session)
  assert.equal(tracker.reminder(session), '')
  tracker.observe(session, 'bash', { command: 'npm test' }, failed('assertion failed'))
  assert.match(tracker.reminder(session), /至少两次/)
  assert.equal(tracker.reminder(other), '')
  tracker.clear(session)
  assert.equal(tracker.reminder(session), '')
})

test('工具传输成功但命令退出码非零时仍识别为失败', () => {
  const tracker = new FailureTracker(), session = {}
  const result = { isError: false, value: { kind: 'foreground', exitCode: 1, aborted: false, stdout: { text: '' }, stderr: { text: 'build failed' } }, content: [] }
  tracker.observe(session, 'bash', { command: 'npm run build' }, result)
  tracker.observe(session, 'bash', { command: 'npm run build' }, result)
  assert.notEqual(tracker.reminder(session), '')
  assert.equal(result.value.exitCode, 1)
})

const nodeReport = (failed, prefix = 'ℹ') => [
  `${prefix} tests 9`, `${prefix} suites 0`, `${prefix} pass ${9 - failed}`,
  `${prefix} fail ${failed}`, `${prefix} cancelled 0`, `${prefix} skipped 0`,
  `${prefix} todo 0`, `${prefix} duration_ms 52.4`,
].join('\n')
const bashReport = (text, truncated = false) => ({
  isError: false, value: { kind: 'foreground', exitCode: 0, aborted: false,
    stdout: { text, truncated }, stderr: { text: '', truncated: false } }, content: [],
})

test('命令退出码掩盖 Node 测试失败时保留失败提醒，不篡改工具结果', () => {
  for (const prefix of ['ℹ', '#']) {
    const tracker = new FailureTracker(), session = {}
    const args = { command: 'node --test tests.mjs; exit 0' }
    const result = bashReport(nodeReport(1, prefix))
    const original = structuredClone(result)
    tracker.observe(session, 'bash', args, result)
    assert.match(tracker.reminder(session), /测试报告.*失败/)
    assert.match(tracker.reminder(session), /退出码/)
    assert.deepEqual(result, original)
    tracker.observe(session, 'bash', args, bashReport(nodeReport(0, prefix)))
    assert.equal(tracker.reminder(session), '')
  }
})

test('不把片段、截断、矛盾汇总或无关输出当成实际测试失败', () => {
  const inputs = [
    ['cat report.txt', bashReport(nodeReport(1))],
    ['node --test tests.mjs', bashReport('ℹ fail 1')],
    ['node --test tests.mjs', bashReport(nodeReport(1), true)],
    ['node --test tests.mjs', bashReport(nodeReport(1).replace('tests 9', 'tests 100'))],
    ['node --test tests.mjs', bashReport(nodeReport(1) + '\n' + nodeReport(0))],
    ['node --test tests.mjs', bashReport(nodeReport(0))],
  ]
  for (const [command, result] of inputs) {
    const tracker = new FailureTracker(), session = {}
    tracker.observe(session, 'bash', { command }, result)
    assert.equal(tracker.reminder(session), '')
  }
})

test('用户取消不会触发失败提醒', () => {
  const tracker = new FailureTracker(), session = {}
  tracker.observe(session, 'bash', {}, failed('cancelled'), true)
  tracker.observe(session, 'bash', {}, failed('cancelled'), true)
  assert.equal(tracker.reminder(session), '')
})

test('命令工具的界面说明变化不会掩盖重复失败', () => {
  const tracker = new FailureTracker(), session = {}
  tracker.observe(session, 'bash', { command: 'npm test', description: 'Run focused tests' }, failed('missing package'))
  tracker.observe(session, 'bash', { command: 'npm test', description: 'Check test result again' }, failed('missing package'))
  assert.notEqual(tracker.reminder(session), '')
  tracker.observe(session, 'bash', { command: 'npm test', description: 'Verify repaired tests' }, succeeded)
  assert.equal(tracker.reminder(session), '')
})

test('其他工具的描述字段仍参与操作比较', () => {
  const tracker = new FailureTracker(), session = {}
  tracker.observe(session, 'create_event', { description: 'First event' }, failed('invalid event'))
  tracker.observe(session, 'create_event', { description: 'Second event' }, failed('invalid event'))
  assert.match(tracker.reminder(session), /dsh-focus-debugging/)
  assert.doesNotMatch(tracker.reminder(session), /至少两次/)
})

test('不把工具参数和输出中的敏感内容复制到提醒中', () => {
  const tracker = new FailureTracker(), session = {}
  const secret = 'private-token-do-not-repeat'
  const args = { command: secret }
  tracker.observe(session, 'bash', args, failed(secret))
  tracker.observe(session, 'bash', args, failed(secret))
  const note = tracker.reminder(session)
  assert.notEqual(note, '')
  assert.ok(!note.includes(secret))
  assert.ok(note.length < 500)
})
