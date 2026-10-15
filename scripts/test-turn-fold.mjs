// A finished reply folds its working behind one line and keeps the answer; anything
// unfinished, short, or waiting on the person does not fold.
import { foldPlan, FOLD_AT } from '../src/turnfold.js'

let pass = 0, fail = 0
const ok = (c, what) => { if (c) pass++; else { fail++; console.log('  FAIL', what) } }
const tool = (n = 'run_command', extra = {}) => ({ type: 'tool', id: Math.random().toString(36), name: n, args: {}, result: 'ok', ...extra })
const text = t => ({ type: 'text', text: t })

const long = [text('Looking.'), tool(), text('More.'), tool(), tool(), text('The answer.')]
const p = foldPlan(long)
ok(p.fold && p.nTools === 3, 'three tool calls and an answer fold')
ok(p.answer.length === 1 && p.answer[0].text === 'The answer.', 'only the final text stays out')
ok(p.worked.length === 5, 'the narration between the calls folds with them')
ok(!foldPlan(long, { streaming: true }).fold, 'a reply still streaming never folds')
ok(!foldPlan([text('a'), tool(), tool(), text('b')]).fold, `fewer than ${FOLD_AT} tool calls stay as they are`)
ok(!foldPlan([text('a'), tool(), tool(), tool()]).fold, 'a turn that ended on a tool, with no answer, stays open')
ok(!foldPlan([...long, { type: 'halt', text: 'stopped' }]).fold, 'a halted turn stays open')
ok(!foldPlan([tool(), tool(), tool('ask_user', { result: null }), text('x')]).fold, 'a question waiting on you stays open')
ok(!foldPlan([tool(), tool(), tool({}), text('x')].map((x, i) => i === 2 ? tool('run_command', { pending: true }) : x)).fold, 'a call still waiting for approval stays open')
const widgets = [tool('show_widget'), tool('todo_write'), tool('ask_user'), text('x')]
ok(!foldPlan(widgets).fold, 'widgets, the todo list and questions do not count as tool calls')
const failed = foldPlan([tool('run_command', { result: 'Error: exit 1' }), tool('run_command', { result: 'Error: ENOENT no such file' }), tool(), text('done')])
ok(failed.fold && failed.failed === 1, 'a real failure is counted, a file that was not there is not')
ok(!foldPlan([]).fold && foldPlan([]).answer.length === 0, 'an empty reply is fine')
console.log(`\n${pass}/${pass + fail} passed  ·  a finished turn folds its working and keeps its answer`)
process.exit(fail ? 1 : 0)
