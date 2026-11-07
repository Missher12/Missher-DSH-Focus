import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { FailureTracker } from './runtime.ts'
import { focusProjection, renderPlan } from './plan.ts'
import { workflowProjection, renderWorkflow } from './workflow.ts'
import { bundledSkills, guidance } from './skills.ts'

export const name = 'dsh-focus'
export const inject = ['systemPrompt', 'skills', 'tools', 'sessionProjections']

export function apply(ctx: Context): void {
  const failures = new FailureTracker()
  for (const skill of bundledSkills) ctx.skills.register(skill)
  ctx.sessionProjections.register(focusProjection)
  ctx.sessionProjections.register(workflowProjection)
  ctx.systemPrompt.section({
    name: 'missher-focus-guidance', order: 6500, interpolate: false,
    text: ({ agent }) => agent ? guidance : '',
  })
  ctx.systemPrompt.context({
    name: 'missher-focus-progress', order: 6500, interpolate: false,
    text: ({ agent }) => {
      if (!agent) return ''
      const plan = ctx.sessionProjections.stateOf(agent.session, 'missherFocus') ?? []
      const workflow = ctx.sessionProjections.stateOf(agent.session, 'missherFocusWorkflow')
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
