/**
 * The Changes panel's git side: what changed in a chat's project folder, the
 * diff of one file, a commit, and an undo that can itself be undone.
 *
 * ⚠️ THIS IS NOT server/checkpoints.js, AND IS NOT A COPY OF IT. Checkpoints
 * snapshot the WHOLE folder into a shadow repo around every agent turn and
 * restore the WHOLE folder to a sha. The Changes panel works on the user's REAL
 * repo and needs path-scoped actions ("commit these three files", "throw away
 * this one file"). Reusing the shadow repo for that would mean a full-tree
 * `git add -A` (seconds on a big project — checkpoints disable themselves past
 * 8 s) just to protect one file, and a restore that rewinds files the user did
 * not pick. So Undo keeps its own small safety copy of exactly the files it is
 * about to destroy (see gitRestore). The two features do not touch each other.
 *
 * ⚠️ READS MUST NOT EXECUTE ANYTHING FROM THE REPO. A project folder can come
 * from anywhere, and its .git/config is code: core.fsmonitor runs a command on
 * every `git status`; diff.external and a textconv driver run on `git diff`.
 * Every call here turns the first off (-c core.fsmonitor=false) and the second
 * and third off (--no-ext-diff --no-textconv). Residual risk, on purpose: a
 * repo's own clean/smudge filters (git-lfs is the common one) still run,
 * because switching them off would report wrong numbers for every LFS repo.
 * Hooks DO run for a commit — that is the user's repo and their own checks —
 * and are never skipped (no --no-verify).
 *
 * ⚠️ NO SHELL, EVER. git is spawned with an argument array; paths go after `--`
 * and --literal-pathspecs is on, so a file called ":(top)*" or "-rf" is just a
 * file name. Nothing here pushes, amends, or force-anything.
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const TIMEOUT_MS = 8000          // a status/diff that takes longer is an error, not a hang
export const COMMIT_TIMEOUT_MS = 120000 // hooks may run a test suite
export const LIST_CAP = 500             // files returned; the true count is totals.files
export const DIFF_CAP = 200 * 1024      // bytes of diff returned
export const UNTRACKED_COUNT_CAP = 1024 * 1024 // bigger untracked files are not read to count lines
export const MESSAGE_CAP = 5000
export const UNDO_TTL_MS = 60 * 60 * 1000      // how long "Undo" stays undoable
const SNAPSHOT_FILE_CAP = 50 * 1024 * 1024
const SNAPSHOT_TOTAL_CAP = 200 * 1024 * 1024
const SNAPSHOT_KEEP = 20
const CACHE_MS = 1500

const GIT = fs.existsSync('/usr/bin/git') ? '/usr/bin/git' : 'git'

/** An error whose message is fit to show a person as-is. `status` is the HTTP code a route should use. */
export class ChangesError extends Error {
  constructor (status, message, extra = {}) { super(message); this.status = status; this.extra = extra }
}

// A GIT_DIR / GIT_INDEX_FILE inherited from whatever launched Radiant (a git
// hook, for one) would point every call at the wrong repo. Drop all GIT_*.
const ENV = (() => {
  const e = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) e[k] = v
  return { ...e, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_LITERAL_PATHSPECS: '1', LC_ALL: 'C' }
})()
const FLAGS = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false']
const NO_EXEC_DIFF = ['--no-ext-diff', '--no-textconv', '--no-color']

/** Run git. Never rejects for a non-zero exit — callers read `code`. Rejects only for a missing git or a timeout. */
function run (args, { cwd, input, ms = TIMEOUT_MS, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(GIT, [...FLAGS, ...args], { cwd, env: ENV, stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []; let size = 0; let err = ''; let truncated = false; let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, ms)
    child.stdout.on('data', d => {
      if (truncated) return
      if (size + d.length > maxBytes) { out.push(d.subarray(0, maxBytes - size)); size = maxBytes; truncated = true; child.kill('SIGKILL') } else { out.push(d); size += d.length }
    })
    child.stderr.on('data', d => { if (err.length < 65536) err += d.toString('utf8') })
    child.stdin.on('error', () => {}) // git may exit before reading the message
    child.on('error', e => {
      clearTimeout(timer)
      reject(new ChangesError(500, e.code === 'ENOENT' ? 'Git is not installed on this Mac, so the Changes panel cannot work.' : `Could not run git: ${e.message}`))
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (timedOut) return reject(new ChangesError(504, `Git took longer than ${Math.round(ms / 1000)} seconds to answer, so Radiant stopped waiting. The folder may be very large or on a slow disk.`))
      resolve({ code, out: Buffer.concat(out), text: Buffer.concat(out).toString('utf8'), err, truncated })
    })
    child.stdin.end(input ?? '')
  })
}

// ---------- paths ----------

/** A client-supplied path → a clean repo-relative one, or a ChangesError. */
export function cleanRel (p) {
  const bad = why => new ChangesError(400, `That file path is not allowed (${why}).`)
  if (typeof p !== 'string' || !p) throw bad('empty')
  if (p.includes('\0') || p.length > 4096) throw bad('unreadable')
  if (path.isAbsolute(p)) throw bad('it must be relative to the project')
  const segs = p.split('/')
  if (segs.includes('..')) throw bad('"..", leaving the project')
  const norm = path.posix.normalize(p).replace(/\/+$/, '')
  if (!norm || norm === '.') throw bad('empty')
  if (norm.split('/').some(s => s.toLowerCase() === '.git')) throw bad('it points inside .git')
  return norm
}

/**
 * Validate a path against the repo root and return its absolute form. The
 * FOLDER it sits in is resolved through symlinks and must still be inside the
 * repo — `link/passwd` where `link -> /etc` is refused. The last component may
 * itself be a symlink (git tracks links as links); nothing here ever follows
 * it, because every file operation below uses lstat/readlink/rm, not stat/read.
 */
export function resolveInRepo (top, rel) {
  const r = cleanRel(rel)
  const abs = path.join(top, r)
  let dir = path.dirname(abs); let real
  for (;;) {
    try { real = fs.realpathSync(dir); break } catch { const up = path.dirname(dir); if (up === dir) throw new ChangesError(400, 'That file path is not allowed (folder missing).'); dir = up }
  }
  if (real !== top && !real.startsWith(top + path.sep)) throw new ChangesError(400, 'That file path is not allowed (it leaves the project through a link).')
  return { rel: r, abs }
}

// ---------- status ----------

const cache = new Map() // cwd -> { at, promise }
export function invalidateChanges (cwd) { cache.delete(path.resolve(String(cwd || ''))) }

function countLines (abs, size) {
  // Binary sniff on the first 8 KB, then count newlines in 64 KB reads. Capped
  // so one generated 2 GB file cannot stall the panel.
  let fd
  try {
    fd = fs.openSync(abs, 'r')
    const buf = Buffer.alloc(65536); let n = fs.readSync(fd, buf, 0, buf.length, 0)
    if (buf.subarray(0, Math.min(n, 8000)).includes(0)) return { binary: true, lines: 0 }
    let lines = 0; let pos = 0; let last = 0
    while (n > 0) {
      for (let i = 0; i < n; i++) if (buf[i] === 10) lines++
      last = buf[n - 1]; pos += n
      n = fs.readSync(fd, buf, 0, buf.length, pos)
    }
    if (pos > 0 && last !== 10) lines++
    return { binary: false, lines }
  } catch { return { binary: false, lines: 0 } } finally { if (fd !== undefined) try { fs.closeSync(fd) } catch {} }
}

function parseStatus (text) {
  const toks = text.split('\0')
  const head = { branch: null, oid: null, upstream: null, ahead: null, behind: null }
  const files = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (!t) continue
    if (t.startsWith('# ')) {
      const [k, ...v] = t.slice(2).split(' ')
      if (k === 'branch.oid') head.oid = v[0]
      else if (k === 'branch.head') head.branch = v.join(' ')
      else if (k === 'branch.upstream') head.upstream = v.join(' ')
      else if (k === 'branch.ab') { head.ahead = Number(v[0]); head.behind = Math.abs(Number(v[1])) }
    } else if (t[0] === '1' && t[1] === ' ') {
      const f = splitN(t, 8)                       // 1 XY sub mH mI mW hH hI path
      files.push(entry(f[1], f[8], null, f[6]))
    } else if (t[0] === '2' && t[1] === ' ') {
      const f = splitN(t, 9)                       // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
      files.push(entry(f[1], f[9], toks[++i], f[6], true))
    } else if (t[0] === 'u' && t[1] === ' ') {
      const f = splitN(t, 10)                      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      files.push({ path: f[10], status: '?', staged: false, unstaged: true, untracked: false, conflict: true, inHead: false })
    } else if (t[0] === '?' && t[1] === ' ') {
      files.push({ path: t.slice(2), status: 'U', staged: false, unstaged: false, untracked: true, conflict: false, inHead: false })
    }
  }
  return { head, files }
}
function splitN (s, n) { const out = []; let from = 0; for (let k = 0; k < n; k++) { const j = s.indexOf(' ', from); out.push(s.slice(from, j)); from = j + 1 } out.push(s.slice(from)); return out }
function entry (xy, p, oldPath, hH, renamed = false) {
  const [x, y] = xy
  const status = renamed ? 'R' : (x === 'A' || y === 'A') ? 'A' : (x === 'D' || y === 'D') ? 'D' : 'M'
  const e = { path: p, status, staged: x !== '.', unstaged: y !== '.', untracked: false, conflict: false, inHead: renamed ? false : !/^0+$/.test(hH) }
  if (renamed) e.oldPath = oldPath
  return e
}

function parseNumstat (buf) {
  const toks = buf.toString('utf8').split('\0'); const out = new Map()
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]; if (!t) continue
    const [a, d, p] = t.split('\t')
    const key = p === '' ? toks[i += 2] : p  // a rename is "a\td\t" \0 old \0 new
    const prev = out.get(key) || { additions: 0, deletions: 0, binary: false }
    if (a === '-') prev.binary = true
    else { prev.additions += Number(a); prev.deletions += Number(d) }
    out.set(key, prev)
  }
  return out
}

async function numstat (cwd, ms) {
  const base = ['diff', '--numstat', '-z', '-M', ...NO_EXEC_DIFF]
  const r = await run([...base, 'HEAD'], { cwd, ms })
  if (r.code === 0) return parseNumstat(r.out)
  // A repo with no commits has no HEAD: staged work diffs against the empty
  // tree (--cached), unstaged work against the index.
  const [s, u] = await Promise.all([run([...base, '--cached'], { cwd, ms }), run(base, { cwd, ms })])
  const m = parseNumstat(s.out)
  for (const [k, v] of parseNumstat(u.out)) { const p = m.get(k); m.set(k, p ? { additions: p.additions + v.additions, deletions: p.deletions + v.deletions, binary: p.binary || v.binary } : v) }
  return m
}

/** Everything about the working tree. `all` is the full list; gitStatus trims it. */
async function readStatus (cwd, ms) {
  let st
  try { st = fs.statSync(cwd) } catch { return { isRepo: false, reason: 'The project folder is missing.' } }
  if (!st.isDirectory()) return { isRepo: false, reason: 'The project folder is not a folder.' }
  const [top, status, nums] = await Promise.all([
    run(['rev-parse', '--show-toplevel'], { cwd, ms }),
    run(['status', '--porcelain=v2', '-z', '-b', '--untracked-files=all'], { cwd, ms }),
    numstat(cwd, ms)
  ])
  if (top.code !== 0) {
    if (/dubious ownership/i.test(top.err)) throw new ChangesError(500, 'Git will not open this folder because it belongs to another user. Run "git config --global --add safe.directory <folder>" if you trust it.')
    return { isRepo: false, reason: 'This folder is not a git repository.' }
  }
  const root = fs.realpathSync(top.text.trim())
  const { head, files } = parseStatus(status.text)
  if (status.truncated) files.pop() // the last record may have been cut mid-way
  return { isRepo: true, root, head, files, nums, truncated: status.truncated }
}

/**
 * The Changes panel's list. Paths are relative to the repo ROOT (not to `cwd`),
 * in git's own spelling. Cached 1.5 s per folder so a panel that refreshes after
 * every tool call costs one git run, not one per call.
 */
export function gitStatus (cwd, { timeoutMs = TIMEOUT_MS, fresh = false } = {}) {
  const key = path.resolve(String(cwd || ''))
  const hit = cache.get(key)
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.promise
  const promise = shape(key, timeoutMs)
  cache.set(key, { at: Date.now(), promise })
  promise.catch(() => { if (cache.get(key)?.promise === promise) cache.delete(key) })
  return promise
}

/** The untrimmed view the write operations need (they must see all files, not the first 500). */
async function fullStatus (cwd) {
  const s = await readStatus(path.resolve(cwd), TIMEOUT_MS)
  if (!s.isRepo) throw new ChangesError(400, s.reason)
  return s
}

async function shape (cwd, ms) {
  const s = await readStatus(cwd, ms)
  if (!s.isRepo) return { isRepo: false, reason: s.reason, files: [], totals: { files: 0, additions: 0, deletions: 0 }, revision: 'none' }
  const sorted = s.files.sort((a, b) => (a.untracked - b.untracked) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const shown = sorted.slice(0, LIST_CAP).map(f => {
    const n = s.nums.get(f.path) || { additions: 0, deletions: 0, binary: false }
    const out = { path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), status: f.status, staged: f.staged, unstaged: f.unstaged, untracked: f.untracked, conflict: f.conflict, additions: n.additions, deletions: n.deletions, binary: n.binary }
    let sig = ''
    try {
      const l = fs.lstatSync(path.join(s.root, f.path)); sig = `${l.size}:${l.mtimeMs}`
      if (f.untracked) {
        if (l.isSymbolicLink()) out.additions = 1
        else if (l.isFile() && l.size <= UNTRACKED_COUNT_CAP) { const c = countLines(path.join(s.root, f.path)); out.additions = c.lines; out.binary = c.binary }
        else if (l.isFile()) out.sizeCapped = true // too big to count; additions stays 0
      }
    } catch { /* gone since git looked */ }
    return { out, sig }
  })
  const files = shown.map(x => x.out)
  const h = s.head
  const detached = h.branch === '(detached)'
  const totals = { files: s.files.length, additions: files.reduce((a, f) => a + f.additions, 0), deletions: files.reduce((a, f) => a + f.deletions, 0) }
  const revision = crypto.createHash('sha1').update(JSON.stringify([h.oid, h.branch, h.upstream, h.ahead, h.behind, shown.map(x => [x.out.path, x.out.status, x.out.staged, x.out.unstaged, x.out.additions, x.out.deletions, x.sig])])).digest('hex').slice(0, 16)
  return {
    isRepo: true, root: s.root,
    branch: detached ? null : h.branch, detached,
    head: h.oid && h.oid !== '(initial)' ? h.oid.slice(0, 7) : null, noCommits: h.oid === '(initial)',
    ...(h.upstream ? { upstream: h.upstream, ahead: h.ahead ?? 0, behind: h.behind ?? 0 } : {}),
    files, totals,
    truncated: s.files.length > LIST_CAP || s.truncated,
    revision
  }
}

// ---------- diff ----------

/**
 * One file's unified diff, capped at DIFF_CAP bytes.
 * staged: true → index vs HEAD; false → working tree vs index; undefined →
 * working tree vs HEAD (what the panel shows by default: everything that
 * changed, however it was staged).
 */
export async function gitDiff (cwd, relPath, { staged } = {}) {
  const st = await fullStatus(cwd)
  const { rel, abs } = resolveInRepo(st.root, relPath)
  const f = st.files.find(x => x.path === rel)
  let r
  if (f?.untracked) {
    // --no-index against /dev/null renders a new file as all-added, handles
    // binary, and treats a symlink as a link — it never reads through it.
    const l = fs.lstatSync(abs)
    if (l.isDirectory()) return { path: rel, staged: Boolean(staged), diff: `${rel} is a folder with its own git history; open it as its own project to see its changes.`, truncated: false, binary: false }
    r = await run(['diff', '--no-index', ...NO_EXEC_DIFF, '--', '/dev/null', rel], { cwd: st.root, maxBytes: DIFF_CAP })
  } else {
    const specs = [rel, ...(f?.oldPath ? [f.oldPath] : [])]
    const mode = staged === true ? ['--cached'] : staged === false ? [] : (st.head.oid === '(initial)' ? ['--cached'] : ['HEAD'])
    r = await run(['diff', '-M', ...NO_EXEC_DIFF, ...mode, '--', ...specs], { cwd: st.root, maxBytes: DIFF_CAP })
  }
  if (r.code > 1) throw new ChangesError(500, `Git could not make that diff: ${r.err.trim().split('\n').pop() || 'unknown error'}`)
  let diff = r.text
  if (r.truncated) diff = diff.slice(0, diff.lastIndexOf('\n') + 1 || diff.length)
  return { path: rel, staged: staged === undefined ? null : staged, diff, truncated: r.truncated, binary: /^Binary files .* differ$|^GIT binary patch/m.test(diff) }
}

// ---------- commit ----------

const hex = /^[0-9a-f]{40}$/
function tail (...parts) { const t = parts.filter(Boolean).join('\n').trim(); return t.length > 2000 ? '…' + t.slice(-2000) : t }

/**
 * Commit. WHICH FILES is never a guess:
 *   - `paths: [...]`  → only those files (a rename's old name rides along).
 *     Anything else already staged is left staged and out of the commit.
 *   - `all: true`     → every change, untracked files included (git add -A).
 *   - neither         → refused. An empty request must not become "commit the
 *     whole folder", which is what a bug in a client would otherwise cause.
 * The message goes in on stdin. Hooks run; a failing hook's output comes back.
 * Never pushes, never amends, never --no-verify.
 */
export async function gitCommit (cwd, { message, paths, all } = {}) {
  const msg = typeof message === 'string' ? message.trim() : ''
  if (!msg) throw new ChangesError(400, 'Write a commit message first.')
  if (msg.length > MESSAGE_CAP) throw new ChangesError(400, `That commit message is too long (${msg.length} characters; the limit is ${MESSAGE_CAP}).`)
  if (!all && !(Array.isArray(paths) && paths.length)) throw new ChangesError(400, 'Choose which files to commit, or commit everything.')
  const st = await fullStatus(cwd)
  let specs = []
  const skipped = []
  if (!all) {
    for (const p of paths) {
      const { rel } = resolveInRepo(st.root, p)
      const f = st.files.find(x => x.path === rel)
      if (!f) { skipped.push({ path: rel, reason: 'no changes' }); continue }
      if (f.conflict) throw new ChangesError(409, `${rel} has a merge conflict. Resolve it first.`)
      specs.push(rel); if (f.oldPath) specs.push(f.oldPath)
    }
    specs = [...new Set(specs)]
    if (!specs.length) throw new ChangesError(422, 'Nothing to commit: none of those files have changes.', { skipped })
    const add = await run(['add', '-A', '--', ...specs], { cwd: st.root })
    if (add.code !== 0) throw new ChangesError(422, `Git could not stage those files: ${tail(add.err)}`)
  } else {
    if (!st.files.length) throw new ChangesError(422, 'Nothing to commit: there are no changes.')
    const add = await run(['add', '-A'], { cwd: st.root })
    if (add.code !== 0) throw new ChangesError(422, `Git could not stage the changes: ${tail(add.err)}`)
  }
  invalidateChanges(cwd)
  const c = await run(['commit', '-F', '-', ...(all ? [] : ['--', ...specs])], { cwd: st.root, input: msg + '\n', ms: COMMIT_TIMEOUT_MS })
  if (c.code !== 0) {
    const all_ = tail(c.text, c.err)
    if (/author identity unknown|tell me who you are|unable to auto-detect email|empty ident name/i.test(all_)) {
      throw new ChangesError(422, 'Git needs your name and email before it can commit. In Terminal, run: git config --global user.name "Your Name"  and  git config --global user.email "you@example.com"', { output: all_ })
    }
    if (/nothing (added )?to commit|no changes added to commit/i.test(all_)) throw new ChangesError(422, 'Nothing to commit: those files match the last commit.', { output: all_ })
    if (/cannot do a partial commit during a merge/i.test(all_)) throw new ChangesError(422, 'A merge is in progress, so git only allows committing everything. Use "commit all".', { output: all_ })
    const hooks = await run(['rev-parse', '--git-path', 'hooks'], { cwd: st.root })
    const dir = path.resolve(st.root, hooks.text.trim())
    const hooked = ['pre-commit', 'commit-msg', 'prepare-commit-msg'].some(n => { try { fs.accessSync(path.join(dir, n), fs.constants.X_OK); return true } catch { return false } })
    throw new ChangesError(422, hooked
      ? 'Git stopped the commit, most likely because a commit hook (a check this project runs before each commit) failed. What it printed is below. The files stay staged.'
      : 'Git could not make the commit. What it said is below.', { output: all_ })
  }
  const [h, stat] = await Promise.all([
    run(['log', '-1', '--format=%H%x00%h%x00%s'], { cwd: st.root }),
    run(['show', '--shortstat', '--format=', ...NO_EXEC_DIFF, 'HEAD'], { cwd: st.root })
  ])
  const [full, short, subject] = h.text.trim().split('\0')
  invalidateChanges(cwd)
  return { ok: true, commit: short, sha: hex.test(full) ? full : null, subject, summary: stat.text.trim() || 'Committed.', ...(skipped.length ? { skipped } : {}) }
}

// ---------- undo ----------

function snapshotRoot (dataDir) { return path.join(dataDir, 'changes-undo') }
function prune (dataDir) {
  const root = snapshotRoot(dataDir)
  let names = []
  try { names = fs.readdirSync(root) } catch { return }
  const live = []
  for (const n of names) {
    const dir = path.join(root, n)
    let m = null
    try { m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) } catch {}
    if (!m || Date.now() > m.expiresAt) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} } else live.push({ dir, at: m.createdAt })
  }
  live.sort((a, b) => b.at - a.at).slice(SNAPSHOT_KEEP).forEach(x => { try { fs.rmSync(x.dir, { recursive: true, force: true }) } catch {} })
}

/**
 * "Undo": throw away the listed files' changes. DESTRUCTIVE, so:
 *   - only files that git currently reports as changed, and only the ones the
 *     caller names — never `checkout .`, never a folder, never a conflict;
 *   - before anything is touched, each file's current bytes (or link, or
 *     "absent") are copied to <dataDir>/changes-undo/<id>/ and the id returned;
 *     gitRestoreSnapshot(id) puts them back, for UNDO_TTL_MS;
 *   - tracked files go back to HEAD (index and disk), files that were only ever
 *     added go away, untracked files are deleted.
 * A file over 50 MB, or 200 MB in total, makes the whole undo refuse rather
 * than discard something that cannot be saved first.
 */
export async function gitRestore (cwd, { paths, mode } = {}, { dataDir } = {}) {
  if (mode !== 'discard') throw new ChangesError(400, 'Unknown undo mode.')
  if (!dataDir) throw new ChangesError(500, 'No place to keep the undo copy.')
  if (!Array.isArray(paths) || !paths.length) throw new ChangesError(400, 'Choose which files to undo.')
  if (paths.length > 2000) throw new ChangesError(400, 'Too many files at once; undo them in smaller groups.')
  const st = await fullStatus(cwd)
  const todo = []; const skipped = []
  for (const p of new Set(paths)) {
    const { rel, abs } = resolveInRepo(st.root, p)
    const f = st.files.find(x => x.path === rel)
    if (!f) { skipped.push({ path: rel, reason: 'no changes to undo' }); continue }
    if (f.conflict) { skipped.push({ path: rel, reason: 'has a merge conflict; resolve it in git' }); continue }
    let l = null; try { l = fs.lstatSync(abs) } catch {}
    if (l?.isDirectory()) { skipped.push({ path: rel, reason: 'is a folder with its own git history' }); continue }
    todo.push({ f, rel, abs, l })
    if (f.oldPath) { const o = resolveInRepo(st.root, f.oldPath); let ol = null; try { ol = fs.lstatSync(o.abs) } catch {} todo.push({ f: { ...f, path: f.oldPath, oldPath: undefined, status: 'M', inHead: true, untracked: false }, rel: o.rel, abs: o.abs, l: ol }) }
  }
  if (!todo.length) throw new ChangesError(422, 'None of those files have changes to undo.', { skipped })

  // 1. the safety copy
  let total = 0
  for (const t of todo) {
    if (t.l?.isFile()) { if (t.l.size > SNAPSHOT_FILE_CAP) throw new ChangesError(422, `${t.rel} is too large (over 50 MB) to keep a safety copy of, so Radiant will not discard it. Delete or revert it yourself.`); total += t.l.size }
  }
  if (total > SNAPSHOT_TOTAL_CAP) throw new ChangesError(422, 'Those files add up to more than 200 MB, too much to keep a safety copy of. Undo fewer files at once.')
  prune(dataDir)
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`
  const dir = path.join(snapshotRoot(dataDir), id)
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true })
  const items = todo.map((t, i) => {
    const it = { path: t.rel, staged: t.f.staged, kind: 'absent' }
    if (t.l?.isSymbolicLink()) { it.kind = 'symlink'; it.target = fs.readlinkSync(t.abs) } else if (t.l?.isFile()) { it.kind = 'file'; it.mode = t.l.mode & 0o777; it.store = String(i); fs.copyFileSync(t.abs, path.join(dir, 'files', it.store)) }
    return it
  })
  const createdAt = Date.now()
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, root: st.root, createdAt, expiresAt: createdAt + UNDO_TTL_MS, items }))

  // 2. the discard
  const restored = []; const removed = []
  const gone = todo.filter(t => !t.f.inHead)
  const headPaths = todo.filter(t => t.f.inHead).map(t => t.rel)
  if (headPaths.length) {
    const r = await run(['checkout', 'HEAD', '--', ...headPaths], { cwd: st.root })
    if (r.code !== 0) throw new ChangesError(500, `Git could not put those files back: ${tail(r.err)}. Your safety copy is saved (${id}).`, { snapshotId: id })
    restored.push(...headPaths)
  }
  const indexed = gone.filter(t => !t.f.untracked).map(t => t.rel)
  if (indexed.length) await run(['rm', '-f', '-q', '--ignore-unmatch', '--', ...indexed], { cwd: st.root })
  for (const t of gone) { try { fs.rmSync(t.abs, { force: true }) } catch {} removed.push(t.rel) }
  invalidateChanges(cwd)
  return { ok: true, restored, removed, skipped, snapshotId: id, expiresAt: createdAt + UNDO_TTL_MS }
}

/** Put back everything a gitRestore threw away. The copy is used up by a successful restore. */
export async function gitRestoreSnapshot (cwd, snapshotId, { dataDir } = {}) {
  if (typeof snapshotId !== 'string' || !/^[a-z0-9]+-[0-9a-f]{10}$/.test(snapshotId)) throw new ChangesError(400, 'That undo copy id is not valid.')
  const dir = path.join(snapshotRoot(dataDir), snapshotId)
  let m
  try { m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) } catch { throw new ChangesError(404, 'That undo copy is gone (they are kept for an hour).') }
  if (Date.now() > m.expiresAt) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} ; throw new ChangesError(410, 'That undo copy has expired (they are kept for an hour).') }
  const st = await fullStatus(cwd)
  if (st.root !== m.root) throw new ChangesError(409, 'That undo copy belongs to a different project folder.')
  const back = []
  for (const it of m.items) {
    const { rel, abs } = resolveInRepo(st.root, it.path) // re-checked: the manifest is a file on disk
    try { fs.rmSync(abs, { force: true }) } catch {}
    if (it.kind === 'file') {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.copyFileSync(path.join(dir, 'files', path.basename(it.store)), abs); fs.chmodSync(abs, it.mode)
    } else if (it.kind === 'symlink') {
      fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.symlinkSync(it.target, abs)
    }
    if (it.staged) await run(it.kind === 'absent' ? ['rm', '-q', '--cached', '--ignore-unmatch', '--', rel] : ['add', '-A', '--', rel], { cwd: st.root })
    back.push(rel)
  }
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  invalidateChanges(cwd)
  return { ok: true, restored: back }
}
