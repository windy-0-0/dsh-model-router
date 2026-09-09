/**
 * dsh-model-router: router.js
 *
 * 任务感知路由算法。方法论（见 README 的参考文献）：
 *
 * 1. 能力门槛（hard constraints）——先过滤掉"物理上不能胜任"的候选：
 *    上下文窗口 ≥ 估算输入长度、输出上限 ≥ 估算输出长度、任务需要图像时模型必须支持 image。
 *    （对应 FrugalGPT/RouteLLM 综述中的 pre-router 阶段。）
 *
 * 2. 能力匹配分（quality estimate）——6 维能力向量（code/reasoning/writing/knowledge/
 *    multimodal/speed）与任务需求向量的加权重叠度。任务向量由调用方（agent）显式给出，
 *    未给出的维度按"够用即可"的默认权重处理。这是 RouteLLM 思想的简化落地：
 *    用显式声明代替训练出来的分类器（我们是单次查询路由，无历史标注数据）。
 *
 * 3. 成本最优化（cost-aware selection）——在"能力分 ≥ 质量门槛"的候选集内，
 *    按 帕累托支配 关系找出非支配集；非支配集内按 用户偏好 排序：
 *    - 'balanced'（默认）: score = quality / (cost^alpha)，alpha=0.5，即性价比
 *    - 'quality':  质量优先，成本仅作同分决胜
 *    - 'cost':     成本优先，质量仅作门槛
 *    alpha 与质量门槛都是可调参数（见 FrugalGPT 的 cost-quality tradeoff 曲线）。
 *
 * 4. 置信度输出——每个推荐都带 价格置信度(verified/reported/estimated/unknown) 与
 *    能力置信度(benchmarked/estimated)，低置信度候选降序排列并在说明中标注。
 */

import { effectivePrice, typicalSessionCost, isPeakNow } from './pricing.js'

const DIMS = ['code', 'reasoning', 'writing', 'knowledge', 'multimodal', 'speed']

/** 跨币种排序：统一换算到基准货币。汇率可被 catalog 根配置覆盖（rates: {USD: 7.1}）。 */
function toBaseCurrency(cost, fromCurrency, rates) {
  if (cost === null || !Number.isFinite(cost)) return null
  if (!fromCurrency || fromCurrency === rates.base) return cost
  const r = rates[fromCurrency]
  if (!r) return null // 未知币种，无法换算 → 无法参与排序
  return cost * (fromCurrency === rates.base ? 1 : r / (rates[rates.base] || 1))
}

/** 任务画像：{ dims: {code: 0..1 权重}, minQuality: 0..100, contextTokens, outputTokens, needsImage, needsThinking } */

function capabilityScore(model, task) {
  const caps = model.capabilities || {}
  const dims = task.dims || {}
  let num = 0
  let den = 0
  for (const d of DIMS) {
    const w = dims[d]
    if (!w || w <= 0) continue
    num += (caps[d] || 0) * w
    den += 100 * w
  }
  if (den === 0) {
    // 未声明任务画像：按通用均值估分（reasoning/knowledge 为主）
    return Math.round(((caps.reasoning || 0) + (caps.knowledge || 0) + (caps.code || 0)) / 3)
  }
  return Math.round((num / den) * 100)
}

export function routePlan(catalog, task, opts = {}) {
  const {
    preference = 'balanced',
    alpha = 0.5,
    minQuality = opts.minQuality ?? 70,
    baseCurrency = catalog.rates && catalog.rates.base || 'CNY',
    includeUnknownPrice = true,
  } = opts
  const rates = catalog.rates && typeof catalog.rates === 'object'
    ? catalog.rates
    : { base: 'CNY', CNY: 1, USD: 7.1 }

  const now = new Date()
  const candidates = []

  for (const model of catalog.models) {
    // —— 阶段 1: hard constraints ——
    if (task.contextTokens && model.contextWindow && task.contextTokens > model.contextWindow) continue
    if (task.outputTokens && model.maxTokens && task.outputTokens > model.maxTokens) continue
    if (task.needsImage && !(model.input || []).includes('image')) continue
    if (task.needsThinking && !model.thinking) continue

    // —— 阶段 2: quality ——
    const quality = capabilityScore(model, task)
    if (quality < (task.minQuality ?? minQuality)) continue

    // —— 阶段 3: 每个有报价的平台各成一个候选 ——
    const prices = model.prices || {}
    for (const [platformKey, entry] of Object.entries(prices)) {
      const platform = catalog.platforms[platformKey]
      if (!platform) continue
      const price = effectivePrice(entry, platform, now)
      if (!price) {
        if (!includeUnknownPrice) continue
        candidates.push({
          modelId: model.id, platform: platformKey, platformName: platform.displayName || platformKey,
          modelIdOnPlatform: entry.modelId || model.id,
          quality, cost: null, priceInfo: null,
          priceConfidence: 'unknown', capabilityConfidence: model.capabilityConfidence || 'estimated',
          contextWindow: model.contextWindow, maxTokens: model.maxTokens,
          thinking: !!model.thinking, input: model.input || ['text'],
          note: entry.note || null, promo: null,
        })
        continue
      }
      candidates.push({
        modelId: model.id, platform: platformKey, platformName: platform.displayName || platformKey,
        modelIdOnPlatform: entry.modelId || model.id,
        quality, cost: toBaseCurrency(typicalSessionCost(price), price.currency, rates),
        costNative: typicalSessionCost(price), nativeCurrency: price.currency,
        priceInfo: {
          input: price.input, output: price.output, cacheRead: price.cacheRead,
          currency: price.currency, peak: price.peak, promo: price.promo || null,
        },
        priceConfidence: price.confidence, capabilityConfidence: model.capabilityConfidence || 'estimated',
        contextWindow: model.contextWindow, maxTokens: model.maxTokens,
        thinking: !!model.thinking, input: model.input || ['text'],
        note: entry.note || null, promo: price.promo || null,
      })
    }
  }

  // —— 阶段 4: Pareto 非支配集 + 偏好排序 ——
  const priced = candidates.filter((c) => c.cost !== null && Number.isFinite(c.cost))
  const unknown = candidates.filter((c) => c.cost === null)
  const nonDominated = priced.filter((a) =>
    !priced.some((b) =>
      b !== a &&
      b.quality >= a.quality && b.cost <= a.cost &&
      (b.quality > a.quality || b.cost < a.cost),
    ),
  )

  const rank = (c) => {
    if (preference === 'quality') return c.quality * 1000 - c.cost
    if (preference === 'cost') return -c.cost * 1000 + c.quality / 100
    return c.quality / Math.pow(Math.max(c.cost, 1e-9), alpha)
  }
  nonDominated.sort((a, b) => rank(b) - rank(a))
  unknown.sort((a, b) => b.quality - a.quality)

  return {
    ranked: nonDominated,
    unknownPrice: unknown,
    meta: {
      preference, alpha, minQuality: task.minQuality ?? minQuality,
      generatedAt: now.toISOString(),
      baseCurrency,
      currencyNote: `所有成本已换算为 ${baseCurrency}（汇率默认 USD=7.1 CNY，可在目录根 rates 配置覆盖）`,
      methodology: 'hard-constraint filter → capability match → Pareto non-dominated set → preference ranking (FrugalGPT/RouteLLM-inspired)',
    },
  }
}

/** 给模型选择建议一段人类可读理由。 */
export function explainChoice(c) {
  const parts = []
  parts.push(`能力匹配分 ${c.quality}/100`)
  if (c.cost !== null) {
    const p = c.priceInfo
    const nativePart = c.nativeCurrency !== 'CNY' ? `（本位币 ${c.costNative.toFixed(3)} ${c.nativeCurrency}）` : ''
    parts.push(`典型会话成本 ≈ ${c.cost.toFixed(3)} CNY${nativePart}｜单价(入 ${p.input}/出 ${p.output} ${p.currency}/M${p.peak ? ' 峰时' : ''})`)
    if (p.promo) parts.push(`促销: ${p.promo}`)
  } else {
    parts.push('该平台无核实报价，调用前请补录')
  }
  parts.push(`价格置信度 ${c.priceConfidence} / 能力置信度 ${c.capabilityConfidence}`)
  if (c.note) parts.push(c.note)
  return parts.join('；')
}
