import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { JiwenService } from './jiwen-service.js'

const roots = []

try {
  await testRestartRecovery()
  await testCatchupWithoutDuplicateTrigger()
  await testGoodnightSlowsGrowth()
  await testBusyAndSleepingSuppressContact()
  await testContactThresholdAndPrideBlock()
  await testReplyAndProactiveRelief()
  await testReplyPreservesRawState()
  await testReplyExplicitSignals()
  await testReplyDeduplication()
  await testAckIsIdempotent()
  await testMinimumIntervalAndDailyLimit()
  await testQuietHoursSuppressContact()
  await testEmptyPendingQueueStaysEmpty()
  console.log('Jiwen integration tests passed.')
} finally {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
}

async function testRestartRecovery() {
  const fixture = await createFixture()
  const first = await fixture.service()
  await first.applyDelta({ valence: 0.12, immersion: 0.10 })
  const before = await first.status()
  await first.stop()

  const restarted = await fixture.service()
  const after = await restarted.status()
  assert.equal(after.state.valence, before.state.valence, 'valence must survive restart')
  assert.equal(after.state.immersion, before.state.immersion, 'immersion must survive restart')
  await restarted.stop()
}

async function testCatchupWithoutDuplicateTrigger() {
  const fixture = await createFixture({
    initialState: { connection: 0.40, pride: 0.10, immersion: 0, activity: 'rest' },
    rates: { connectionPerMinute: 0.001, immersionDampenConnection: 0 },
  })
  const first = await fixture.service()
  await first.stop()
  fixture.advance(60)

  const restarted = await fixture.service()
  const pending = await restarted.pendingTriggers({ action: 'contact' })
  assert.equal(pending.events.length, 1, 'elapsed time must be caught up into one contact trigger')
  await restarted.stop()

  const restartedAgain = await fixture.service()
  const pendingAgain = await restartedAgain.pendingTriggers({ action: 'contact' })
  assert.equal(pendingAgain.events.length, 1, 'restart must not duplicate an old trigger')
  await restartedAgain.stop()
}

async function testGoodnightSlowsGrowth() {
  const normalFixture = await createFixture({
    initialState: { connection: 0.10, immersion: 0, activity: 'rest' },
    rates: { connectionPerMinute: 0.001, immersionDampenConnection: 0 },
  })
  const quietFixture = await createFixture({
    initialState: { connection: 0.10, immersion: 0, activity: 'rest' },
    rates: { connectionPerMinute: 0.001, immersionDampenConnection: 0 },
  })
  const normal = await normalFixture.service()
  const quiet = await quietFixture.service()
  await quiet.recordInteraction({ type: 'conversation_end', signalText: '晚安，我去睡觉了' })
  await normal.tick({ elapsedMinutes: 60 })
  await quiet.tick({ elapsedMinutes: 60 })
  const normalState = await normal.status()
  const quietState = await quiet.status()
  const normalGrowth = normalState.state.connection - 0.10
  const quietGrowth = quietState.state.connection - 0.10
  assert.ok(quietGrowth < normalGrowth / 2, 'goodnight must slow connection growth substantially')
  await normal.stop()
  await quiet.stop()
}

async function testBusyAndSleepingSuppressContact() {
  for (const userStatus of ['busy', 'sleeping']) {
    const fixture = await createFixture({ initialState: { connection: 0.50, pride: 0.10, immersion: 0, activity: 'rest' } })
    const service = await fixture.service()
    await service.setUserStatus(userStatus)
    await service.tick({ elapsedMinutes: 5 })
    assert.equal((await service.pendingTriggers({ action: 'contact' })).events.length, 0, `${userStatus} must suppress contact`)
    await service.stop()
  }
}

async function testContactThresholdAndPrideBlock() {
  const contactFixture = await createFixture({ initialState: { connection: 0.50, pride: 0.10, immersion: 0, activity: 'rest' } })
  const contact = await contactFixture.service()
  await contact.tick({ elapsedMinutes: 5 })
  assert.equal((await contact.pendingTriggers({ action: 'contact' })).events.length, 1, 'connection threshold must create contact')
  await contact.stop()

  const prideFixture = await createFixture({ initialState: { connection: 0.50, pride: 0.70, immersion: 0, activity: 'rest' } })
  const pride = await prideFixture.service()
  await pride.tick({ elapsedMinutes: 5 })
  const activities = await pride.pendingTriggers({ action: 'find_activity' })
  assert.equal(activities.events.length, 1, 'pride block must create find_activity')
  assert.equal(activities.events[0].reason, 'pride_block')
  await pride.stop()
}

async function testReplyAndProactiveRelief() {
  const replyFixture = await createFixture({ initialState: { connection: 0.50 } })
  const reply = await replyFixture.service()
  await reply.recordInteraction({ type: 'user_reply', signalText: '我回来啦' })
  assert.equal((await reply.status()).state.connection, 0, 'real reply must reset connection')
  await reply.stop()

  const proactiveFixture = await createFixture({ initialState: { connection: 0.50 } })
  const proactive = await proactiveFixture.service()
  await proactive.recordInteraction({ type: 'proactive_sent' })
  const connection = (await proactive.status()).state.connection
  assert.ok(connection > 0 && connection < 0.50, 'proactive message must only partly lower connection')
  await proactive.stop()
}

async function testReplyPreservesRawState() {
  for (const userStatus of ['active', 'busy', 'sleeping']) {
    const fixture = await createFixture({ initialState: {
      connection: 0.543210987, pride: -0.234567891, arousal: 0.765432198,
      valence: -0.345678912, immersion: 0.456789123, userStatus, activity: 'reading',
    } })
    const service = await fixture.service()
    for (let index = 0; index < 5; index += 1) {
      const before = await fixture.readDocument()
      fixture.advance(1)
      const result = await service.recordInteraction({
        type: 'user_reply', signalText: index % 2 ? '普通测试消息' : '',
        ...(index < 3 ? { messageId: `reply-${index}` } : {}),
      })
      const after = await fixture.readDocument()
      assert.equal(result.recorded, true)
      assert.deepEqual(after.engineState, { ...before.engineState, connection: 0 },
        `reply ${index + 1} (${userStatus}): raw state may only change connection`)
      assert.deepEqual(after.meta, {
        ...before.meta, updatedAt: fixture.now().toISOString(),
        lastInteractionAt: fixture.now().toISOString(), lastUserReplyAt: fixture.now().toISOString(), latches: {},
      }, 'ordinary replies may only update interaction timestamps and reset connection latches')
      assert.deepEqual(after.events, before.events)
      assert.equal(after.history.length, before.history.length + 1)
      assert.equal((await service.status()).lastInteractionAt, fixture.now().toISOString())
      console.log(`PASS user_reply ${userStatus} ${index + 1}/5: raw pride/arousal/valence/immersion unchanged; connection=0`)
    }
    await service.stop()
  }
}

async function testReplyExplicitSignals() {
  const fixture = await createFixture()
  const service = await fixture.service()
  for (const [signalText, userStatus, duration] of [
    ['我在忙，去开会', 'busy', 240], ['晚安，我去睡觉了', 'sleeping', 540],
  ]) {
    const before = await fixture.readDocument()
    fixture.advance(1)
    await service.recordInteraction({ type: 'user_reply', signalText })
    const after = await fixture.readDocument()
    assert.deepEqual(after.engineState, { ...before.engineState, connection: 0, userStatus })
    assert.deepEqual(after.meta, {
      ...before.meta, updatedAt: fixture.now().toISOString(),
      lastInteractionAt: fixture.now().toISOString(), lastUserReplyAt: fixture.now().toISOString(), latches: {},
      quietReason: userStatus, slowGrowthUntil: new Date(fixture.now().getTime() + duration * 60_000).toISOString(),
    })
    assert.deepEqual(after.events, before.events)
    assert.equal(after.history.at(-1).details.quietSignal, userStatus)
    assert.equal(JSON.stringify(after).includes(signalText), false, 'signal text must not be persisted')
    fixture.advance(1)
    await service.recordInteraction({ type: 'user_reply', signalText: '普通测试消息' })
    const ordinary = await fixture.readDocument()
    assert.deepEqual(ordinary.engineState, after.engineState)
    assert.equal(ordinary.meta.slowGrowthUntil, after.meta.slowGrowthUntil)
    assert.equal(ordinary.meta.quietReason, after.meta.quietReason)
  }
  await service.stop()
  console.log('PASS explicit busy/sleeping signals; ordinary replies preserve status and quiet metadata')
}

async function testReplyDeduplication() {
  const fixture = await createFixture()
  const service = await fixture.service()
  const request = { type: 'user_reply', messageId: 'deduplicated-reply', signalText: '普通测试消息' }
  const results = await Promise.all([service.recordInteraction(request), service.recordInteraction(request)])
  assert.deepEqual(results.map((result) => result.recorded), [true, false])
  // Advance the fixture clock without a tick; duplicate calls must not persist anything.
  fixture.advance(1)
  const before = await fixture.readDocument()
  const duplicate = await service.recordInteraction({ ...request, signalText: '晚安' })
  assert.equal(duplicate.recorded, false)
  assert.deepEqual(await fixture.readDocument(), before)
  await service.stop()
  const restarted = await fixture.service()
  const afterRestart = await fixture.readDocument()
  assert.equal((await restarted.recordInteraction(request)).recorded, false)
  assert.deepEqual(await fixture.readDocument(), afterRestart, 'deduplication must survive restart')
  assert.equal((await restarted.recordInteraction({ ...request, type: 'user_appeared' })).recorded, true,
    'message deduplication must be scoped by interaction type')
  await restarted.stop()
  console.log('PASS duplicate/concurrent/restarted user_reply: no extra state, timestamp, signal or history writes')
}

async function testAckIsIdempotent() {
  const fixture = await createFixture({ initialState: { connection: 0.50, pride: 0.10, immersion: 0, activity: 'rest' } })
  const service = await fixture.service()
  await service.tick({ elapsedMinutes: 5 })
  const [event] = (await service.pendingTriggers({ action: 'contact' })).events
  const first = await service.ackTrigger({ id: event.id, status: 'delivered', deliveryChannel: 'chatgpt' })
  const second = await service.ackTrigger({ id: event.id, status: 'delivered', deliveryChannel: 'chatgpt' })
  assert.equal(first.duplicate, false)
  assert.equal(second.duplicate, true)
  assert.equal(second.event.deliveredAt, first.event.deliveredAt)
  assert.equal(second.state.connection, first.state.connection, 'duplicate ack must not apply relief twice')
  await service.stop()
}

async function testMinimumIntervalAndDailyLimit() {
  const fixture = await createFixture({
    initialState: { connection: 0.50, pride: 0.10, immersion: 0, activity: 'rest' },
    rates: { connectionPerMinute: 0, immersionDampenConnection: 0 },
  })
  const service = await fixture.service()

  await createAndDeliverContact(service)
  await raiseConnection(service)
  fixture.advance(60)
  await service.tick({ elapsedMinutes: 5, now: fixture.now() })
  assert.equal((await service.pendingTriggers({ action: 'contact' })).events.length, 0, 'two-hour minimum interval must block contact')

  fixture.advance(61)
  await service.tick({ elapsedMinutes: 5, now: fixture.now() })
  await deliverOnlyPendingContact(service)
  await raiseConnection(service)

  fixture.advance(121)
  await service.tick({ elapsedMinutes: 5, now: fixture.now() })
  await deliverOnlyPendingContact(service)
  await raiseConnection(service)

  fixture.advance(121)
  await service.tick({ elapsedMinutes: 5, now: fixture.now() })
  assert.equal((await service.pendingTriggers({ action: 'contact' })).events.length, 0, 'daily limit must block the fourth contact')
  await service.stop()
}

async function testQuietHoursSuppressContact() {
  const fixture = await createFixture(
    { initialState: { connection: 0.50, pride: 0.10, immersion: 0, activity: 'rest' } },
    new Date('2026-08-18T17:00:00.000Z'),
  )
  const service = await fixture.service()
  await service.tick({ elapsedMinutes: 5 })
  assert.equal((await service.pendingTriggers({ action: 'contact' })).events.length, 0, '01:00 Asia/Shanghai must be quiet')
  await service.stop()
}

async function testEmptyPendingQueueStaysEmpty() {
  const fixture = await createFixture({ initialState: { connection: 0.08 } })
  const service = await fixture.service()
  const first = await service.pendingTriggers({ action: 'contact', limit: 1 })
  const second = await service.pendingTriggers({ action: 'contact', limit: 1 })
  assert.deepEqual(first.events, [])
  assert.deepEqual(second.events, [], 'polling an empty queue must not create a notification event')
  await service.stop()
}

async function createAndDeliverContact(service) {
  await service.tick({ elapsedMinutes: 5 })
  await deliverOnlyPendingContact(service)
}

async function deliverOnlyPendingContact(service) {
  const [event] = (await service.pendingTriggers({ action: 'contact', limit: 1 })).events
  assert.ok(event, 'expected one pending contact')
  await service.ackTrigger({ id: event.id, status: 'delivered', deliveryChannel: 'test' })
}

async function raiseConnection(service) {
  let connection = (await service.status()).state.connection
  while (connection < 0.48) {
    await service.applyDelta({ connection: Math.min(0.20, 0.48 - connection) })
    connection = (await service.status()).state.connection
  }
}

async function createFixture(config = {}, start = new Date('2026-08-18T04:00:00.000Z')) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'c-pocket-jiwen-'))
  roots.push(root)
  let current = new Date(start)
  return {
    readDocument: async () => JSON.parse(await readFile(path.join(root, 'jiwen', 'state.json'), 'utf8')),
    now: () => new Date(current),
    advance(minutes) { current = new Date(current.getTime() + minutes * 60_000) },
    async service() {
      const service = new JiwenService({ dataDir: root, config, now: () => new Date(current) })
      await service.init()
      return service
    },
  }
}
