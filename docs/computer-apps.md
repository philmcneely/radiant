# Per-app approval for desktop control

`server/computer-apps.js`, wired into the tool loop in `server/providers.js` (before the
tool time budget starts, so a person deciding is not a slow tool).

After LCU (github.com/amontlabs/lcu). Every acting desktop tool (`screen_click`,
`screen_doubleclick`, `screen_drag`, `screen_type`, `screen_key`, `screen_scroll`) is
resolved to an APP first: the owner of the window under the point (click, double-click,
drag start) or the focused app (type, key, scroll), via one `osascript -l JavaScript`
call (~70 ms, no permission prompt). Screenshots and `screen_move` are not gated.

| kind | apps | rule |
| --- | --- | --- |
| never | Terminal, iTerm, Ghostty, Warp, kitty, Alacritty, WezTerm, Hyper, Script Editor, Radiant | refused in every mode, even "Allow all", even if granted |
| risky | 1Password, Bitwarden, Dashlane, LastPass, Keychain Access, Passwords, System Settings | asked every chat; no "Always" |
| browser | Chrome, Safari, Firefox, Arc, Edge, Brave | asked once, with a warning |
| normal | everything else | asked once |

Answers: *Allow for this chat* (`session.appGrants`), *Always allow* (machine setting
`computerApps.always`, `~/.radiant-machine.json`, never synced), *Deny*. The question is
the normal `question_request` card; the model cannot see or answer it. A run with no one
to ask (tasks, loops, graphs) uses only the always list.

`computerApps` is removed from `PUT /api/settings`; the only writers are the approval
card and `DELETE /api/computer-apps/:id` (Revoke). `GET /api/computer-apps` lists.

Not covered: macOS only (other systems have no cheap permission-free way to ask which
window is under a point, so the gate steps aside); `browser_*` tools, which act inside
the browser through the extension and keep their existing per-action approval; and a
window that appears between the check and the click.

Test: `scripts/test-computer-apps.mjs`.
