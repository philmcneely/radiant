import React, { useCallback, useEffect, useRef, useState } from 'react'
import { changesApi } from '../api.js'
import { Icon } from './Icons.jsx'

/**
 * What changed in this chat's folder, and the way to keep or undo it.
 *
 * MonoCode's right-hand "Changes" panel (Tony pointed at it, 2026-10): the files the
 * agent touched with M/A/D/U letters and +/- counts, a diff a click away, a commit box.
 * The server half is docs/changes-panel.md; this is only the surface.
 *
 * ⚠️ NOTHING HERE DOES ANYTHING IRREVERSIBLE WITHOUT SAYING SO. Commit lists exactly
 * which files it will include; Undo is asked about first, names how many files it will
 * discard, and then offers "Restore" for an hour (the server keeps a safety copy).
 * Nothing is ever pushed.
 */

const LETTER = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'New file', '?': 'Needs merging' }

/** Poll while visible: cheap on the server (cached 1.5 s, revision-gated), and a focus returns refresh at once. */
function useChanges (sessionId, { every = 3000 } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true })
  const rev = useRef(null)
  const alive = useRef(true)
  const refresh = useCallback(async (force = false) => {
    if (!sessionId) return
    try {
      const d = await changesApi.changes(sessionId, force ? undefined : rev.current)
      if (!alive.current) return
      if (d && d.unchanged) { setState(s => (s.loading || s.error ? { ...s, loading: false, error: null } : s)); return }
      rev.current = d?.revision || null
      setState({ data: d, error: null, loading: false })
    } catch (e) {
      if (alive.current) setState(s => ({ ...s, error: e.message || String(e), loading: false }))
    }
  }, [sessionId])
  useEffect(() => {
    alive.current = true
    rev.current = null
    setState({ data: null, error: null, loading: true })
    refresh(true)
    const t = setInterval(() => { if (!document.hidden) refresh() }, every)
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => { alive.current = false; clearInterval(t); window.removeEventListener('focus', onFocus) }
  }, [sessionId, every, refresh])
  return { ...state, refresh: () => refresh(true) }
}

function DiffView ({ diff, truncated, binary }) {
  const [all, setAll] = useState(false)
  if (binary) return <div className='chg-note'>Binary file — no text diff.</div>
  if (!diff) return <div className='chg-note'>No textual changes.</div>
  const lines = diff.split('\n')
  const CAP = 400
  const shown = all ? lines : lines.slice(0, CAP)
  return (
    <div className='chg-diff mono'>
      {shown.map((l, i) => {
        const k = l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : /^(diff |index |new file mode|deleted file mode|similarity |rename |old mode|new mode)/.test(l) || l.startsWith('---') || l.startsWith('+++') ? 'meta' : ''
        return k === 'meta' ? null : <div key={i} className={'chg-line ' + k}>{l || ' '}</div>
      })}
      {!all && lines.length > CAP && <button className='chg-more' onClick={() => setAll(true)}>Show all {lines.length} lines</button>}
      {truncated && <div className='chg-note'>The rest of this diff is too large to show.</div>}
    </div>
  )
}

function FileRow ({ f, sessionId, checked, onCheck, onUndo, open, onToggle }) {
  const [diff, setDiff] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    if (!open || diff) return
    changesApi.diff(sessionId, f.path).then(setDiff).catch(e => setErr(e.message))
  }, [open, diff, sessionId, f.path])
  // a diff goes stale when the file changes again; drop it whenever the counts move
  useEffect(() => { setDiff(null); setErr(null) }, [f.additions, f.deletions, f.status])
  const slash = f.path.lastIndexOf('/')
  const dir = slash >= 0 ? f.path.slice(0, slash) : ''
  const name = slash >= 0 ? f.path.slice(slash + 1) : f.path
  return (
    <div className={'chg-file' + (open ? ' is-open' : '')}>
      <div className='chg-row'>
        <input type='checkbox' className='chg-check' checked={checked} onChange={e => onCheck(e.target.checked)} aria-label={`Include ${f.path} in the commit`} />
        <button className='chg-name' onClick={onToggle} aria-expanded={open} title={f.path}>
          <span className='chg-file-name'>{name}</span>
          {dir && <span className='chg-file-dir'>{dir}</span>}
        </button>
        <span className='chg-counts'>
          {f.binary ? <span className='chg-bin'>binary</span> : <>
            {f.additions > 0 && <span className='chg-add'>+{f.additions}</span>}
            {f.deletions > 0 && <span className='chg-del'>−{f.deletions}</span>}
          </>}
        </span>
        <span className={'chg-letter l-' + (f.status === '?' ? 'conf' : f.status)} title={LETTER[f.status] || f.status}>{f.status}</span>
        <button className='chg-undo' onClick={onUndo} title={`Discard changes to ${name}`} aria-label={`Discard changes to ${name}`}><Icon.trash size={13} /></button>
      </div>
      {open && (
        <div className='chg-body'>
          {err ? <div className='chg-note is-err'>{err}</div> : !diff ? <div className='chg-note'>Loading…</div> : <DiffView diff={diff.diff} truncated={diff.truncated} binary={diff.binary} />}
        </div>
      )}
    </div>
  )
}

export default function ChangesPanel ({ session }) {
  const sessionId = session?.id
  const { data, error, loading, refresh } = useChanges(sessionId)
  const [picked, setPicked] = useState(() => new Set())
  const [seen, setSeen] = useState(() => new Set())   // paths we have already auto-ticked
  const [open, setOpen] = useState(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null)               // { kind: 'ok' | 'err', text, snapshotId? }
  const [confirm, setConfirm] = useState(null)         // { paths, label }

  // new files appear ticked; one the person unticked stays unticked
  useEffect(() => {
    if (!data?.files) return
    const fresh = data.files.filter(f => !seen.has(f.path))
    if (!fresh.length) return
    setSeen(s => new Set([...s, ...fresh.map(f => f.path)]))
    setPicked(p => new Set([...p, ...fresh.map(f => f.path)]))
  }, [data, seen])
  useEffect(() => { setNote(null); setOpen(null); setConfirm(null); setSeen(new Set()); setPicked(new Set()) }, [sessionId])

  if (!sessionId) return <div className='chg-empty'>Open a chat to see what changed in its folder.</div>
  if (loading && !data) return <div className='chg-empty'>Looking at the folder…</div>
  if (error && !data) return <div className='chg-empty is-err'>{error}</div>
  if (data && !data.isRepo) return <div className='chg-empty'>{data.reason || 'This chat’s folder is not a git repository, so there is nothing to track.'}</div>
  if (!data) return null

  const files = data.files || []
  const pickedFiles = files.filter(f => picked.has(f.path))
  const allPicked = files.length > 0 && pickedFiles.length === files.length

  const commit = async () => {
    if (busy || !message.trim() || !pickedFiles.length) return
    setBusy(true); setNote(null)
    try {
      const body = allPicked ? { message: message.trim(), all: true } : { message: message.trim(), paths: pickedFiles.map(f => f.path) }
      const r = await changesApi.commit(sessionId, body)
      setMessage('')
      setNote({ kind: 'ok', text: `Committed ${r.sha ? r.sha.slice(0, 7) : ''} — ${r.subject || r.summary || 'done'}` })
      refresh()
    } catch (e) {
      setNote({ kind: 'err', text: e.message + (e.body?.output ? `\n${String(e.body.output).slice(-600)}` : '') })
    } finally { setBusy(false) }
  }

  const undo = async paths => {
    setBusy(true); setNote(null); setConfirm(null)
    try {
      const r = await changesApi.undo(sessionId, paths)
      const n = (r.restored?.length || 0) + (r.removed?.length || 0)
      setNote({ kind: 'ok', text: `Discarded ${n} file${n === 1 ? '' : 's'}.${r.skipped?.length ? ` Skipped ${r.skipped.length}: ${r.skipped.map(s => s.reason).join('; ')}` : ''}`, snapshotId: r.snapshotId })
      refresh()
    } catch (e) { setNote({ kind: 'err', text: e.message }) } finally { setBusy(false) }
  }

  const restore = async id => {
    setBusy(true)
    try { await changesApi.undoRestore(sessionId, id); setNote({ kind: 'ok', text: 'Brought the files back.' }); refresh() } catch (e) { setNote({ kind: 'err', text: e.message }) } finally { setBusy(false) }
  }

  return (
    <div className='chg'>
      <div className='chg-head'>
        <div className='chg-title'>
          <span>Changes</span>
          {data.totals.additions > 0 && <span className='chg-add'>+{data.totals.additions}</span>}
          {data.totals.deletions > 0 && <span className='chg-del'>−{data.totals.deletions}</span>}
        </div>
        {data.branch && <span className='chg-branch' title={data.upstream ? `Tracking ${data.upstream}` : 'No upstream'}><Icon.branch size={12} /> {data.branch}{data.ahead ? ` ↑${data.ahead}` : ''}{data.behind ? ` ↓${data.behind}` : ''}</span>}
        {data.detached && <span className='chg-branch'>detached</span>}
      </div>

      <div className='chg-commit'>
        <textarea
          className='chg-msg' rows={2} placeholder='Message (⌘↵ to commit)' value={message}
          onChange={e => setMessage(e.target.value)}
          onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); commit() } }}
        />
        <button className='chg-commit-btn' onClick={commit} disabled={busy || !message.trim() || !pickedFiles.length}>
          <Icon.check size={14} /> Commit{pickedFiles.length && pickedFiles.length !== files.length ? ` ${pickedFiles.length} of ${files.length}` : files.length ? ` ${files.length}` : ''}
        </button>
      </div>

      {note && (
        <div className={'chg-flash is-' + note.kind} role='status'>
          <span className='chg-flash-text'>{note.text}</span>
          {note.snapshotId && <button className='chg-flash-btn' onClick={() => restore(note.snapshotId)} disabled={busy}>Restore</button>}
          <button className='chg-flash-x' onClick={() => setNote(null)} aria-label='Dismiss'>×</button>
        </div>
      )}

      {confirm && (
        <div className='chg-confirm' role='alertdialog'>
          <div>Discard your changes to <b>{confirm.label}</b>? They can be brought back for an hour.</div>
          <div className='chg-confirm-row'>
            <button className='small-btn danger' onClick={() => undo(confirm.paths)} disabled={busy}>Discard</button>
            <button className='small-btn' onClick={() => setConfirm(null)}>Keep them</button>
          </div>
        </div>
      )}

      {files.length === 0 ? (
        <div className='chg-empty'>{data.noCommits ? 'No commits yet, and nothing to add.' : 'Nothing has changed since the last commit.'}</div>
      ) : (
        <>
          <div className='chg-listhead'>
            <label className='chg-all'>
              <input type='checkbox' checked={allPicked} onChange={e => setPicked(e.target.checked ? new Set(files.map(f => f.path)) : new Set())} />
              <span>{files.length} file{files.length === 1 ? '' : 's'}</span>
            </label>
            <button className='chg-undo-all' onClick={() => setConfirm({ paths: files.map(f => f.path), label: files.length === 1 ? files[0].path : `all ${files.length} files` })} disabled={busy}>Undo all</button>
          </div>
          <div className='chg-list'>
            {files.map(f => (
              <FileRow
                key={f.path} f={f} sessionId={sessionId}
                checked={picked.has(f.path)}
                onCheck={on => setPicked(p => { const n = new Set(p); if (on) n.add(f.path); else n.delete(f.path); return n })}
                onUndo={() => setConfirm({ paths: [f.path], label: f.path })}
                open={open === f.path} onToggle={() => setOpen(o => (o === f.path ? null : f.path))}
              />
            ))}
          </div>
          {data.truncated && <div className='chg-note'>Showing the first {files.length} files.</div>}
        </>
      )}
    </div>
  )
}
