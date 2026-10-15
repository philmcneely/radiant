// Which part of a finished reply is "the work" and which is "the answer".
//
// ⚠️ A FINISHED TURN FOLDS TO ONE LINE, THE ANSWER STAYS. Twelve tool calls and the
// narration between them are the agent's working, not its reply. Only a turn that is
// over, did real work (three or more tool calls), ended in an answer, and is not
// waiting on the person is folded — anything running, stopped short, or asking
// something is left open exactly as it was.
export const FOLD_AT = 3
const NOTHING_THERE = /ENOENT|no such file|not found|404|does not exist|no matches|old_string not found/i

/** A tool call that shows as a chip (widgets, the todo list and questions render their own way). */
export const isChip = p => p.type === 'tool' && !p.widget && p.name !== 'show_widget' && p.name !== 'todo_write' && p.name !== 'ask_user' && !p.hidden

export function foldPlan (parts = [], { streaming = false } = {}) {
  let lastTool = -1
  let nTools = 0
  parts.forEach((p, i) => { if (isChip(p)) { lastTool = i; nTools++ } })
  const answer = parts.slice(lastTool + 1)
  const fold = !streaming && nTools >= FOLD_AT &&
    answer.some(p => p.type === 'text' && (p.text || '').trim()) &&
    !parts.some(p => p.type === 'halt' || p.pending || (p.type === 'tool' && p.name === 'ask_user' && p.result == null))
  if (!fold) return { fold: false, worked: [], answer: parts, nTools, failed: 0 }
  const worked = parts.slice(0, lastTool + 1)
  // an agent looking for a file that is not there is how searching works; only the rest is a failure
  const failed = worked.filter(p => isChip(p) && !p.denied && p.result != null && /^Error/i.test(String(p.result)) && !NOTHING_THERE.test(String(p.result))).length
  return { fold: true, worked, answer, nTools, failed }
}
