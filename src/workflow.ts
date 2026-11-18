import z from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

const stateSchema = z.object({
  active: z.boolean(), changed: z.boolean(), progressed: z.boolean(), planDone: z.boolean(),
  reviewRead: z.boolean(), recheck: z.boolean(),
  // 单个原生清单调用，或该调用完整结果在会话表面中的位置。
  planSource: z.union([z.string(), z.number().int().nonnegative()]).nullable(),
  pending: z.array(z.object({ callId: z.string(), name: z.string() })).max(32),
})
type WorkflowState = z.infer<typeof stateSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { missherFocusWorkflow: WorkflowState }
}

const initial = (): WorkflowState => ({
  active: false, changed: false, progressed: false, planDone: false,
  reviewRead: false, recheck: false, planSource: null, pending: [],
})
const workflowSkills = new Set([
  'dsh-focus-planning', 'dsh-focus-execution', 'dsh-focus-testing',
  'dsh-focus-debugging', 'dsh-focus-review', 'dsh-focus-delivery',
])

/** 复用原生日志恢复阶段，只记录工具名称和调用编号，不保存源码或命令。 */
export const workflowProjection: ProjectionDefinition<'missherFocusWorkflow', WorkflowState> = {
  key: 'missherFocusWorkflow', stateVersion: 4, stateSchema, init: initial,
  apply(state, event) {
    if (event.type === 'turn/start') return initial()
    if (String(event.type) === 'compaction/prune' && state.planSource !== null) {
      return { ...state, planSource: null }
    }
    if (event.type === 'todo/write') {
      const { todos } = event.data
      const multiStep = todos.length > 1
      const progressed = multiStep && todos.some(item => item.status === 'completed')
      const active = state.active || progressed || (multiStep && todos.some(item => item.status === 'in_progress'))
      const planDone = multiStep && todos.every(item => item.status === 'completed')
      const calls = state.pending.filter(item => item.name === 'todo_write')
      return { ...state, active, progressed, planDone, planSource: calls.length === 1 ? calls[0]!.callId : null }
    }
    if (event.type === 'tool/call') {
      let name = event.data.name
      if (name === 'skill') {
        if (event.data.arguments.length > 1024) return state
        try {
          const args: unknown = JSON.parse(event.data.arguments)
          if (!args || typeof args !== 'object' || !('name' in args)
            || typeof args.name !== 'string' || !workflowSkills.has(args.name)) return state
          name = args.name
        } catch { return state }
      } else if (name !== 'todo_write' && (!state.active || !['write', 'edit', 'apply_patch'].includes(name))) return state
      return { ...state, pending: [...state.pending.filter(item => item.callId !== event.data.callId),
        { callId: event.data.callId, name }].slice(-32) }
    }
    if (event.type !== 'tool/result') return state
    const call = state.pending.find(item => item.callId === event.data.message.toolCallId)
    if (!call) return state
    const next = { ...state, pending: state.pending.filter(item => item !== call) }
    if (call.name === 'todo_write') {
      if (state.planSource === call.callId) next.planSource = event.data.message.isError ? null : event.seq
      return next
    }
    // 原生取消与工具失败均以 isError 记录，不能视为已读取或已修改。
    if (event.data.message.isError) return next
    if (workflowSkills.has(call.name)) {
      next.active = true
      if (call.name === 'dsh-focus-review' || call.name === 'dsh-focus-delivery') {
        next.reviewRead = true
        next.recheck = false
      }
    } else {
      next.changed = true
      next.recheck = next.recheck || next.reviewRead || next.planDone
    }
    return next
  },
}

export function renderWorkflow(state: WorkflowState | undefined): string {
  if (!state?.active) return ''
  if (state.recheck) return '再次修改了文件，只复查最新变更影响的部分。'
  if ((state.changed || state.progressed) && !state.reviewRead) return '交付前核对实际成果和关键证据。'
  return ''
}
