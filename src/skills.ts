import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'

const version: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

export const guidance = `DSH 执行增强已启用，当前版本 ${version}。用户最新要求和项目 AGENTS.md 优先，以下方法不增加权限或任务范围。
按任务语义自动调用原生技能工具并读取正文，无需用户点名：
• 需求规划（dsh-focus-planning）：网站、应用和多步功能尚未形成有效计划时。
• 按计划实施（dsh-focus-execution）：已有计划，开始或继续实现时。
• 针对性测试（dsh-focus-testing）：修改业务逻辑、数据处理或修复可复现缺陷，需要验证行为时。
• 定位修复（dsh-focus-debugging）：修复已报告缺陷前，或遇到非预期检查失败、重复失败时。
• 代码检查（dsh-focus-review）：改动公开接口、数据校验、状态行为或多个模块后，或处理代码审查意见时；不以代码行数少为由跳过。
• 交付核对（dsh-focus-delivery）：多项开发要求收尾时。
通常按「需求规划 → 按计划实施（按需穿插针对性测试）→ 代码检查 → 交付核对」推进，出现故障进入定位修复后回到原任务。技能正文会说明下一阶段，不能只读目录摘要。简单问答、明确的文案或外观小改直接处理，不强行走整套流程。
同一任务中本版本已加载且仍适用的技能直接复用；旧版本正文不等于已读过当前版本，已有计划、有效成果与证据仍然沿用。用户要求跳过某流程时遵从。多步任务沿用原生 todo_write，完成一项或切换阶段时更新，不等到交付才补记，也不为每次工具调用更新。用户的状态询问不会取消原任务；补充要求融入当前目标。
默认用中文说明步骤、问题、按钮和交付结果，技术标识、命令及用户要求保留的原文除外；不添加装饰性英文或反复展示技能内部名称。
每次行动对应当前要求、待确认事实或具体失败。复用仍有效的证据，不为收尾额外计算无比较依据的文件哈希、建立快照或重复生成流程文档。清单和提醒不是完成证明。满足完成条件就结束；子代理、提交、推送和发布遵循用户授权。`

function loadSkill(name: string): SkillRegistration {
  const path = fileURLToPath(new URL(`../skills/${name}/SKILL.md`, import.meta.url))
  const text = readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
  const parsed = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n+([\s\S]+)$/.exec(text)
  if (!parsed || parsed[1] !== name || !parsed[3].trim()) throw new Error(`内置技能文档格式无效：${name}`)
  return {
    name, description: parsed[2], content: `版本：${version}。\n\n${parsed[3]}`, path, source: 'bundled',
    invocation: { modelInvocable: true, userInvocable: true },
    resourceBase: { kind: 'directory', path: dirname(path) },
  }
}

export const bundledSkills = [
  'dsh-focus-planning', 'dsh-focus-execution', 'dsh-focus-testing',
  'dsh-focus-debugging', 'dsh-focus-review', 'dsh-focus-delivery',
].map(loadSkill)
