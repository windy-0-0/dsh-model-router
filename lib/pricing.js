/**
 * dsh-model-router: pricing.js
 *
 * 定价引擎。三种价目形态：
 *   1. 平价:   { input, output, cacheRead?, promo? }
 *   2. 峰谷:   { cacheMissInput: {offPeak, peak}, cacheHitInput: {...}, output: {...} }（DeepSeek 官方）
 *   3. 未知:   { input: null, ... }（无报价，路由时按 Infinity 处理并标注）
 *
 * 峰谷判定：DeepSeek 官方文档——周一至周五 01:00-04:00 与 06:00-10:00 UTC 为峰时，
 * 其余为谷时（含周末全天）。价格 = tokens/1M × 单价，货币为平台本位币。
 *
 * 费用计算：区分 cache hit / miss 输入（未提供命中率时全按 miss 估算，输出保守）。
 */

const HOUR_MS = 3600 * 1000

/** 当前是否处于峰时。now 可注入以便测试。 */
export function isPeakNow(platform, now = new Date()) {
  const tv = platform && platform.timeVarying
  if (!tv || !Array.isArray(tv.peakUtcHourRanges)) return false
  if (tv.weekdaysOnly) {
    const day = now.getUTCDay()
    if (day === 0 || day === 6) return false
  }
  const h = now.getUTCHours()
  return tv.peakUtcHourRanges.some(([from, to]) => h >= from && h < to)
}

/** 展平一份报价为「此刻」的即时单价（每 1M tokens，平台本位币）。 */
export function effectivePrice(entry, platform, now = new Date()) {
  if (!entry) return null
  if (entry.input === null || entry.output === null) return null
  if (entry.cacheMissInput && entry.output && typeof entry.output === 'object') {
    const peak = isPeakNow(platform, now)
    const pick = (o) => (o === undefined || o === null ? null : peak ? o.peak : o.offPeak)
    const input = pick(entry.cacheMissInput)
    const output = pick(entry.output)
    if (input === null || output === null) return null
    return {
      input,
      output,
      cacheRead: pick(entry.cacheHitInput) ?? 0,
      peak,
      currency: platform ? platform.currency : 'CNY',
      confidence: entry.confidence || 'unknown',
      sourceUrl: entry.sourceUrl || (platform && platform.sourceUrl) || null,
    }
  }
  return {
    input: entry.input,
    output: entry.output,
    cacheRead: entry.cacheRead ?? 0,
    peak: false,
    currency: platform ? platform.currency : 'CNY',
    confidence: entry.confidence || 'unknown',
    sourceUrl: entry.sourceUrl || (platform && platform.sourceUrl) || null,
    promo: entry.promo || null,
  }
}

/**
 * 估算一次调用的费用（平台本位币）。
 * usage: { promptTokens, completionTokens, cachedPromptTokens? }
 */
export function estimateCost(price, usage) {
  if (!price || !usage) return null
  const inMiss = Math.max(0, (usage.promptTokens || 0) - (usage.cachedPromptTokens || 0))
  const inHit = usage.cachedPromptTokens || 0
  const out = usage.completionTokens || 0
  const cost =
    (inMiss / 1e6) * price.input +
    (inHit / 1e6) * price.cacheRead +
    (out / 1e6) * price.output
  return {
    cost: Math.round(cost * 1e6) / 1e6,
    currency: price.currency,
    breakdown: {
      inputMissTokens: inMiss,
      inputHitTokens: inHit,
      outputTokens: out,
      inputUnit: price.input,
      cacheUnit: price.cacheRead,
      outputUnit: price.output,
    },
  }
}

/** 典型 agent 会话的成本估算（供路由排序用）：20 万输入 / 5 万输出，无缓存。 */
export function typicalSessionCost(price) {
  if (!price) return Infinity
  return (0.2 * price.input + 0.05 * price.output)
}
