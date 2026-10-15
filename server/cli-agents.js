// Claude Code and Codex as backends: list and import their saved sessions, and
// run a Radiant chat turn through their command-line tools.
//
// Both tools are signed in on this Mac with the user's subscription. Radiant
// never sees a login: it reads the session files each tool already writes
// (~/.claude/projects, ~/.codex/sessions) and starts the tool's own `claude` /
// `codex` program, which uses its own credentials. Nothing here opens
// ~/.claude/.credentials*, ~/.codex/auth.json or any token.
//
// ⚠️ THESE CHATS ARE NOT RADIANT TURNS. The tool brings its own model, tools,
// skills and memory; Radiant's tools, skills, memory and Jev do not apply. All
// Radiant does is carry the text in, show the reply, and keep the transcript.
//
// ⚠️ TRANSCRIPTS CAN BE HUGE AND ARE PRIVATE. A single Codex rollout on this Mac
// is 218 MB. Nothing below reads a whole file into memory: summaries come from
// the head and tail, counts and imports stream line by line, and an import only
// looks at the last IMPORT_MAX_BYTES of a giant file. Nothing is ever read
// outside the two session folders, and no symlink is followed.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { execFile, spawn } from 'node:child_process'
import { SPAWN_ENV, resolveBin } from './ollama.js'
import { boundResult } from './tool-bounds.js'

export const CLI_TOOLS = {
  'claude-code': {
    id: 'claude-code', name: 'claude', envVar: 'CLAUDE_BIN', label: 'Claude Code', providerName: 'Claude Code (subscription)',
    install: 'Install Claude Code (claude.com/claude-code), then run `claude` once in Terminal to sign in with your subscription.'
  },
  codex: {
    id: 'codex', name: 'codex', envVar: 'CODEX_BIN', label: 'Codex', providerName: 'Codex (subscription)',
    install: 'Install the OpenAI Codex CLI (`npm i -g @openai/codex`), then run `codex login` in Terminal to sign in with your ChatGPT subscription.'
  }
}
export const isCliTool = id => Object.prototype.hasOwnProperty.call(CLI_TOOLS, id)

// ---------------------------------------------------------------------------
// Where the files live, and which ids are allowed to name one
// ---------------------------------------------------------------------------

// Read at call time, not import time, so a test (or a user who sets
// CLAUDE_CONFIG_DIR / CODEX_HOME) is honored without a restart.
const claudeRoot = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects')
const codexRoot = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions')
const rootFor = tool => (tool === 'codex' ? codexRoot() : claudeRoot())

// ⚠️ THE ID IS THE ONLY THING A CALLER CHOOSES. It becomes part of a file name,
// so it is held to the shape the tool itself writes before it gets anywhere
// near a path. Claude ids are uuid-like (some have a 5 in the third group, so
// "hex and dashes" rather than strict v4); Codex rollouts end in a plain uuid.
const CLAUDE_ID = /^[0-9a-fA-F-]{8,64}$/
const CODEX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function validCliId (tool, id) {
  if (typeof id !== 'string') return false
  return tool === 'codex' ? CODEX_ID.test(id) : tool === 'claude-code' ? CLAUDE_ID.test(id) : false
}

/** A real path of a regular file that really sits under `root` (no symlink hops out). */
async function contained (root, file) {
  try {
    const [r, f] = await Promise.all([fsp.realpath(root), fsp.realpath(file)])
    return f.startsWith(r + path.sep)
  } catch { return false }
}

// Dirent.isFile()/isDirectory() are false for a symlink, so a link is skipped
// rather than followed — the folder tree is walked only through real entries.
async function readdirSafe (dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }) } catch { return [] }
}

async function statFile (file) {
  try { const s = await fsp.stat(file); return { file, size: s.size, mtimeMs: s.mtimeMs } } catch { return null }
}

/** Every session file for a tool, as { file, size, mtimeMs }, newest first. */
async function walkSessions (tool) {
  const root = rootFor(tool)
  const found = []
  if (tool === 'claude-code') {
    for (const d of await readdirSafe(root)) {
      if (!d.isDirectory()) continue
      for (const f of await readdirSafe(path.join(root, d.name))) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue
        if (!validCliId(tool, f.name.slice(0, -6))) continue
        found.push(path.join(root, d.name, f.name))
      }
    }
  } else {
    // YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
    for (const y of await readdirSafe(root)) {
      if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) continue
      for (const m of await readdirSafe(path.join(root, y.name))) {
        if (!m.isDirectory() || !/^\d{2}$/.test(m.name)) continue
        for (const d of await readdirSafe(path.join(root, y.name, m.name))) {
          if (!d.isDirectory() || !/^\d{2}$/.test(d.name)) continue
          for (const f of await readdirSafe(path.join(root, y.name, m.name, d.name))) {
            if (f.isFile() && /^rollout-.*-[0-9a-f-]{36}\.jsonl$/i.test(f.name)) found.push(path.join(root, y.name, m.name, d.name, f.name))
          }
        }
      }
    }
  }
  const stats = (await Promise.all(found.map(statFile))).filter(Boolean)
  return stats.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** The one file an id names, or null. Never builds a path from anything unvalidated. */
async function findSessionFile (tool, id) {
  if (!validCliId(tool, id)) return null
  const root = rootFor(tool)
  if (tool === 'claude-code') {
    for (const d of await readdirSafe(root)) {
      if (!d.isDirectory()) continue
      const file = path.join(root, d.name, id + '.jsonl')
      let st
      try { st = await fsp.lstat(file) } catch { continue }
      if (st.isFile() && await contained(root, file)) return { file, size: st.size, mtimeMs: st.mtimeMs }
    }
    return null
  }
  const want = id.toLowerCase()
  for (const s of await walkSessions(tool)) {
    if (path.basename(s.file).toLowerCase().endsWith(`-${want}.jsonl`) && await contained(root, s.file)) return s
  }
  return null
}

// ---------------------------------------------------------------------------
// Reading big files a line at a time
// ---------------------------------------------------------------------------

// Return true from onLine to stop early (the stream is destroyed so a 200 MB
// file is not read to the end for the sake of its first user message).
async function scanLines (file, onLine, { start = 0, end, skipFirst = false } = {}) {
  const stream = fs.createReadStream(file, { start, end, encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let first = skipFirst
  try {
    for await (const line of rl) {
      if (first) { first = false; continue }
      if (line && onLine(line) === true) break
    }
  } finally { rl.close(); stream.destroy() }
}

/** The complete lines in the last `bytes` of a file. */
async function tailLines (file, size, bytes = 256 * 1024) {
  const start = Math.max(0, size - bytes)
  const fh = await fsp.open(file, 'r')
  try {
    const buf = Buffer.alloc(size - start)
    await fh.read(buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n')
    if (start > 0) lines.shift() // began mid-line
    return lines.filter(Boolean)
  } finally { await fh.close() }
}

const parse = line => { try { return JSON.parse(line) } catch { return null } }
const oneLine = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)

// ---------------------------------------------------------------------------
// What counts as something the person typed
// ---------------------------------------------------------------------------

/** The text of a real Claude Code prompt, or null for tool results and injected noise. */
function claudeUserText (rec) {
  if (rec.type !== 'user' || rec.isMeta || rec.isSidechain) return null
  const c = rec.message?.content
  let t = ''
  if (typeof c === 'string') t = c
  else if (Array.isArray(c)) {
    if (c.some(b => b?.type === 'tool_result')) return null
    t = c.map(b => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n')
  } else return null
  t = t.replace(/^(\s*<system-reminder>[\s\S]*?<\/system-reminder>)+/, '').trim()
  if (!t) return null
  // The app wraps local command output and hook reminders in tags; those are
  // not the person talking.
  if (/^<(local-command-|ide_|user-prompt-submit-hook)/.test(t) || /^Caveat: The messages below were generated by the user/.test(t)) return null
  if (/^\[Request interrupted by user/.test(t)) return null
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(t)
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)
    t = `${cmd[1].trim()} ${args ? args[1].trim() : ''}`.trim()
  }
  return t
}

const CODEX_INJECTED = /^(<(environment_context|user_instructions|recommended_plugins|permissions|collaboration_mode|turn_aborted|subagent_notification)[ >]|# AGENTS\.md instructions)/

/** The text of a real Codex prompt from a response_item message payload, or null. */
function codexUserText (p) {
  if (p?.type !== 'message' || p.role !== 'user') return null
  const text = (Array.isArray(p.content) ? p.content : [])
    .map(b => (b?.type === 'input_text' || b?.type === 'text' ? b.text : b?.type === 'input_image' ? '[image]' : ''))
    .filter(Boolean).join('\n').trim()
  if (!text) return null
  // Newer rollouts label each message's kinds; the person's own words carry
  // "user.text" and everything the tool injected does not.
  const kinds = p.internal_chat_message_metadata_passthrough?.content_item_kinds
  if (Array.isArray(kinds) && kinds.length) return kinds.includes('user.text') ? text : null
  return CODEX_INJECTED.test(text) ? null : text
}

// ---------------------------------------------------------------------------
// Summaries (cheap: the head, the tail, and a streamed count for modest files)
// ---------------------------------------------------------------------------

const COUNT_MAX_BYTES = 16 * 1024 * 1024 // past this, messageCount is null: counting 200 MB for a list row is not worth it
const summaryCache = new Map()           // path|size|mtime -> summary (or false for "skip this one")
const CACHE_MAX = 3000

function remember (key, value) {
  if (summaryCache.size >= CACHE_MAX) summaryCache.delete(summaryCache.keys().next().value)
  summaryCache.set(key, value)
  return value
}

async function summarizeClaude ({ file, size, mtimeMs }) {
  const sum = { tool: 'claude-code', id: path.basename(file, '.jsonl'), cwd: null, title: null, gitBranch: null, model: null, startedAt: null, updatedAt: new Date(mtimeMs).toISOString(), messageCount: null, sizeBytes: size }
  let firstUser = null, custom = null, ai = null, sidechain = false, lines = 0
  const take = rec => {
    if (!rec) return
    if (rec.cwd && !sum.cwd) sum.cwd = rec.cwd
    if (rec.gitBranch && !sum.gitBranch) sum.gitBranch = rec.gitBranch
    if (rec.timestamp && !sum.startedAt) sum.startedAt = rec.timestamp
    if (rec.type === 'custom-title' && rec.customTitle) custom = rec.customTitle
    else if (rec.type === 'ai-title' && rec.aiTitle) ai = rec.aiTitle
    else if (rec.type === 'assistant' && !sum.model && rec.message?.model && !String(rec.message.model).startsWith('<')) sum.model = rec.message.model
    if (!firstUser) firstUser = claudeUserText(rec)
  }
  // Head: the first user prompt, cwd and branch are all in the first lines. A
  // sidechain (a sub-agent's private transcript) says so on its first record.
  await scanLines(file, line => {
    lines++
    const rec = parse(line)
    if (lines === 1 && rec?.isSidechain === true) { sidechain = true; return true }
    take(rec)
    return lines >= 400 || (firstUser && sum.cwd && sum.model && (custom || ai))
  }, { end: 8 * 1024 * 1024 })
  if (sidechain || !firstUser) return false
  // Tail: titles are rewritten as the chat goes on, so the latest are at the end.
  try {
    for (const l of await tailLines(file, size)) {
      const rec = parse(l)
      if (!rec) continue
      if (rec.type === 'custom-title' && rec.customTitle) custom = rec.customTitle
      else if (rec.type === 'ai-title' && rec.aiTitle) ai = rec.aiTitle
      else if (rec.type === 'assistant' && rec.message?.model && !String(rec.message.model).startsWith('<')) sum.model = rec.message.model
    }
  } catch {}
  sum.title = oneLine(custom || ai || firstUser, 80)
  if (size <= COUNT_MAX_BYTES) {
    // Substring tests, not JSON.parse: approximate on purpose (a prompt that
    // quotes the string "tool_result" would be missed) and several times faster.
    let n = 0
    await scanLines(file, l => {
      if (l.includes('"type":"user"')) { if (!l.includes('"tool_result"') && !l.includes('"isMeta":true') && !l.includes('"isSidechain":true') && !l.includes('<local-command-')) n++ }
      else if (l.includes('"type":"assistant"') && l.includes('"type":"text"') && !l.includes('"isSidechain":true')) n++
    })
    sum.messageCount = n
  }
  return sum
}

async function summarizeCodex ({ file, size, mtimeMs }) {
  const sum = { tool: 'codex', id: path.basename(file, '.jsonl').slice(-36).toLowerCase(), cwd: null, title: null, gitBranch: null, model: null, startedAt: null, updatedAt: new Date(mtimeMs).toISOString(), messageCount: null, sizeBytes: size }
  let firstUser = null, subagent = false, lines = 0
  await scanLines(file, line => {
    lines++
    const rec = parse(line)
    if (!rec) return
    const p = rec.payload || {}
    if (rec.type === 'session_meta') {
      if (p.id) sum.id = String(p.id).toLowerCase()
      sum.cwd = p.cwd || sum.cwd
      sum.startedAt = p.timestamp || rec.timestamp || sum.startedAt
      sum.gitBranch = p.git?.branch || sum.gitBranch
      // A sub-agent's thread is the parent's private business, not a chat.
      if (p.thread_source === 'subagent' || (p.source && typeof p.source === 'object' && p.source.subagent)) { subagent = true; return true }
    } else if (!sum.model && (rec.type === 'turn_context' || p.type === 'thread_settings_applied')) {
      sum.model = p.model || p.thread_settings?.model || sum.model
    } else if (!firstUser && rec.type === 'response_item') {
      firstUser = codexUserText(p)
    }
    return lines >= 4000 || (firstUser && sum.model)
  }, { end: 32 * 1024 * 1024 })
  if (subagent || !firstUser) return false
  sum.title = oneLine(firstUser, 80)
  if (size <= COUNT_MAX_BYTES) {
    let n = 0
    await scanLines(file, l => {
      if (!l.includes('"type":"message"')) return
      if (l.includes('"role":"assistant"')) n++
      else if (l.includes('"role":"user"') && l.includes('user.text')) n++
    })
    sum.messageCount = n
  }
  return sum
}

async function summarize (tool, entry) {
  const key = `${entry.file}|${entry.size}|${entry.mtimeMs}`
  if (summaryCache.has(key)) return summaryCache.get(key)
  let s = false
  try { s = tool === 'codex' ? await summarizeCodex(entry) : await summarizeClaude(entry) } catch { s = false }
  return remember(key, s)
}

// Do the work a few files at a time: a list row is cheap but 400 of them at once is not.
async function pool (items, n, fn) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]) }
  }))
  return out
}

/**
 * Lightweight summaries of the saved sessions, newest first.
 * Walks at most `scan` files (newest first) so a search over a huge history
 * stays quick; sidechains, sub-agent threads and empty sessions are skipped.
 */
export async function listCliSessions ({ tool, limit = 50, since, q, scan = 400 } = {}) {
  const tools = tool ? [tool] : ['claude-code', 'codex']
  const needle = String(q || '').toLowerCase().trim()
  const sinceMs = since ? new Date(since).getTime() : 0
  const out = []
  for (const t of tools) {
    if (!isCliTool(t)) continue
    const entries = (await walkSessions(t)).filter(e => !sinceMs || e.mtimeMs >= sinceMs).slice(0, scan)
    for (let i = 0; i < entries.length && out.filter(s => s.tool === t).length < limit; i += 12) {
      const batch = await pool(entries.slice(i, i + 12), 6, e => summarize(t, e))
      for (const s of batch) {
        if (!s) continue
        if (needle && !`${s.title} ${s.cwd}`.toLowerCase().includes(needle)) continue
        out.push(s)
      }
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit)
}

// ---------------------------------------------------------------------------
// Reading one session as a Radiant transcript
// ---------------------------------------------------------------------------

export const IMPORT_MESSAGE_CAP = 400
const IMPORT_MAX_BYTES = 48 * 1024 * 1024 // a bigger file is read from its end; the early turns are what get dropped
const IMPORT_RESULT_CAP = 8000

// One name per job, so a Claude Code Bash call reads like a Radiant run_command
// in the chat. Anything unfamiliar keeps its own name and arguments.
function capArgs (a) {
  const out = {}
  for (const [k, v] of Object.entries(a || {})) out[k] = typeof v === 'string' && v.length > 4000 ? v.slice(0, 4000) + '…' : v
  return out
}
function claudeToolPart (b, round) {
  const i = b.input && typeof b.input === 'object' ? b.input : {}
  let name = b.name || 'tool', args = capArgs(i)
  if (name === 'Bash') name = 'run_command'
  else if (name === 'Read') { name = 'read_file'; args = { ...args, path: i.file_path } }
  else if (name === 'Write') { name = 'write_file'; args = { ...args, path: i.file_path } }
  else if (name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') { name = 'edit_file'; args = { ...args, path: i.file_path || i.notebook_path } }
  return { type: 'tool', id: b.id, name, args, round }
}
function codexShellCommand (args) {
  const c = args?.command ?? args?.cmd
  if (Array.isArray(c)) { // ["bash","-lc","the command"]: show the command, not the wrapper
    const k = c.findIndex(x => x === '-lc' || x === '-c')
    return k >= 0 && c[k + 1] ? c[k + 1] : c.join(' ')
  }
  return typeof c === 'string' ? c : ''
}
function codexToolPart (p, round) {
  const id = p.call_id || p.id
  let args = {}
  if (typeof p.arguments === 'string') { try { args = JSON.parse(p.arguments) } catch { args = { raw: p.arguments.slice(0, 2000) } } }
  else if (p.arguments && typeof p.arguments === 'object') args = p.arguments
  if (p.type === 'local_shell_call') return { type: 'tool', id, name: 'run_command', args: { command: codexShellCommand(p.action || {}) }, round }
  if (p.type === 'custom_tool_call') {
    const input = typeof p.input === 'string' ? p.input : ''
    if (p.name === 'apply_patch') return { type: 'tool', id, name: 'edit_file', args: { path: (/\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(input) || [])[1] || '', patch: input.slice(0, 4000) }, round }
    return { type: 'tool', id, name: p.name === 'exec' ? 'run_command' : (p.name || 'tool'), args: p.name === 'exec' ? { command: input.slice(0, 4000) } : { input: input.slice(0, 4000) }, round }
  }
  if (p.name === 'shell' || p.name === 'exec_command' || p.name === 'container.exec') return { type: 'tool', id, name: 'run_command', args: { command: codexShellCommand(args) }, round }
  if (p.name === 'apply_patch') return { type: 'tool', id, name: 'edit_file', args: { path: '', patch: String(args.input || args.patch || '').slice(0, 4000) }, round }
  return { type: 'tool', id, name: p.name || 'tool', args: capArgs(args), round }
}
function setResult (part, text, max = IMPORT_RESULT_CAP) {
  const b = boundResult(part.name, text, { max })
  part.result = b.text
  if (b.truncated) part.truncated = b.truncated
}
function toolResultText (c) {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(x => (typeof x === 'string' ? x : x?.type === 'image' || x?.type === 'input_image' ? '[image]' : x?.text || '')).filter(Boolean).join('\n')
  return c == null ? '' : JSON.stringify(c)
}

/**
 * One saved session as Radiant messages: [{role:'user',text}, {role:'assistant',parts}].
 * Returns { tool, id, cwd, title, model, gitBranch, startedAt, messages, truncated, totalMessages }.
 */
export async function readCliSession ({ tool, id, cap = IMPORT_MESSAGE_CAP }) {
  if (!isCliTool(tool)) throw new Error('Unknown tool.')
  if (!validCliId(tool, id)) throw new Error('That is not a session id.')
  const entry = await findSessionFile(tool, id)
  if (!entry) throw new Error('That session was not found.')
  const meta = (await summarize(tool, entry)) || { tool, id, cwd: null, title: null, gitBranch: null, model: null, startedAt: null }
  const out = []
  let cur = null, dropped = 0, round = 0
  const pending = new Map() // tool call id -> its part, until the result arrives
  const trim = () => { if (out.length > cap * 2) { dropped += out.length - cap; out.splice(0, out.length - cap) } }
  const asst = model => { if (!cur) { cur = { role: 'assistant', parts: [], ...(model ? { model } : {}) }; out.push(cur); round = 0 } return cur }
  const user = text => { cur = null; out.push({ role: 'user', text }); trim() }

  const partial = entry.size > IMPORT_MAX_BYTES
  const opts = partial ? { start: entry.size - IMPORT_MAX_BYTES, skipFirst: true } : {}

  if (tool === 'claude-code') {
    await scanLines(entry.file, line => {
      const rec = parse(line)
      if (!rec || rec.isSidechain) return
      if (rec.type === 'user') {
        const c = rec.message?.content
        if (Array.isArray(c)) for (const b of c) {
          if (b?.type !== 'tool_result') continue
          const part = pending.get(b.tool_use_id)
          if (part) { setResult(part, toolResultText(b.content)); if (b.is_error) part.error = true; pending.delete(b.tool_use_id) }
        }
        const t = claudeUserText(rec)
        if (t) user(t)
      } else if (rec.type === 'assistant') {
        const c = rec.message?.content
        const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : []
        for (const b of blocks) {
          if (b?.type === 'text' && b.text?.trim()) asst(rec.message?.model).parts.push({ type: 'text', text: b.text })
          else if (b?.type === 'tool_use') { const part = claudeToolPart(b, round); asst(rec.message?.model).parts.push(part); pending.set(b.id, part); round++ }
        }
      }
    }, opts)
  } else {
    await scanLines(entry.file, line => {
      if (!line.includes('"response_item"')) return // event_msg, token counts, world_state: none of it is the conversation
      const rec = parse(line)
      const p = rec?.payload
      if (!p || rec.type !== 'response_item') return
      if (p.type === 'message') {
        if (p.role === 'user') { const t = codexUserText(p); if (t) user(t) }
        else if (p.role === 'assistant') {
          const text = (Array.isArray(p.content) ? p.content : []).map(b => b?.text || '').join('').trim()
          if (text) asst(meta.model).parts.push({ type: 'text', text })
        }
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
        const part = codexToolPart(p, round)
        asst(meta.model).parts.push(part); pending.set(part.id, part); round++
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const part = pending.get(p.call_id)
        if (!part) return
        let text = toolResultText(p.output)
        if (typeof p.output === 'string' && p.output.startsWith('{')) { // {"output":"...","metadata":{...}}
          const o = parse(p.output)
          if (o && typeof o.output === 'string') text = o.output
        }
        setResult(part, text); pending.delete(p.call_id)
      }
    }, opts)
  }

  const total = out.length + dropped
  let messages = out.slice(-cap)
  // A transcript that opens on the assistant's half of a turn cannot be sent
  // on to a model; start at the first thing the person said.
  const firstUser = messages.findIndex(m => m.role === 'user')
  if (firstUser > 0) messages = messages.slice(firstUser)
  return {
    tool, id, cwd: meta.cwd, title: meta.title, model: meta.model, gitBranch: meta.gitBranch, startedAt: meta.startedAt,
    // a file read from its end cannot say how long the whole conversation was
    messages, totalMessages: partial ? null : total, truncated: partial || total > messages.length
  }
}

// ---------------------------------------------------------------------------
// Which tools are installed
// ---------------------------------------------------------------------------

// The override wins on every call (a test, or a user with the tool somewhere
// odd). Otherwise resolveBin knows the places a GUI-launched app must look,
// because Finder-launched Radiant does not inherit the shell's PATH.
function binFor (tool) {
  const spec = CLI_TOOLS[tool]
  const o = process.env[spec.envVar]
  if (o && fs.existsSync(o)) return o
  return resolveBin(spec.name, spec.envVar)
}
const runnable = bin => path.isAbsolute(bin) && fs.existsSync(bin)

// The child's environment: Radiant's own PATH additions, with anything that
// would make the tool bill an API key or behave as a nested session removed.
// ⚠️ The point of this feature is the SUBSCRIPTION login. An ANTHROPIC_API_KEY
// or OPENAI_API_KEY left in the shell Radiant was started from would silently
// switch the tool to metered billing, and the CLAUDE_CODE_* variables of a
// session that launched Radiant would point the child at that session's host.
const DROP_ENV = /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|OPENAI_(API_KEY|BASE_URL)|CODEX_API_KEY|CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_AGENT_SDK.*|CLAUDE_(PID|EFFORT|PREVIEW_.*)|AI_AGENT)$/
function childEnv () {
  // Live process.env (so a changed variable is seen) with SPAWN_ENV's PATH on top.
  const env = { ...process.env, PATH: SPAWN_ENV.PATH, TERM: 'dumb', NO_COLOR: '1' }
  for (const k of Object.keys(env)) if (DROP_ENV.test(k)) delete env[k]
  return env
}

const run = (bin, args, ms = 5000) => new Promise(resolve => {
  execFile(bin, args, { timeout: ms, env: childEnv(), maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '') + String(stderr || '') }))
})

let detectCache = null
/** [{ id, label, bin, version, available, hint }], cached for about a minute. */
export async function detectCliAgents ({ fresh = false } = {}) {
  if (!fresh && detectCache && Date.now() - detectCache.at < 60_000) return detectCache.value
  const value = await Promise.all(Object.values(CLI_TOOLS).map(async spec => {
    const bin = binFor(spec.id)
    const base = { id: spec.id, label: spec.label, bin: runnable(bin) ? bin : null, version: null, available: false, hint: spec.install }
    if (!runnable(bin)) return base
    const v = await run(bin, ['--version'])
    const m = /(\d+\.\d+\.\d+[\w.-]*)/.exec(v.out)
    if (!v.ok && !m) return { ...base, hint: `${spec.label} is installed but did not answer \`${spec.name} --version\`. Open Terminal and run \`${spec.name}\` to see what is wrong.` }
    return { ...base, version: m ? m[1] : null, available: true, hint: `Uses the ${spec.label} sign-in already on this Mac. If a chat says you are signed out, run \`${spec.name}\` in Terminal once.` }
  }))
  detectCache = { at: Date.now(), value }
  return value
}

const helpCache = new Map()
/** The tool's own --help text, once per binary: how we learn which flags this version has. */
function helpText (bin) {
  if (!helpCache.has(bin)) helpCache.set(bin, run(bin, ['--help'], 8000).then(r => r.out))
  return helpCache.get(bin)
}

/** Models offered in the picker. The aliases come from the installed CLI's own help when it lists them. */
export async function cliModelsFor (tool) {
  const def = { id: 'default', label: 'Default (your own setting)' }
  if (tool === 'claude-code') {
    const bin = binFor(tool)
    let aliases = []
    if (runnable(bin)) {
      const m = /alias(?:es)? for the latest model \(e\.g\.\s*([^)]*)\)/.exec((await helpText(bin)).replace(/\s+/g, ' '))
      if (m) aliases = [...m[1].matchAll(/'([a-z][\w.-]*)'/gi)].map(x => x[1].toLowerCase())
    }
    const ids = [...new Set(['opus', 'sonnet', 'haiku', ...aliases])]
    return [def, ...ids.map(id => ({ id, label: id }))]
  }
  // Codex: the models its own catalog cache lists for this account (slug and visibility only), and
  // the model named at the top of config.toml, nothing else in either file.
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  let configured = null, listed = []
  try {
    const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8')
    configured = (/^\s*model\s*=\s*"([^"]+)"/m.exec(toml.split(/^\s*\[/m)[0]) || [])[1] || null
  } catch {}
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8'))
    listed = (cache.models || []).filter(x => x?.slug && x.visibility === 'list').map(x => x.slug)
  } catch {}
  // The configured model is not offered on its own: a name no longer in the catalog is a stale setting.
  return [{ id: 'default', label: configured ? `Default (${configured})` : 'Default (your Codex setting)' }, ...listed.map(id => ({ id, label: id }))]
}

// ---------------------------------------------------------------------------
// Permissions: Radiant's approval setting, translated for a tool with no one to ask
// ---------------------------------------------------------------------------
//
// ⚠️ THESE TOOLS RUN HEADLESS. There is no terminal for a "may I run this?"
// prompt, so a mode that asks would stall the turn until the idle timeout.
// Radiant's three approval settings therefore become the closest thing that
// can be decided up front:
//
//   Radiant approvalMode   Claude Code `--permission-mode`   Codex `sandbox_mode`
//   ask   (Ask each)       plan  - reads and researches only  read-only
//   auto  (Auto approve)   acceptEdits - edits go through     workspace-write
//   off   (Allow all)      bypassPermissions                  danger-full-access
//
// On top of that Claude Code gets `--permission-prompts none`, so anything the
// mode would still have asked about (a shell command, say) is declined at once
// instead of waiting for an answer nobody can give. Codex runs with
// approval_policy "never" for the same reason: what the sandbox forbids simply
// fails and the model sees the failure.
export function cliPermissionFor (tool, approvalMode) {
  const level = approvalMode === 'off' ? 'off' : approvalMode === 'auto' ? 'auto' : 'ask'
  if (tool === 'codex') return { ask: 'read-only', auto: 'workspace-write', off: 'danger-full-access' }[level]
  return { ask: 'plan', auto: 'acceptEdits', off: 'bypassPermissions' }[level]
}

const CLAUDE_EFFORT = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const CODEX_EFFORT = new Set(['low', 'medium', 'high', 'xhigh'])
const SAFE_MODEL = /^[A-Za-z0-9][\w.\-[\]:/@]{0,79}$/

// ---------------------------------------------------------------------------
// Running a turn
// ---------------------------------------------------------------------------

const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, lastPrompt: 0, costUsd: 0 })
const RESULT_CAP = 20000

/** Turns Claude Code's stream-json lines into Radiant events and message parts. */
class ClaudeStream {
  constructor ({ emit, parts }) {
    this.emit = emit; this.parts = parts
    this.sessionId = null; this.model = null
    this.usage = zeroUsage()
    this.streamed = new Set()  // message ids whose text already went out live
    this.live = ''             // text streamed for the message in flight but not yet committed
    this.byId = new Map()      // tool call id -> part
    this.round = 0; this.lastMsg = null
    this.final = null          // the `result` event
    this.denials = []
  }

  handle (ev) {
    if (!ev || typeof ev !== 'object') return
    if (ev.session_id && !this.sessionId) this.sessionId = ev.session_id
    // A sub-agent's inner traffic is not the conversation; its answer comes back as the Task tool's result.
    if (ev.parent_tool_use_id) return
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') { this.sessionId = ev.session_id || this.sessionId; this.model = ev.model || this.model }
        else if (ev.subtype === 'api_retry') this.emit({ type: 'notice', text: `Claude Code is retrying a request (attempt ${ev.attempt || '?'}).` })
        break
      case 'stream_event': this.stream(ev.event || {}); break
      case 'assistant':
        // An API failure arrives as an assistant message whose text is the error ("Failed to
        // authenticate..."). It is not a reply; the result event below carries it as the failure.
        if (ev.is_api_error_message) { this.apiError = toolResultText(ev.message?.content); break }
        this.assistant(ev.message || {}); break
      case 'user': this.userMessage(ev.message || {}); break
      case 'result': this.final = ev; break
      default: break // rate_limit_event, hooks, anything newer: not part of the chat
    }
  }

  stream (e) {
    if (e.type === 'message_start' && e.message?.id) { this.streamed.add(e.message.id); this.live = '' }
    else if (e.type === 'content_block_delta') {
      const d = e.delta || {}
      if (d.type === 'text_delta' && d.text) { this.live += d.text; this.emit({ type: 'text_delta', text: d.text }) }
      else if (d.type === 'thinking_delta' && d.thinking) this.emit({ type: 'thinking_delta', text: d.thinking })
    }
  }

  assistant (m) {
    if (m.id && m.id !== this.lastMsg) { if (this.lastMsg) this.round++; this.lastMsg = m.id }
    if (m.model && !String(m.model).startsWith('<')) this.model = m.model
    const u = m.usage
    if (u) this.usage.lastPrompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
    const live = this.streamed.has(m.id)
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : []
    for (const b of blocks) {
      if (b.type === 'text' && b.text) {
        this.parts.push({ type: 'text', text: b.text })
        if (!live) this.emit({ type: 'text_delta', text: b.text }) // older CLI without partial messages
        this.live = ''
      } else if (b.type === 'thinking' && b.thinking && !live) this.emit({ type: 'thinking_delta', text: b.thinking })
      else if (b.type === 'tool_use') {
        const part = claudeToolPart(b, this.round)
        this.parts.push(part); this.byId.set(b.id, part)
        this.emit({ type: 'tool_start', id: part.id, name: part.name, args: part.args })
      }
    }
  }

  userMessage (m) {
    if (!Array.isArray(m.content)) return
    for (const b of m.content) {
      if (b?.type !== 'tool_result') continue
      const part = this.byId.get(b.tool_use_id)
      if (!part) continue
      setResult(part, toolResultText(b.content), RESULT_CAP)
      const denied = Boolean(b.is_error) && /permission|not allowed|requires approval|was denied|doesn't want to proceed/i.test(part.result.slice(0, 300))
      if (denied) part.denied = true
      else if (b.is_error) part.error = true
      this.emit({ type: 'tool_result', id: part.id, result: part.result, denied })
    }
  }

  finish () {
    const f = this.final
    if (f?.usage) {
      const u = f.usage
      this.usage.cacheRead = u.cache_read_input_tokens || 0
      this.usage.cacheWrite = u.cache_creation_input_tokens || 0
      this.usage.input = (u.input_tokens || 0) + this.usage.cacheRead + this.usage.cacheWrite
      this.usage.output = u.output_tokens || 0
    }
    if (f?.total_cost_usd) this.usage.costUsd = f.total_cost_usd // notional on a subscription; kept, never billed
    if (Array.isArray(f?.permission_denials)) this.denials = [...new Set(f.permission_denials.map(d => d?.tool_name).filter(Boolean))]
    // The reply that was streaming when the process ended is still real work.
    if (this.live.trim()) { this.parts.push({ type: 'text', text: this.live }); this.live = '' }
    // A slash command or a short answer can come only in `result`.
    if (f && !f.is_error && typeof f.result === 'string' && f.result.trim() && !this.parts.some(p => p.type === 'text')) {
      this.parts.push({ type: 'text', text: f.result })
      this.emit({ type: 'text_delta', text: f.result })
    }
  }

  /** Why the turn failed, if the tool said so in its own result. */
  failure () {
    const f = this.final
    if (!f) return this.apiError || null
    if (!(f.is_error || (f.subtype && f.subtype !== 'success'))) return null
    if (f.subtype === 'error_max_turns') return 'Claude Code stopped because it reached its limit on steps for one message. Say "continue" to let it carry on.'
    if (f.subtype === 'error_max_budget_usd') return 'Claude Code stopped because it reached its spending limit for one message.'
    return (typeof f.result === 'string' && f.result.trim()) || this.apiError || (Array.isArray(f.errors) && f.errors.join(' ')) || `Claude Code ended with ${f.subtype || 'an error'}.`
  }
}

// Codex hands back an API failure as a JSON string ({"type":"error","error":{"message":...}}).
function plainError (m) {
  const t = String(m || '').trim()
  if (!t.startsWith('{')) return t
  try { const o = JSON.parse(t); return String(o.error?.message || o.message || t) } catch { return t }
}

/** Turns `codex exec --json` lines into Radiant events and message parts. */
class CodexStream {
  constructor ({ emit, parts }) {
    this.emit = emit; this.parts = parts
    this.sessionId = null; this.model = null
    this.usage = zeroUsage()
    this.byId = new Map(); this.round = 0
    this.fatal = null; this.sawTurn = false
    this.retrying = null
  }

  handle (ev) {
    if (!ev || typeof ev !== 'object') return
    switch (ev.type) {
      case 'thread.started': this.sessionId = ev.thread_id || this.sessionId; break
      case 'turn.started': this.sawTurn = true; break
      case 'item.started': if (ev.item) this.item(ev.item, false); break
      case 'item.completed': if (ev.item) this.item(ev.item, true); break
      case 'turn.completed': {
        const u = ev.usage || {}
        // codex reports input INCLUDING the cached part; Radiant's `input` is the
        // whole prompt too, so no addition is needed here (unlike Claude's split).
        this.usage.input += u.input_tokens || 0
        this.usage.cacheRead += u.cached_input_tokens || 0
        this.usage.output += u.output_tokens || 0
        this.usage.lastPrompt = u.input_tokens || this.usage.lastPrompt
        break
      }
      case 'turn.failed': this.fatal = plainError(ev.error?.message || ev.message) || 'Codex could not finish the turn.'; break
      case 'error': {
        // Codex says "Reconnecting... 2/5" through here before it gives up; only turn.failed is final.
        const msg = plainError(ev.message || ev.error?.message || '')
        if (/reconnect/i.test(msg)) { if (this.retrying !== msg) { this.retrying = msg; this.emit({ type: 'notice', text: `Codex: ${msg}` }) } } else this.lastError = msg
        break
      }
      default: break
    }
  }

  item (it, done) {
    const id = it.id || `item_${this.parts.length}`
    switch (it.type) {
      case 'agent_message':
        if (done && it.text) { this.parts.push({ type: 'text', text: it.text }); this.emit({ type: 'text_delta', text: it.text }); this.round++ }
        break
      case 'reasoning': if (done && it.text) this.emit({ type: 'thinking_delta', text: it.text }); break
      case 'command_execution': {
        let part = this.byId.get(id)
        if (!part) { part = { type: 'tool', id, name: 'run_command', args: { command: it.command || '' }, round: this.round }; this.parts.push(part); this.byId.set(id, part); this.emit({ type: 'tool_start', id, name: part.name, args: part.args }) }
        if (done) {
          const code = it.exit_code
          setResult(part, `${it.aggregated_output || ''}${code != null && code !== 0 ? `\n[exit code ${code}]` : ''}`.trim(), RESULT_CAP)
          if (code != null && code !== 0) part.error = true
          this.emit({ type: 'tool_result', id, result: part.result, denied: false })
        }
        break
      }
      case 'file_change': {
        if (!done) break
        const changes = Array.isArray(it.changes) ? it.changes : []
        const part = { type: 'tool', id, name: 'edit_file', args: { path: changes[0]?.path || '', changes: changes.slice(0, 50) }, round: this.round }
        part.result = changes.length ? changes.map(c => `${c.kind || 'update'}: ${c.path}`).join('\n') : 'No files changed.'
        if (it.status === 'failed') part.error = true
        this.parts.push(part)
        this.emit({ type: 'tool_start', id, name: part.name, args: part.args })
        this.emit({ type: 'tool_result', id, result: part.result, denied: false })
        break
      }
      case 'mcp_tool_call': case 'web_search': {
        if (!done) break
        const name = it.type === 'web_search' ? 'web_search' : `mcp__${it.server || 'server'}__${it.tool || 'tool'}`
        const part = { type: 'tool', id, name, args: it.type === 'web_search' ? { query: it.query } : capArgs(typeof it.arguments === 'object' ? it.arguments : { arguments: it.arguments }), round: this.round }
        setResult(part, it.error?.message || toolResultText(it.result?.content ?? it.result ?? ''), RESULT_CAP)
        this.parts.push(part)
        this.emit({ type: 'tool_start', id, name, args: part.args })
        this.emit({ type: 'tool_result', id, result: part.result, denied: false })
        break
      }
      // Startup warnings about the user's own config ("Under-development features enabled…") ride in
      // here on every run; they are not about this turn, so they are not shown.
      case 'error': if (done && it.message && !/under-development features/i.test(it.message)) this.emit({ type: 'notice', text: `Codex: ${it.message}` }); break
      default: break
    }
  }

  finish () {}
  failure () { return this.fatal }
}

// What the tool printed when it died, boiled down to a sentence a person can act on.
function friendlyCliError (spec, raw) {
  const t = String(raw || '').trim()
  if (/not logged in|please run \/login|invalid api key|log ?in required|\b401\b|unauthorized|authenticat|oauth session|session expired|token (?:has )?expired|no api key|codex login/i.test(t)) {
    return `${spec.label} is not signed in on this Mac. Open Terminal, run \`${spec.name}${spec.id === 'codex' ? ' login' : ''}\` and sign in with your subscription, then try again.`
  }
  if (/no conversation found|session not found|no (?:recorded )?session|could not find session|no rollout found/i.test(t)) {
    return `${spec.label} could not find that conversation any more. It may have been deleted, or it was started in a different folder. Start a new chat to continue.`
  }
  const tail = t.split('\n').map(l => l.trim()).filter(Boolean).slice(-3).join(' ').slice(-400)
  const hint = /model.{0,80}(not supported|does not exist|not found|unknown)|(unknown|invalid|unsupported) model/i.test(t) ? ' Choose another model from the model picker.' : ''
  return tail ? `${spec.label} stopped with an error: ${tail}${hint}` : `${spec.label} stopped without saying why.`
}

// ⚠️ A TURN OUTLIVES THE APP UNLESS SOMEONE ENDS IT. The tool runs in its own process group (so Stop can
// reach its helpers), which also means quitting Radiant mid-turn would leave it running and editing files
// with nobody watching. Anything still alive when this process exits is sent SIGTERM.
const live = new Set()
process.on('exit', () => { for (const c of live) { try { process.kill(-c.pid, 'SIGTERM') } catch {} } })

function killTree (child, killMs) {
  const pid = child.pid
  if (!pid) return
  const send = sig => {
    // The tool starts its own helpers (shells, language servers); signal the
    // whole group so none outlive the turn. Falls back to the child alone.
    try { process.kill(-pid, sig) } catch { try { child.kill(sig) } catch {} }
  }
  send('SIGTERM')
  const t = setTimeout(() => send('SIGKILL'), killMs)
  t.unref?.()
  child.once('close', () => { clearTimeout(t); try { process.kill(-pid, 'SIGKILL') } catch {} }) // sweep stragglers in the group
}

/**
 * Run one chat turn through the tool and stream it.
 * Resolves (never rejects for a tool failure) with
 *   { parts, usage, cliSessionId, model, error, aborted, timedOut, exitCode }
 * `parts` is filled as the turn goes (pass your own array to keep partial
 * work if the process dies). `error` is a sentence for a person, or null.
 * `permissionMode` is Radiant's approval setting: 'ask' | 'auto' | 'off'.
 */
export async function runCliTurn ({ tool, text, cwd, resumeId, model, permissionMode = 'ask', effort, emit = () => {}, signal, parts = [], ephemeral = false, onRaw } = {}) {
  const spec = CLI_TOOLS[tool]
  if (!spec) throw new Error(`Unknown tool: ${tool}`)
  const res = { parts, usage: zeroUsage(), cliSessionId: resumeId || null, model: null, error: null, aborted: false, timedOut: false, exitCode: null }
  if (signal?.aborted) { res.aborted = true; return res }

  const bin = binFor(tool)
  if (!runnable(bin)) { res.error = `${spec.label} is not installed on this Mac. ${spec.install}`; return res }
  let dir = cwd
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    // A resumed conversation lives under its folder; carrying on from another one would start a different chat.
    if (resumeId) { res.error = `This chat's folder (${cwd || 'none set'}) is not on this Mac, and ${spec.label} keeps each conversation with its folder. Pick the folder in the header, or start a new chat here.`; return res }
    dir = os.homedir()
  }

  const mode = cliPermissionFor(tool, permissionMode)
  const m = model && model !== 'default' && SAFE_MODEL.test(model) ? model : null
  let args
  if (tool === 'claude-code') {
    args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', mode]
    // Only the newer CLI has this flag; an older one would refuse to start over it.
    if (/--permission-prompts/.test(await helpText(bin))) args.push('--permission-prompts', 'none')
    if (m) args.push('--model', m)
    if (CLAUDE_EFFORT.has(effort)) args.push('--effort', effort)
    if (ephemeral) args.push('--no-session-persistence')
    if (resumeId && validCliId(tool, resumeId)) args.push('--resume', resumeId)
  } else {
    // `-c key=value` rather than --sandbox: the resume subcommand has no --sandbox flag but honors -c.
    args = ['exec', '--json', '--skip-git-repo-check', '-c', `sandbox_mode="${mode}"`, '-c', 'approval_policy="never"']
    if (m) args.push('-m', m)
    if (CODEX_EFFORT.has(effort)) args.push('-c', `model_reasoning_effort="${effort}"`)
    if (ephemeral) args.push('--ephemeral')
    if (resumeId && validCliId(tool, resumeId)) args.push('resume', resumeId)
    args.push('-') // the prompt arrives on stdin
  }

  const idleMs = Number(process.env.RADIANT_CLI_IDLE_MS) > 0 ? Number(process.env.RADIANT_CLI_IDLE_MS) : 10 * 60 * 1000
  const killMs = Number(process.env.RADIANT_CLI_KILL_MS) > 0 ? Number(process.env.RADIANT_CLI_KILL_MS) : 3000
  const stream = tool === 'codex' ? new CodexStream({ emit, parts }) : new ClaudeStream({ emit, parts })

  return await new Promise(resolve => {
    let child
    try {
      // The prompt goes in on stdin, never in argv: a message that starts with
      // "-" would be read as a flag, and a pasted file can exceed the argv limit.
      child = spawn(bin, args, { cwd: dir, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    } catch (e) { res.error = `${spec.label} could not start (${e.message}).`; return resolve(res) }

    live.add(child)
    let buf = '', errTail = '', plain = '', settled = false, idle
    const bump = () => { clearTimeout(idle); idle = setTimeout(() => { res.timedOut = true; killTree(child, killMs) }, idleMs) }
    const onAbort = () => { res.aborted = true; killTree(child, killMs) }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    bump()

    const line = l => {
      if (onRaw) { try { onRaw(l) } catch {} }
      let ev = null
      try { ev = JSON.parse(l) } catch { plain = (plain + '\n' + l).slice(-800); return }
      try { stream.handle(ev) } catch (e) { console.warn(`[cli-agents] could not read a ${spec.label} event:`, e.message) }
    }
    child.stdout.on('data', d => {
      bump()
      buf += d.toString('utf8')
      let i
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) line(l) }
    })
    child.stderr.on('data', d => { bump(); errTail = (errTail + d.toString('utf8')).slice(-1500) })
    child.stdin.on('error', () => {}) // the tool may exit before reading the prompt
    try { child.stdin.end(String(text ?? '')) } catch {}

    const done = (code, spawnErr) => {
      if (settled) return
      settled = true
      live.delete(child)
      clearTimeout(idle)
      if (signal) signal.removeEventListener('abort', onAbort)
      if (buf.trim()) line(buf.trim())
      stream.finish()
      res.exitCode = code
      res.cliSessionId = stream.sessionId || res.cliSessionId
      res.model = stream.model || null
      res.usage = stream.usage
      if (stream.denials?.length) {
        const note = `${spec.label} was not allowed to use ${stream.denials.join(', ')} because Radiant's permission setting is "${permissionMode === 'off' ? 'Allow all' : permissionMode === 'auto' ? 'Auto approve' : 'Ask each'}", and there is nobody to ask while it works. ${permissionMode === 'off' ? '' : 'Switch the permission setting to let it do that.'}`.trim()
        parts.push({ type: 'notice', text: note }); emit({ type: 'notice', text: note })
      }
      if (res.usage.input || res.usage.output) {
        emit({ type: 'usage', input: res.usage.lastPrompt || res.usage.input, output: res.usage.output, ...(res.usage.cacheRead ? { cacheRead: res.usage.cacheRead } : {}), ...(res.usage.cacheWrite ? { cacheWrite: res.usage.cacheWrite } : {}) })
      }
      if (res.aborted) { /* stopped on purpose: no error, the caller marks it stopped */ }
      else if (res.timedOut) res.error = `${spec.label} went quiet for ${idleMs >= 60000 ? `${Math.round(idleMs / 6000) / 10} minutes` : `${Math.round(idleMs / 100) / 10} seconds`}, so Radiant stopped it. What it had finished is kept above. Send another message to carry on.`
      else if (spawnErr) res.error = spawnErr.code === 'ENOENT' ? `${spec.label} is not installed on this Mac. ${spec.install}` : `${spec.label} could not start (${spawnErr.message}).`
      else if (stream.failure()) res.error = friendlyCliError(spec, stream.failure())
      else if (code !== 0) res.error = friendlyCliError(spec, errTail || plain || `It exited with code ${code}.`)
      else if (!parts.length) res.error = `${spec.label} finished without saying anything.${errTail.trim() ? ` It printed: ${errTail.trim().split('\n').slice(-2).join(' ').slice(0, 200)}` : ''}`
      resolve(res)
    }
    child.on('error', e => done(null, e))
    child.on('close', code => done(code))
  })
}
