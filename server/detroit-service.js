import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const bridgePath = fileURLToPath(new URL('./detroit/bridge.py', import.meta.url))

export class DetroitService {
  constructor({ dataDir, pythonPath = process.env.DETROIT_PYTHON_BIN || 'python3' }) {
    this.dbPath = path.join(dataDir, 'detroit', 'games.sqlite3')
    this.pythonPath = pythonPath
    this.ready = false
    this.active = 0
  }

  async init() {
    this.ready = (await this.call('ping', {})).ready === true
  }

  async call(action, args) {
    if (this.active >= 4) throw new Error('Game is busy. Please retry shortly.')
    this.active += 1
    try {
      return await this.runBridge(action, args)
    } finally {
      this.active -= 1
    }
  }

  runBridge(action, args) {
    return new Promise((resolve, reject) => {
      // Fixed executable and script; only bounded JSON goes to stdin. No shell.
      // Do not pass Pocket, memory, or hosting credentials to the game process.
      const child = spawn(this.pythonPath, ['-I', bridgePath], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH || '',
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          PYTHONIOENCODING: 'utf-8',
        },
      })
      let output = ''
      let size = 0
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(value)
      }
      const timer = setTimeout(() => {
        child.kill()
        finish(new Error('Game request timed out. Read the saved scene before retrying.'))
      }, 15000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        size += Buffer.byteLength(chunk)
        if (size > 2 * 1024 * 1024) {
          child.kill()
          finish(new Error('Game response too large. Request a smaller history page.'))
        } else output += chunk
      })
      child.stderr.resume()
      child.on('error', () => finish(new Error('Game runtime unavailable.')))
      child.stdin.on('error', () => finish(new Error('Game runtime unavailable.')))
      child.on('close', (code) => {
        if (code !== 0) return finish(new Error('Game runtime stopped. Read the saved scene before retrying.'))
        try {
          const envelope = JSON.parse(output)
          if (!envelope.ok) return finish(new Error(envelope.error || 'Game operation failed.'))
          const payload = envelope.result
          if (['choose_action', 'continue_game'].includes(payload.next_action)) payload.next_action = `detroit_${payload.next_action}`
          finish(null, payload)
        } catch { finish(new Error('Invalid game response.')) }
      })
      child.stdin.end(JSON.stringify({ action, args, db_path: this.dbPath }))
    })
  }
}
