/**
 * HTTP side of the Changes panel (logic in server/git-changes.js).
 *
 * Auth is not repeated here: every /api route already sits behind the access
 * token gate in index.js (loopback always allowed, remote devices need the
 * token), so a remote phone gets exactly what the Mac gets and no more.
 *
 * ⚠️ A running turn blocks Undo. The agent may be mid-edit on the very file the
 * person is discarding, and its next write would silently bring it back. Commit
 * is allowed during a turn — it snapshots what is on disk, nothing is lost.
 */
import { gitStatus, gitDiff, gitCommit, gitRestore, gitRestoreSnapshot, ChangesError } from './git-changes.js'

export function registerGitRoutes (app, { loadSession, activeTurns, dataDir }) {
  const session = (req, res) => {
    const s = loadSession(req.params.id)
    if (!s) { res.status(404).json({ error: 'not found' }); return null }
    return s
  }
  const fail = (res, e) => {
    if (e instanceof ChangesError) return res.status(e.status).json({ ok: false, error: e.message, ...e.extra })
    console.error('[changes]', e)
    res.status(500).json({ ok: false, error: 'Something went wrong reading the project folder.' })
  }
  const busy = (s, res) => {
    if (!activeTurns.has(s.id)) return false
    res.status(409).json({ ok: false, error: 'The assistant is still working in this chat. Stop it, or wait for it to finish, before undoing changes.' })
    return true
  }

  // Cheap by design: status is cached ~1.5 s per folder, and a client that
  // passes ?rev=<last revision> gets a few bytes back when nothing changed.
  app.get('/api/sessions/:id/changes', async (req, res) => {
    const s = session(req, res); if (!s) return
    try {
      const st = await gitStatus(s.cwd)
      res.set('ETag', `"${st.revision}"`)
      if (req.headers['if-none-match'] === `"${st.revision}"`) return res.status(304).end()
      if (req.query.rev && req.query.rev === st.revision) return res.json({ unchanged: true, revision: st.revision })
      res.json(st)
    } catch (e) { fail(res, e) }
  })

  app.get('/api/sessions/:id/changes/diff', async (req, res) => {
    const s = session(req, res); if (!s) return
    if (!req.query.path) return res.status(400).json({ ok: false, error: 'path is required' })
    const staged = req.query.staged === undefined ? undefined : /^(1|true)$/i.test(String(req.query.staged))
    try { res.json(await gitDiff(s.cwd, String(req.query.path), { staged })) } catch (e) { fail(res, e) }
  })

  app.post('/api/sessions/:id/changes/commit', async (req, res) => {
    const s = session(req, res); if (!s) return
    try { res.json(await gitCommit(s.cwd, { message: req.body?.message, paths: req.body?.paths, all: req.body?.all === true })) } catch (e) { fail(res, e) }
  })

  app.post('/api/sessions/:id/changes/undo', async (req, res) => {
    const s = session(req, res); if (!s || busy(s, res)) return
    try { res.json(await gitRestore(s.cwd, { paths: req.body?.paths, mode: req.body?.mode || 'discard' }, { dataDir })) } catch (e) { fail(res, e) }
  })

  app.post('/api/sessions/:id/changes/undo/restore', async (req, res) => {
    const s = session(req, res); if (!s || busy(s, res)) return
    try { res.json(await gitRestoreSnapshot(s.cwd, req.body?.snapshotId, { dataDir })) } catch (e) { fail(res, e) }
  })
}
