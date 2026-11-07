import z from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

const stateSchema = z.object({
  active: z.boolean(), plan: z.boolean(), execution: z.boolean(), changed: z.boolean(),
  review: z.boolean(), delivery: z.boolean(), recheck: z.boolean(),
  pending: z.array(z.object({ callId: z.string(), name: z.string() })).max(32),
})
type WorkflowState = z.infer<typeof stateSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { missherFocusWorkflow: WorkflowState }
}

const initial = (): WorkflowState => ({
  active: false, plan: false, execution: false, changed: false,
  review: false, delivery: false, recheck: false, pending: [],
})
const workflowSkills = new Set([
  'dsh-focus-planning', 'dsh-focus-execution', 'dsh-focus-testing',
  'dsh-focus-debugging', 'dsh-focus-review', 'dsh-focus-delivery',
])

/** 复用原生日志恢复阶段，只记录工具名称和调用编号，不保存源码或命令。 */
export const workflowProjection: ProjectionDefinition<'missherFocusWorkflow'> = {
  key: 'missherFocusWorkflow', stateVersion: 2, stateSchema, init: initial,
  apply(state, event) {
    // 沿用会话已经选择的方法；上一轮的修改、检查和交付进度不沿用。
    if (event.type === 'turn/start') return { ...initial(), active: state.active }
    if (event.type === 'todo/write') {
      const plan = event.data.todos.length > 1 && event.data.todos.some(item => item.status === 'in_progress')
      return plan === state.plan ? state : { ...state, plan }
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
      } else if (!state.active || (name !== 'write' && name !== 'edit')) return state
      return { ...state, pending: [...state.pending.filter(item => item.callId !== event.data.callId),
        { callId: event.data.callId, name }].slice(-32) }
    }
    if (event.type !== 'tool/result') return state
    const call = state.pending.find(item => item.callId === event.data.message.toolCallId)
    if (!call) return state
    const next = { ...state, pending: state.pending.filter(item => item !== call) }
    // 原生取消与工具失败均以 isError 记录，不能视为已读取或已修改。
    if (event.data.message.isError) return next
    if (workflowSkills.has(call.name)) {
      next.active = true
      if (call.name === 'dsh-focus-execution') next.execution = true
      if (call.name === 'dsh-focus-review') { next.review = true; next.recheck = false; next.delivery = false }
      if (call.name === 'dsh-focus-delivery') { next.delivery = true; next.recheck = false }
    } else {
      next.changed = true
      next.recheck = next.review || next.delivery
      next.delivery = false
    }
    return next
  },
}

export function renderWorkflow(state: WorkflowState | undefined): string {
  if (!state?.active) return ''
  if (state.recheck) {
    return '阶段提醒：读取检查或交付方法后又再次修改了文件。请针对最新变更核对受影响的行为，必要时补充相关验证；先前证据只适用于未受影响的部分。可以沿用已读方法，不必重复加载技能或重跑全部检查。确认后再按「交付核对」（dsh-focus-delivery）说明结果。'
  }
  if (state.plan && !state.execution && !state.changed) {
    return '阶段提醒：已形成原生清单。如用户已要求实现，请加载或沿用本版本「按计划实施」（dsh-focus-execution），从当前步骤连续推进；用户只要方案时交付方案即可。'
  }
  if (state.changed && !state.review) {
    return '阶段提醒：本轮开发已通过原生工具修改文件。继续完成当前实现和必要验证；交付前加载或沿用本版本「代码检查」（dsh-focus-review），核对接口、数据校验和状态行为。仅文案或外观小改按原要求检查即可。文件写入成功不代表功能完成。'
  }
  if (state.changed && state.review && !state.delivery) {
    return '阶段提醒：已读取代码检查方法。完成本次检查及必要修复后，进入本版本「交付核对」（dsh-focus-delivery），复用有效证据并说明实际结果。读取技能本身不是已经检查或完成的证明。'
  }
  return ''
}
