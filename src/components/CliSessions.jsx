import React, { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { cliApi, api } from '../api.js'
import { ageShort } from '../timeago.js'

const NAME = { 'claude-code': 'Claude Code', codex: 'Codex' }
const home = p => (p || '').replace(/^\/Users\/[^/]+/, '~')

/**
 * Chats you started in Claude Code or Codex, ready to continue in Radiant.
 *
 * Nothing is read until the person has turned the feature on in Settings, and the
 * server refuses anyone but this Mac unless they allowed more. Picking a row copies
 * that conversation into a Radiant chat (once — picking it again opens the same
 * chat); sending a message there goes back through the tool's own sign-in.
 */
export default function CliSessions ({ onClose, onOpen }) {
  const [info, setInfo] = useState(null)
  const [rows, setRows] = useState(null)
  const [tool, setTool] = useState('')
  const [q, setQ] = useState('')
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(null)

  useEffect(() => { cliApi.agents().then(setInfo).catch(e => setErr(e.message)) }, [])
  const usable = info?.usable
  useEffect(() => {
    if (!usable) return undefined
    setRows(null)
    const t = setTimeout(() => cliApi.sessions({ tool, q }).then(r => setRows(r.sessions || [])).catch(e => { setErr(e.message); setRows([]) }), q ? 250 : 0)
    return () => clearTimeout(t)
  }, [usable, tool, q])
  useEffect(() => {
    const esc = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])

  const groups = useMemo(() => {
    const by = new Map()
    for (const r of rows || []) { const k = home(r.cwd) || 'No folder'; if (!by.has(k)) by.set(k, []); by.get(k).push(r) }
    return [...by.entries()]
  }, [rows])

  const turnOn = async () => {
    try { await api.saveSettings({ cliAgents: { enabled: true, allowRemote: false } }); setInfo(await cliApi.agents(true)) } catch (e) { setErr(e.message) }
  }
  const pick = async r => {
    setBusy(r.id); setErr(null)
    try { const s = r.radiantId ? { id: r.radiantId } : await cliApi.importSession(r.tool, r.id); onOpen(s.id) } catch (e) { setErr(e.message) } finally { setBusy(null) }
  }

  // a portal: the sidebar is its own stacking context, and the dialog must sit over the whole window
  return createPortal(
    <div className='clis-back' onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className='clis' role='dialog' aria-label='Claude Code and Codex sessions'>
        <div className='clis-head'>
          <div className='clis-title'>Claude Code &amp; Codex sessions</div>
          <button className='clis-x' onClick={onClose} aria-label='Close'>×</button>
        </div>
        {!info && !err && <div className='clis-note'>Looking…</div>}
        {info && !info.enabled && (
          <div className='clis-note'>
            <p>Radiant can list the chats you started in the Claude Code and Codex apps on this Mac and let you carry on with them here, using the sign-in those apps already have. No API key.</p>
            <p>That means reading their saved history — everything you asked them and the files they opened. It stays on this Mac, and other devices cannot see it unless you allow that in Settings.</p>
            <button className='small-btn' onClick={turnOn}>Turn it on</button>
          </div>
        )}
        {info && info.enabled && !info.usable && <div className='clis-note'>{info.remote ? 'This Mac keeps its Claude Code and Codex sessions to itself. Allow other devices in Settings → Agent on the Mac to use them from here.' : 'Not available right now.'}</div>}
        {usable && (
          <>
            <div className='clis-bar'>
              <input className='session-search' placeholder='Search by title or folder…' value={q} onChange={e => setQ(e.target.value)} autoFocus />
              <div className='seg-control'>
                {[['', 'All'], ['claude-code', 'Claude Code'], ['codex', 'Codex']].map(([id, label]) => <button key={id} className={'seg-btn' + (tool === id ? ' on' : '')} onClick={() => setTool(id)}>{label}</button>)}
              </div>
            </div>
            {err && <div className='clis-err'>{err}</div>}
            <div className='clis-list'>
              {rows === null && <div className='clis-note'>Reading saved sessions…</div>}
              {rows && !rows.length && <div className='clis-note'>No saved sessions found{q ? ' for that search' : ''}.</div>}
              {groups.map(([cwd, list]) => (
                <div key={cwd} className='clis-group'>
                  <div className='clis-cwd'>{cwd}</div>
                  {list.map(r => (
                    <button key={r.tool + r.id} className='clis-row' onClick={() => pick(r)} disabled={busy === r.id}>
                      <span className='clis-row-title'>{r.title || 'Untitled'}</span>
                      <span className='clis-row-meta'>
                        <span className={'clis-tool t-' + r.tool}>{NAME[r.tool] || r.tool}</span>
                        {r.updatedAt ? ageShort(r.updatedAt) : ''}{r.messageCount ? ` · ${r.messageCount} msg` : ''}{r.gitBranch ? ` · ⎇ ${r.gitBranch}` : ''}
                        {r.imported ? ' · in Radiant' : ''}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
        {!usable && err && <div className='clis-err'>{err}</div>}
      </div>
    </div>,
    document.body
  )
}
