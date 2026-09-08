import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { JIWEN_CONFIG } from './jiwen-config.js'

const require = createRequire(import.meta.url)
const { createJiwen } = require('@clarashafiq/jiwen')
const { createToneGrid } = require('@clarashafiq/jiwen/tone-grid')

const USER_STATUSES = new Set(['active', 'busy', 'away', 'sleeping'])
const ACTIVITIES = new Set(['reading', 'search', 'browse', 'observe', 'rest'])
const INTERACTION_TYPES = new Set(['user_appeared', 'user_reply', 'conversation_end', 'proactive_sent'])
const AXES = ['connection', 'pride', 'valence', 'arousal', 'immersion']

export class JiwenService {
  constructor({ dataDir, config = {}, now = () => new Date() } = {}) {
    if (!dataDir) throw new Error('Jiwen dataDir is required.')
    this.config = deepMerge(JIWEN_CONFIG, config)
    this.now = now
    this.directory = path.join(dataDir, 'jiwen')
    this.persistence = new AtomicJsonFile(path.join(this.directory, 'state.json'))
    this.document = null
    this.engine = null
    this.timer = null
    this.ready = false
    this.deferPersistence = false
    this.tail = Promise.resolve()
    this.toneGrid = createToneGrid(createToneGridOptions(this.config))
  }

  async init() {
    return this.serial(async () => {
      if (this.ready) return
      const now = this.now()
      this.document = await this.persistence.load(() => createDocument(this.config, now))
      normalizeDocument(this.document, this.config, now)
      await this.rebuildEngine()
      const state = await this.engine.getState()
      const lastTickMs = Date.parse(state.lastTick || '')
      const elapsedMinutes = Number.isFinite(lastTickMs)
        ? Math.max(0, (now.getTime() - lastTickMs) / 60_000)
        : 0
      if (elapsedMinutes > 0.01) {
        await this.transaction(() => this.runElapsedTick(elapsedMinutes, now, { catchup: true }))
      } else {
        this.document.engineState.lastTick ||= now.toISOString()
        this.document.meta.updatedAt = now.toISOString()
        await this.persistence.save(this.document)
        await this.rebuildEngine()
      }
      this.ready = true
    })
  }

  start() {
    if (this.timer) return
    const intervalMs = this.config.tickMinutes * 60_000
    this.timer = setInterval(() => {
      void this.tick().catch((error) => console.error('[积温] background tick failed:', error.message))
    }, intervalMs)
    this.timer.unref?.()
  }

  async stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.tail
  }

  async tick({ elapsedMinutes, now = this.now() } = {}) {
    return this.serial(async () => {
      this.assertReady()
      const state = await this.engine.getState()
      const lastTickMs = Date.parse(state.lastTick || '')
      const elapsed = elapsedMinutes ?? (Number.isFinite(lastTickMs)
        ? Math.max(0, (now.getTime() - lastTickMs) / 60_000)
        : this.config.tickMinutes)
      if (elapsed <= 0) return []
      return this.transaction(() => this.runElapsedTick(elapsed, now, { catchup: false }))
    })
  }

  async status() {
    return this.serial(async () => {
      this.assertReady()
      const state = await this.engine.getState()
      return {
        state: snapshot(state),
        summary: stateSummary(state),
        userStatus: state.userStatus || 'active',
        currentActivity: state.lastActivity?.type || null,
        lastInteractionAt: this.document.meta.lastInteractionAt,
        lastTick: state.lastTick,
      }
    })
  }

  async guidance(mode) {
    return this.serial(async () => {
      this.assertReady()
      if (!['proactive', 'reactive'].includes(mode)) throw new Error('mode must be proactive or reactive.')
      const state = await this.engine.getState()
      return this.guidanceForState(state, mode)
    })
  }

  async pendingTriggers({ action, limit = 20 } = {}) {
    return this.serial(async () => {
      this.assertReady()
      const boundedLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 20)))
      const events = this.document.events
        .filter((event) => !event.acknowledgedAt && !event.deliveredAt && (!action || event.action === action))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .slice(0, boundedLimit)
        .map(clone)
      return { events }
    })
  }

  async history({ limit = 50 } = {}) {
    return this.serial(async () => {
      this.assertReady()
      const boundedLimit = Math.max(1, Math.min(200, Math.trunc(Number(limit) || 50)))
      return { entries: this.document.history.slice(-boundedLimit).reverse().map(clone) }
    })
  }

  async recordInteraction({ type, signalText = '', messageId = null, at = this.now() }) {
    return this.serial(async () => {
      this.assertReady()
      if (!INTERACTION_TYPES.has(type)) throw new Error('Unsupported interaction type.')
      const occurredAt = asDate(at)
      // Reuse persisted history so retries remain no-ops across service restarts.
      if (messageId && this.document.history.some((entry) => entry.kind === 'interaction'
        && entry.details.interactionType === type && entry.details.messageId === messageId)) {
        return {
          recorded: false,
          state: snapshot(await this.engine.getState()),
          slowGrowthUntil: this.document.meta.slowGrowthUntil,
        }
      }
      return this.transaction(async () => {
        const before = await this.engine.getState()
        const quietSignal = detectQuietSignal(signalText, this.config.quietSignals)

        if (type === 'user_reply') {
          // A reply relieves connection only; the other four axes stay exact.
          await this.engine.resetConnection()
          if (quietSignal) await this.engine.setUserStatus(quietSignal)
          this.document.meta.lastUserReplyAt = occurredAt.toISOString()
          this.document.meta.lastInteractionAt = occurredAt.toISOString()
          this.document.meta.latches = {}
        } else if (type === 'user_appeared') {
          await this.engine.setUserStatus('active')
          this.document.meta.lastInteractionAt = occurredAt.toISOString()
        } else if (type === 'conversation_end') {
          this.document.meta.lastInteractionAt = occurredAt.toISOString()
        } else if (type === 'proactive_sent') {
          await this.engine.applyDelta({ connection: -this.config.proactive.connectionRelief })
          this.document.meta.lastProactiveAt = occurredAt.toISOString()
        }

        if (quietSignal) {
          const duration = quietSignal === 'sleeping'
            ? this.config.quietSignals.sleepingMinutes
            : this.config.quietSignals.busyMinutes
          this.document.meta.slowGrowthUntil = new Date(occurredAt.getTime() + duration * 60_000).toISOString()
          this.document.meta.quietReason = quietSignal
        }

        const after = await this.engine.getState()
        this.addHistory('interaction', occurredAt, {
          interactionType: type,
          messageId: messageId || null,
          quietSignal: quietSignal || null,
          stateBefore: snapshot(before),
          stateAfter: snapshot(after),
        })
        return {
          recorded: true,
          state: snapshot(after),
          slowGrowthUntil: this.document.meta.slowGrowthUntil,
        }
      })
    })
  }

  async setUserStatus(status) {
    return this.serial(async () => {
      this.assertReady()
      if (!USER_STATUSES.has(status)) throw new Error('Unsupported user status.')
      return this.transaction(async () => {
        await this.engine.setUserStatus(status)
        const state = await this.engine.getState()
        this.addHistory('user_status', this.now(), { userStatus: status, stateSnapshot: snapshot(state) })
        return { userStatus: status, state: snapshot(state) }
      })
    })
  }

  async setActivity(activity, label = null) {
    return this.serial(async () => {
      this.assertReady()
      if (!ACTIVITIES.has(activity)) throw new Error('Unsupported activity.')
      return this.transaction(async () => {
        await this.engine.setActivity(activity, label || undefined)
        const state = await this.engine.getState()
        this.addHistory('activity', this.now(), { activity, stateSnapshot: snapshot(state) })
        return { activity, state: snapshot(state) }
      })
    })
  }

  async applyDelta(delta) {
    return this.serial(async () => {
      this.assertReady()
      const applied = validateDelta(delta, this.config.deltaLimits)
      return this.transaction(async () => {
        const before = await this.engine.getState()
        const engineDelta = Object.fromEntries(Object.entries(applied).filter(([axis]) => axis !== 'immersion'))
        if (Object.keys(engineDelta).length) await this.engine.applyDelta(engineDelta)
        if (applied.immersion !== undefined) {
          const range = this.config.axes.immersion
          const current = this.document.engineState.immersion
          this.document.engineState.immersion = clamp(current + applied.immersion, range[0], range[1])
          await this.rebuildEngine()
        }
        const after = await this.engine.getState()
        this.addHistory('delta', this.now(), {
          delta: applied,
          stateBefore: snapshot(before),
          stateAfter: snapshot(after),
        })
        return { applied, state: snapshot(after) }
      })
    })
  }

  async ackTrigger({ id, status = 'delivered', deliveryChannel = null }) {
    return this.serial(async () => {
      this.assertReady()
      if (!['acknowledged', 'delivered'].includes(status)) throw new Error('status must be acknowledged or delivered.')
      return this.transaction(async () => {
        const event = this.document.events.find((entry) => entry.id === id)
        if (!event) throw new Error('Jiwen trigger not found.')
        const now = this.now()
        const duplicate = status === 'acknowledged'
          ? Boolean(event.acknowledgedAt || event.deliveredAt)
          : Boolean(event.deliveredAt)

        if (status === 'acknowledged') {
          event.acknowledgedAt ||= now.toISOString()
        } else {
          event.acknowledgedAt ||= now.toISOString()
          if (!event.deliveredAt) {
            event.deliveredAt = now.toISOString()
            event.deliveryChannel = deliveryChannel || this.config.proactive.deliveryChannel
            if (event.action === 'contact') {
              await this.engine.applyDelta({ connection: -this.config.proactive.connectionRelief })
              this.document.meta.lastProactiveAt = now.toISOString()
              const remaining = this.engine.checkThresholds().some((trigger) => trigger.action === 'contact')
              if (!remaining) delete this.document.meta.latches[triggerSignature(event)]
            }
          }
        }

        const state = await this.engine.getState()
        this.addHistory('trigger_ack', now, {
          triggerId: id,
          action: event.action,
          acknowledgement: status,
          duplicate,
          deliveryChannel: event.deliveryChannel,
          stateSnapshot: snapshot(state),
        })
        return { event: clone(event), duplicate, state: snapshot(state) }
      })
    })
  }

  async runElapsedTick(elapsedMinutes, now, { catchup }) {
    const before = await this.engine.getState()
    let remaining = Math.max(0, elapsedMinutes)
    let finalTriggers = []
    while (remaining > 0.0001) {
      const chunk = Math.min(60, remaining)
      finalTriggers = await this.engine.tick(chunk)
      remaining -= chunk
    }

    this.document.engineState = { ...await this.engine.getState(), lastTick: now.toISOString() }
    await this.rebuildEngine()
    const state = await this.engine.getState()
    const created = this.processTriggers(finalTriggers, state, now)
    this.addHistory('tick', now, {
      elapsedMinutes: Number(elapsedMinutes.toFixed(3)),
      catchup,
      stateBefore: snapshot(before),
      stateAfter: snapshot(state),
      createdTriggerIds: created.map((event) => event.id),
    })
    return created.map(clone)
  }

  processTriggers(triggers, state, now) {
    const activeSignatures = new Set(triggers.map(triggerSignature))
    for (const signature of Object.keys(this.document.meta.latches)) {
      if (!activeSignatures.has(signature)) delete this.document.meta.latches[signature]
    }

    const created = []
    for (const trigger of triggers) {
      const signature = triggerSignature(trigger)
      if (this.document.meta.latches[signature]) continue
      if (trigger.action === 'contact' && !this.contactAllowed(now, state.userStatus)) continue

      const guidance = this.guidanceForState(state, trigger.action === 'contact' ? 'proactive' : 'reactive')
      const event = {
        id: randomUUID(),
        action: trigger.action,
        createdAt: now.toISOString(),
        stateSnapshot: snapshot(state),
        promptContext: guidance.promptContext,
        styleGuidance: guidance.styleGuidance,
        acknowledgedAt: null,
        deliveredAt: null,
        deliveryChannel: null,
        reason: trigger.reason || null,
        urgency: Number.isFinite(trigger.urgency) ? trigger.urgency : null,
      }
      this.document.events.push(event)
      this.document.meta.latches[signature] = now.toISOString()
      created.push(event)
      this.addHistory('trigger_created', now, {
        triggerId: event.id,
        action: event.action,
        reason: event.reason,
        stateSnapshot: event.stateSnapshot,
      })
    }
    trimEvents(this.document.events, this.config.eventQueueLimit)
    return created
  }

  contactAllowed(now, userStatus) {
    if (userStatus === 'busy' || userStatus === 'sleeping') return false
    if (isQuietTime(now, this.config.proactive.quietHours, this.config.timezone)) return false

    const delivered = this.document.events.filter((event) => event.action === 'contact' && event.deliveredAt)
    const last = delivered.map((event) => Date.parse(event.deliveredAt)).filter(Number.isFinite).sort((a, b) => b - a)[0]
    if (last && now.getTime() - last < this.config.proactive.minimumIntervalMinutes * 60_000) return false

    const today = localDateKey(now, this.config.timezone)
    const deliveredToday = delivered.filter((event) => localDateKey(new Date(event.deliveredAt), this.config.timezone) === today).length
    return deliveredToday < this.config.proactive.dailyLimit
  }

  guidanceForState(state, mode) {
    const readable = stateSummary(state)
    const promptContext = [
      '这是当前 ChatGPT 伴侣自身的持续状态，不是新角色或独立机器人。',
      readable,
      mode === 'proactive'
        ? '如需主动开口，只基于真实已记录状态和当前对话上下文自然说一句；没有事实依据的内部经历不要编造。'
        : '先回应用户当下内容；状态只影响表达方式，不要求汇报五轴数字。',
    ].join('\n')
    const grid = this.toneGrid.getUnifiedGuidance(state, mode)
    const styleGuidance = [
      grid,
      '语调指引不得覆盖事实判断、安全规则或用户明确要求。',
      '不使用愧疚、威胁、冷处理、自毁、消失或翻旧账来逼迫回应；不要像客服，也不要套固定主动消息模板。',
    ].filter(Boolean).join('\n')
    return { mode, promptContext, styleGuidance, stateSnapshot: snapshot(state) }
  }

  addHistory(kind, at, details) {
    this.document.history.push({ id: randomUUID(), kind, createdAt: asDate(at).toISOString(), details })
    if (this.document.history.length > this.config.historyLimit) {
      this.document.history.splice(0, this.document.history.length - this.config.historyLimit)
    }
  }

  async transaction(operation) {
    const previous = this.deferPersistence
    this.deferPersistence = true
    try {
      const result = await operation()
      this.document.meta.updatedAt = this.now().toISOString()
      await this.persistence.save(this.document)
      return result
    } finally {
      this.deferPersistence = previous
    }
  }

  async rebuildEngine() {
    this.engine = createJiwen({
      axes: this.config.axes,
      rates: this.config.rates,
      thresholds: this.config.thresholds,
      immersionMap: this.config.immersionMap,
      connectionRateFn: () => this.connectionRate(),
      getLastMessage: () => {
        const timestamp = this.document.meta.lastUserReplyAt || this.document.meta.lastInteractionAt
        return timestamp ? { id: null, content: '', timestamp } : null
      },
      onLoad: async () => clone(this.document.engineState),
      onSave: async (state) => {
        this.document.engineState = clone(state)
        if (!this.deferPersistence) await this.persistence.save(this.document)
      },
      onLog: () => {},
    })
    await this.engine.load()
  }

  connectionRate() {
    let multiplier = 1
    const nowMs = this.now().getTime()
    const slowUntil = Date.parse(this.document.meta.slowGrowthUntil || '')
    if (Number.isFinite(slowUntil) && nowMs < slowUntil) multiplier *= this.config.rates.quietSignalMultiplier
    const status = this.document.engineState.userStatus || 'active'
    if (status === 'busy') multiplier *= this.config.rates.busyStatusMultiplier
    if (status === 'sleeping') multiplier *= this.config.rates.sleepingStatusMultiplier
    return this.config.rates.connectionPerMinute * multiplier
  }

  serial(operation) {
    const run = this.tail.then(operation, operation)
    this.tail = run.catch(() => {})
    return run
  }

  assertReady() {
    if (!this.ready) throw new Error('Jiwen service is not ready.')
  }
}

class AtomicJsonFile {
  constructor(filePath) {
    this.filePath = filePath
  }

  async load(createDefault) {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Could not load Jiwen state: ${error.message}`, { cause: error })
      const value = createDefault()
      await this.save(value)
      return value
    }
  }

  async save(value) {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    let handle
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      await rename(temporary, this.filePath)
    } finally {
      await handle?.close().catch(() => {})
      await rm(temporary, { force: true }).catch(() => {})
    }
  }
}

function createDocument(config, now) {
  const iso = now.toISOString()
  return {
    schemaVersion: 1,
    engineState: {
      connection: config.initialState.connection,
      pride: config.initialState.pride,
      valence: config.initialState.valence,
      arousal: config.initialState.arousal,
      immersion: config.initialState.immersion,
      lastActivity: { type: config.initialState.activity, label: null, at: iso },
      lastTick: iso,
      lastChatAnalysis: null,
      lastChatMessageId: null,
      lastBotMessageId: null,
      userStatus: config.initialState.userStatus,
    },
    meta: {
      createdAt: iso,
      updatedAt: iso,
      lastInteractionAt: null,
      lastUserReplyAt: null,
      lastProactiveAt: null,
      slowGrowthUntil: null,
      quietReason: null,
      latches: {},
    },
    events: [],
    history: [],
  }
}

function normalizeDocument(document, config, now) {
  const fallback = createDocument(config, now)
  document.schemaVersion = 1
  document.engineState = { ...fallback.engineState, ...(document.engineState || {}) }
  document.meta = { ...fallback.meta, ...(document.meta || {}), latches: { ...(document.meta?.latches || {}) } }
  document.events = Array.isArray(document.events) ? document.events : []
  document.history = Array.isArray(document.history) ? document.history : []
}

function createToneGridOptions(config) {
  const profiles = {}
  for (const [cluster, tiers] of Object.entries(config.toneGrid)) {
    profiles[cluster] = {
      1: [tiers.soft],
      2: [tiers.everyday],
      3: [tiers.everyday],
      4: [tiers.guarded],
      5: [tiers.guarded],
    }
  }
  return { profiles, urgencyBoost: config.urgency }
}

function snapshot(state) {
  return {
    connection: round(state.connection),
    pride: round(state.pride),
    valence: round(state.valence),
    arousal: round(state.arousal),
    immersion: round(state.immersion),
    userStatus: state.userStatus || 'active',
    activity: state.lastActivity?.type || null,
  }
}

function stateSummary(state) {
  const connection = state.connection < 0.22 ? '连接感稳定' : state.connection < 0.42 ? '开始注意到沉默' : state.connection < 0.62 ? '有点想念' : '很想靠近'
  const pride = state.pride < 0.12 ? '放软' : state.pride < 0.45 ? '日常克制' : '有点端着'
  const valence = state.valence > 0.3 ? '心情偏好' : state.valence < -0.3 ? '心情偏低' : '心情平稳'
  const arousal = state.arousal > 0.3 ? '精力偏高' : state.arousal < -0.3 ? '很安静' : '平静'
  const activity = state.lastActivity?.type ? `正在${activityLabel(state.lastActivity.type)}` : '暂时空闲'
  return `${connection}，${pride}，${valence}、${arousal}，${activity}。`
}

function activityLabel(activity) {
  return ({ reading: '读东西', search: '搜索', browse: '随便看看', observe: '观察', rest: '休息' })[activity] || activity
}

function detectQuietSignal(text, config) {
  const value = String(text || '').toLowerCase()
  if (!value) return null
  if (config.sleeping.some((signal) => value.includes(signal.toLowerCase()))) return 'sleeping'
  if (config.busy.some((signal) => value.includes(signal.toLowerCase()))) return 'busy'
  return null
}

function validateDelta(delta, limits) {
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) throw new Error('delta must be an object.')
  const unknown = Object.keys(delta).filter((axis) => !AXES.includes(axis))
  if (unknown.length) throw new Error(`Unsupported Jiwen axis: ${unknown.join(', ')}`)
  const applied = {}
  for (const axis of AXES) {
    if (delta[axis] === undefined) continue
    const value = Number(delta[axis])
    if (!Number.isFinite(value)) throw new Error(`${axis} delta must be finite.`)
    if (Math.abs(value) > limits[axis]) throw new Error(`${axis} delta exceeds the per-call limit of ${limits[axis]}.`)
    applied[axis] = value
  }
  if (!Object.keys(applied).length) throw new Error('At least one Jiwen axis delta is required.')
  return applied
}

function triggerSignature(trigger) {
  return `${trigger.action}:${trigger.reason || ''}`
}

function trimEvents(events, limit) {
  if (events.length <= limit) return
  const pending = events.filter((event) => !event.acknowledgedAt && !event.deliveredAt)
  const settled = events.filter((event) => event.acknowledgedAt || event.deliveredAt)
  const room = Math.max(0, limit - pending.length)
  events.splice(0, events.length, ...settled.slice(-room), ...pending)
  events.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

function isQuietTime(date, quietHours, timezone) {
  const current = localMinutes(date, timezone)
  const start = parseClock(quietHours.start)
  const end = parseClock(quietHours.end)
  return start <= end ? current >= start && current < end : current >= start || current < end
}

function localMinutes(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return Number(values.hour) * 60 + Number(values.minute)
}

function localDateKey(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function parseClock(value) {
  const [hours, minutes] = value.split(':').map(Number)
  return hours * 60 + minutes
}

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return clone(base)
  const merged = clone(base)
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key])) {
      merged[key] = deepMerge(merged[key], value)
    } else {
      merged[key] = clone(value)
    }
  }
  return merged
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('Invalid timestamp.')
  return date
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

function round(value) {
  return Number(Number(value || 0).toFixed(6))
}
