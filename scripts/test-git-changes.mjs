#!/usr/bin/env node
// The Changes panel's git side, against REAL throwaway repos (no mocks of git),
// then the HTTP routes on a Radiant this script starts on its own port and data
// folder. NEVER port 5834: that is the installed app and the user's real chats.
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, symlinkSync, readdirSync, chmodSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'

// An empty HOME so the machine's own git config (and identity) cannot leak into
// the assertions. Must be set BEFORE git-changes.js builds its environment.
const home = realpathSync(mkdtempSync(join(tmpdir(), 'rx-gchome-')))
process.env.HOME = home; process.env.XDG_CONFIG_HOME = join(home, '.config')
const G = await import('../server/git-changes.js')
const { registerGitRoutes } = await import('../server/git-changes-routes.js')

let pass = 0, fail = 0
const ok = (n, c, extra = '') => { c ? pass++ : (fail++, console.log(`  FAIL ${n}${extra ? ' — ' + extra : ''}`)) }
const root = realpathSync(mkdtempSync(join(tmpdir(), 'rx-gc-')))
const data = join(root, 'data'); mkdirSync(data)
const tmp = []
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
const git = (cwd, ...a) => execFileSync('/usr/bin/git', a, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const w = (d, f, c) => { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), c) }
const lines = n => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
function repo (name, { identity = true } = {}) {
  const d = join(root, name); mkdirSync(d)
  git(d, 'init', '-q', '-b', 'main')
  if (identity) { git(d, 'config', 'user.name', 'Test'); git(d, 'config', 'user.email', 't@example.com') } else git(d, 'config', 'user.useConfigOnly', 'true')
  git(d, 'config', 'commit.gpgsign', 'false')
  return d
}
const fx = async (p, ...a) => { try { return { v: await p(...a) } } catch (e) { return { e } } }
const by = (st, p) => st.files.find(f => f.path === p)

// ── not a repo / missing / no commits ─────────────────────────────────────
{
  const plain = join(root, 'plain'); mkdirSync(plain); w(plain, 'x.txt', 'hi')
  const s = await G.gitStatus(plain)
  ok('a non-repo folder is {isRepo:false}, not an error', s.isRepo === false && s.files.length === 0 && s.totals.files === 0, JSON.stringify(s))
  const m = await G.gitStatus(join(root, 'nope'))
  ok('a missing folder is {isRepo:false} too', m.isRepo === false)
  const d = await fx(G.gitDiff, plain, 'x.txt')
  ok('a diff in a non-repo is a plain 400', d.e?.status === 400 && /not a git repository/.test(d.e.message))

  const fresh = repo('fresh')
  w(fresh, 'a.txt', lines(3)); w(fresh, 'b.txt', lines(2)); git(fresh, 'add', 'a.txt')
  const f = await G.gitStatus(fresh, { fresh: true })
  ok('no commits yet is flagged', f.isRepo && f.noCommits === true && f.head === null && f.branch === 'main', JSON.stringify(f))
  ok('a staged new file in an empty repo is A with its lines', by(f, 'a.txt')?.status === 'A' && by(f, 'a.txt').staged && by(f, 'a.txt').additions === 3)
  ok('an untracked file is U and counted as additions', by(f, 'b.txt')?.status === 'U' && by(f, 'b.txt').untracked && by(f, 'b.txt').additions === 2)
  ok('totals add up', f.totals.files === 2 && f.totals.additions === 5 && f.totals.deletions === 0)
  const df = await G.gitDiff(fresh, 'a.txt')
  ok('a diff works before the first commit', /\+line 3/.test(df.diff))
  // the very first commit, by explicit path
  const c = await G.gitCommit(fresh, { message: 'first', paths: ['a.txt'] })
  ok('the first commit works by path', c.ok && /^[0-9a-f]{7,}$/.test(c.commit), JSON.stringify(c))
  ok('and left the other file alone', by(await G.gitStatus(fresh, { fresh: true }), 'b.txt')?.untracked === true)
}

// ── the busy repo ─────────────────────────────────────────────────────────
const R = repo('busy')
w(R, 'mod.txt', lines(5)); w(R, 'del.txt', lines(4)); w(R, 'old.txt', lines(6))
w(R, 'sp ace.txt', 'a\n'); w(R, 'ünï/çödé.txt', 'x\n'); writeFileSync(join(R, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255]))
w(R, 'keep.txt', 'keep\n')
git(R, 'add', '-A'); git(R, 'commit', '-q', '-m', 'base')
w(R, 'mod.txt', 'line 1\nCHANGED\nline 3\nline 4\nline 5\nextra\n')  // +2 -1
rmSync(join(R, 'del.txt'))
git(R, 'mv', 'old.txt', 'new.txt')
w(R, 'sp ace.txt', 'a\nb\nc\n')
w(R, 'ünï/çödé.txt', 'x\ny\n')
w(R, 'new dir/x y.txt', 'one\ntwo\n')
writeFileSync(join(R, 'new.bin'), Buffer.from([0, 9, 9, 0]))
writeFileSync(join(R, 'bin.dat'), Buffer.from([0, 1, 2, 3, 4, 0, 255]))
git(R, 'add', 'sp ace.txt')           // staged
w(R, 'sp ace.txt', 'a\nb\nc\nd\n')    // and edited again after staging
const S = await G.gitStatus(R, { fresh: true })
ok('a repo reports its branch and head', S.isRepo && S.branch === 'main' && /^[0-9a-f]{7}$/.test(S.head) && !S.detached && S.root === R)
ok('modified: M with +2 -1', by(S, 'mod.txt')?.status === 'M' && by(S, 'mod.txt').additions === 2 && by(S, 'mod.txt').deletions === 1, JSON.stringify(by(S, 'mod.txt')))
ok('deleted: D with -4', by(S, 'del.txt')?.status === 'D' && by(S, 'del.txt').deletions === 4)
ok('renamed: R keeps the old path', by(S, 'new.txt')?.status === 'R' && by(S, 'new.txt').oldPath === 'old.txt' && by(S, 'new.txt').staged)
ok('a path with a space survives', by(S, 'sp ace.txt')?.staged && by(S, 'sp ace.txt').unstaged && by(S, 'sp ace.txt').additions === 3, JSON.stringify(by(S, 'sp ace.txt')))
ok('a unicode path survives, unquoted', by(S, 'ünï/çödé.txt')?.additions === 1)
ok('untracked in a folder with a space', by(S, 'new dir/x y.txt')?.status === 'U' && by(S, 'new dir/x y.txt').additions === 2)
ok('a tracked binary is flagged and not counted', by(S, 'bin.dat')?.binary === true && by(S, 'bin.dat').additions === 0)
ok('an untracked binary is flagged', by(S, 'new.bin')?.binary === true)
ok('clean files are absent', !by(S, 'keep.txt'))
ok('totals: files / additions / deletions', S.totals.files === 8 && S.totals.deletions === 5 && S.totals.additions === 2 + 3 + 1 + 2, JSON.stringify(S.totals))
ok('not truncated, has a revision', S.truncated === false && /^[0-9a-f]{16}$/.test(S.revision))

// the cache: a second call inside 1.5 s costs no git run (same answer object)
const p1 = G.gitStatus(R), p2 = G.gitStatus(R)
ok('status is cached for a moment', p1 === p2)
const r0 = (await p1).revision
w(R, 'keep.txt', 'keep\nmore\n')
ok('a fresh read sees the edit and the revision moves', (await G.gitStatus(R, { fresh: true })).revision !== r0)
w(R, 'keep.txt', 'keep\n'); await G.gitStatus(R, { fresh: true })

// ── detached HEAD, upstream ───────────────────────────────────────────────
{
  const D = repo('detached'); w(D, 'a', '1\n'); git(D, 'add', '-A'); git(D, 'commit', '-q', '-m', 'one'); w(D, 'a', '2\n'); git(D, 'commit', '-qam', 'two')
  git(D, 'checkout', '-q', '--detach', 'HEAD~1'); w(D, 'a', '3\n')
  const s = await G.gitStatus(D, { fresh: true })
  ok('detached HEAD: branch null, detached true, still lists changes', s.detached === true && s.branch === null && /^[0-9a-f]{7}$/.test(s.head) && by(s, 'a')?.status === 'M')

  const bare = join(root, 'remote.git'); git(root, 'init', '-q', '--bare', '-b', 'main', bare)
  const U = repo('upstream'); w(U, 'a', '1\n'); git(U, 'add', '-A'); git(U, 'commit', '-q', '-m', 'one')
  git(U, 'remote', 'add', 'origin', bare); git(U, 'push', '-q', '-u', 'origin', 'main')
  w(U, 'a', '2\n'); git(U, 'commit', '-qam', 'local only')
  const us = await G.gitStatus(U, { fresh: true })
  ok('upstream, ahead and behind are reported', us.upstream === 'origin/main' && us.ahead === 1 && us.behind === 0, JSON.stringify([us.upstream, us.ahead, us.behind]))
}

// ── thousands of files, and a slow git ────────────────────────────────────
{
  const B = repo('big'); w(B, 'seed', 's\n'); git(B, 'add', '-A'); git(B, 'commit', '-q', '-m', 's')
  for (let i = 0; i < 5200; i++) writeFileSync(join(B, `f${String(i).padStart(5, '0')}.txt`), `${i}\n`)
  const t0 = Date.now()
  const s = await G.gitStatus(B, { fresh: true })
  ok('5,200 changed files: the list is capped, the real count is kept', s.truncated === true && s.files.length === G.LIST_CAP && s.totals.files === 5200, `${s.files.length}/${s.totals.files}`)
  ok('and it did not take long', Date.now() - t0 < 6000, `${Date.now() - t0}ms`)
  const slow = await fx(G.gitStatus, B, { timeoutMs: 1, fresh: true })
  ok('a git that is too slow is a clear 504, not a hang', slow.e?.status === 504 && /took longer/.test(slow.e.message), slow.e?.message)
  const huge = join(B, 'huge.txt'); writeFileSync(huge, 'x'.repeat(G.UNTRACKED_COUNT_CAP + 10))
  const hs = by(await G.gitStatus(B, { fresh: true }), 'huge.txt')
  ok('an untracked file over the size cap is not read to count lines', hs === undefined || hs.sizeCapped === true)
}

// ── diff ──────────────────────────────────────────────────────────────────
{
  const d = await G.gitDiff(R, 'mod.txt')
  ok('diff of a modified file (vs HEAD)', /^diff --git a\/mod.txt b\/mod.txt/m.test(d.diff) && /\+CHANGED/.test(d.diff) && /-line 2/.test(d.diff) && d.truncated === false)
  const ds = await G.gitDiff(R, 'sp ace.txt', { staged: true }), du = await G.gitDiff(R, 'sp ace.txt', { staged: false })
  ok('staged and unstaged halves are separate', /\+c/.test(ds.diff) && !/\+d/.test(ds.diff) && /\+d/.test(du.diff) && !/\+c/.test(du.diff))
  const dn = await G.gitDiff(R, 'new dir/x y.txt')
  ok('an untracked file shows as all-added', /new file mode/.test(dn.diff) && /\+one/.test(dn.diff) && /\+two/.test(dn.diff))
  const db = await G.gitDiff(R, 'bin.dat'), dnb = await G.gitDiff(R, 'new.bin')
  ok('binary is a one-line note', db.binary && /Binary files/.test(db.diff) && dnb.binary)
  const dd = await G.gitDiff(R, 'del.txt'); ok('a deleted file shows its lines as removed', /-line 4/.test(dd.diff))
  const dr = await G.gitDiff(R, 'new.txt'); ok('a rename diff mentions the rename', /rename from old.txt/.test(dr.diff))

  const H = repo('hugediff'); w(H, 'big.txt', 'a\n'); git(H, 'add', '-A'); git(H, 'commit', '-q', '-m', 'a')
  w(H, 'big.txt', Array.from({ length: 60000 }, (_, i) => `row number ${i} of the big file`).join('\n') + '\n')
  const dh = await G.gitDiff(H, 'big.txt')
  ok('a huge diff is capped and flagged', dh.truncated === true && dh.diff.length <= G.DIFF_CAP && dh.diff.endsWith('\n'), `${dh.diff.length}`)
}

// ── path safety ───────────────────────────────────────────────────────────
{
  const outside = join(root, 'outside'); mkdirSync(outside); w(outside, 'secret.txt', 'TOP SECRET\n')
  symlinkSync(outside, join(R, 'link')); symlinkSync(join(outside, 'secret.txt'), join(R, 'filelink'))
  await G.gitStatus(R, { fresh: true })
  for (const bad of ['../x', 'a/../../x', 'a/..', '/etc/passwd', outside + '/secret.txt', '.git/config', 'x/.git/hooks/pre-commit', '', '\0', 'link/secret.txt']) {
    const r = await fx(G.gitDiff, R, bad)
    ok(`diff refuses ${JSON.stringify(bad)}`, r.e?.status === 400, r.e ? r.e.message : 'it was allowed')
  }
  const rc = await fx(G.gitCommit, R, { message: 'm', paths: ['../x'] }); ok('commit refuses a traversal', rc.e?.status === 400)
  const ru = await fx(G.gitRestore, R, { paths: ['link/secret.txt'], mode: 'discard' }, { dataDir: data }); ok('undo refuses a path through a symlink', ru.e?.status === 400)
  ok('and the outside file is untouched', readFileSync(join(outside, 'secret.txt'), 'utf8') === 'TOP SECRET\n')
  const dl = await G.gitDiff(R, 'filelink')
  ok('a symlink is diffed as a link, never read through', !/TOP SECRET/.test(dl.diff) && /120000/.test(dl.diff), dl.diff)
  // undoing the symlink itself removes the link, not its target
  const un = await G.gitRestore(R, { paths: ['link', 'filelink'], mode: 'discard' }, { dataDir: data })
  ok('undoing an untracked symlink removes the link only', !existsSync(join(R, 'link')) && !existsSync(join(R, 'filelink')) && existsSync(join(outside, 'secret.txt')) && un.removed.length === 2)
  await G.gitRestoreSnapshot(R, un.snapshotId, { dataDir: data })
  ok('and its safety copy puts the links back', existsSync(join(R, 'link')) && existsSync(join(R, 'filelink')))
  rmSync(join(R, 'link')); rmSync(join(R, 'filelink'))
}

// ── hostile repo config: status and diff must run nothing ─────────────────
{
  const X = repo('hostile'); w(X, 'a.txt', 'one\n'); w(X, '.gitattributes', '*.txt diff=evil\n'); git(X, 'add', '-A'); git(X, 'commit', '-q', '-m', 'a')
  const marker = join(root, 'PWNED')
  git(X, 'config', 'core.fsmonitor', `touch ${marker} #`)
  git(X, 'config', 'diff.external', `touch ${marker}; true #`)
  git(X, 'config', 'diff.evil.textconv', `touch ${marker}; cat #`)
  w(X, 'a.txt', 'two\n')
  await G.gitStatus(X, { fresh: true }); const d = await G.gitDiff(X, 'a.txt')
  ok('the diff still works', /\+two/.test(d.diff))
  ok('and no command from the repo config ran (fsmonitor, diff.external, textconv)', !existsSync(marker))
}

// ── commit ────────────────────────────────────────────────────────────────
{
  const C = repo('commit'); w(C, 'a.txt', 'a\n'); w(C, 'b.txt', 'b\n'); git(C, 'add', '-A'); git(C, 'commit', '-q', '-m', 'base')
  w(C, 'a.txt', 'a2\n'); w(C, 'b.txt', 'b2\n'); w(C, 'u.txt', 'u\n'); git(C, 'add', 'b.txt')   // b is already staged
  const e1 = await fx(G.gitCommit, C, { message: '   ', paths: ['a.txt'] }); ok('an empty message is refused', e1.e?.status === 400 && /message/i.test(e1.e.message))
  const e2 = await fx(G.gitCommit, C, { message: 'x'.repeat(5001), paths: ['a.txt'] }); ok('a message over 5,000 characters is refused', e2.e?.status === 400)
  const e3 = await fx(G.gitCommit, C, { message: 'm' }); ok('no paths and no all:true is refused (never "everything" by accident)', e3.e?.status === 400)
  const e4 = await fx(G.gitCommit, C, { message: 'm', paths: [] }); ok('an empty paths list is refused too', e4.e?.status === 400)
  const e5 = await fx(G.gitCommit, C, { message: 'm', paths: ['keep-that-is-clean.txt'] }); ok('a path with no changes is "nothing to commit"', e5.e?.status === 422 && /Nothing to commit/.test(e5.e.message))

  const msg = 'Fix the thing\n\nIt'+"'"+'s got `backticks`, $(dollars) and "quotes"; and a #hash line.\n# not a comment'
  const c1 = await G.gitCommit(C, { message: msg, paths: ['a.txt', 'u.txt'] })
  ok('commit by explicit paths', c1.ok && c1.subject === 'Fix the thing' && /2 files? changed/.test(c1.summary), JSON.stringify(c1))
  ok('the message arrived byte for byte (no shell, no # stripping)', git(C, 'log', '-1', '--format=%B').trim() === msg)
  const files1 = git(C, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()
  ok('only the listed files were committed, not the one already staged', files1.join() === 'a.txt,u.txt', files1.join())
  const s1 = await G.gitStatus(C, { fresh: true })
  ok('the already-staged file is still staged afterwards', by(s1, 'b.txt')?.staged === true && !by(s1, 'a.txt') && !by(s1, 'u.txt'))

  w(C, 'z.txt', 'z\n'); w(C, 'sub/q.txt', 'q\n')
  const c2 = await G.gitCommit(C, { message: 'everything', all: true })
  ok('all:true commits everything incl. untracked', c2.ok && (await G.gitStatus(C, { fresh: true })).totals.files === 0)
  ok('and the staged leftover went with it', git(C, 'show', '--name-only', '--format=', 'HEAD').includes('b.txt'))
  const e6 = await fx(G.gitCommit, C, { message: 'again', all: true }); ok('all:true on a clean tree is "nothing to commit"', e6.e?.status === 422)
  ok('commit never pushes or amends: history is linear and unchanged below', git(C, 'rev-list', '--count', 'HEAD').trim() === '3')

  // a failing pre-commit hook: surfaced, files stay staged, nothing committed
  mkdirSync(join(C, '.git', 'hooks'), { recursive: true })
  writeFileSync(join(C, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "lint failed: no TODOs allowed"\nexit 1\n'); chmodSync(join(C, '.git', 'hooks', 'pre-commit'), 0o755)
  w(C, 'h.txt', 'TODO\n')
  const h = await fx(G.gitCommit, C, { message: 'blocked', paths: ['h.txt'] })
  ok('a failing hook is a 422 with the hook output and a plain reason', h.e?.status === 422 && /hook/i.test(h.e.message) && /lint failed: no TODOs/.test(h.e.extra.output), JSON.stringify(h.e))
  ok('the hook really ran and blocked the commit', git(C, 'rev-list', '--count', 'HEAD').trim() === '3')
  rmSync(join(C, '.git', 'hooks', 'pre-commit'))

  // no name/email configured
  const I = repo('noident', { identity: false }); w(I, 'a', '1\n')
  const id = await fx(G.gitCommit, I, { message: 'm', all: true })
  ok('missing git identity gets the exact fix, in plain words', id.e?.status === 422 && /git config --global user\.name/.test(id.e.message), id.e?.message)
}

// ── undo ──────────────────────────────────────────────────────────────────
{
  const U = repo('undo'); w(U, 'mod.txt', 'orig\n'); w(U, 'del.txt', 'gone soon\n'); w(U, 'old.txt', 'renamed\n'); w(U, 'other.txt', 'other\n'); w(U, 'staged.txt', 's\n')
  git(U, 'add', '-A'); git(U, 'commit', '-q', '-m', 'base')
  w(U, 'mod.txt', 'edited\nby agent\n'); rmSync(join(U, 'del.txt')); git(U, 'mv', 'old.txt', 'new.txt')
  w(U, 'untracked.txt', 'brand new\n'); w(U, 'other.txt', 'OTHER EDIT\n')
  w(U, 'added.txt', 'added\n'); git(U, 'add', 'added.txt'); w(U, 'staged.txt', 's2\n'); git(U, 'add', 'staged.txt')
  const before = await G.gitStatus(U, { fresh: true })

  const bad = await fx(G.gitRestore, U, { paths: ['mod.txt'], mode: 'nuke' }, { dataDir: data }); ok('only mode "discard" exists', bad.e?.status === 400)
  const none = await fx(G.gitRestore, U, { paths: [] , mode: 'discard' }, { dataDir: data }); ok('no paths is refused (no blanket undo)', none.e?.status === 400)
  const clean = await fx(G.gitRestore, U, { paths: ['nothing.txt'], mode: 'discard' }, { dataDir: data }); ok('a file with no changes cannot be "undone" (it might be deleted)', clean.e?.status === 422 && existsSync(join(U, 'nothing.txt')) === false)

  const r = await G.gitRestore(U, { paths: ['mod.txt', 'del.txt', 'new.txt', 'untracked.txt', 'added.txt', 'staged.txt', 'keep-clean.txt'], mode: 'discard' }, { dataDir: data })
  ok('undo reports what it did', r.ok && /^[a-z0-9]+-[0-9a-f]{10}$/.test(r.snapshotId) && r.restored.includes('mod.txt') && r.removed.includes('untracked.txt') && r.skipped.some(s => s.path === 'keep-clean.txt'), JSON.stringify(r))
  ok('modified file is back to HEAD', readFileSync(join(U, 'mod.txt'), 'utf8') === 'orig\n')
  ok('deleted file is back', readFileSync(join(U, 'del.txt'), 'utf8') === 'gone soon\n')
  ok('rename is undone both ways', existsSync(join(U, 'old.txt')) && !existsSync(join(U, 'new.txt')))
  ok('untracked and index-only added files are gone', !existsSync(join(U, 'untracked.txt')) && !existsSync(join(U, 'added.txt')))
  ok('a staged edit is back to HEAD too', readFileSync(join(U, 'staged.txt'), 'utf8') === 's\n')
  ok('a file NOT listed is untouched', readFileSync(join(U, 'other.txt'), 'utf8') === 'OTHER EDIT\n')
  const after = await G.gitStatus(U, { fresh: true })
  ok('only the unlisted change remains', after.files.length === 1 && after.files[0].path === 'other.txt', JSON.stringify(after.files))
  ok('the safety copy exists under the data dir', readdirSync(join(data, 'changes-undo')).includes(r.snapshotId))

  const back = await G.gitRestoreSnapshot(U, r.snapshotId, { dataDir: data })
  const again = await G.gitStatus(U, { fresh: true })
  ok('restoring the safety copy brings every change back', back.ok && again.files.length === before.files.length)
  ok('with the same contents', readFileSync(join(U, 'mod.txt'), 'utf8') === 'edited\nby agent\n' && !existsSync(join(U, 'del.txt')) && readFileSync(join(U, 'untracked.txt'), 'utf8') === 'brand new\n' && readFileSync(join(U, 'new.txt'), 'utf8') === 'renamed\n')
  ok('and the same staged state', by(again, 'added.txt')?.staged === true && by(again, 'new.txt')?.status === 'R' && by(again, 'staged.txt')?.staged === true && by(again, 'mod.txt')?.staged === false)
  const twice = await fx(G.gitRestoreSnapshot, U, r.snapshotId, { dataDir: data }); ok('a safety copy is used up once', twice.e?.status === 404)
  const junk = await fx(G.gitRestoreSnapshot, U, '../../etc', { dataDir: data }); ok('a made-up snapshot id is refused', junk.e?.status === 400)
  const other = repo('undo-other'); const r2 = await G.gitRestore(U, { paths: ['untracked.txt'], mode: 'discard' }, { dataDir: data })
  const wrong = await fx(G.gitRestoreSnapshot, other, r2.snapshotId, { dataDir: data }); ok('a safety copy will not restore into a different project', wrong.e?.status === 409)
}

// ── the routes ────────────────────────────────────────────────────────────
{
  // fake sessions + a real active-turn map, to test the 409 that a real turn would cause
  const sessions = { s1: { id: 's1', cwd: R }, plain: { id: 'plain', cwd: join(root, 'plain') } }
  const active = new Map()
  const app = express(); app.use(express.json())
  registerGitRoutes(app, { loadSession: id => sessions[id] || null, activeTurns: active, dataDir: data })
  const srv = app.listen(0, '127.0.0.1'); await new Promise(r => srv.once('listening', r))
  const base = `http://127.0.0.1:${srv.address().port}/api/sessions`
  const j = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null), etag: r.headers.get('etag') } }
  ok('unknown session: 404', (await j('GET', '/nope/changes')).status === 404)
  const rp = await j('GET', '/plain/changes'); ok('non-repo session: 200 {isRepo:false}', rp.status === 200 && rp.body.isRepo === false)
  const rs = await j('GET', '/s1/changes'); ok('status route returns the shape and an ETag', rs.status === 200 && rs.body.isRepo && rs.etag === `"${rs.body.revision}"`)
  const ru = await j('GET', `/s1/changes?rev=${rs.body.revision}`); ok('?rev= of the current revision answers {unchanged:true}', ru.body.unchanged === true && ru.body.files === undefined)
  const nm = await fetch(base + '/s1/changes', { headers: { 'if-none-match': rs.etag } }); ok('If-None-Match gets a 304', nm.status === 304)
  ok('diff route', (await j('GET', '/s1/changes/diff?path=mod.txt&staged=0')).body.diff.includes('+CHANGED'))
  ok('diff route refuses traversal with a message', (await j('GET', '/s1/changes/diff?path=' + encodeURIComponent('../x'))).status === 400)
  ok('diff route needs a path', (await j('GET', '/s1/changes/diff')).status === 400)
  const cm = await j('POST', '/s1/changes/commit', { message: 'm' }); ok('commit route: no paths/all → 400 with an error sentence', cm.status === 400 && typeof cm.body.error === 'string')
  active.set('s1', {})
  const ub = await j('POST', '/s1/changes/undo', { paths: ['mod.txt'] }); ok('undo while a turn runs: 409 with a plain sentence', ub.status === 409 && /still working/.test(ub.body.error))
  ok('so is restoring an undo copy', (await j('POST', '/s1/changes/undo/restore', { snapshotId: 'x' })).status === 409)
  ok('but a commit is allowed during a turn', (await j('POST', '/s1/changes/commit', { message: '' })).status === 400)
  active.delete('s1')
  const un = await j('POST', '/s1/changes/undo', { paths: ['mod.txt'] }); ok('undo route works once idle', un.status === 200 && un.body.snapshotId && readFileSync(join(R, 'mod.txt'), 'utf8') === lines(5))
  const rs2 = await j('POST', '/s1/changes/undo/restore', { snapshotId: un.body.snapshotId }); ok('undo/restore route puts it back', rs2.status === 200 && readFileSync(join(R, 'mod.txt'), 'utf8').includes('CHANGED'))
  const cm2 = await j('POST', '/s1/changes/commit', { message: 'route commit', paths: ['mod.txt'] }); ok('commit route', cm2.status === 200 && cm2.body.ok && cm2.body.commit)
  srv.close()
}

// ── wired into the real server ────────────────────────────────────────────
{
  const PORT = 5862
  const B = `http://127.0.0.1:${PORT}`
  const dir = mkdtempSync(join(tmpdir(), 'radiant-gc-'))
  const server = spawn('node', ['server/index.js'], { env: { ...process.env, RADIANT_DIR: dir, RADIANT_PORT: String(PORT) }, stdio: 'ignore' })
  const stop = () => { try { server.kill() } catch {} ; try { rmSync(dir, { recursive: true, force: true }) } catch {} }
  process.on('exit', stop)
  let ready = false
  for (let i = 0; i < 120 && !ready; i++) { try { const r = await fetch(B + '/api/version'); if (r.ok && (await r.json())?.version) ready = true } catch {} ; if (!ready) await new Promise(r => setTimeout(r, 250)) }
  ok('the real server came up', ready)
  if (ready) {
    const j = async (m, p, b) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) } }
    const W = repo('wired'); w(W, 'a.txt', 'a\n'); git(W, 'add', '-A'); git(W, 'commit', '-q', '-m', 'base'); w(W, 'a.txt', 'a\nb\n'); w(W, 'n.txt', 'n\n')
    const s = (await j('POST', '/api/sessions', { cwd: W })).body
    const st = await j('GET', `/api/sessions/${s.id}/changes`)
    ok('GET /changes on the real server', st.status === 200 && st.body.isRepo && st.body.totals.files === 2 && st.body.totals.additions === 2, JSON.stringify(st.body))
    ok('GET /changes/diff on the real server', (await j('GET', `/api/sessions/${s.id}/changes/diff?path=n.txt`)).body.diff.includes('+n'))
    const cm = await j('POST', `/api/sessions/${s.id}/changes/commit`, { message: 'via server', paths: ['a.txt'] })
    ok('POST /changes/commit on the real server', cm.status === 200 && cm.body.ok, JSON.stringify(cm.body))
    const un = await j('POST', `/api/sessions/${s.id}/changes/undo`, { paths: ['n.txt'] })
    ok('POST /changes/undo on the real server', un.status === 200 && !existsSync(join(W, 'n.txt')))
    ok('POST /changes/undo/restore on the real server', (await j('POST', `/api/sessions/${s.id}/changes/undo/restore`, { snapshotId: un.body.snapshotId })).status === 200 && existsSync(join(W, 'n.txt')))
    ok('unknown session on the real server', (await j('GET', '/api/sessions/does-not-exist/changes')).status === 404)
  }
  stop()
}

for (const d of [root, home]) try { rmSync(d, { recursive: true, force: true }) } catch {}
console.log(`\n${pass}/${pass + fail} passed  ·  the Changes panel lists, diffs, commits and undoes only what it was asked to`)
process.exit(fail ? 1 : 0)
