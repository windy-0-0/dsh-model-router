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

/**
 * 任务画像预设（agent 不声明六维权重的兜底）。六类 + 通用：
 * 每项权重和为 1，作为能力匹配分的任务侧向量。
 */
export const TASK_PROFILES = {
  general:   { code: 0.18, reasoning: 0.26, writing: 0.20, knowledge: 0.26, multimodal: 0.04, speed: 0.06 },
  code:      { code: 0.55, reasoning: 0.22, knowledge: 0.10, writing: 0.03, multimodal: 0.02, speed: 0.08 },
  reasoning: { code: 0.12, reasoning: 0.55, knowledge: 0.18, writing: 0.08, multimodal: 0.02, speed: 0.05 },
  writing:   { code: 0.02, reasoning: 0.15, writing: 0.52, knowledge: 0.20, multimodal: 0.03, speed: 0.08 },
  knowledge: { code: 0.05, reasoning: 0.25, writing: 0.22, knowledge: 0.42, multimodal: 0.02, speed: 0.04 },
  multimodal:{ code: 0.02, reasoning: 0.18, writing: 0.08, knowledge: 0.12, multimodal: 0.56, speed: 0.04 },
  chat:      { code: 0.06, reasoning: 0.14, writing: 0.24, knowledge: 0.24, multimodal: 0.04, speed: 0.28 },
}

/**
 * 关键词 → 类别 的确定性分类表（大小写不敏感；英文关键词配中英常见词）。
 * 计数加权：命中类别数越少、权重越集中，画像越有指向性。
 */
const TASK_KEYWORDS = {
  code: ['代码', '编程', '实现', '重构', '调试', 'bug', '报错', '编译', '测试', '函数', '脚本', '接口', 'api', '算法', '依赖', '升级', '部署', 'deploy', 'review', 'pr', 'git', '类型', 'database', 'sql', 'regex', 'json', '前端', '后端', '配置', '迁移'],
  reasoning: ['推理', '证明', '为什么', '数学', '逻辑', '策略', '论证', '评估', '深入分析', '规划', '优化方案', '根因', '权衡', '比较分析', 'solver', '证明'],
  writing: ['写', '文案', '润色', '翻译', '邮件', '总结', '报告', '标题', '小说', '文档', 'markdown', '大纲', '演讲稿', '改写', '回复', '公告'],
  knowledge: ['解释', '科普', '领域', '概念', '原理', '资料', '研究', '调查', '历史', '背景', '文献', '综述', '是什么', '介绍'],
  multimodal: ['图片', '图像', '截图', '识别', '视觉', '照片', '视频', 'ocr', '图表解读', 'logo', '海报'],
  extraction: ['提取', '结构化', '表格', '解析', '抓取', 'scrape', '整理成', '字段', '清单', '名单', 'csv'],
  chat: ['闲聊', '聊天', '简单', '快速', '一句话', '打招呼', '回复一下', '帮我看看这句话'],
}

/**
 * 自动任务分类：文本 → { profile, dims, matched }。
 * matched = 每类命中的关键词数（供调用方展示依据与置信度）。
 * 兜底 general（不瞎猜）。
 */
export function classifyTask(text) {
  const lower = String(text || '')
  const counts = {}
  for (const [cat, words] of Object.entries(TASK_KEYWORDS)) {
    counts[cat] = words.reduce((n, w) => n + (lower.toLowerCase().includes(String(w).toLowerCase()) ? 1 : 0), 0)
  }
  const matched = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  if (matched.length === 0) return { profile: 'general', dims: { ...TASK_PROFILES.general }, matched: [] }
  // 取命中数最多的类别；并列时按表中顺序（code 优先，其次 reasoning）稳定取第一个
  let top = matched[0][0]
  // chat 并列豁免：chat 命中且与首位并列，且首位是弱指向类别(writing/knowledge)时偏向 chat（低风险默认）
  if (counts.chat > 0 && top !== 'code' && top !== 'reasoning' && top !== 'multimodal'
      && counts.chat >= counts[top] && (top === 'writing' || top === 'knowledge' || top === 'chat')) top = 'chat'
  // 若最高类别与次高差距 ≤1 且都不是 code/reasoning，说明意图模糊 → general 更稳
  const gap = matched.length > 1 ? matched[0][1] - matched[1][1] : 99
  const ambiguous = matched.length > 1 && gap <= 1 && top !== 'code' && top !== 'reasoning' && top !== 'multimodal' && top !== 'chat'
  const profile = ambiguous ? 'general' : top
  return { profile, dims: { ...TASK_PROFILES[profile] }, matched: matched.slice(0, 3) }
}

/**
 * 解析任务画像：显式 dims > 显式 profile > 文本自动分类 > general 兜底。
 * 返回值附 source 供输出说明（'explicit'|'profile:<名>'|'auto:<名>'|'fallback'）。
 */
export function resolveTaskProfile(task, opts = {}) {
  const hasDims = !!(task && task.dims && typeof task.dims === 'object' && Object.keys(task.dims).length > 0)
  if (hasDims) return { dims: { ...task.dims }, source: 'explicit' }
  const profileName = opts.profile || (task && task.profile) || ''
  if (profileName && TASK_PROFILES[profileName]) return { dims: { ...TASK_PROFILES[profileName] }, source: 'profile:' + profileName }
  const auto = classifyTask((task && task.text) || opts.task || '')
  if (auto.profile !== 'general') return { dims: auto.dims, source: 'auto:' + auto.profile, matched: auto.matched }
  if (task && task.text) return { dims: { ...TASK_PROFILES.general }, source: 'fallback-general', matched: [] }
  return { dims: { ...TASK_PROFILES.general }, source: 'fallback', matched: [] }
}


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
  // 画像兜底：调用方没给权重/画像/文本时用 general；给了就用（不覆盖显式声明）
  if (task && !task.dims) {
    const resolved = resolveTaskProfile(task, opts)
    task.dims = resolved.dims
    task._profileSource = resolved.source
    if (resolved.matched) task._profileMatched = resolved.matched
  }
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
