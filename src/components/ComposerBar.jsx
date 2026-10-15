import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './Icons.jsx'

/**
 * The strip under the message box.
 *
 * ⚠️ IT USED TO BE EIGHT TOGGLES, EACH A BARE ICON THAT GREW INTO ITS WORD ON
 * HOVER. That kept the row small and made its state invisible: whether plan mode,
 * computer control or "allow all" was on could only be told by the colour of a
 * glyph. MonoCode's composer (Tony pointed at it, 2026-10) does the opposite and
 * is easier to read for it: a "+" for the things you do now and then, and a few
 * LABELED chips for the things that decide what the next message will do — which
 * model, how hard it thinks, whether it asks before acting.
 *
 * So: the occasional actions (attach, design, dictate, talk) and the switches
 * that are usually left alone (tools, computer, plan, show-thinking) live in the
 * "+" menu; the model, the thinking level and the approval mode are always on
 * screen with their words; and anything unusual — plan mode on, computer control
 * on, tools off — shows up as its own chip, so a chat that is in a special state
 * says so without being opened. Nothing was removed.
 */

export const EFFORT_STOPS = [
  ['auto', 'Auto', "The provider's own default"],
  ['low', 'Low', 'Answer quickly, think briefly'],
  ['medium', 'Medium', 'A balance of speed and care'],
  ['high', 'High', 'Think hard before answering']
]

export function ThinkRail ({ value, onPick }) {
  const at = Math.max(0, EFFORT_STOPS.findIndex(([id]) => id === (value || 'auto')))
  const rail = useRef(null)
  const [box, setBox] = useState(null)

  // ⚠️ THE PILL HAS TO MEASURE THE STOP, NOT ASSUME A QUARTER OF THE RAIL. The
  // labels are different lengths — "Auto" against "Medium" — so four equal
  // quarters never line up with them: the pill sat off-centre on Low and clipped
  // Medium. Tony: "you didnt fix the spacing of low medium and high text in the
  // thinking window." Measured, it fits whatever the words happen to be, in any
  // language.
  useLayoutEffect(() => {
    const el = rail.current?.children?.[at + 1]   // +1: the pill itself is first
    if (el) setBox({ left: el.offsetLeft, width: el.offsetWidth })
  }, [at, value])

  return (
    <div className='think-rail' ref={rail} role='group' aria-label='Thinking level'>
      <span
        className='think-pill'
        aria-hidden
        style={box ? { transform: `translateX(${box.left}px)`, width: box.width } : { opacity: 0 }}
      />
      {EFFORT_STOPS.map(([id, label, hint], n) => (
        <button
          key={id}
          className={'think-stop' + (n === at ? ' is-on' : '')}
          aria-pressed={n === at}
          data-tip={hint}
          data-tip-below
          title={hint}
          onClick={() => onPick(id)}
        >{label}</button>
      ))}
    </div>
  )
}

/** A popover that closes on an outside click or Escape — a panel a keyboard cannot dismiss is a trap. */
function usePopover () {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const close = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const esc = e => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])
  return { open, setOpen, ref }
}

function MenuItem ({ icon, label, hint, checked, danger, disabled, onClick }) {
  return (
    <button
      type='button'
      role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={checked}
      className={'cbar-item' + (checked ? ' is-on' : '') + (danger ? ' is-warn' : '')}
      disabled={disabled}
      onClick={onClick}
    >
      <span className='cbar-item-icon'>{icon}</span>
      <span className='cbar-item-text'>
        <span className='cbar-item-label'>{label}</span>
        {hint && <span className='cbar-item-hint'>{hint}</span>}
      </span>
      {checked !== undefined && <span className='cbar-item-check' aria-hidden>{checked ? <Icon.check size={13} /> : null}</span>}
    </button>
  )
}

export default function ComposerBar ({
  session, modelPicker, skillMenu, skillChips,
  effort, onSetEffort,
  toolsOn, onToggleTools, onToggleComputer, onTogglePlan, showThinking, onToggleThinking,
  approvalMode, onCycleApproval,
  onAttach, onDesign, designBusy,
  canDictate, dictating, onToggleDictation,
  voice, onToggleVoice,
  onAnotherMac, serverHost, machineNoun = 'Mac'
}) {
  const plus = usePopover()
  const think = usePopover()
  const pick = fn => () => { plus.setOpen(false); fn?.() }
  const effortLabel = (EFFORT_STOPS.find(([id]) => id === (effort || 'auto')) || EFFORT_STOPS[0])[1]
  const approvalLabel = approvalMode === 'off' ? 'Allow all' : approvalMode === 'auto' ? 'Auto approve' : 'Ask each'
  const voiceOn = voice && voice.state !== 'off'
  const voiceWord = !voice ? '' : voice.state === 'connecting' ? 'Connecting…' : voice.state === 'listening' ? 'Listening' : voice.state === 'working' ? 'Working…' : voice.state === 'closing' ? 'Ending…' : 'End'

  return (
    <div className='cbar'>
      <div ref={plus.ref} className='cbar-anchor'>
        <button
          type='button'
          className={'cbar-plus' + (plus.open ? ' is-open' : '')}
          aria-haspopup='menu' aria-expanded={plus.open} aria-label='Add, and more options'
          data-tip={plus.open ? undefined : 'Attach, design, dictate, and the switches for tools, computer control and plan mode'}
          onClick={() => plus.setOpen(o => !o)}
        ><Icon.plus size={16} /></button>
        {plus.open && (
          <div className='cbar-menu' role='menu'>
            <MenuItem icon={<Icon.plus size={15} />} label='Attach files or images' onClick={pick(onAttach)} />
            <MenuItem icon={<Icon.target size={15} />} label='Design Mode' hint='Click an element on a web page to capture its HTML, CSS and a screenshot' disabled={designBusy} onClick={pick(onDesign)} />
            {canDictate && <MenuItem icon={<Icon.mic size={15} />} label={dictating ? 'Stop dictating' : 'Dictate'} hint={`Transcribed on this ${machineNoun}`} onClick={pick(onToggleDictation)} />}
            {voice && !onAnotherMac && !voiceOn && <MenuItem icon={<Icon.waves size={15} />} label='Talk to Radiant' hint='A live voice conversation over this chat' onClick={pick(onToggleVoice)} />}
            <div className='cbar-sep' role='separator' />
            <MenuItem icon={<Icon.wrench size={15} />} label='Agent tools' hint='Read and write files and run commands in the folder' checked={Boolean(toolsOn)} onClick={pick(onToggleTools)} />
            <MenuItem icon={<Icon.monitor size={15} />} label='Computer control' hint={`The model drives the browser and desktop of ${onAnotherMac ? serverHost : `this ${machineNoun}`}`} checked={Boolean(session.computerControl)} onClick={pick(onToggleComputer)} />
            <MenuItem icon={<Icon.clipboard size={15} />} label='Plan mode' hint='Propose a plan for your approval before changing anything' checked={Boolean(session.planMode)} onClick={pick(onTogglePlan)} />
            <MenuItem icon={<Icon.bulb size={15} />} label='Show the model’s thinking' hint='Only hides the reasoning; it still thinks and you are still billed for it' checked={Boolean(showThinking)} onClick={pick(onToggleThinking)} />
          </div>
        )}
      </div>

      {skillMenu}
      {modelPicker}

      <div ref={think.ref} className='cbar-anchor'>
        <button
          type='button'
          className={'cbar-chip' + (effort && effort !== 'auto' ? ' is-set' : '')}
          aria-haspopup='dialog' aria-expanded={think.open}
          data-tip={think.open ? undefined : 'How hard the model thinks before answering.\nAuto leaves it to the provider.'}
          onClick={() => think.setOpen(o => !o)}
        >
          <Icon.bulb size={14} />
          <span className='cbar-chip-key'>Thinking</span>
          <span className='cbar-chip-val'>{effortLabel}</span>
          <Icon.chevronDown size={9} />
        </button>
        {think.open && (
          <div className='cbar-pop' role='dialog' aria-label='Thinking level'>
            <ThinkRail value={effort} onPick={id => { onSetEffort?.(id); think.setOpen(false) }} />
          </div>
        )}
      </div>

      <button
        type='button'
        className={'cbar-chip' + (approvalMode === 'off' ? ' is-warn' : approvalMode === 'auto' ? ' is-set' : '')}
        onClick={onCycleApproval}
        data-tip={'Permissions — what the agent may do without asking:\n• Ask each: confirm every command (safest)\n• Auto approve: run low-risk commands, ask for risky ones\n• Allow all: never ask (fastest, least safe)\nClick to cycle.'}
      >
        {approvalMode === 'off' ? <Icon.unlock size={14} /> : approvalMode === 'auto' ? <Icon.zap size={14} /> : <Icon.hand size={14} />}
        <span className='cbar-chip-val'>{approvalLabel}</span>
      </button>

      {/* the unusual states, said out loud: each is one click from being turned off */}
      {session.planMode && <button type='button' className='cbar-chip is-set' onClick={onTogglePlan} data-tip='Plan mode is on — the agent proposes a plan first.\nClick to turn it off.'><Icon.clipboard size={14} /><span className='cbar-chip-val'>Plan</span></button>}
      {session.computerControl && <button type='button' className='cbar-chip is-set' onClick={onToggleComputer} data-tip='Computer control is on.\nClick to turn it off.'><Icon.monitor size={14} /><span className='cbar-chip-val'>Computer{onAnotherMac ? ` · ${serverHost}` : ''}</span></button>}
      {!toolsOn && <button type='button' className='cbar-chip is-warn' onClick={onToggleTools} data-tip='Agent tools are off — chat only.\nClick to turn them on.'><Icon.wrench size={14} /><span className='cbar-chip-val'>Tools off</span></button>}
      {voiceOn && <button type='button' className='cbar-chip is-set' onClick={onToggleVoice} data-tip='End the voice conversation'><Icon.waves size={14} /><span className='cbar-chip-val'>{voiceWord}</span></button>}
      {dictating && <button type='button' className='cbar-chip is-set' onClick={onToggleDictation} data-tip='Stop dictating'><Icon.mic size={14} /><span className='cbar-chip-val'>Listening</span></button>}
      {skillChips}
    </div>
  )
}
