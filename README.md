# dsh-archived-sessions

[![DeepSeek Harness](https://img.shields.io/badge/DSH-0.2.x-4B6BFB)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that adds an **Archived Sessions** panel to Settings: archived sessions grouped by workspace, with **unarchive** and **permanent delete**.

> DSH hides archived sessions from the sidebar and ships no UI to bring them back or remove them. Once archived, a session is effectively invisible — the only trace left is its log on disk. This plugin closes that gap.

---

## Features

| | |
|---|---|
| **Grouped by workspace** | Archived sessions are listed under the workspace they belong to, plus a separate bucket for sessions whose workspace is gone. |
| **Unarchive** | Restores a session to the sidebar in one click. |
| **Permanent delete** | Removes the session log from disk, its projection cache, and its in-process registries — so the row does not come back as a ghost. |
| **Subagent cleanup** | Deleting a parent session also removes its `origin: 'subagent'` descendants, which the sidebar never shows and nothing else would ever collect. |
| **Self-healing** | On mount, the panel prunes entries that no longer have any backing data on disk or in memory. |
| **Minimal UI** | Icon-only actions, no redundant labels. |

---

## Requirements

- **DSH `0.2.x`** (declared as `>=0.2.1-rc.2 <0.3.0` via `engines.dsh`)
- A DSH profile that can load local bundles

The version range covers the entire `0.2.x` line — **you do not need to touch it for ordinary DSH upgrades**. See [Version policy](#version-policy).

---

## Install

This is a **local plugin**. DSH resolves it from your profile, not from npm.

### 1. Get the source

```bash
git clone https://github.com/XD06/dsh-archived-sessions.git
```

Place it somewhere stable, e.g. `~/dsh-plugins/archived-sessions`.

### 2. Point your profile at it

Edit your profile's `package.json` (e.g. `~/.dsh/profiles/desktop/package.json`):

```json
{
  "dependencies": {
    "@local/dsh-archived-sessions": "link:/absolute/path/to/archived-sessions"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@local/dsh-archived-sessions"
      ]
    }
  }
}
```

Use an **absolute path**. On Windows, forward slashes work: `link:C:/Users/you/dsh-plugins/archived-sessions`.

### 3. Link it

```bash
cd ~/.dsh/profiles/desktop
pnpm install
```

Or, to avoid pnpm copying the files (which makes edits silently go stale):

**Windows (junction — recommended):**
```cmd
mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\@local\dsh-archived-sessions" "C:\path\to\archived-sessions"
```

**macOS / Linux (symlink):**
```bash
ln -s /path/to/archived-sessions ~/.dsh/profiles/desktop/node_modules/@local/dsh-archived-sessions
```

### 4. Restart DSH

The panel appears in **Settings → Archived Sessions**.

---

## Usage

1. Archive a session as usual (sidebar context menu → **Archive session**).
2. Open **Settings → Archived Sessions**.
3. Per row:
   - **Unarchive** — back to the sidebar
   - **Delete** — permanent, with a confirmation dialog

Deletion is **irreversible**. It removes:

- the session log (`sessions/<project>/<sessionId>/session.v4.jsonl.zstd`)
- the projection cache (`storages/session_projcache/sessions/<sessionId>.json`)
- any pending creation entry
- the live Agent / Session registry entries
- all `origin: 'subagent'` descendants

A session that is currently **running** or **in use** is refused rather than force-removed.

---

## Version policy

The manifest declares:

```json
"engines": {
  "dsh": ">=0.2.1-rc.2 <0.3.0"
}
```

DSH evaluates this on every boot. When `engines.dsh` is present it decides **alone** — `peerDependencies` is ignored entirely.

**Why not `peerDependencies`?** DSH compares a `peerDependencies` range against the **DSH runtime version**, not against that package's own version. Writing `"@deepseek-ai/dsh-typert-protocol": "0.2.1-rc.2"` therefore means *"require the DSH runtime to be exactly 0.2.1-rc.2"* — and the plugin breaks on the next DSH release. This plugin originally made that mistake; see [PLUGIN-NOTES.md](PLUGIN-NOTES.md).

| DSH version | Status |
|---|---|
| `0.2.1-rc.2` … `0.2.9` | ✅ works |
| `0.3.0` and later | ⛔ refused until re-validated |

When DSH reaches `0.3.0`, bump the upper bound **after** re-checking the APIs this plugin relies on (`Remote`, `RemoteError`, `TypertRemoteService`).

---

## How it works

DSH exposes no session-deletion Remote, so the plugin registers its own authenticated route on the Host fetch carrier:

```
POST /api/session.purgeArchived
```

`purgeSession()` then runs a fixed sequence — log first, accounting last — because clearing the bookkeeping before the file makes the row flash back:

1. Guard: the session must be archived
2. Precheck: refuse if running / in use
3. Rename log → remove (rename makes a partial delete recoverable)
4. Unarchive + detach
5. Drop projection cache
6. Drop pending creation
7. Dispose the Agent scope and purge both registries

Children are collected **before** the parent is deleted, since a child's header is unreadable once its directory is gone.

---

## Known limitations

- **Local only.** Not published to npm; install by path as shown above.
- **No cascade guarantee for already-orphaned sessions.** Deleting a parent cleans up its children. Children orphaned *before* this plugin existed are not retroactively collected — remove them manually or via the `prune` action.
- **One-frame flash.** Because the log and accounting are cleared before the registries release, the row can flash for one frame during deletion. Making it disappear instantly would require replacing `getSnapshot` with a freshly allocated object, which violates `useSyncExternalStore`'s identity contract and crashes the UI. Not worth it.
- **No undo.** Deletion does not use the OS trash.

---

## Development

```bash
node --check host.js
node --check client.js
```

There is no build step — both halves ship as plain ESM.

**Host** (`host.js`) exports `name`, `inject`, `apply`.
**Client** (`client.js`) is a `window.__ModuleLoader__.load({ id, factory })` bundle that returns `{ name, inject, apply }`.

Two hard-won constraints, documented in full in [PLUGIN-NOTES.md](PLUGIN-NOTES.md):

- A controller mounted via nested `ctx.plugin()` is **not reachable** through the Typert gateway. Only `ctx.connection.fetch.register({ path, methods, requestBody, fetch })` works.
- The route path must start with `/api/` and use a single-segment suffix.

### Diagnostic route

```bash
# health
curl http://127.0.0.1:<port>/api/session.purgeArchived

# drop archived ids with no backing data
curl -X POST -H 'content-type: application/json' \
  -d '{"action":"prune"}' \
  http://127.0.0.1:<port>/api/session.purgeArchived

# drop pending creations with no backing data
curl -X POST -H 'content-type: application/json' \
  -d '{"action":"prunePending"}' \
  http://127.0.0.1:<port>/api/session.purgeArchived
```

---

## Documentation

- [ISSUE.md](ISSUE.md) — the ghost-row bug: symptom, evidence, root cause, four failed fixes, final fix
- [PLUGIN-NOTES.md](PLUGIN-NOTES.md) — DSH plugin development notes: packaging, the Remote trap, Cordis service access, `useSyncExternalStore` constraints, asar internals

---

## License

[MIT](LICENSE)
