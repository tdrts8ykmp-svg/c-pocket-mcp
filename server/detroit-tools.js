import * as z from 'zod/v4'

const gameId = z.string().regex(/^[A-Za-z0-9_-]{43}$/).describe('Exact game_id from start_game; keep it to resume.')
const turn = z.number().int().min(0).describe('Latest turn returned by get_scene or the previous action.')
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const chapter = z.object({ number: z.number(), title: z.string(), protagonist: z.union([z.string(), z.array(z.string())]).nullable() })
const event = z.record(z.string(), z.unknown())
const view = {
  game_id: gameId,
  status: z.enum(['playing', 'chapter_complete', 'complete']),
  turn: z.number().int(),
  chapter,
  history_count: z.number().int(),
  events: z.array(event).optional(),
  scene: z.object({ context: z.string(), choices: z.array(z.object({ number: z.number(), text: z.string() })) }).optional(),
  chapter_result: event.optional(),
  next_action: z.string(),
}

export function registerDetroitTools(server, service) {
  const register = (name, action, description, inputSchema, annotations, outputSchema = view) => {
    server.registerTool(name, { title: name.replaceAll('_', ' '), description, inputSchema, outputSchema, annotations }, async (args) => {
      try {
        const payload = await service.call(action, args)
        return { structuredContent: payload, content: [{ type: 'text', text: JSON.stringify(payload) }] }
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] }
      }
    })
  }
  register('detroit_start_game', 'start',
    'Start a new Detroit AI Player 32-chapter text adventure. Returns only the opening scene and visible choices, never a full script or ending list. The assistant in this conversation is the player; no separate AI or API key. Defaults to Chinese. Save game_id. Use get_scene to resume instead.',
    { language: z.enum(['zh', 'en']).default('zh'), difficulty: z.enum(['casual', 'experienced', 'hardcore']).default('casual') },
    { ...write, idempotentHint: false })
  register('detroit_get_scene', 'scene',
    'Read or resume the current saved Detroit scene, numbered choices and turn. No advancement and no spoilers.',
    { game_id: gameId }, read)
  register('detroit_choose_action', 'choose',
    'Choose one displayed action number for the current Detroit turn. Optional note is a short player comment. Uses only the current scene, not walkthrough knowledge. Progress saves automatically. Exact retries do not repeat a move.',
    { game_id: gameId, turn, choice: z.number().int().min(1).max(100), note: z.string().max(500).default('') }, write)
  register('detroit_continue_game', 'continue',
    'Only when Detroit status is chapter_complete, advance to the next chapter, preserving consequences. Read the reached chapter outcome first. Cannot skip to a future chapter. Stop when the user asks to pause.',
    { game_id: gameId, turn }, write)
  register('detroit_get_history', 'history',
    'Restore past Detroit scenes, actual choices and completed chapter summaries. Follow next_offset for more. Excludes internal scores, future branches and the companion memory store.',
    { game_id: gameId, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(30) }, read,
    { game_id: gameId, events: z.array(event), next_offset: z.number().int().nullable(), chapter_summaries: z.array(z.string()) })
}
