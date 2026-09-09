/**
 * dsh-model-router: dispatcher.js
 *
 * 调度器（通用化版）：
 *
 *   1. 协议适配器（HTTP 模型直调）—— protocol 字段决定请求/响应翻译：
 *      - openai-completions:  POST {base}/chat/completions（Bearer 鉴权）
 *      - anthropic-messages:  POST {base}/v1/messages（x-api-key 或 Bearer，可配）
 *      thinking 参数按平台 thinkingStyle 翻译：deepseek({type}) / reasoning-effort / anthropic / none
 *
 *   2. Agent CLI 通用执行器 —— agentCliExec(adapter, opts)：
 *      适配器全部是声明式 JSON（lib/data/agents.json 出厂层 + overrides.agents 用户层），
 *      执行器只认 4 个原语：命令模板({sandbox}/{model} 占位)、promptMode(arg|stdin)、
 *      parseProfile(plain|jsonl-codex|json-envelope)、退出码。新增 CLI = 加一段 JSON，零代码。
 *
 * 凭证：~/.dsh/.credentials.yaml refs 段（llm-pi-ai 同款）→ 进程 env 兜底。key 永不落日志/账本。
 */

import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { effectivePrice, estimateCost } from './pricing.js'

const DEFAULT_TIMEOUT_MS = 180 * 1000

/* ── 凭证 ─────────────────────────────────────────────────────────────── */

export function resolveCredential(home, refName) {
  if (!refName) return null
  if (process.env[refName]) return process.env[refName]
  try {
    const p = resolvePath(home, '.credentials.yaml')
    if (!existsSync(p)) return null
    const text = readFileSync(p, 'utf8')
    const lines = text.split('\n')
    let inRefs = false
    for (const line of lines) {
      if (/^refs:\s*$/.test(line)) { inRefs = true; continue }
      if (inRefs) {
        if (/^\S/.test(line)) break
        const m = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.+?)\s*$/)
        if (m && m[1] === refName) return m[2]
      }
    }
  } catch { /* ignore */ }
  return null
}

/* ── thinking 参数翻译（按平台 thinkingStyle）─────────────────────────── */

function applyThinking(body, thinking, style) {
  if (thinking === 'auto' || !style || style === 'none') return
  if (style === 'deepseek') {
    body.thinking = { type: thinking === 'off' ? 'disabled' : 'enabled' }
  } else if (style === 'reasoning-effort') {
    if (thinking === 'off') body.reasoning_effort = 'minimal'
    else body.reasoning_effort = thinking === 'on' ? 'high' : 'medium'
  } else if (style === 'anthropic') {
    if (thinking === 'on') body.thinking = { type: 'enabled', budget_tokens: 10000 }
    // off = 不带 thinking 字段（Anthropic 默认关）
  }
}

/* ── 协议适配器：openai-completions ───────────────────────────────────── */

function buildOpenAICompletions({ baseURL, apiKey, model, messages, temperature, maxTokens, stream, thinking, thinkingStyle }) {
  const body = { model, messages, stream: !!stream }
  if (temperature !== undefined) body.temperature = temperature
  if (maxTokens) body.max_tokens = maxTokens
  applyThinking(body, thinking, thinkingStyle)
  return {
    url: baseURL.replace(/\/+$/, '') + '/chat/completions',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body,
  }
}

function parseOpenAICompletions(j, streamDelta) {
  if (streamDelta) return { text: streamDelta.content || '', usage: extractOpenAIUsage(j) }
  const msg = j.choices && j.choices[0] && j.choices[0].message
  return { text: (msg && msg.content) || '', usage: extractOpenAIUsage(j) }
}

function extractOpenAIUsage(j) {
  const u = j && j.usage
  if (!u) return null
  return {
    promptTokens: u.prompt_tokens ?? u.promptTokens ?? null,
    completionTokens: u.completion_tokens ?? u.completionTokens ?? null,
    cachedPromptTokens: (u.prompt_tokens_details && (u.prompt_tokens_details.cached_tokens ?? u.prompt_tokens_details.prompt_tokens_cached)) || u.prompt_cache_hit_tokens || null,
  }
}

/* ── 协议适配器：anthropic-messages ───────────────────────────────────── */

function buildAnthropicMessages({ baseURL, apiKey, model, messages, temperature, maxTokens, stream, thinking, thinkingStyle, authStyle }) {
  const system = []
  const chat = []
  for (const m of messages) {
    if (m.role === 'system') system.push(String(m.content || ''))
    else chat.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') })
  }
  const body = { model, messages: chat, max_tokens: maxTokens || 4096 }
  if (system.length) body.system = system.join('\n\n')
  if (temperature !== undefined) body.temperature = temperature
  if (stream) body.stream = true
  applyThinking(body, thinking, thinkingStyle === 'deepseek' ? 'anthropic' : thinkingStyle)
  const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' }
  if (authStyle === 'bearer') headers.Authorization = `Bearer ${apiKey}`
  else headers['x-api-key'] = apiKey
  // baseURL 兼容三种写法：.../v1（追加 /messages）、.../v1/messages（原样）、裸域名（追加 /v1/messages）
  let base = baseURL.replace(/\/+$/, '')
  if (/\/messages$/.test(base)) { /* 原样 */ }
  else if (/\/v\d+$/.test(base)) base = base + '/messages'
  else base = base + '/v1/messages'
  return { url: base, headers, body }
}

function parseAnthropicMessages(j, streamEvent) {
  if (streamEvent) {
    if (streamEvent.type === 'content_block_delta' && streamEvent.delta && streamEvent.delta.type === 'text_delta') {
      return { text: streamEvent.delta.text || '', usage: null }
    }
    return { text: '', usage: null }
  }
  const text = Array.isArray(j.content)
    ? j.content.filter((b) => b.type === 'text').map((b) => b.text || '').join('')
    : ''
  const u = j.usage || {}
  return {
    text,
    usage: {
      promptTokens: u.input_tokens ?? null,
      completionTokens: u.output_tokens ?? null,
      cachedPromptTokens: (u.input_tokens_details && u.input_tokens_details.cache_read_input_tokens) || null,
    },
  }
}

const PROTOCOLS = {
  'openai-completions': { build: buildOpenAICompletions, streamDataLine: true },
  'anthropic-messages': { build: buildAnthropicMessages, streamDataLine: true },
}

/** 按平台协议直调。stream 模式统一聚合增量文本。 */
export async function modelDirectCall(opts) {
  const {
    baseURL, apiKey, model, messages,
    temperature, maxTokens, stream = false,
    timeoutMs = DEFAULT_TIMEOUT_MS, signal,
    thinking = 'auto', thinkingStyle = 'deepseek',
    protocol = 'openai-completions', authStyle,
  } = opts
  if (!baseURL || !model || !Array.isArray(messages)) throw new Error('modelDirectCall: baseURL/model/messages 必填')
  const proto = PROTOCOLS[protocol]
  if (!proto) throw new Error(`不支持的协议 ${protocol}（内置: ${Object.keys(PROTOCOLS).join(', ')}）`)

  const { url, headers, body } = proto.build({ baseURL, apiKey, model, messages, temperature, maxTokens, stream, thinking, thinkingStyle, authStyle })

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs)
  const onAbort = () => ctrl.abort(signal && signal.reason)
  if (signal) { if (signal.aborted) { clearTimeout(timer); throw new Error('aborted') } signal.addEventListener('abort', onAbort, { once: true }) }

  let text = ''
  let usage = null
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal })
    if (!res.ok) {
      const errText = (await res.text().catch(() => '')).slice(0, 500)
      throw Object.assign(new Error(`HTTP ${res.status}: ${errText}`), { httpStatus: res.status })
    }
    if (stream) {
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          const s = line.trim()
          if (!s.startsWith('data:')) continue
          const payload = s.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const j = JSON.parse(payload)
            if (protocol === 'openai-completions') {
              const delta = j.choices && j.choices[0] && j.choices[0].delta
              const r = parseOpenAICompletions(j, delta)
              text += r.text
              if (r.usage) usage = r.usage
            } else {
              const r = parseAnthropicMessages(null, j)
              text += r.text
              if (r.usage) usage = r.usage
            }
          } catch { /* 跳过不完整行 */ }
        }
      }
    } else {
      const j = await res.json()
      const r = protocol === 'openai-completions' ? parseOpenAICompletions(j) : parseAnthropicMessages(j)
      text = r.text
      usage = r.usage
    }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
  return { text, usage }
}

/** 用完一次调用后核算费用（需要目录里的报价条目）。 */
export function costForCall(catalog, platformKey, modelId, usage, now = new Date()) {
  const model = (catalog.models || []).find((m) => m.id === modelId)
  if (!model) return null
  const entry = model.prices && model.prices[platformKey]
  const platform = catalog.platforms && catalog.platforms[platformKey]
  const price = effectivePrice(entry, platform, now)
  if (!price || !usage) return null
  const est = estimateCost(price, usage)
  return est ? { ...est, modelId, platform: platformKey, modelIdOnPlatform: (entry && entry.modelId) || modelId } : null
}

/* ── Agent CLI 通用执行器 ──────────────────────────────────────────────── */

/** 按点路径从对象取值：getByPath({a:{b:1}}, 'a.b') → 1 */
function getByPath(obj, dotted) {
  if (!dotted) return undefined
  let cur = obj
  for (const k of dotted.split('.')) {
    if (cur == null) return undefined
    cur = cur[k]
  }
  return cur
}

/** 展开命令模板：['-s','{sandbox}'] + {sandbox:'read-only'} → ['-s','read-only'] */
function expandTemplate(arr, vars) {
  return (arr || []).map((s) => String(s).replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`)))
}

/**
 * 通用 Agent CLI 执行。adapter 来自 loadAgents()。
 * opts: { prompt, cwd?, sandbox?, model?, timeoutMs? }
 */
export function agentCliExec(adapter, opts) {
  const { prompt, cwd, sandbox = 'workspace-write', model, timeoutMs } = opts
  return new Promise((resolve) => {
    const displayName = adapter.displayName || 'agent'
    const sandboxMap = adapter.sandboxMap || {}
    const sandboxValue = sandboxMap[sandbox]
    if (adapter.sandboxFlag && sandboxValue === undefined) {
      resolve({ ok: false, error: `适配器 ${displayName} 不支持沙箱级别 ${sandbox}（可用: ${Object.keys(sandboxMap).join('/') || '无'}）` })
      return
    }
    const vars = { sandbox: sandboxValue, model }
    const args = [...expandTemplate(adapter.command, vars)]
    if (adapter.sandboxFlag && sandboxValue !== undefined) args.push(...expandTemplate(adapter.sandboxFlag, vars))
    if (model && adapter.modelFlag) args.push(...expandTemplate(adapter.modelFlag, vars))
    if (adapter.separator) args.push(adapter.separator)
    const promptMode = adapter.promptMode || 'arg'
    if (prompt && promptMode === 'arg') args.push(prompt)

    const started = Date.now()
    let child
    try {
      // stdin: arg 模式必须 ignore（多数 agent CLI 检测到 stdin 管道会等待输入，codex 实测踩坑）；
      // stdin 模式则必须开着管道写入 prompt。
      child = spawn(adapter.command[0], args.slice(1), {
        cwd: cwd || undefined,
        env: process.env,
        stdio: [promptMode === 'stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      resolve({ ok: false, error: `spawn ${displayName} 失败: ${e.message}（是否已安装？ detect: ${adapter.detect || adapter.command[0]}）` })
      return
    }
    if (prompt && promptMode === 'stdin' && child.stdin) {
      child.stdin.write(prompt + '\n')
      child.stdin.end()
    }

    let finalMessage = ''
    let usage = null
    let eventCount = 0
    const eventTypes = {}
    let stderr = ''
    let stdoutBuf = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, durationMs: Date.now() - started })
    }
    const timeout = timeoutMs || adapter.defaultTimeoutMs || 600000
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* noop */ }
      finish({ ok: false, error: `${displayName} 超时（${timeout}ms）`, finalMessage, usage, exitCode: null, eventCount, eventTypes, stderr: stderr.slice(0, 500) })
    }, timeout)

    const handleLine = (line) => {
      if (!line) return
      const profile = adapter.parseProfile || 'plain'
      if (profile === 'plain') {
        finalMessage += (finalMessage ? '\n' : '') + line
        eventCount++
        eventTypes.plain = (eventTypes.plain || 0) + 1
        return
      }
      if (profile === 'json-envelope') {
        // 整个 stdout 可能是一个 JSON 对象（可能多行），先攒着，close 时解析
        stdoutBuf += line + '\n'
        return
      }
      // jsonl-codex：每行一个事件对象
      eventCount++
      try {
        const ev = JSON.parse(line)
        const t = ev.type || 'unknown'
        eventTypes[t] = (eventTypes[t] || 0) + 1
        if (t === 'item.completed' && ev.item) {
          const item = ev.item
          if (item.type === 'agent_message' && item.text) finalMessage = item.text
          if (item.type === 'token_count' || item.type === 'token_count_update') {
            const ti = item.info || item.tokenInfo || item
            const last = ti.last_token_usage || ti.lastTokenUsage
            const tot = ti.total_token_usage || ti.totalTokenUsage
            usage = {
              promptTokens: (tot && (tot.input_tokens ?? tot.inputTokens)) ?? (last && (last.input_tokens ?? last.inputTokens)) ?? null,
              completionTokens: (tot && (tot.output_tokens ?? tot.outputTokens)) ?? (last && (last.output_tokens ?? last.outputTokens)) ?? null,
              cachedPromptTokens: (tot && tot.cached_input_tokens) ?? (last && (last.cached_input_tokens ?? (last.input_token_details && last.input_token_details.cached_tokens))) ?? null,
            }
          }
        }
        if (t === 'turn.completed' && ev.usage) {
          usage = {
            promptTokens: ev.usage.input_tokens ?? null,
            completionTokens: ev.usage.output_tokens ?? null,
            cachedPromptTokens: ev.usage.input_token_details && ev.usage.input_token_details.cached_tokens,
          }
        }
      } catch { /* 非 JSON 行按 plain 追加兜底 */ }
    }

    child.stdout.on('data', (chunk) => {
      const s = chunk.toString('utf8')
      if ((adapter.parseProfile || 'plain') === 'json-envelope') { stdoutBuf += s; return }
      stdoutBuf += s
      let idx
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).replace(/\r$/, '')
        stdoutBuf = stdoutBuf.slice(idx + 1)
        handleLine(line)
      }
    })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', (e) => finish({ ok: false, error: `${displayName} 启动失败: ${e.message}（是否已安装？）`, finalMessage, usage, exitCode: null, eventCount, eventTypes }))
    child.on('close', (code) => {
      const okExits = adapter.okExitCodes || [0]
      const ok = okExits.includes(code)
      if ((adapter.parseProfile || 'plain') === 'json-envelope') {
        // 解析整个 stdout 为单个 JSON 信封
        try {
          const j = JSON.parse(stdoutBuf)
          const env = adapter.envelope || {}
          finalMessage = String(getByPath(j, env.finalText) ?? '')
          const um = env.usage || {}
          const u = getByPath(j, um.usage || 'usage') || {}
          usage = {
            promptTokens: getByPath(j, um.promptTokens) ?? null,
            completionTokens: getByPath(j, um.completionTokens) ?? null,
            cachedPromptTokens: getByPath(j, um.cachedPromptTokens) ?? null,
          }
          void u
          eventCount = 1
          eventTypes.envelope = 1
        } catch (e) {
          finish({ ok: false, error: `${displayName} 输出不是合法 JSON: ${e.message}；原文前 300 字: ${stdoutBuf.slice(0, 300)}`, finalMessage, usage, exitCode: code, eventCount, eventTypes })
          return
        }
      }
      if (ok) finish({ ok: true, finalMessage, usage, exitCode: code, eventCount, eventTypes })
      else finish({ ok: false, error: `${displayName} 退出码 ${code}: ${stderr.slice(0, 300) || '(无 stderr)'}`, finalMessage, usage, exitCode: code, eventCount, eventTypes })
    })
  })
}

/** 兼容旧名：codexExec(adapter, opts)。 */
export function codexExec(adapter, opts) {
  return agentCliExec(adapter, opts)
}
