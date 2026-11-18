import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

interface Attempt { name: string; reason: string; repeated: boolean; acknowledged: boolean; masked: boolean }

const isShellTool = (name: string): boolean => name === 'bash' || name === 'pwsh'

function callKey(name: string, args: unknown): string | undefined {
  try {
    // 原生命令工具的 description 仅用于界面展示，不改变实际操作。
    const inputs = isShellTool(name) && args !== null && typeof args === 'object' && !Array.isArray(args)
      ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'description')) : args
    const value = JSON.stringify(inputs, (_key, item) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return item
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    })
    // 限制精确比较的大小，不引入可能误判的摘要。
    return value !== undefined && value.length <= 16_384 ? `${name}\n${value}` : undefined
  } catch { return undefined }
}

function hasFailedNodeReport(args: unknown, stdout: unknown, stderr: unknown): boolean {
  if (!args || typeof args !== 'object' || !('command' in args) || typeof args.command !== 'string'
    || !/\bnode(?:\.exe)?["']?\s+(?:--[\w=-]+\s+)*--test(?:\s|=|$)/.test(args.command)) return false
  const streams: string[] = []
  for (const stream of [stdout, stderr]) {
    if (!stream || typeof stream !== 'object' || !('text' in stream) || typeof stream.text !== 'string'
      || ('truncated' in stream && stream.truncated === true) || stream.text.length > 16_384) return false
    streams.push(stream.text)
  }
  const text = streams.join('\n').replace(/\u001b\[[0-9;]*m/g, '')
  // 只认完整且唯一的 Node 原生汇总，不从任意日志中的 fail/error 字样猜测。
  const reports = [...text.matchAll(/^(ℹ|#) tests (\d+)\r?\n\1 suites \d+\r?\n\1 pass (\d+)\r?\n\1 fail (\d+)\r?\n\1 cancelled (\d+)\r?\n\1 skipped (\d+)\r?\n\1 todo (\d+)\r?\n\1 duration_ms [\d.]+\s*$/gm)]
  if (reports.length !== 1) return false
  const [, , total, passed, failed, cancelled, skipped, todo] = reports[0]!.map(Number)
  return failed! > 0 && total === passed! + failed! + cancelled! + skipped! + todo!
}

function failureReason(name: string, args: unknown, result: ToolExecutionResult): { reason: string; masked: boolean } | undefined {
  if (result.isError) return { reason: `${result.error.info?.code ?? ''}\n${result.error.message}`, masked: false }
  // 工具传输成功不代表命令成功，需要检查前台命令退出码。
  const value = result.value
  if (!isShellTool(name) || value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (value.kind !== 'foreground' || value.aborted === true || typeof value.exitCode !== 'number') return undefined
  const masked = value.exitCode === 0 && hasFailedNodeReport(args, value.stdout, value.stderr)
  if (value.exitCode === 0 && !masked) return undefined
  return { reason: JSON.stringify({ exitCode: value.exitCode, stdout: value.stdout, stderr: value.stderr }), masked }
}

/** 只观察最终结果，不修改结果或阻止工具执行。 */
export class FailureTracker {
  private readonly sessions = new WeakMap<object, Map<string, Attempt>>()

  observe(session: object, name: string, args: unknown, result: ToolExecutionResult, aborted = false): void {
    if (aborted) return
    const key = callKey(name, args)
    if (key === undefined) return
    const failure = failureReason(name, args, result)
    let attempts = this.sessions.get(session)
    if (failure === undefined) { attempts?.delete(key); return }
    const { reason, masked } = failure
    if (reason.length > 16_384) return
    if (!attempts) { attempts = new Map(); this.sessions.set(session, attempts) }
    const previous = attempts.get(key)
    attempts.delete(key)
    attempts.set(key, { name, reason, repeated: previous?.reason === reason, acknowledged: false, masked })
    if (attempts.size > 24) attempts.delete(attempts.keys().next().value!)
  }

  clear(session: object): void { this.sessions.delete(session) }

  acknowledge(session: object): void {
    for (const attempt of this.sessions.get(session)?.values() ?? []) attempt.acknowledged = true
  }

  reminder(session: object): string {
    const pending = [...(this.sessions.get(session)?.values() ?? [])].filter(item => !item.acknowledged)
    if (!pending.length) return ''
    const report = pending.some(item => item.masked)
      ? '测试报告提醒：退出码为 0，但完整测试报告显示失败。以报告和后续实测为准。\n' : ''
    const repeated = pending.filter(item => item.repeated).slice(-3)
    if (!repeated.length) {
      const name = JSON.stringify(pending.at(-1)!.name.slice(0, 80))
      return report + `工具 ${name} 曾失败。先看已有结果，原因不明时按需查定位修复（dsh-focus-debugging）。`
    }
    const names = [...new Set(repeated.map(item => item.name))].map(name => JSON.stringify(name.slice(0, 80))).join('、')
    return report + `工具 ${names} 同参数至少两次返回相同失败。换方法，原因不明时查定位修复（dsh-focus-debugging）。`
  }
}
