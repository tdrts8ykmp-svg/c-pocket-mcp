import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startBridge } from './index.js'

const prefix = path.join(os.tmpdir(), 'detroit-mcp-test-')
const dataDir = await mkdtemp(prefix)
let bridge
let client
async function connect() {
  bridge = await startBridge({ dataDir, port: 0, host: '127.0.0.1' })
  const baseUrl = `http://127.0.0.1:${bridge.address.port}`
  const health = await fetch(`${baseUrl}/health`).then((r) => r.json())
  assert.equal(health.capabilities.detroit, true)
  assert.equal(health.capabilities.rss, true)
  client = new Client({ name: 'detroit-smoke', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)))
}
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args })
  assert.notEqual(response.isError, true, JSON.stringify(response))
  return response.structuredContent
}
try {
  await connect()
  const tools = (await client.listTools()).tools
  const names = tools.map((tool) => tool.name)
  for (const name of ['pocket_list', 'rss_list_feeds', 'jiwen_status', 'detroit_start_game', 'detroit_choose_action']) assert.ok(names.includes(name))
  for (const tool of tools.filter((t) => t.name.startsWith('detroit_'))) {
    assert.ok(tool.inputSchema)
    assert.ok(tool.outputSchema)
    assert.equal(tool.annotations.openWorldHint, false)
  }
  const start = await call('detroit_start_game')
  assert.equal(start.chapter.title, '人质')
  assert.equal(start.turn, 0)
  assert.ok(start.scene.context.includes('鱼'))
  assert.ok(!JSON.stringify(start).includes('success_probability'))
  const game_id = start.game_id
  const args = { game_id, turn: 0, choice: 1, note: 'Test choice' }
  const moved = await call('detroit_choose_action', args)
  assert.deepEqual(await call('detroit_choose_action', args), moved)
  assert.equal((await call('detroit_get_scene', { game_id })).turn, 1)
  const bad = await client.callTool({ name: 'detroit_choose_action', arguments: { game_id, turn: 1, choice: 99 } })
  assert.equal(bad.isError, true)
  assert.equal((await call('detroit_get_scene', { game_id })).turn, 1)
  const history = await call('detroit_get_history', { game_id, limit: 1 })
  assert.equal(history.events.length, 1)
  assert.equal(history.next_offset, 1)
  const continuation = await call('detroit_get_history', { game_id, offset: 1, limit: 20 })
  assert.equal(continuation.events[0].action, moved.events[0].action)
  let current = moved
  for (let count = 0; count < 50 && current.status === 'playing'; count += 1) {
    current = await call('detroit_choose_action', { game_id, turn: current.turn, choice: 1 })
  }
  assert.equal(current.status, 'chapter_complete')
  current = await call('detroit_continue_game', { game_id, turn: current.turn })
  assert.equal(current.chapter.number, 2)
  await client.close()
  client = null
  await bridge.stop()
  bridge = null
  await connect()
  assert.deepEqual((await call('detroit_get_scene', { game_id })).scene, current.scene)
  assert.equal((await call('pocket_list')).items.length, 0)
  console.log('Detroit MCP integration passed: discovery, choices, retry, invalid inputs, chapter transition, restart persistence, Pocket coexistence.')
  const campaigns = spawnSync(process.env.DETROIT_PYTHON_BIN || 'python3', [fileURLToPath(new URL('./detroit/test_campaign.py', import.meta.url))], { windowsHide: true, encoding: 'utf8', timeout: 60000 })
  assert.equal(campaigns.status, 0, campaigns.stderr || campaigns.error?.message)
  console.log('18 full Detroit campaigns passed: Chinese/English, three difficulties, three choice strategies.')
} finally {
  if (client) await client.close()
  if (bridge) await bridge.stop()
  assert.ok(path.resolve(dataDir).startsWith(path.resolve(prefix)), 'Unexpected test directory')
  await rm(dataDir, { recursive: true, force: true })
}
