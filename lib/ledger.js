/**
 * dsh-model-router: ledger.js
 *
 * 费用账本：记录每次直调/codex 调用的 tokens 与费用（按平台本位币），
 * 持久化到 $DSH_HOME/.model-router/ledger.json。结构：
 *
 * {
 *   "entries": [ { at, kind: 'model'|'codex', platform, modelId, modelIdOnPlatform,
 *                  promptTokens, completionTokens, cachedPromptTokens,
 *                  cost, currency, priceConfidence, peak, note } ],
 *   "totals": { byPlatform: { tokenrhythm: {cost, currency, calls, tokens} } }
 * }
 *
 * 只保留最近 N=2000 条（防无限膨胀），totals 按全量滚动累计。
 */

import { readJsonSafe, writeJsonAtomic, ledgerPath } from './catalog.js'

const MAX_ENTRIES = 2000

export function loadLedger(home) {
  const l = readJsonSafe(ledgerPath(home))
  if (l && Array.isArray(l.entries)) {
    l.totals = l.totals && typeof l.totals === 'object' ? l.totals : { byPlatform: {} }
    return l
  }
  return { entries: [], totals: { byPlatform: {} } }
}

export function recordCall(home, entry) {
  const l = loadLedger(home)
  l.entries.push({ at: new Date().toISOString(), ...entry })
  if (l.entries.length > MAX_ENTRIES) l.entries = l.entries.slice(-MAX_ENTRIES)
  const key = entry.platform || 'unknown'
  const t = (l.totals.byPlatform[key] ||= { cost: 0, calls: 0, promptTokens: 0, completionTokens: 0, currency: entry.currency || null })
  t.calls += 1
  t.promptTokens += entry.promptTokens || 0
  t.completionTokens += entry.completionTokens || 0
  t.cost = Math.round((t.cost + (entry.cost || 0)) * 1e6) / 1e6
  if (entry.currency) t.currency = entry.currency
  writeJsonAtomic(ledgerPath(home), l)
  return entry
}

export function summarize(home, sinceIso) {
  const l = loadLedger(home)
  const cutoff = sinceIso ? Date.parse(sinceIso) : null
  const entries = Number.isFinite(cutoff)
    ? l.entries.filter((e) => Date.parse(e.at) >= cutoff)
    : l.entries
  const byPlatform = {}
  const byModel = {}
  for (const e of entries) {
    const pk = e.platform || 'unknown'
    byPlatform[pk] ||= { cost: 0, currency: e.currency || null, calls: 0, promptTokens: 0, completionTokens: 0 }
    byPlatform[pk].cost = Math.round((byPlatform[pk].cost + (e.cost || 0)) * 1e6) / 1e6
    byPlatform[pk].calls += 1
    byPlatform[pk].promptTokens += e.promptTokens || 0
    byPlatform[pk].completionTokens += e.completionTokens || 0
    const mk = `${pk}/${e.modelId || e.kind || '?'}`
    byModel[mk] ||= { cost: 0, currency: e.currency || null, calls: 0 }
    byModel[mk].cost = Math.round((byModel[mk].cost + (e.cost || 0)) * 1e6) / 1e6
    byModel[mk].calls += 1
  }
  return {
    since: sinceIso || '(all)',
    entriesShown: entries.length,
    totalEntries: l.entries.length,
    byPlatform,
    byModel,
    recent: entries.slice(-10).map((e) => ({
      at: e.at, kind: e.kind, platform: e.platform, model: e.modelId || e.modelIdOnPlatform || '-',
      cost: e.cost, currency: e.currency, tokens: `${e.promptTokens || 0}in/${e.completionTokens || 0}out`,
      priceConfidence: e.priceConfidence, note: e.note,
    })),
  }
}
