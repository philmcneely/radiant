import React, { useEffect, useRef, useState } from 'react'
import Terminal from './Terminal.jsx'
import Preview from './Preview.jsx'
import ChangesPanel from './ChangesPanel.jsx'
import GlideSelect from './GlideSelect.jsx'
import { Icon } from './Icons.jsx'

const MIN_W = 300
const MAX_W = 720

// ⚠️ ONE SCROLLBAR PER PANEL, NOT ONE PER ENTRY. Every activity row carried
// `max-height: 200px; overflow-y: auto`, so reading the feed meant scrolling the
// panel to a card and then scrolling again inside it, with each card a separate
// bordered box. Tony: "having the commands in separate rolling boxes is also
// poor design and hard to follow."
//
// Now it is one continuous stream. Long output is clamped with a fade and a
// button that says how much is hidden, rather than trapped in a small window —
// so the panel scrolls once and nothing is buried inside something else.
const CLAMP_LINES = 12

function ActivityItem ({ item }) {
  const [open, setOpen] = useState(false)
  const head = item.name === 'run_command' ? '$ ' + (item.args?.command || '') : JSON.stringify(item.args ?? {})
  const body = item.denied ? '[denied by user]'
    : item.result != null ? String(item.result).slice(0, 8000)
    : '[running…]'
  const text = head + '\n' + body
  const lines = text.split('\n')
  const long = lines.length > CLAMP_LINES
  const shown = open || !long ? text : lines.slice(0, CLAMP_LINES).join('\n')
  const failed = item.denied || (item.result != null && /^Error/i.test(String(item.result)))
  return (
    <div className={'activity-item' + (failed ? ' failed' : '')}>
      <div className='head'>
        <span className='tool-name'>{item.name}</span>
        {failed && <span className='act-fail'>failed</span>}
        <span className='when'>{new Date(item.at).toLocaleTimeString()}</span>
      </div>
      <pre className={long && !open ? 'is-clamped' : ''}>{shown}</pre>
      {long && (
        <button className='act-more' onClick={() => setOpen(o => !o)}>
          {open ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  )
}

// ⚠️ WHO IS WAITING ON YOU, in one place. With three chats running, the only
// sign that one had stopped to ask something was a notification you may
// have dismissed. OpenHarness has one key for "the agents waiting on me";
// Tony asked for it as a tab beside Activity and Terminal. Each row is a
// chat that needs you — an approval, a question, or a turn that finished
// while you were looking at another chat — and clicking it takes you there.
// ⇧⌘I opens the first one.
function ForYou ({ waiting, onOpen }) {
  if (!waiting.length) return <div className='activity-empty'>Nothing is waiting on you. A chat that stops to ask, or finishes while you are elsewhere, will be listed here.</div>
  const label = { approval: 'Approve', question: 'Answer', finished: 'Finished' }
  return (
    <div className='foryou'>
      {waiting.map(w => (
        <button key={w.sessionId + w.kind} className={'foryou-row is-' + w.kind} onClick={() => onOpen(w.sessionId)}>
          <span className='foryou-kind'>{label[w.kind] || w.kind}</span>
          <span className='foryou-title'>{w.title || 'Untitled chat'}</span>
          {w.text && <span className='foryou-text'>{w.text}</span>}
        </button>
      ))}
    </div>
  )
}

const SECTIONS = [
  { id: 'activity', label: 'Activity' },
  { id: 'changes', label: 'Changes' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'preview', label: 'Preview' },
  { id: 'foryou', label: 'For you', hint: '⇧⌘I' }
]

export default function RightPanel ({ tab, onTab, activity, cwd, mode, onClose, session, waiting = [], onOpenSession }) {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem('radiant.rightWidth'))
    return saved >= MIN_W && saved <= MAX_W ? saved : 400
  })
  const dragging = useRef(false)

  useEffect(() => {
    const move = e => {
      if (!dragging.current) return
      const w = Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - e.clientX))
      setWidth(w)
    }
    const up = () => {
      if (dragging.current) {
        dragging.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        localStorage.setItem('radiant.rightWidth', String(width))
      }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [width])

  const startDrag = () => {
    dragging.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  return (
    <aside className='right-panel' style={{ width }}>
      <div className='right-resize' onMouseDown={startDrag} title='Drag to resize' />
      {/* ⚠️ ONE MENU, NOT A ROW OF TABS. Four tabs across a 300px panel read
          as clutter — Tony: "dont like all the tabs. make it a menu." Then:
          "use this for the sidebar menu" — reactbits' Glide Select, so the
          highlight glides between rows and the menu pops from its trigger.
          The For you count rides on the row, and on the trigger while you
          are in another section. */}
      <div className='right-tabs'>
        <GlideSelect
          ariaLabel='Panel section'
          value={SECTIONS.some(x => x.id === tab) ? tab : 'activity'}
          onChange={onTab}
          options={SECTIONS.map(x => ({ value: x.id, label: x.label, tag: x.hint, badge: x.id === 'foryou' ? waiting.length : 0 }))}
        />
        <div style={{ flex: 1 }} />
        <button className='icon-btn' onClick={onClose} title='Close panel'><Icon.close /></button>
      </div>
      <div className='right-body'>
        {tab === 'activity' && (
          <div className='activity-feed'>
            {!activity.length && <div className='activity-empty'>Agent tool calls will appear here as they run.</div>}
            {/* ⚠️ NEWEST FIRST. The feed appends as tools run and never follows the
                bottom, so watching a long turn meant scrolling down again after
                every call. Tony: "shouldnt newest be at the top so i dont have to
                scroll down every time to see latest?"
                Reversed on render rather than stored backwards, because the array
                is updated by id — a completed call is patched in place, and
                reversing the SOURCE would put the write and the read out of step. */}
            {[...activity].reverse().map(item => <ActivityItem key={item.id + item.at} item={item} />)}
          </div>
        )}
        {tab === 'changes' && <ChangesPanel session={session} />}
        {tab === 'terminal' && <Terminal cwd={cwd} mode={mode} />}
        {tab === 'preview' && <Preview session={session} visible />}
        {tab === 'foryou' && <ForYou waiting={waiting} onOpen={onOpenSession} />}
      </div>
    </aside>
  )
}
