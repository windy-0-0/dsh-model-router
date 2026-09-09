/**
 * dsh-model-router host half.
 *
 * 模型调度中枢：让当前会话无论跑在哪个模型上，都能按任务需求跨平台调度模型与 Codex。
 *
 * 工具：
 *   - model_route_plan      任务画像 → 排序后的跨平台候选（含价格/置信度/理由）
 *   - model_dispatch        直调任意目录内平台的模型（OpenAI 兼容，流式可选）
 *   - codex_dispatch        派 Codex CLI 非交互干活
 *   - model_ledger          费用账本（按平台/模型汇总）
 *   - model_catalog_manage  目录三层管理（show/upsert/remove/discover）
 *
 * 零外部依赖（node builtins + 同包 lib/*），与 dsh-safety 同款约束：
 * 裸 link: 安装无自身 node_modules，不得 import @deepseek-ai/*。
 * 工具定义手写 JSON Schema 子集。
 *
 * 系统提示词段会告知 agent 本工具族的存在与用法（多模型协作思维）。
 */

import path from 'node:path'
import os from 'node:os'
import { loadCatalog, loadAgents, overridesPath, writeJsonAtomic, readJsonSafe, platformCachePath } from './catalog.js'
import { routePlan, explainChoice, resolveTaskProfile, TASK_PROFILES } from './router.js'
import { resolveCredential, modelDirectCall, costForCall, agentCliExec } from './dispatcher.js'
import { recordCall, summarize } from './ledger.js'

export const name = 'dsh-model-router'
export const inject = ['systemPrompt', 'tools']

function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (Array.isArray(meta.enum)) prop.enum = meta.enum
    if (meta.description) prop.description = meta.description
    if (meta.items) prop.items = { type: meta.items }
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

const textTool = ({ name, description, parameters, execute }) => ({
  name,
  description,
  parameters: toJsonSchema(parameters || {}),
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { ok: { type: 'boolean' }, text: { type: 'string' }, error: { type: 'string' } },
    },
    render: (_args, value) => [{ type: 'text', text: (value && (value.text || value.error)) || '(empty)' }],
  },
  async execute(args) {
    try {
      return await execute(args)
    } catch (e) {
      return { ok: false, text: '', error: `[model-router] ${e && e.message ? e.message : String(e)}` }
    }
  },
})

export function apply(ctx, config = {}) {
  const home = path.resolve(config.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))
  const register = (tool) => ctx.effect(() => ctx.tools.register(tool), `model-router: ${tool.name}`)

  /* ── 系统提示词：多模型调度思维 ─────────────────────────────────────────── */
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'model-router:policy',
    order: 210,
    text: [
      '模型调度中枢 — 由 dsh-model-router 提供。当前会话的模型不是唯一可用模型：遇到任务时，主动考虑跨模型/跨平台协作：',
      '- 接到子任务前，可先调 model_route_plan（给出任务画像：code/reasoning/writing/knowledge/multimodal/speed 六维权重 0-1、minQuality、contextTokens、needsImage 等），得到按 性价比/质量/成本 排序的候选及实时价格与置信度。',
      '- 小/快任务（归类、抽取、轻改写、简单问答）交给 glm-5.3-flash、qwen3.8-flash 一类低价模型；重推理/难编程交 deepseek-v4-pro / glm-5.3；本会话模型保留给主线任务。',
            '- 用 model_dispatch 直调目录中任意平台的模型（OpenAI/Anthropic 兼容协议，不经本会话上下文，独立计费并自动记账）。需要结构化子结果时给它明确指令。',
      '- 需要长自主工作流/独立代码任务时用 agent_dispatch 派外部编码代理干活（codex / opencode / claude-code 等，装了哪个用哪个，agent 参数选；消耗对应平台额度，注意别滥用）。',
      '- 费用意识：每次 dispatch 后看返回的 cost；model_ledger 可查累计。价格置信度低的候选先核价（model_catalog_manage.upsert）再大批量用。',
      '- 目录会过期：模型/价格变化时用 model_catalog_manage.upsert 更新（写用户覆盖层），新平台可 discover 拉模型清单后逐个补价。',
    ].join('\n'),
  }), 'model-router: policy section')

  /* ── model_route_plan ─────────────────────────────────────────────────── */
  register(textTool({
    name: 'model_route_plan',
    description: '给出任务画像，返回跨平台模型候选排序（能力门槛过滤 → Pareto 非支配集 → 偏好排序），每项含实时价格、峰谷状态、置信度与理由。用于决定子任务交给哪个模型/平台最划算。',
    parameters: {
      task: { type: 'string', required: true, description: '任务一句话描述（仅用于展示与上下文）' },
      code: { type: 'number', description: '编程能力权重 0-1' },
      reasoning: { type: 'number', description: '推理能力权重 0-1' },
      writing: { type: 'number', description: '写作能力权重 0-1' },
      knowledge: { type: 'number', description: '知识面权重 0-1' },
      multimodal: { type: 'number', description: '图像/视频理解权重 0-1' },
      speed: { type: 'number', description: '响应速度权重 0-1' },
      minQuality: { type: 'number', description: '质量门槛 0-100，默认 70' },
      profile: { type: 'string', enum: Object.keys(TASK_PROFILES), description: '任务画像预设（未填六维权重的兜底）：code/reasoning/writing/knowledge/multimodal/chat/general。也可不填，由任务文本自动分类' },
      contextTokens: { type: 'number', description: '预计输入 tokens（用于过滤上下文不足的模型）' },
      outputTokens: { type: 'number', description: '预计需要输出 tokens（过滤输出上限不足的模型）' },
      needsImage: { type: 'boolean', description: '任务是否需要图像输入' },
      needsThinking: { type: 'boolean', description: '是否必须支持深度思考' },
      preference: { type: 'string', enum: ['balanced', 'quality', 'cost'], description: '排序偏好：balanced=性价比(默认) quality=质量优先 cost=成本优先' },
      limit: { type: 'number', description: '返回前 N 个候选，默认 8' },
    },
    async execute(args) {
      const catalog = loadCatalog(home)
      const explicitDims = {}
      for (const d of ['code', 'reasoning', 'writing', 'knowledge', 'multimodal', 'speed']) {
        if (typeof args[d] === 'number' && args[d] > 0) explicitDims[d] = args[d]
      }
      const resolved = resolveTaskProfile(
        { dims: Object.keys(explicitDims).length ? explicitDims : null, text: args.task, profile: args.profile },
        { task: args.task },
      )
      const task = {
        dims: resolved.dims,
        _profileSource: resolved.source,
        _profileMatched: resolved.matched || [],
        minQuality: typeof args.minQuality === 'number' ? args.minQuality : undefined,
        contextTokens: args.contextTokens || undefined,
        outputTokens: args.outputTokens || undefined,
        needsImage: args.needsImage === true,
        needsThinking: args.needsThinking === true,
      }
      const plan = routePlan(catalog, task, { preference: args.preference || 'balanced' })
      const limit = Math.max(1, Number(args.limit) || 8)
      const src = task._profileSource
      const matchedNote = task._profileMatched && task._profileMatched.length
        ? '（依据: ' + task._profileMatched.map(([k, n]) => `${k}×${n}`).join(', ') + '）'
        : ''
      const srcNote = src === 'explicit' ? '调用方显式声明六维权重的任务画像' : src.startsWith('profile:') ? `使用画像预设 ${src.slice(8)}` : src.startsWith('auto:') ? `按任务文本自动分类 → ${src.slice(5)}${matchedNote}` : '未提供画像信息，使用通用画像（建议填写权重或 profile 以提升路由精度）'
      const lines = [`任务: ${args.task}`, `任务画像: ${srcNote}`, `排序偏好: ${plan.meta.preference}｜${plan.meta.currencyNote}`, '']
      plan.ranked.slice(0, limit).forEach((c, i) => {
        lines.push(`${i + 1}. ${c.modelId} @ ${c.platformName} (平台模型ID: ${c.modelIdOnPlatform})`)
        lines.push(`   ${explainChoice(c)}`)
      })
      if (plan.ranked.length === 0) lines.push('(无满足门槛且有报价的候选——放宽 minQuality 或检查目录)')
      if (plan.unknownPrice.length > 0) {
        lines.push('', '以下候选暂无核实报价（如需使用请先补价）:')
        plan.unknownPrice.slice(0, 5).forEach((c) => lines.push(`- ${c.modelId} @ ${c.platformName}${c.note ? ' — ' + c.note : ''}`))
      }
      lines.push('', `方法论: ${plan.meta.methodology}`)
      return { ok: true, text: lines.join('\n') }
    },
  }))

  /* ── model_dispatch ───────────────────────────────────────────────────── */
  register(textTool({
    name: 'model_dispatch',
    description: '直调目录中任意平台的模型（OpenAI 兼容 /chat/completions）。不经本会话主模型，独立计费并自动记入账本。适合子任务：分类、抽取、轻量生成、第二意见等。messages 用 OpenAI 格式。',
    parameters: {
      platform: { type: 'string', required: true, description: '平台键（见 model_route_plan 输出或 model_catalog_manage.show），如 tokenrhythm / deepseek-official' },
      model: { type: 'string', required: true, description: '该平台上的模型 ID（如 glm-5.3-flash、deepseek-v4-flash-0731）' },
      prompt: { type: 'string', description: '用户消息内容（与 messages 二选一，简单场景用这个）' },
      system: { type: 'string', description: 'system 消息内容（可选）' },
      messages: { type: 'string', description: '完整 OpenAI messages JSON 数组字符串（复杂对话用这个，优先于 prompt）' },
      maxTokens: { type: 'number', description: '最大输出 tokens' },
      temperature: { type: 'number', description: '采样温度' },
      thinking: { type: 'string', enum: ['auto', 'off', 'on'], description: '思考模式：auto=平台默认，off=关闭（deepseek 协议，轻任务提速），on=强制开启' },
      timeoutMs: { type: 'number', description: '超时毫秒，默认 180000' },
    },
    async execute(args) {
      const catalog = loadCatalog(home)
      const platform = catalog.platforms[args.platform]
      if (!platform) return { ok: false, error: `未知平台 ${args.platform}（model_catalog_manage.show 查看可用平台）` }
      const apiKey = resolveCredential(home, platform.credentialRef)
      if (!apiKey) return { ok: false, error: `平台 ${args.platform} 的凭证 ${platform.credentialRef || '(未配置 credentialRef)'} 未找到（credentials refs / 环境变量）` }

      let messages
      if (args.messages) {
        try { messages = JSON.parse(args.messages) } catch { return { ok: false, error: 'messages 不是合法 JSON' } }
      } else if (args.prompt) {
        messages = []
        if (args.system) messages.push({ role: 'system', content: args.system })
        messages.push({ role: 'user', content: args.prompt })
      } else {
        return { ok: false, error: 'prompt 与 messages 至少提供一个' }
      }

      const t0 = Date.now()
      const result = await modelDirectCall({
        baseURL: platform.baseURL,
        apiKey,
        model: args.model,
        messages,
        maxTokens: args.maxTokens,
        temperature: args.temperature,
        thinking: args.thinking || 'auto',
        thinkingStyle: platform.thinkingStyle || 'deepseek',
        protocol: platform.protocol || 'openai-completions',
        authStyle: platform.authStyle,
        timeoutMs: args.timeoutMs || 180000,
      })
      const durationMs = Date.now() - t0

      // 记账：尝试在目录中匹配规范模型（按 platform 上的 modelId 反查）
      const canonical = (catalog.models || []).find((m) => {
        const e = m.prices && m.prices[args.platform]
        return e && (e.modelId === args.model || m.id === args.model)
      })
      const cost = canonical ? costForCall(catalog, args.platform, canonical.id, result.usage) : null
      const entry = {
        kind: 'model',
        platform: args.platform,
        modelId: canonical ? canonical.id : args.model,
        modelIdOnPlatform: args.model,
        promptTokens: result.usage ? result.usage.promptTokens : null,
        completionTokens: result.usage ? result.usage.completionTokens : null,
        cachedPromptTokens: result.usage ? result.usage.cachedPromptTokens : null,
        cost: cost ? cost.cost : null,
        currency: cost ? cost.currency : (platform.currency || null),
        priceConfidence: cost && canonical ? (canonical.prices[args.platform].confidence || 'unknown') : 'unknown',
        note: `dispatch ${durationMs}ms`,
      }
      recordCall(home, entry)

      const lines = []
      lines.push(result.text || '(空响应)')
      lines.push('', '---')
      const usageLine = result.usage
        ? `tokens: ${result.usage.promptTokens ?? '?'} in / ${result.usage.completionTokens ?? '?'} out${result.usage.cachedPromptTokens ? ` (cache hit ${result.usage.cachedPromptTokens})` : ''}`
        : 'tokens: (平台未返回 usage)'
      lines.push(usageLine + `｜耗时 ${durationMs}ms`)
      if (cost) {
        lines.push(`费用估算: ${cost.cost} ${cost.currency}${cost.breakdown.inputHitTokens ? `（缓存命中 ${cost.breakdown.inputHitTokens} tokens）` : ''}｜价格置信度 ${entry.priceConfidence}`)
      } else {
        lines.push('费用: 目录中无该模型在该平台的报价——用 model_catalog_manage.upsert 补价后可自动记账')
      }
      return { ok: true, text: lines.join('\n') }
    },
  }))

  /* ── agent_dispatch（通用外部 Agent CLI 调度）───────────────────────── */
  register(textTool({
    name: 'agent_dispatch',
    description: '派外部编码代理 CLI 非交互执行独立任务（编程/探索/审查）。支持 agent 由注册表决定（出厂: codex/opencode/claude-code；可在 model_catalog_manage 用 target=agent 增改）。返回最终消息、事件统计与 token 用量。',
    parameters: {
      task: { type: 'string', required: true, description: '给 agent 的完整任务指令（自包含：它看不到本会话上下文）' },
      agent: { type: 'string', description: 'agent 名（默认 codex）。可选项见 model_catalog_manage show 的 agents 段' },
      cwd: { type: 'string', description: '工作目录（默认当前会话工作区）' },
      sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'], description: '沙箱级别，默认 workspace-write（按适配器 sandboxMap 映射到各 CLI 自己的语义）' },
      model: { type: 'string', description: '指定该 agent 使用的模型（传给 CLI 的 --model）' },
      timeoutMs: { type: 'number', description: '超时毫秒，默认 600000（10 分钟）' },
    },
    async execute(args) {
      const agents = loadAgents(home)
      const agentName = args.agent || 'codex'
      const adapter = agents[agentName]
      if (!adapter) {
        return { ok: false, error: `未知 agent "${agentName}"。已注册: ${Object.keys(agents).join(', ')}。新 agent 用 model_catalog_manage upsert target=agent 添加。` }
      }
      const cwd = args.cwd || process.cwd()
      const result = await agentCliExec(adapter, {
        prompt: args.task,
        cwd,
        sandbox: args.sandbox || 'workspace-write',
        model: args.model,
        timeoutMs: args.timeoutMs,
      })
      recordCall(home, {
        kind: 'agent',
        platform: `agent:${agentName}`,
        modelId: args.model || '(default)',
        modelIdOnPlatform: args.model || '(default)',
        promptTokens: result.usage ? result.usage.promptTokens : null,
        completionTokens: result.usage ? result.usage.completionTokens : null,
        cachedPromptTokens: result.usage ? result.usage.cachedPromptTokens : null,
        cost: null,
        currency: null,
        priceConfidence: 'unknown',
        note: `${agentName} ${result.ok ? 'ok' : 'fail'} in ${result.durationMs}ms, events=${result.eventCount || 0}`,
      })
      const lines = []
      lines.push(result.ok ? (result.finalMessage || '(无最终消息，查看事件统计)') : `失败: ${result.error}`)
      lines.push('', '---', `agent: ${agentName} (${adapter.displayName || agentName})｜耗时 ${(result.durationMs / 1000).toFixed(1)}s｜事件数 ${result.eventCount || 0}`)
      if (result.usage) lines.push(`tokens: ${result.usage.promptTokens ?? '?'} in / ${result.usage.completionTokens ?? '?'} out`)
      if (adapter.billingNote) lines.push(`计费说明: ${adapter.billingNote}`)
      const out = { ok: result.ok, text: lines.join('\n') }
      if (!result.ok) out.error = result.error
      return out
    },
  }))

  /* ── model_ledger ─────────────────────────────────────────────────────── */
  register(textTool({
    name: 'model_ledger',
    description: '查看模型调度费用账本：按平台/模型汇总，最近 10 条明细。可传 since (ISO 时间) 只看某时刻之后。',
    parameters: {
      since: { type: 'string', description: 'ISO 时间串，如 2026-09-09T00:00:00Z' },
    },
    async execute(args) {
      const s = summarize(home, args.since)
      const lines = [`账本（since ${s.since}，共 ${s.entriesShown}/${s.totalEntries} 条）`, '']
      lines.push('按平台:')
      for (const [k, v] of Object.entries(s.byPlatform)) {
        lines.push(`- ${k}: ${v.calls} 次｜${v.cost} ${v.currency || '?'}｜${v.promptTokens} in / ${v.completionTokens} out tokens`)
      }
      if (Object.keys(s.byModel).length) {
        lines.push('', '按模型:')
        for (const [k, v] of Object.entries(s.byModel)) {
          lines.push(`- ${k}: ${v.calls} 次｜${v.cost} ${v.currency || '?'}`)
        }
      }
      if (s.recent.length) {
        lines.push('', '最近明细:')
        for (const e of s.recent) {
          lines.push(`- ${e.at} ${e.platform}/${e.model}: ${e.cost ?? '?'} ${e.currency || ''} (${e.tokens})`)
        }
      }
      return { ok: true, text: lines.join('\n') }
    },
  }))

  /* ── model_catalog_manage ─────────────────────────────────────────────── */
  register(textTool({
    name: 'model_catalog_manage',
    description: '管理模型目录（三层：出厂默认 → 用户覆盖 → 平台缓存）。show=浏览；upsert=新增/修改模型或平台（写入用户覆盖层，null 值删除字段，模型加 __delete:true 下架）；remove=删除覆盖恢复默认；discover=拉取平台 /v1/models 模型清单（需凭证）。',
    parameters: {
      action: { type: 'string', required: true, enum: ['show', 'upsert', 'remove', 'discover', 'bench-audit'] },
      target: { type: 'string', enum: ['model', 'platform', 'agent'], description: '操作对象类型（upsert/remove 必填）' },
      id: { type: 'string', description: '模型规范 ID 或平台键（upsert/remove 必填；show 可选过滤）' },
      data: { type: 'string', description: 'upsert 的 JSON 载荷（模型或平台对象，字符串形式）' },
      platform: { type: 'string', description: 'discover 的平台键' },
      adopt: { type: 'boolean', description: 'discover 时为清单中尚无目录条目的模型自动生成条目（价格为 unknown，随后可逐个补价）。默认 false' },
    },
    async execute(args) {
      const catalog = loadCatalog(home)
      if (args.action === 'show') {
        const lines = [`目录版本: ${catalog.version}（出厂 ${catalog.defaultsVersion}）`, '']
        const kw = args.id ? args.id.toLowerCase() : null
        lines.push('平台:')
        for (const [k, p] of Object.entries(catalog.platforms)) {
          if (kw && !k.toLowerCase().includes(kw) && !(p.displayName || '').includes(args.id || '\0')) continue
          lines.push(`- ${k}: ${p.displayName || ''} [${p.protocol}] ${p.baseURL}｜凭证 ${p.credentialRef || '(无)'}｜货币 ${p.currency || '?'}${p.timeVarying ? '｜峰谷计价' : ''}${p.thinkingStyle ? '｜思考:' + p.thinkingStyle : ''}`)
        }
        const agents = loadAgents(home)
        if (Object.keys(agents).length) {
          lines.push('', 'Agent CLI 注册表:')
          for (const [k, a] of Object.entries(agents)) {
            lines.push(`- ${k}: ${a.displayName || k}｜命令 ${JSON.stringify((a.command || []).slice(0, 3))}…｜解析 ${a.parseProfile || 'plain'}｜${a.note || ''}`)
          }
        }
        if (!kw) {
          lines.push('', `模型 (${catalog.models.length}):`)
          for (const m of catalog.models) {
            const priceKeys = Object.keys(m.prices || {})
            lines.push(`- ${m.id} (${m.vendor}): ctx ${Math.round((m.contextWindow || 0) / 1000)}K/out ${Math.round((m.maxTokens || 0) / 1000)}K｜输入 ${(m.input || ['text']).join('+')}｜思考 ${m.thinking ? '✓' : '✗'}｜报价平台 ${priceKeys.join(',') || '(无)'}`)
          }
        }
        return { ok: true, text: lines.join('\n') }
      }

      if (args.action === 'upsert') {
        if (!args.target || !args.id) return { ok: false, error: 'upsert 需要 target(model|platform) 和 id' }
        let data
        try { data = JSON.parse(args.data || '{}') } catch { return { ok: false, error: 'data 不是合法 JSON' } }
        const ov = readJsonSafe(overridesPath(home)) || {}
        if (args.target === 'model') {
          ov.models = Array.isArray(ov.models) ? ov.models : []
          const existing = ov.models.find((m) => m.id === args.id)
          if (existing) Object.assign(existing, data, { id: args.id })
          else ov.models.push({ id: args.id, ...data })
        } else if (args.target === 'agent') {
          ov.agents = ov.agents || {}
          ov.agents[args.id] = { ...(ov.agents[args.id] || {}), ...data }
        } else {
          ov.platforms = ov.platforms || {}
          ov.platforms[args.id] = { ...(ov.platforms[args.id] || {}), ...data }
        }
        writeJsonAtomic(overridesPath(home), ov)
        return { ok: true, text: `已写入用户覆盖层: ${args.target} ${args.id}（下次工具调用即生效；出厂层未动，remove 可恢复）` }
      }

      if (args.action === 'remove') {
        if (!args.target || !args.id) return { ok: false, error: 'remove 需要 target(model|platform|agent) 和 id' }
        const ov = readJsonSafe(overridesPath(home)) || {}
        if (args.target === 'model') {
          if (Array.isArray(ov.models)) {
            ov.models = ov.models.filter((m) => m.id !== args.id)
          }
        } else if (args.target === 'agent') {
          if (ov.agents) delete ov.agents[args.id]
        } else if (ov.platforms) {
          delete ov.platforms[args.id]
        }
        writeJsonAtomic(overridesPath(home), ov)
        return { ok: true, text: `已删除用户覆盖: ${args.target} ${args.id}（恢复出厂默认）` }
      }

      if (args.action === 'discover') {
        if (!args.platform) return { ok: false, error: 'discover 需要 platform' }
        const p = catalog.platforms[args.platform]
        if (!p) return { ok: false, error: `未知平台 ${args.platform}` }
        const apiKey = resolveCredential(home, p.credentialRef)
        if (!apiKey) return { ok: false, error: `平台 ${args.platform} 的凭证未找到` }
        const url = p.baseURL.replace(/\/+$/, '') + '/models'
        const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } })
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
        const j = await res.json()
        const list = Array.isArray(j.data) ? j.data : Array.isArray(j) ? j : []
        const ids = list.map((m) => m.id || m.name || String(m)).filter(Boolean)
        const cache = readJsonSafe(platformCachePath(home)) || {}
        cache.platforms = cache.platforms || {}
        cache.platforms[args.platform] = { discoveredAt: new Date().toISOString(), modelIds: ids }
        writeJsonAtomic(platformCachePath(home), cache)

        // adopt：为清单中尚无目录条目的模型自动生成骨架条目（价格 unknown，路由时归入"暂无报价"组）
        let adopted = 0
        if (args.adopt === true) {
          const ov = readJsonSafe(overridesPath(home)) || {}
          ov.models = Array.isArray(ov.models) ? ov.models : []
          const known = new Set(catalog.models.map((m) => m.id))
          // 已知平台 modelId 也视为已知（避免重复建条目）
          for (const m of catalog.models) {
            const e = m.prices && m.prices[args.platform]
            if (e && e.modelId) known.add(e.modelId)
          }
          for (const mid of ids) {
            if (known.has(mid)) continue
            ov.models.push({
              id: mid, vendor: '(adopted, 待补)', contextWindow: 1000000, maxTokens: 131072,
              input: ['text'], thinking: false,
              capabilities: { code: 50, reasoning: 50, writing: 50, knowledge: 50, multimodal: 0, speed: 50 },
              capabilityConfidence: 'estimated',
              prices: { [args.platform]: { modelId: mid, input: null, output: null, confidence: 'unknown', note: 'discover 自动收录，价格待补' } },
            })
            adopted++
          }
          if (adopted > 0) writeJsonAtomic(overridesPath(home), ov)
        }
        const adoptNote = args.adopt === true
          ? `\n已自动收录 ${adopted} 个新模型骨架（能力/价格为占位，用 upsert 精化）。`
          : '\n（加 adopt:true 可自动为新模型建骨架条目）'
        return { ok: true, text: `拉取到 ${ids.length} 个模型 ID:\n${ids.join('\n')}\n${adoptNote}` }
      }

      if (args.action === 'bench-audit') {
        // 基准数据缺口审计：列出「能力分无公开基准支撑」的模型，指导 benchmarked 数据回填
        const est = catalog.models.filter((m) => (m.capabilityConfidence || 'estimated') === 'estimated')
        const bench = catalog.models.filter((m) => Array.isArray(m.benchmarkRefs) && m.benchmarkRefs.length > 0)
        const hasRealPrice = (p) => !!p && (typeof p.input === 'number' || !!p.cacheMissInput)
        const unknownPrice = catalog.models.filter((m) => Object.values(m.prices || {}).some((p) => !hasRealPrice(p)))
        const lines = [
          `基准数据审计：模型 ${catalog.models.length} 个`,
          `- 能力分有公开基准支撑(benchmarked): ${bench.length} 个${bench.map((m) => ' ' + m.id + '(' + (m.benchmarkRefs || []).map((r) => r.name).join(';') + ')').join('')}`,
          `- 能力分为分层估计(estimated, 待基准回填): ${est.length} 个${est.slice(0, 30).map((m) => ' ' + m.id).join('')}`,
          `- 报价缺失(unknown): ${unknownPrice.length} 个${unknownPrice.map((m) => ' ' + m.id).join('')}`,
          '',
          '回填方法：capabilities 改为 benchmarked 值 + benchmarkRefs:[{name, score, sourceUrl}] 权威出处；',
          '切勿无源填充——能力分是路由心脏，宁缺毋假（规则：无 public 记录则保持 estimated 并靠实测工具补）。',
        ]
        return { ok: true, text: lines.join('\n') }
      }
      return { ok: false, error: `未知 action ${args.action}` }
    },
  }))
}
