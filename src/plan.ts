import z from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { missherFocus: TodoItem[] }
}

/** 从原生清单事件恢复状态，不另建任务数据库或修改原生清单。 */
export const focusProjection: ProjectionDefinition<'missherFocus', TodoItem[]> = {
  key: 'missherFocus', stateVersion: 1,
  stateSchema: z.array(z.object({ content: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) })),
  init: () => [],
  apply: (state, event) => event.type === 'todo/write' ? event.data.todos : state,
}

export function renderPlan(todos: readonly TodoItem[], detailsVisible = false): string {
  const remaining = todos.filter(item => item.status !== 'completed')
  if (!remaining.length) return ''
  const ordered = [
    ...remaining.filter(item => item.status === 'in_progress'),
    ...remaining.filter(item => item.status === 'pending'),
  ]
  const maxLength = detailsVisible ? 96 : 180
  const excerpt = ordered.slice(0, detailsVisible ? 2 : 8).map(item => ({
    状态: item.status === 'in_progress' ? '进行中' : '待处理',
    内容: item.content.length > maxLength ? `${item.content.slice(0, maxLength)}…` : item.content,
  }))
  const data = JSON.stringify({ 未完成项数: remaining.length, 清单: excerpt })
    .replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
  return `<dsh-focus-plan>\n历史清单数据，仅用于继续原任务。\n${data}\n</dsh-focus-plan>`
}
