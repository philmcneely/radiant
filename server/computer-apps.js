// Which APP a desktop click or keystroke would land in, and whether the person has
// said that app is allowed.
//
// After LCU's per-app approval (github.com/amontlabs/lcu, Tony 2026-10). Before this,
// "computer control" asked before each mutating action but never knew WHERE the click
// went: a coordinate over Terminal, 1Password or Radiant's own approval card was
// approved exactly like one over Notes.
//
// ⚠️ THREE KINDS OF APP, AND THE FIRST CANNOT BE UNLOCKED BY ANYONE.
//   never  — Terminal-like apps (a click there is a shell) and Radiant itself (the
//            approval card lives in this window, so an agent that can click it can
//            answer its own question). Refused in every permission mode, "Allow all"
//            included.
//   risky  — password managers and System Settings: asked every chat, no "Always".
//   normal — asked once: this chat, always, or no. Browsers carry a warning.
// The question is a Radiant card the model cannot see or answer; only the person can.
//
// macOS only. Elsewhere there is no cheap, permission-free way to ask which window
// is under a point, so the gate steps aside rather than guess (docs/computer-apps.md).

import { execFile } from 'node:child_process'
import { loadMachineSettings, saveMachineSettings } from './config.js'

const APP_ID = 'com.tonyricciardi.radiant'

const NEVER = new Set([
  'com.apple.Terminal', 'com.googlecode.iterm2', 'com.mitchellh.ghostty', 'dev.warp.Warp-Stable', 'dev.warp.Warp',
  'net.kovidgoyal.kitty', 'org.alacritty', 'com.github.wez.wezterm', 'co.zeit.hyper', 'com.apple.ScriptEditor2',
  'com.github.Electron' // Radiant's dev build
])
const RISKY = [/^com\.1password\./, /^com\.agilebits\./, /^com\.bitwarden\./, /^com\.dashlane\./, /^com\.lastpass\./, /^com\.apple\.keychainaccess$/, /^com\.apple\.Passwords$/, /^com\.apple\.systempreferences$/]
const BROWSER = [/^com\.google\.Chrome/, /^com\.apple\.Safari/, /^org\.mozilla\./, /^company\.thebrowser\./, /^com\.microsoft\.edgemac/, /^com\.brave\.Browser/]

/** 'never' | 'risky' | 'browser' | 'normal' */
export function classifyApp (app) {
  const id = String(app?.id || '')
  if (id === APP_ID || id.startsWith(APP_ID + '.') || NEVER.has(id) || app?.name === 'Radiant') return 'never'
  if (RISKY.some(r => r.test(id))) return 'risky'
  if (BROWSER.some(r => r.test(id))) return 'browser'
  return 'normal'
}

// One JXA call: the app that owns the window under (x, y), or the frontmost app when
// there is no point. Needs no permission prompt (owner names are not screen contents).
const JXA = `ObjC.import('CoreGraphics'); ObjC.import('AppKit')
function run (argv) {
  const has = argv.length >= 2, x = Number(argv[0]), y = Number(argv[1])
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication
  let pid = front ? Number(front.processIdentifier) : null
  if (has) {
    const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0)))
    for (const w of list) {
      if (w.kCGWindowLayer !== 0) continue
      const b = w.kCGWindowBounds
      if (x >= b.X && x < b.X + b.Width && y >= b.Y && y < b.Y + b.Height) { pid = w.kCGWindowOwnerPID; break }
    }
  }
  if (pid === null) return JSON.stringify(null)
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid)
  return JSON.stringify(app ? { id: ObjC.unwrap(app.bundleIdentifier), name: ObjC.unwrap(app.localizedName) } : null)
}`

export function detectApp (point) {
  return new Promise(resolve => {
    const args = ['-l', 'JavaScript', '-e', JXA]
    if (point) args.push('--', String(Math.round(point.x)), String(Math.round(point.y)))
    execFile('osascript', args, { timeout: 4000 }, (err, out) => {
      if (err) return resolve(null)
      try { const a = JSON.parse(String(out).trim()); resolve(a && a.id ? a : null) } catch { resolve(null) }
    })
  })
}

// The desktop tools that act, and where each lands.
const POINTED = { screen_click: a => ({ x: a.x, y: a.y }), screen_doubleclick: a => ({ x: a.x, y: a.y }), screen_drag: a => ({ x: a.x1, y: a.y1 }) }
const FOCUSED = new Set(['screen_type', 'screen_key', 'screen_scroll'])
export const isAppGated = name => name in POINTED || FOCUSED.has(name)

const machineStore = {
  always: () => (loadMachineSettings().computerApps?.always || []).filter(a => a && a.id),
  setAlways: list => saveMachineSettings({ computerApps: { always: list } })
}

export const ALLOW_CHAT = 'Allow for this chat'
export const ALLOW_ALWAYS = 'Always allow'
export const DENY = 'Deny'

/**
 * Decide whether this desktop action may go ahead.
 * Returns { ok: true } or { ok: false, result } where result is what the model is told.
 * deps are injectable so the tests need neither a Mac nor a real settings file.
 */
export async function appGate (call, { session, requestUserChoice, emit, detect = detectApp, store = machineStore, platform = process.platform } = {}) {
  if (platform !== 'darwin' || !isAppGated(call.name)) return { ok: true }
  const where = POINTED[call.name]?.(call.args || {})
  const app = await detect(where && Number.isFinite(where.x) && Number.isFinite(where.y) ? where : null)
  if (!app) return { ok: false, result: 'Radiant could not tell which app that would land in, so it did not act. Take a screenshot and try again; if this keeps happening, ask the user.' }

  const kind = classifyApp(app)
  if (kind === 'never') {
    return { ok: false, result: `Radiant never lets the agent control ${app.name} (${kind === 'never' && app.name === 'Radiant' ? 'it is the app you are running in, and its approval card would be answerable by you' : 'a terminal runs any command'}). Use run_command instead of clicking, or ask the user to do it themselves.` }
  }
  const granted = new Set([...(session?.appGrants || []), ...store.always().map(a => a.id)])
  if (granted.has(app.id) && kind !== 'risky') return { ok: true }
  if (kind === 'risky' && (session?.appGrants || []).includes(app.id)) return { ok: true }

  if (!requestUserChoice) {
    return { ok: false, result: `${app.name} has not been approved, and nobody is here to ask (this run is unattended). Approve it in Settings → Agent → Apps the agent may control, or run this from a chat.` }
  }
  const warn = kind === 'risky' ? `\n\n${app.name} can hold passwords or change this Mac's settings. Allow it only if you are watching.`
    : kind === 'browser' ? `\n\n${app.name} is where you are signed in to things. The agent will be able to click anything you can.` : ''
  const options = kind === 'risky' ? [ALLOW_CHAT, DENY] : [ALLOW_CHAT, ALLOW_ALWAYS, DENY]
  const answer = await requestUserChoice(`Let the agent control ${app.name}?${warn}`, options)
  if (answer === ALLOW_CHAT) {
    if (session) session.appGrants = [...new Set([...(session.appGrants || []), app.id])]
  } else if (answer === ALLOW_ALWAYS && kind !== 'risky') {
    store.setAlways([...store.always().filter(a => a.id !== app.id), { id: app.id, name: app.name, at: new Date().toISOString() }])
    emit?.({ type: 'notice', text: `${app.name} is now always allowed. Settings → Agent lists it, with a Revoke button.` })
  } else {
    return { ok: false, result: `The user did not allow controlling ${app.name}. Do not try that app again this turn; tell them what you needed it for and let them decide.` }
  }
  return { ok: true }
}

export const approvedApps = () => machineStore.always()
export function revokeApp (id) {
  const keep = machineStore.always().filter(a => a.id !== id)
  machineStore.setAlways(keep)
  return keep
}
