/**
 * dsh-model-router: catalog.js
 *
 * 三层目录合并：出厂默认层(lib/data/models.json) → 用户覆盖层($DSH_HOME/.model-router/overrides.json)
 * → 平台实时层($DSH_HOME/.model-router/platform-cache.json, 由 discovery 拉取的 /models 清单缓存)。
 *
 * 合并语义（深合并、按 id 键）：
 *   - platforms: 每键深合并（用户层可改 displayName/credentialRef/baseURL，可加新平台）
 *   - models:    按 id 合并；prices 按 platform 键合并；capabilities 整体替换（若用户提供了该字段）
 *   - 删除语义: 用户层值设为 null → 该键从合并结果中移除（用于下架某模型/某平台报价）
 *
 * 热更新：本模块不缓存合并结果之外的状态；每次调用 loadCatalog() 重新读盘（文件都很小，避免
 * 陈旧状态）；内存中仅 mtime 检测避免重复 IO。修改任意层文件后下一次工具调用即生效。
 */

import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { resolve as resolvePath, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))

const DEFAULTS_PATH = resolvePath(here, 'data', 'models.json')
const AGENTS_DEFAULTS_PATH = resolvePath(here, 'data', 'agents.json')
export const OVERRIDES_DIRNAME = '.model-router'
export function overridesPath(home) { return resolvePath(home, OVERRIDES_DIRNAME, 'overrides.json') }
export function platformCachePath(home) { return resolvePath(home, OVERRIDES_DIRNAME, 'platform-cache.json') }
export function ledgerPath(home) { return resolvePath(home, OVERRIDES_DIRNAME, 'ledger.json') }

function readJsonSafe(p) {
  try {
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** 记录 {path, mtime} 的微缓存，避免每次工具调用都全量读盘三份文件。 */
const fileCache = new Map()
function readJsonCached(p) {
  let st
  try { st = statSync(p) } catch { fileCache.delete(p); return null }
  const mtime = st.mtimeMs
  const hit = fileCache.get(p)
  if (hit && hit.mtime === mtime) return hit.value
  const value = readJsonSafe(p)
  fileCache.set(p, { mtime, value })
  return value
}

/** 深合并，null 值表示"删除该键"。 */
function mergeValue(base, over) {
  if (over === null) return undefined
  if (Array.isArray(over) || typeof over !== 'object' || over === null) return over
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) {
    const merged = mergeValue(base[k], v)
    if (merged === undefined) delete out[k]
    else out[k] = merged
  }
  return out
}

export function loadCatalog(home) {
  const defaults = readJsonCached(DEFAULTS_PATH) || { platforms: {}, models: [] }
  const overrides = readJsonCached(overridesPath(home)) || {}
  const platformCache = readJsonCached(platformCachePath(home)) || {}

  const platforms = mergeValue(defaults.platforms || {}, overrides.platforms || {}) || {}
  if (platformCache.platforms) {
    for (const [k, v] of Object.entries(platformCache.platforms)) {
      platforms[k] = mergeValue(platforms[k] || {}, v) || platforms[k]
    }
  }

  const byId = new Map()
  for (const m of defaults.models || []) byId.set(m.id, { ...m })
  const modelOverrides = overrides.models || []
  if (Array.isArray(modelOverrides)) {
    for (const mo of modelOverrides) {
      if (!mo || typeof mo.id !== 'string') continue
      if (mo.__delete === true) { byId.delete(mo.id); continue }
      byId.set(mo.id, mergeValue(byId.get(mo.id) || {}, mo) || mo)
    }
  }
  const models = [...byId.values()]

  return {
    version: overrides.version || defaults.version || 'unknown',
    defaultsVersion: defaults.version || 'unknown',
    // 根级配置（如 rates: {base:'CNY', CNY:1, USD:7.1}）用户层覆盖出厂层
    rates: mergeValue(defaults.rates || { base: 'CNY', CNY: 1, USD: 7.1 }, overrides.rates || {}) || { base: 'CNY', CNY: 1, USD: 7.1 },
    platforms,
    models,
  }
}

/** Agent CLI 注册表：出厂层(data/agents.json) → 用户覆盖层(overrides.json 的 agents 段)。 */
export function loadAgents(home) {
  const defaults = readJsonCached(AGENTS_DEFAULTS_PATH) || { agents: {} }
  const overrides = readJsonCached(overridesPath(home)) || {}
  const merged = {}
  for (const [k, v] of Object.entries(defaults.agents || {})) merged[k] = { ...v }
  for (const [k, v] of Object.entries((overrides && overrides.agents) || {})) {
    if (v === null || v.__delete === true) { delete merged[k]; continue }
    merged[k] = mergeValue(merged[k] || {}, v) || v
  }
  return merged
}

/** 原子写 JSON（写临时文件后 rename），供目录管理工具与账本使用。 */
export function writeJsonAtomic(p, value) {
  mkdirSync(dirname(p), { recursive: true })
  const tmp = p + '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, p)
  fileCache.delete(p)
}

export { readJsonSafe, readJsonCached }
