// The per-app gate for desktop control (server/computer-apps.js). No Mac, no real
// settings file: detection, the question and the "always" store are all stand-ins.
import { appGate, classifyApp, isAppGated, ALLOW_CHAT, ALLOW_ALWAYS, DENY } from '../server/computer-apps.js'

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${cond ? '' : ' — ' + extra}`) }

const notes = new Map(), TextEdit = { id: 'com.apple.TextEdit', name: 'TextEdit' }
const mk = (app, answers = []) => {
  const asked = []
  const mem = []
  return {
    asked, mem,
    deps: {
      session: { appGrants: [] },
      detect: async () => app,
      platform: 'darwin',
      emit: () => {},
      store: { always: () => mem, setAlways: l => { mem.length = 0; mem.push(...l) } },
      requestUserChoice: answers === null ? undefined : async (q, o) => { asked.push({ q, o }); return answers.shift() }
    }
  }
}
const click = { name: 'screen_click', args: { x: 10, y: 10 } }

ok('Terminal, iTerm and Radiant are "never"', ['com.apple.Terminal', 'com.googlecode.iterm2', 'com.tonyricciardi.radiant'].every(id => classifyApp({ id, name: 'x' }) === 'never'))
ok('a window named Radiant is "never" even from an odd bundle id', classifyApp({ id: 'x.y', name: 'Radiant' }) === 'never')
ok('password managers and System Settings are "risky"', ['com.1password.1password', 'com.apple.systempreferences', 'com.bitwarden.desktop'].every(id => classifyApp({ id }) === 'risky'))
ok('browsers are "browser", anything else "normal"', classifyApp({ id: 'com.google.Chrome' }) === 'browser' && classifyApp(TextEdit) === 'normal')
ok('only acting desktop tools are gated', isAppGated('screen_click') && isAppGated('screen_type') && !isAppGated('screen_screenshot') && !isAppGated('screen_move') && !isAppGated('browser_read'))

{ // never: refused even with a grant and with nobody to ask
  const t = mk({ id: 'com.apple.Terminal', name: 'Terminal' }, [ALLOW_ALWAYS]); t.deps.session.appGrants.push('com.apple.Terminal'); t.mem.push({ id: 'com.apple.Terminal' })
  const r = await appGate(click, t.deps)
  ok('Terminal is refused even when granted and always-listed', !r.ok && !t.asked.length && /never/i.test(r.result))
}
{ const t = mk({ id: 'com.tonyricciardi.radiant', name: 'Radiant' }, [ALLOW_CHAT]); const r = await appGate(click, t.deps)
  ok('Radiant itself is refused without asking', !r.ok && !t.asked.length) }
{ const t = mk(TextEdit, [ALLOW_CHAT]); const r = await appGate(click, t.deps); const r2 = await appGate(click, t.deps)
  ok('"this chat" allows, remembers for the chat, and asks once', r.ok && r2.ok && t.asked.length === 1 && t.deps.session.appGrants.includes('com.apple.TextEdit') && !t.mem.length) }
{ const t = mk(TextEdit, [ALLOW_ALWAYS]); const r = await appGate(click, t.deps)
  const t2 = mk(TextEdit, []); t2.mem.push(...t.mem); const r2 = await appGate(click, t2.deps)
  ok('"always" is stored, and a later chat is not asked', r.ok && t.mem.length === 1 && t.mem[0].id === 'com.apple.TextEdit' && r2.ok && !t2.asked.length) }
{ const t = mk(TextEdit, [DENY]); const r = await appGate(click, t.deps)
  ok('Deny refuses and tells the model not to retry', !r.ok && /did not allow/.test(r.result) && !t.deps.session.appGrants.length && !t.mem.length) }
{ const t = mk(TextEdit, ['(no answer — the user did not respond in time)']); const r = await appGate(click, t.deps)
  ok('an unanswered question is a refusal', !r.ok) }
{ const t = mk(TextEdit, null); const r = await appGate(click, t.deps)
  ok('unattended and not pre-approved: refused', !r.ok && /unattended/.test(r.result)) }
{ const t = mk(TextEdit, null); t.mem.push({ id: 'com.apple.TextEdit' }); const r = await appGate(click, t.deps)
  ok('unattended but always-allowed: goes ahead', r.ok) }
{ const t = mk({ id: 'com.1password.1password', name: '1Password' }, [ALLOW_ALWAYS]); const r = await appGate(click, t.deps)
  ok('risky apps are not offered "Always", and "Always" cannot be forced', t.asked[0]?.o.join() === `${ALLOW_CHAT},${DENY}` && !r.ok && !t.mem.length) }
{ const t = mk({ id: 'com.1password.1password', name: '1Password' }, null); t.mem.push({ id: 'com.1password.1password' }); const r = await appGate(click, t.deps)
  ok('risky apps ignore the always list', !r.ok) }
{ const t = mk({ id: 'com.google.Chrome', name: 'Chrome' }, [DENY]); await appGate(click, t.deps)
  ok('browsers carry a warning in the question', /signed in/.test(t.asked[0]?.q || '')) }
{ const t = mk(null, [ALLOW_CHAT]); const r = await appGate(click, t.deps)
  ok('if the app cannot be identified, nothing happens', !r.ok && !t.asked.length) }
{ const t = mk(TextEdit, [ALLOW_CHAT]); t.deps.platform = 'linux'; const r = await appGate(click, t.deps)
  ok('off macOS the gate steps aside', r.ok && !t.asked.length) }
{ const t = mk(TextEdit, []); const r = await appGate({ name: 'screen_screenshot', args: {} }, t.deps)
  ok('screenshots are not gated', r.ok && !t.asked.length) }
{ let seen = null; const t = mk(TextEdit, [DENY]); t.deps.detect = async p => { seen = p; return TextEdit }
  await appGate({ name: 'screen_drag', args: { x1: 5, y1: 6, x2: 90, y2: 90 } }, t.deps)
  ok('a drag is judged by where it starts; typing by the focused app', seen?.x === 5 && seen?.y === 6)
  let seen2 = 'unset'; t.deps.detect = async p => { seen2 = p; return TextEdit }; t.deps.session.appGrants = ['com.apple.TextEdit']
  await appGate({ name: 'screen_type', args: { text: 'hi' } }, t.deps)
  ok('typing asks for the focused app, not a point', seen2 === null) }

console.log(`\ncomputer apps: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
