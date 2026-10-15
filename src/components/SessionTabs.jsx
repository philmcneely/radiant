import React from 'react'

/**
 * The chats you have open, as tabs across the top of the conversation.
 *
 * After MonoCode's layout (Tony pointed at it, 2026-10). It is deliberately only a
 * switcher: opening a chat from the sidebar adds a tab, a tab keeps its place until
 * you close it, and a dot says "finished while you were looking elsewhere". Every
 * chat keeps running in the background exactly as before — the tab just makes it one
 * click away instead of a hunt through the sidebar. Hidden until a second chat is open.
 */
export default function SessionTabs ({ tabs, activeId, titleOf, finished, onPick, onClose }) {
  if (tabs.length < 2) return null
  return (
    <div className='stabs' role='tablist' aria-label='Open chats'>
      {tabs.map(id => (
        <div key={id} role='tab' aria-selected={id === activeId} className={'stab' + (id === activeId ? ' is-active' : '')}>
          <button className='stab-main' onClick={() => onPick(id)} title={titleOf(id)}>
            {finished[id] && <span className='stab-dot' aria-label='Finished while you were away' />}
            <span className='stab-title'>{titleOf(id)}</span>
          </button>
          <button className='stab-x' onClick={() => onClose(id)} aria-label={`Close ${titleOf(id)}`}>×</button>
        </div>
      ))}
    </div>
  )
}
