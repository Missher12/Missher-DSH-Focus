import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { FailureTracker } from './runtime.ts'
import { focusProjection, renderPlan } from './plan.ts'
import { workflowProjection, renderWorkflow } from './workflow.ts'
import { bundledSkills, guidance } from './skills.ts'

export const name = 'dsh-focus'
export const inject = ['systemPrompt', 'skills', 'tools', 'sessionProjections']

// 0.2.2 返回就绪句柄；0.2.1 返回释放函数，仍通过旧注册表读取。
function stateReader<S>(registered: unknown, legacy: (session: Session) => unknown): (session: Session) => S | undefined {
  if (registered !== null && typeof registered === 'object' && 'stateOf' in registered && typeof registered.stateOf === 'function') {
    const stateOf = registered.stateOf
    return session => stateOf.call(registered, session) as S
  }
  return session => legacy(session) as S | undefined
}

export async function apply(ctx: Context): Promise<void> {
  const failures = new FailureTracker()
  for (const skill of bundledSkills) ctx.skills.register(skill)
  const planRegistration = await ctx.sessionProjections.register(focusProjection)
  const workflowRegistration = await ctx.sessionProjections.register(workflowProjection)
  const planOf = stateReader<ReturnType<typeof focusProjection.init>>(planRegistration,
    session => ctx.sessionProjections.stateOf(session, 'missherFocus'))
  const workflowOf = stateReader<ReturnType<typeof workflowProjection.init>>(workflowRegistration,
    session => ctx.sessionProjections.stateOf(session, 'missherFocusWorkflow'))
  ctx.systemPrompt.section({
    name: 'missher-focus-guidance', order: 6500, interpolate: false,
    text: ({ agent }) => agent ? guidance : '',
  })
  ctx.systemPrompt.context({
    name: 'missher-focus-progress', order: 6500, interpolate: false,
    text: ({ agent }) => {
      if (!agent) return ''
      const plan = planOf(agent.session) ?? []
      const workflow = workflowOf(agent.session)
      return [renderPlan(plan), failures.reminder(agent.session), renderWorkflow(workflow)].filter(Boolean).join('\n\n')
    },
  })
  ctx.on('tools/result', (exec, result) => {
    if (!exec.agent) return
    failures.observe(exec.agent.session, exec.name, exec.arguments, result, exec.signal.aborted)
    const args = exec.arguments
    if (!exec.signal.aborted && !result.isError && exec.name === 'skill'
      && args !== null && typeof args === 'object' && 'name' in args && args.name === 'dsh-focus-debugging') {
      failures.acknowledge(exec.agent.session)
    }
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      failures.clear(session)
    }
  })
}
