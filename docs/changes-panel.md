# Changes panel: server API

Code: `server/git-changes.js` (logic), `server/git-changes-routes.js` (HTTP),
`changesApi` at the end of `src/api.js` (client helpers). Test:
`node scripts/test-git-changes.mjs`.

Everything works on the chat's project folder (`session.cwd`). All paths in
requests and responses are relative to the **repo root**, in git's spelling
(that can differ from `cwd` when the project is a sub-folder of a repo).
Routes sit behind the normal access-token gate, so a remote device gets the same
API as the Mac. Errors are `{ ok:false, error:"plain sentence", ...extra }`.

## GET /api/sessions/:id/changes

```json
{
  "isRepo": true, "root": "/abs/repo",
  "branch": "main", "detached": false,          // branch is null when detached
  "head": "a1b2c3d", "noCommits": false,        // head is null before the first commit
  "upstream": "origin/main", "ahead": 1, "behind": 0,   // only when an upstream exists
  "files": [{
    "path": "src/a.js", "oldPath": "src/old.js",  // oldPath only for renames
    "status": "M",
    "staged": true, "unstaged": false,
    "untracked": false, "conflict": false,
    "additions": 3, "deletions": 1, "binary": false,
    "sizeCapped": true                             // only on untracked files too big to count
  }],
  "totals": { "files": 12, "additions": 40, "deletions": 9 },
  "truncated": false,
  "revision": "9f2c4e1a7b3d5c60"
}
```

- `status`: `M` modified, `A` added, `D` deleted, `R` renamed, `U` untracked
  (VS Code's letter), `?` merge conflict (`conflict:true`).
- `staged` / `unstaged`: a file edited after staging is both.
- Numbers are against `HEAD` (staged + unstaged combined). Untracked files count
  their lines as `additions`; binary files are `binary:true` with 0/0.
- At most 500 files are listed (tracked files first, then untracked, then by
  path). `totals.files` is the real count; when `truncated` is true,
  `additions`/`deletions` cover the listed files only.
- Not a repo, or the folder is missing: `200 { isRepo:false, reason, files:[],
  totals:{...0}, revision:"none" }`.
- **Cheap refresh.** Status is cached about 1.5 s per folder. `revision` changes
  whenever the branch, head, or any listed file's status/size/mtime changes.
  Send `?rev=<last revision>` and an unchanged tree answers
  `{ unchanged:true, revision }`; the `ETag` header / `If-None-Match` (304) work
  too. There is no new SSE event: refresh when a turn's stream ends.
- A git that takes over 8 seconds: `504` with a plain message. Git not
  installed or folder owned by another user: `500` with a plain message.

## GET /api/sessions/:id/changes/diff?path=&staged=

`staged=1` index vs HEAD, `staged=0` working tree vs index, omitted = working
tree vs HEAD (the default; shows everything however it was staged).

```json
{ "path": "src/a.js", "staged": null, "diff": "diff --git a/…", "truncated": false, "binary": false }
```

Capped at 200 KB (`truncated:true`, cut at a line boundary). Untracked files
render as all-added. Binary files give git's one-line `Binary files … differ`
note with `binary:true`. A renamed file's diff includes the rename header.

## POST /api/sessions/:id/changes/commit

Body: `{ "message": "…", "paths": ["a.js", "b/c.js"] }` **or**
`{ "message": "…", "all": true }`.

- `paths` commits **only those files** (a rename's old name rides along); files
  already staged but not listed stay staged and out of the commit.
- `all:true` stages everything, untracked files included, and commits it.
- Neither: `400`. A client bug must never turn into "commit the whole folder".
- Message: trimmed, required, at most 5,000 characters. Sent on stdin.
- Success: `{ ok:true, commit:"a1b2c3d", sha:"<40 hex>", subject, summary:"2 files changed, 3 insertions(+)", skipped?:[{path,reason}] }`.
- Failure: `422 { ok:false, error, output? }` for nothing to commit, missing git
  identity (the error gives the exact `git config` lines), a merge in progress,
  or a failing hook (`output` is the last 2,000 characters of what git and the
  hook printed; the files stay staged, as in a normal git commit).
- Hooks run. Never `--no-verify`, never amend, never push.

## POST /api/sessions/:id/changes/undo

Body: `{ "paths": ["a.js", …], "mode": "discard" }` (`mode` defaults to
`discard`, the only mode).

```json
{ "ok": true, "restored": ["a.js"], "removed": ["new.js"],
  "skipped": [{ "path": "clean.js", "reason": "no changes to undo" }],
  "snapshotId": "mgx3k1-9a8b7c6d5e", "expiresAt": 1760000000000 }
```

- Tracked files go back to `HEAD` (index and disk); files that were only ever
  added, and untracked files, are deleted; a rename is undone on both names.
- Only files git currently reports as changed, and only those named. Conflicts
  and nested repos are skipped with a reason. `409` while a turn is running in
  that chat.
- Before touching anything, the files' current bytes are copied to
  `<data dir>/changes-undo/<snapshotId>/`. Kept one hour (20 at most); a single
  file over 50 MB, or more than 200 MB in all, makes the undo refuse.
- This deliberately does **not** reuse `server/checkpoints.js`: checkpoints
  snapshot the whole folder into a shadow repo and restore the whole folder,
  while Undo is per-file on the user's real repo and must stay fast on big
  projects. The two never interact.

## POST /api/sessions/:id/changes/undo/restore

Body: `{ "snapshotId": "…" }` puts back what that undo threw away (contents,
symlinks, re-deleted files, and staged state; partial staging collapses to
fully staged). Returns `{ ok:true, restored:[…] }`. The copy is used up by a
successful restore. `404` gone, `410` expired, `409` for a different project,
`409` while a turn is running.

## Safety rules

- Git is spawned with an argument array, never a shell; paths follow `--` and
  `--literal-pathspecs` is on.
- Read calls pass `--no-optional-locks`, `-c core.fsmonitor=false`,
  `--no-ext-diff`, `--no-textconv`, so a hostile `.git/config` cannot run a
  command during status or diff. Known gap: a repo's own clean/smudge filters
  (git-lfs) still run, since turning them off would give wrong LFS numbers.
- Paths must be relative, contain no `..`, no `.git` segment, and the folder
  they sit in must resolve (through symlinks) inside the repo root. The last
  component may be a symlink; it is handled as a link and never followed.
- Inherited `GIT_*` environment variables are dropped so Radiant cannot be
  pointed at another repo.

## Limits

| What | Limit |
|---|---|
| git call (status, diff) | 8 s, then a plain error |
| commit | 120 s (hooks may run tests) |
| files listed | 500 (true count in `totals.files`) |
| diff size | 200 KB |
| untracked file read to count lines | 1 MB (above: `sizeCapped`) |
| status output read | 8 MB (then `truncated`) |
| commit message | 5,000 characters |
| undo safety copy | 50 MB per file, 200 MB total, 1 hour, 20 copies |
