/**
 * Host half of the Archived Sessions bundle.
 *
 * The page itself is Client code over the shipped Workspace controller. What no
 * shipped Remote offers is removal of a session log, so this package contributes
 * one small authenticated POST route:
 *
 * - `{ sessionId }` purges that session (every retained log generation, its
 *   archive flag, its Workspace accounting, and its projection-cache entry);
 * - `{ action: 'prune' }` drops archived ids whose log is already gone;
 * - `{ action: 'sweep' }` reconciles the durable registry with the Host's own
 *   session index after a purge.
 *
 * Why `sweep` exists: deleting a log does not make the Client forget the row it
 * already loaded. The Session list keeps the summary until something removes it,
 * and the registry's header index keeps the id, so the Workspace still owns a
 * row the sidebar renders under "未分组". The Host can close that loop because it
 * is the one place that sees both the registry and the live session store.
 *
 * The route is a plain `connection.fetch.register` handler rather than a
 * `TypertRemoteService`: a controller mounted from inside another plugin is not
 * reachable through the Typert gateway ("this Host does not expose the …
 * controller"). See PLUGIN-NOTES.md for that and the other constraints.
 *
 * @module @local/dsh-archived-sessions
 */
import { open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

/** Route of the purge/sweep endpoint, behind the same authentication as every Host API. */
export const PURGE_PATH = '/api/session.purgeArchived'
/** Suffix of the rename-first tombstone a purge owns, so a retry finishes an interrupted delete. */
const PURGE_SUFFIX = '.purge'
/** A session directory holds a log when one of these files exists. */
const LOG_SUFFIXES = ['.jsonl', '.jsonl.zstd']
/**
 * Bound on the descendant walk. A delegation chain is as deep as the product
 * allows a subagent to delegate again, which is small; the cap only exists so a
 * forged or corrupted header cannot make the walk loop.
 */
const DELEGATION_MAX_DEPTH = 16

/**
 * Encode one session id the way the shipped JSONL backend names its session
 * directory (`encodeSegment`): `[A-Za-z0-9._-]` stays literal and every other
 * UTF-16 unit becomes `~XXXX` — including `~` itself — so the result is one
 * injective, traversal-safe path segment.
 * @param {string} sessionId - durable session identity.
 * @returns {string} one safe path segment.
 */
export function encodeSessionDirectory(sessionId) {
  if (sessionId === '') throw new Error('cannot encode an empty session directory')
  if (sessionId === '.') return '~002E'
  if (sessionId === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < sessionId.length; index += 1) {
    const char = sessionId[index]
    if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) {
      out += char
      continue
    }
    out += `~${sessionId.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * The mounted persistence root, or `undefined` when the backend is not file-based.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @returns {string | undefined} absolute root directory.
 */
function rootOf(ctx) {
  const root = ctx.get('sessionPersistence')?.config?.root
  return typeof root === 'string' && root !== '' ? root : undefined
}

/**
 * Whether this Host process still tracks a session it created but never wrote.
 * Such a session has no artifact on disk yet and still owns its write claim, so
 * nothing may be deleted and no accounting may be swept for it.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {string} sessionId - session identity.
 * @returns {boolean} whether a detached creation is pending.
 */
function isPendingCreation(ctx, sessionId) {
  const persistence = ctx.get('sessionPersistence')
  if (typeof persistence?.hasPendingSession === 'function') return persistence.hasPendingSession(sessionId) === true
  return false
}

/**
 * The backend's created-but-unmaterialized registry, read through Cordis's own
 * escape hatch.
 *
 * A Service handed back by `ctx.get` is a traceable proxy: every string property
 * it does not declare routes through the inject guard and throws
 * `cannot get property "…" without inject`, and even `Object.values` trips it.
 * `cordis.original` is the well-known symbol that yields the raw receiver, and
 * `getPropertyDescriptor` reads a field without invoking the proxy's getter — a
 * plain `obj.field` is served by the Object.prototype descriptor and comes back
 * shadowed, which is why the descriptor route is required here.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @returns {{ pending: Map<string, unknown>, writers?: Map<string, unknown> } | undefined} the tracker.
 */
function trackerOf(ctx) {
  const original = Symbol.for('cordis.original')
  /** Resolve one own-or-inherited data/accessor slot, bypassing traceable proxies. */
  const slot = (target, key) => {
    let cursor = target
    while (cursor !== null && cursor !== undefined) {
      const descriptor = Reflect.getOwnPropertyDescriptor(cursor, key)
      if (descriptor !== undefined) {
        if ('value' in descriptor) return descriptor.value
        return descriptor.get?.call(target)
      }
      cursor = Reflect.getPrototypeOf(cursor)
    }
    return undefined
  }
  let persistence
  try {
    persistence = ctx.get('sessionPersistence')?.[original]
  } catch {
    return undefined
  }
  const raw = persistence?.[original] ?? persistence
  let tracker
  try {
    // The tracker is a plain object held in a field; only the Service itself is
    // proxied, so the `cordis.original` unwrap happens exactly once, above.
    tracker = slot(raw, 'tracker')
  } catch {
    return undefined
  }
  if (tracker === null || typeof tracker !== 'object') return undefined
  try {
    const pending = slot(tracker, 'pending')
    if (!(pending instanceof Map)) return undefined
    const writers = slot(tracker, 'writers')
    return { pending, writers: writers instanceof Map ? writers : undefined }
  } catch {
    return undefined
  }
}

/**
 * Forget a session this process created but never materialized. The Session list
 * merges pending entries, so leaving one behind after the log was removed reports
 * a row that can never open. Best effort: an unknown backend shape simply leaves
 * the entry, which the restart path clears.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {string} sessionId - session identity.
 * @returns {boolean} whether a pending entry was dropped.
 */
export function dropPendingCreation(ctx, sessionId) {
  const tracker = trackerOf(ctx)
  if (tracker === undefined) return false
  if (!tracker.pending.has(sessionId)) return false
  tracker.pending.delete(sessionId)
  // The entry owned the write claim; without it the claim would outlive the
  // session and block a later create that reuses the id.
  try {
    if (tracker.writers?.get(sessionId) === null) tracker.writers.delete(sessionId)
  } catch {
    // A claim we cannot inspect is left to the backend's own teardown.
  }
  return true
}

/**
 * Every session id this process still tracks as a created-but-unmaterialized
 * creation. These are never on disk, so nothing else can enumerate them.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @returns {string[]} pending session ids.
 */
export function listPendingCreations(ctx) {
  const tracker = trackerOf(ctx)
  return tracker === undefined ? [] : [...tracker.pending.keys()]
}

/**
 * Every candidate directory that can hold per-session derived state, derived
 * from the mounted persistence root (`<home>/sessions` → `<home>`). The
 * projection cache the Session controller keeps is not part of the session log,
 * so deleting a log leaves its cache entry behind; this is where a purge finds
 * and removes it.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @returns {string[]} absolute cache directories, most specific first.
 */
function cacheDirectoriesOf(ctx) {
  const root = rootOf(ctx)
  if (root === undefined) return []
  const home = dirname(root)
  return [
    join(home, 'storages', 'session_projcache', 'sessions'),
    join(home, 'cache', 'session_projcache', 'sessions'),
  ]
}

/**
 * Remove this session's derived projection-cache entry, if any backend keeps
 * one. Best effort: a cache entry is regenerable state, so a failure here is
 * logged and never turns a completed purge into an error.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {string} sessionId - durable session identity.
 * @returns {Promise<boolean>} whether an entry was removed.
 */
export async function dropSessionCache(ctx, sessionId) {
  const segment = encodeSessionDirectory(sessionId)
  let removed = false
  for (const directory of cacheDirectoriesOf(ctx)) {
    const target = join(directory, `${segment}.json`)
    try {
      await stat(target)
    } catch {
      continue
    }
    try {
      await rm(target, { force: true })
      removed = true
    } catch (error) {
      ctx.logger?.warn?.(`archived-sessions: removing the cached projection state of "${sessionId}" failed: ${String(error)}`)
    }
  }
  return removed
}

/**
 * Find a session's on-disk directory, including one left by an interrupted
 * purge. The backend nests logs under a project directory named after the
 * session's cwd; the session directory segment is globally unique, so every
 * project directory is scanned instead of re-deriving that name.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {string} sessionId - durable session identity.
 * @returns {Promise<{ directory: string, leftover: boolean, bytes: number } | undefined>} location.
 */
export async function locateSessionDirectory(ctx, sessionId) {
  const root = rootOf(ctx)
  if (root === undefined) return undefined
  const segment = encodeSessionDirectory(sessionId)
  let projects
  try {
    // Dirent.type is unreliable on some Windows filesystems, so probe instead
    // of trusting isDirectory() and skipping a real session directory.
    projects = await readdir(root)
  } catch {
    return undefined
  }
  for (const projectName of projects) {
    const projectDirectory = join(root, projectName)
    for (const [suffix, leftover] of [['', false], [PURGE_SUFFIX, true]]) {
      const directory = join(projectDirectory, `${segment}${suffix}`)
      let files
      try {
        files = await readdir(directory)
      } catch {
        continue
      }
      const logs = files.filter((name) => LOG_SUFFIXES.some((end) => name.endsWith(end)))
      if (!leftover && logs.length === 0) continue
      let bytes = 0
      for (const name of logs) {
        try {
          bytes += (await stat(join(directory, name))).size
        } catch {
          // A vanished generation contributes no size.
        }
      }
      return { directory, leftover, bytes }
    }
  }
  return undefined
}

/**
 * Read one session's header straight out of its log, without going through the
 * persistence Service.
 *
 * A subagent's parent link lives only in the first line of its own log — the
 * header carries `parentSession` and `origin: 'subagent'`. The persistence
 * Service exposes the same data through `list()`, but that call walks and
 * decompresses every generation under the root, and the purge path must stay
 * cheap. Reading one already-located file is bounded work.
 *
 * Both log generations are handled: a version-zero log is plain JSONL, a later
 * one is a concatenation of zstd frames. Only the first frame matters, because
 * the header is the first line.
 * @param {string} directory - the session's own directory.
 * @returns {Promise<object | undefined>} the parsed header, when readable.
 */
async function readSessionHeader(directory) {
  let names
  try {
    names = await readdir(directory)
  } catch {
    return undefined
  }
  // Any retained generation will do: the header is written once, at creation, and
  // never rewritten, so every generation of one session carries the same identity.
  const log = names.find((name) => name.startsWith('session.v') && LOG_SUFFIXES.some((end) => name.endsWith(end)))
  if (log === undefined) return undefined
  const path = join(directory, log)
  let text
  if (log.endsWith('.jsonl')) {
    try {
      text = (await readFile(path, 'utf8')).slice(0, 65536)
    } catch {
      return undefined
    }
  } else {
    text = await readFirstZstdFrameText(path)
  }
  if (text === undefined) return undefined
  const newline = text.indexOf('\n')
  const firstLine = newline === -1 ? text : text.slice(0, newline)
  let header
  try {
    header = JSON.parse(firstLine)
  } catch {
    return undefined
  }
  if (header === null || typeof header !== 'object' || header.type !== 'session') return undefined
  return header
}

/**
 * Decode the first line of a concatenated-frame zstd log without reading the
 * whole file.
 *
 * The backend appends one frame per batch, so a log is a chain of independent
 * frames; the header sits alone in the first one. `zstdDecompressSync` accepts a
 * truncated tail only up to a frame boundary, so the read grows until the first
 * frame decodes — in practice one 16 KiB read, and never more than the file.
 * @param {string} path - the log file.
 * @returns {Promise<string | undefined>} the first frame's text, when readable.
 */
async function readFirstZstdFrameText(path) {
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    return undefined
  }
  try {
    let content = Buffer.alloc(0)
    const chunk = Buffer.alloc(16384)
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) return undefined
      content = Buffer.concat([content, chunk.subarray(0, bytesRead)])
      try {
        return zstdDecompressSync(content).toString('utf8')
      } catch {
        // The read ended inside the first frame; one more chunk may complete it.
        continue
      }
    }
  } catch {
    return undefined
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * Find every session directory whose log names `parentId` as its parent.
 *
 * A purge removes one session, but a parent may own subagent children, and each
 * child is a separate session directory with its own log. Deleting the parent
 * alone leaves those children behind as files nothing references: the sidebar
 * hides every `origin: 'subagent'` row outright (`sessionVisible` returns false
 * for them), so an orphaned child is invisible garbage that never surfaces in
 * the UI and never gets collected.
 *
 * The scan is deliberately brute force: a subagent's project directory is keyed
 * by its `cwd`, which need not match the parent's, so no index can narrow it. The
 * whole root is walked and each candidate header is read directly.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {string} parentId - the session whose children to collect.
 * @returns {Promise<string[]>} child session ids, direct children only.
 */
export async function findChildSessionIds(ctx, parentId) {
  const index = await indexSessionParents(ctx)
  return index.get(parentId) ?? []
}

/**
 * Build the whole parent → children index in one pass over the session root.
 *
 * A per-level rescan would re-read every header once per delegation level, so a
 * chain of N levels would cost N full walks. One pass answers every level.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @returns {Promise<Map<string, string[]>>} parent id → child ids.
 */
async function indexSessionParents(ctx) {
  const index = new Map()
  const root = rootOf(ctx)
  if (root === undefined) return index
  let projects
  try {
    projects = await readdir(root)
  } catch {
    return index
  }
  for (const projectName of projects) {
    let entries
    try {
      entries = await readdir(join(root, projectName))
    } catch {
      continue
    }
    for (const entry of entries) {
      // `Dirent.type` is unreliable on some Windows filesystems, so the header
      // read below is the probe rather than `isDirectory()`.
      const header = await readSessionHeader(join(root, projectName, entry))
      if (header === undefined) continue
      if (header.origin !== 'subagent') continue
      if (typeof header.id !== 'string' || header.id === '') continue
      if (typeof header.parentSession !== 'string' || header.parentSession === '') continue
      const siblings = index.get(header.parentSession)
      if (siblings === undefined) index.set(header.parentSession, [header.id])
      else siblings.push(header.id)
    }
  }
  return index
}

/**
 * Collect a session and every subagent session descended from it, parents first.
 *
 * The walk is breadth-first so a parent is always visited before its children,
 * which is the order a purge wants: the root is the row the user acted on, and a
 * child that fails to delete must not prevent its parent from being removed.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {string} rootId - the session the user asked to purge.
 * @returns {Promise<string[]>} the root followed by every descendant, deduplicated.
 */
export async function collectSessionLineage(ctx, rootId) {
  const index = await indexSessionParents(ctx)
  const seen = new Set([rootId])
  const ordered = [rootId]
  let frontier = [rootId]
  for (let depth = 0; depth < DELEGATION_MAX_DEPTH && frontier.length > 0; depth += 1) {
    const next = []
    for (const parentId of frontier) {
      for (const childId of index.get(parentId) ?? []) {
        // A malformed header could name a session as its own ancestor; the set
        // makes the walk terminate instead of looping.
        if (seen.has(childId)) continue
        seen.add(childId)
        ordered.push(childId)
        next.push(childId)
      }
    }
    frontier = next
  }
  return ordered
}

/**
 * Read one field from a Cordis Service without tripping its inject guard.
 *
 * A Service returned by `ctx.get` is a traceable proxy: string properties it does
 * not declare route through the guard and throw `cannot get property "…" without
 * inject`, and `Object.values` trips it too. `cordis.original` yields the raw
 * receiver, and a descriptor lookup reads a field without invoking any proxy
 * getter (a plain `obj.field` is served by `Object.prototype`'s descriptor and
 * comes back shadowed).
 * @param {unknown} service - the value returned by `ctx.get`.
 * @param {string} key - field name to read.
 * @returns {unknown} the field value, or `undefined` when it cannot be read.
 */
function rawField(service, key) {
  try {
    const raw = service?.[Symbol.for('cordis.original')] ?? service
    let cursor = raw
    while (cursor !== null && cursor !== undefined) {
      const descriptor = Reflect.getOwnPropertyDescriptor(cursor, key)
      if (descriptor !== undefined) {
        return 'value' in descriptor ? descriptor.value : descriptor.get?.call(raw)
      }
      cursor = Reflect.getPrototypeOf(cursor)
    }
  } catch {
    // An unreadable service is reported as "unknown shape" by the caller.
  }
  return undefined
}

/**
 * Retire the live Agent that owns a session, so the Session list stops reporting
 * it once its log is gone.
 *
 * Why this is required: archiving only blocks the next step through the
 * `agent/pre-step` gate — it never unloads the Agent. The Session list builds a
 * live row from `ctx.sessions` whenever one exists, regardless of whether any log
 * is left, so a purged-but-mounted session keeps appearing as a row the Host
 * cannot open. Removing the Agent registry entry is not enough on its own:
 * `session-query.listSessions()` also folds `ctx.sessions.list()`, so the Session
 * store entry has to go too, or the row survives with `agentAvailable: false`.
 *
 * Refusals are deliberate: a running or client-pinned session is never torn down
 * behind the user's back, because that would abort in-flight work or break an open
 * page. The caller reports `busy` instead and the row stays retryable.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {string} sessionId - session identity.
 * @param {{ dryRun?: boolean }} [options] - `dryRun` reports occupancy without disposing.
 * @returns {Promise<{ retired: boolean, reason?: 'running' | 'in-use' | 'available' | 'unavailable' }>} outcome.
 */
export async function retireAgent(ctx, sessionId, options = {}) {
  let agents
  try {
    agents = ctx.get('agents')
  } catch {
    return { retired: false, reason: 'unavailable' }
  }
  if (typeof agents?.get !== 'function') return { retired: false, reason: 'unavailable' }
  let agent
  try {
    agent = agents.get(sessionId)
  } catch {
    return { retired: false, reason: 'unavailable' }
  }
  if (agent === undefined) return { retired: true }
  // Running work is the user's, not ours to throw away.
  try {
    if (agent.status === 'running') return { retired: false, reason: 'running' }
  } catch {
    // A status we cannot read is treated as idle; the detach below is idempotent.
  }
  // A page holding the session would break when its Agent vanishes underneath it.
  try {
    const references = ctx.get('sessions')
    if (typeof references?.retainedBy === 'function' && (references.retainedBy(sessionId) ?? 0) > 0) {
      return { retired: false, reason: 'in-use' }
    }
  } catch {
    // Reference bookkeeping is advisory; an unreadable count is not a refusal.
  }
  if (options.dryRun === true) return { retired: false, reason: 'available' }
  let scope
  try {
    scope = agent.scope
  } catch {
    return { retired: false, reason: 'unavailable' }
  }
  const dispose = scope?.rawDispose ?? scope?.dispose
  if (typeof dispose === 'function') {
    try {
      await dispose.call(scope)
    } catch (error) {
      ctx.logger?.warn?.(`archived-sessions: retiring the agent of "${sessionId}" failed: ${String(error)}`)
    }
  }
  // Disposing the scope runs the loop teardown, which detaches both registries
  // only once the machine reaches idle. If that did not happen — a teardown
  // failure, or a provider that never idles — remove the exact entries here: a
  // purged session must not keep a row in either store. Entry identity is
  // checked so an unrelated agent or session that reused the id survives.
  let stillLive
  try {
    stillLive = agents.get(sessionId)
  } catch {
    stillLive = undefined
  }
  if (stillLive !== undefined) {
    const entries = rawField(agents, 'store')
    const entry = entries instanceof Map ? entries.get(sessionId) : undefined
    if (!(entries instanceof Map) || entry?.agent !== stillLive) return { retired: false, reason: 'unavailable' }
    entries.delete(sessionId)
    ctx.logger?.warn?.(`archived-sessions: force-removed the agent registry entry of "${sessionId}" after its scope did not detach`)
  }
  let sessions
  try {
    sessions = ctx.get('sessions')
  } catch {
    sessions = undefined
  }
  if (typeof sessions?.list === 'function') {
    const store = rawField(sessions, 'store')
    if (store instanceof Map && store.has(sessionId)) {
      const entry = store.get(sessionId)
      store.delete(sessionId)
      ctx.logger?.warn?.(`archived-sessions: dropped the session store entry of "${sessionId}" after its agent was retired`)
      // Keep the attachments index consistent with the store we just edited.
      const attachments = rawField(sessions, 'attachments')
      if (attachments instanceof Map && entry?.session !== undefined) attachments.delete(entry.session)
    }
  }
  return { retired: true }
}

/**
 * Permanently remove one session: every retained log generation plus its
 * archive flag and Workspace accounting. The directory is renamed to a
 * purge-owned tombstone before removal so a retry finishes an interrupted
 * delete.
 *
 * Occupancy is decided by what actually blocks the delete, not by "still
 * mounted": an archived session may stay loaded while idle, so the check only
 * reports `busy` when the backend holds the write claim or the file itself
 * cannot be removed.
 *
 * Subagent children are removed with it. A parent's children are separate
 * session directories, and the sidebar hides every `origin: 'subagent'` row, so
 * a child left behind by a parent's deletion is invisible to the UI and is never
 * collected by anything else. Children are purged after the parent, because the
 * parent is the row the user acted on: a child that cannot be removed is
 * reported, not turned into a failure of the whole request.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {string} sessionId - session identity to purge.
 * @returns {Promise<{ deleted: boolean, sessionId: string, pending: boolean, removedLog: boolean, removedCache: boolean, bytes: number, removedChildren?: string[], childrenFailed?: string[], reason?: 'busy' }>} outcome.
 */
export async function purgeSession(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) throw new RemoteError('archived-sessions/unavailable', 'the workspace registry is not mounted', {})

  // Permanent deletion is only ever reachable from the archive list. Guarding the
  // mount point keeps a stale page, a bookmarked request, or a retry from tearing
  // down a session the user is still using.
  //
  // The guard covers the session the user acted on, never its children: a
  // subagent session is not archivable in the first place — the sidebar hides it
  // — so requiring it to be archived would make every parent purge fail.
  if (!(registry.archivedSessionIds ?? []).includes(sessionId)) {
    throw new RemoteError('archived-sessions/not-archived', `cannot purge "${sessionId}": it is not archived`, { sessionId })
  }

  // Collect before deleting: the walk reads each child's header off disk, and a
  // header that is gone cannot be read. Collecting first means a discovery
  // failure leaves nothing half-deleted.
  const lineage = await collectSessionLineage(ctx, sessionId)
  const childIds = lineage.slice(1)

  const outcome = await purgeOneSession(ctx, registry, sessionId)
  // A busy parent deleted nothing, so its children must be left alone too:
  // removing them would strip a session the user still has open.
  if (outcome.deleted !== true) return outcome

  const removedChildren = []
  const childrenFailed = []
  for (const childId of childIds) {
    try {
      const child = await purgeOneSession(ctx, registry, childId)
      if (child.deleted === true) removedChildren.push(childId)
      else childrenFailed.push(childId)
    } catch (error) {
      // One unremovable child must not undo the parent's deletion.
      ctx.logger?.warn?.(`archived-sessions: purging child "${childId}" of "${sessionId}" failed: ${String(error)}`)
      childrenFailed.push(childId)
    }
  }
  return {
    ...outcome,
    ...removedChildren.length === 0 ? {} : { removedChildren },
    ...childrenFailed.length === 0 ? {} : { childrenFailed },
  }
}

/**
 * Remove exactly one session's artifacts and bookkeeping. No archive guard: the
 * caller decides which ids are eligible, so this stays usable for a subagent
 * child that can never be archived.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {object} registry - the mounted workspace registry.
 * @param {string} sessionId - session identity to purge.
 * @returns {Promise<{ deleted: boolean, sessionId: string, pending: boolean, removedLog: boolean, removedCache: boolean, bytes: number, reason?: 'busy' }>} outcome.
 */
async function purgeOneSession(ctx, registry, sessionId) {
  const pending = isPendingCreation(ctx, sessionId)
  // Refuse before deleting anything: a running session or one an open page is
  // holding must not lose its log out from under it.
  const occupancy = await retireAgent(ctx, sessionId, { dryRun: true })
  if (occupancy.reason === 'running' || occupancy.reason === 'in-use') {
    return { deleted: false, sessionId, pending, removedLog: false, bytes: 0, reason: 'busy', busyBecause: occupancy.reason }
  }
  const located = await locateSessionDirectory(ctx, sessionId)
  // A session this Host created but never materialized has no log yet: its
  // durable identity is dropped from the registry only, and the Client removes
  // the row after the Agent is disposed.
  let target = located?.directory
  if (located !== undefined && !located.leftover) {
    const tombstone = `${located.directory}${PURGE_SUFFIX}`
    try {
      await rm(tombstone, { recursive: true, force: true })
      await rename(located.directory, tombstone)
      target = tombstone
    } catch (error) {
      ctx.logger?.warn?.(`archived-sessions: could not move "${sessionId}" aside: ${String(error)}`)
    }
  }
  if (target !== undefined) {
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch (error) {
      const code = error?.code ?? ''
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        // The file is held open by a live writer; deleting now would truncate
        // its history, so nothing is committed and the row stays retryable.
        if (target.endsWith(PURGE_SUFFIX)) {
          await rename(target, target.slice(0, -PURGE_SUFFIX.length)).catch(() => undefined)
        }
        return { deleted: false, sessionId, pending, removedLog: false, bytes: 0, reason: 'busy' }
      }
      throw new RemoteError('archived-sessions/purge-failed', `could not remove the session log: ${String(error)}`, {})
    }
  }

  if ((registry.archivedSessionIds ?? []).includes(sessionId)) {
    try {
      await registry.unarchiveSession(sessionId)
    } catch (error) {
      ctx.logger?.warn?.(`archived-sessions: clearing the archive flag for "${sessionId}" failed: ${String(error)}`)
    }
  }
  for (const workspace of registry.list()) {
    if (!workspace.sessionIds.includes(sessionId)) continue
    try {
      await workspace.detachSession(sessionId)
    } catch (error) {
      ctx.logger?.warn?.(`archived-sessions: detaching "${sessionId}" from "${workspace.id}" failed: ${String(error)}`)
    }
  }
  // The log is gone, so the derived cache entry describes nothing; leaving it
  // behind would keep a dead id in the projection store for no benefit.
  const removedCache = await dropSessionCache(ctx, sessionId)
  // A created-but-unmaterialized session is merged into the Session list from
  // process memory, so its pending entry must go too — otherwise the Host keeps
  // reporting a row that has neither a log nor a Workspace slot, which surfaces
  // in the sidebar as "未分组".
  const removedPending = dropPendingCreation(ctx, sessionId)
  // Last, and only now that nothing on disk backs it: unload the live Agent.
  // Until this runs, `session/list` keeps projecting a row from `ctx.sessions`
  // even though the log, the accounting, and the cache are all gone.
  const retirement = await retireAgent(ctx, sessionId)
  return {
    deleted: true,
    sessionId,
    pending,
    removedLog: located !== undefined,
    removedCache,
    removedPending,
    retiredAgent: retirement.retired,
    ...retirement.retired || retirement.reason === undefined ? {} : { retirementReason: retirement.reason },
    bytes: located?.bytes ?? 0,
  }
}

/**
 * Read one pending Remote (unused at runtime; kept for controller parity with
 * shipped controllers that expose `service.typertRemote`).
 */
export class ArchivedSessionsController extends TypertRemoteService {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - owning Host Context.
   */
  constructor(ctx) {
    super(ctx, 'archivedSessionsController', { namespace: 'archivedSessions' })
  }
}

/**
 * Whether a session id is backed by something this Host can still open: a stored
 * log generation, a live Session, or a live Agent. A created-but-unmaterialized
 * pending entry deliberately does NOT count here — it is the very thing the sweep
 * is looking for, and it is only kept while the Client still holds it.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {string} sessionId - session identity.
 * @returns {Promise<boolean>} whether the identity is still backed by data.
 */
async function sessionSurvives(ctx, sessionId) {
  if (ctx.get('sessions')?.get(sessionId) !== undefined) return true
  if (ctx.get('agents')?.get(sessionId) !== undefined) return true
  return (await locateSessionDirectory(ctx, sessionId)) !== undefined
}

/**
 * Whether the Client still holds an open handle for this id. An unmaterialized
 * creation whose Session is open on a page must not be forgotten, or the page's
 * next event would target a registry entry that no longer exists.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {string} sessionId - session identity.
 * @returns {boolean} whether a client reference is reported.
 */
function isHeldByClient(ctx, sessionId) {
  let references
  try {
    references = ctx.get('sessionReference')
  } catch {
    return false
  }
  if (references === undefined || references === null || typeof references !== 'object') return false
  let values
  try {
    values = Object.values(references)
  } catch {
    return false
  }
  for (const value of values) {
    if (value === null || typeof value !== 'object') continue
    try {
      if (typeof value.holdersOf === 'function' && (value.holdersOf(sessionId)?.length ?? 0) > 0) return true
    } catch {
      // A guarded field on an unexpected receiver: keep probing.
    }
  }
  return false
}

/**
 * Drop every durable trace of session ids whose log no longer exists: the
 * archive flag, the Workspace accounting, the derived projection cache, and any
 * created-but-unmaterialized pending entry. This is what makes a purged session
 * disappear from the sidebar instead of moving to "未分组" — the registry's header
 * index outlives the file, a Workspace that still counts an unknown id renders it
 * as a stray row, and the Session list merges pending entries straight from
 * process memory.
 *
 * Only durable bookkeeping and in-memory registry rows are touched; no file is
 * deleted, and a session this Host can still reach (live, held by a Client, or on
 * disk) is never dropped.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Iterable<string>} candidates - ids to test.
 * @returns {Promise<{ dropped: string[], kept: string[] }>} what changed.
 */
export async function dropMissingSessions(ctx, candidates) {
  const registry = ctx.get('workspaceRegistry')
  const dropped = []
  const kept = []
  const unique = [...new Set(candidates)].filter((id) => typeof id === 'string' && id !== '')
  if (registry === undefined) return { dropped, kept: unique }
  for (const sessionId of unique) {
    if (await sessionSurvives(ctx, sessionId)) {
      kept.push(sessionId)
      continue
    }
    // An unmaterialized creation that a page still holds is real to that page;
    // forgetting it here would break its next event. It stays until the Client
    // drops it, and the next sweep collects it.
    if (isPendingCreation(ctx, sessionId) && isHeldByClient(ctx, sessionId)) {
      kept.push(sessionId)
      continue
    }
    let changed = false
    if ((registry.archivedSessionIds ?? []).includes(sessionId)) {
      try {
        await registry.unarchiveSession(sessionId)
        changed = true
      } catch (error) {
        ctx.logger?.warn?.(`archived-sessions: unarchiving "${sessionId}" failed: ${String(error)}`)
        kept.push(sessionId)
        continue
      }
    }
    for (const workspace of registry.list()) {
      if (!workspace.sessionIds.includes(sessionId)) continue
      try {
        await workspace.detachSession(sessionId)
        changed = true
      } catch (error) {
        ctx.logger?.warn?.(`archived-sessions: detaching "${sessionId}" from "${workspace.id}" failed: ${String(error)}`)
      }
    }
    // A dead id may also still own a derived cache entry from an earlier
    // delete; clearing it here finishes the sweep instead of leaving garbage.
    const removedCache = await dropSessionCache(ctx, sessionId)
    // The pending entry is the one trace no file or registry table holds, so a
    // sweep that skipped it would keep reporting the row forever.
    const removedPending = dropPendingCreation(ctx, sessionId)
    if (changed || removedCache || removedPending) dropped.push(sessionId)
    else kept.push(sessionId)
  }
  return { dropped, kept }
}

/**
 * Sweep archived ids whose log no longer exists on disk, so the sidebar stops
 * offering a row that can only answer `session/not-found`.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @returns {Promise<{ pruned: string[], kept: string[] }>} what changed.
 */
export async function pruneMissingArchived(ctx) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return { pruned: [], kept: [] }
  const { dropped, kept } = await dropMissingSessions(ctx, registry.archivedSessionIds ?? [])
  return { pruned: dropped, kept }
}

/**
 * Forget unmaterialized creations that nothing backs any more: no stored log, no
 * Workspace slot, no archive flag, and no live Agent. The Session list merges
 * these entries straight from process memory, so they keep appearing as rows the
 * Host cannot open — the shape that shows up under "未分组" — long after the files
 * and the accounting are gone.
 *
 * A creation still held by a live Session or Agent, or still counted by a
 * Workspace (it was just created and simply has no log yet), is left alone.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @returns {Promise<{ swept: string[], kept: string[] }>} what changed.
 */
export async function prunePendingCreations(ctx) {
  const registry = ctx.get('workspaceRegistry')
  const swept = []
  const kept = []
  const pendingIds = listPendingCreations(ctx)
  // Reported back whenever the tracker could not be reached, so an unknown
  // backend shape is visible instead of looking like "nothing to clean".
  const trackerReachable = pendingIds.length > 0 || trackerOf(ctx) !== undefined
  for (const sessionId of pendingIds) {
    if (ctx.get('sessions')?.get(sessionId) !== undefined) {
      kept.push(sessionId)
      continue
    }
    if (ctx.get('agents')?.get(sessionId) !== undefined) {
      kept.push(sessionId)
      continue
    }
    if ((await locateSessionDirectory(ctx, sessionId)) !== undefined) {
      kept.push(sessionId)
      continue
    }
    const archived = (registry?.archivedSessionIds ?? []).includes(sessionId)
    const accounted = (registry?.list() ?? []).some((workspace) => workspace.sessionIds.includes(sessionId))
    if (archived || accounted) {
      kept.push(sessionId)
      continue
    }
    if (dropPendingCreation(ctx, sessionId)) swept.push(sessionId)
    else kept.push(sessionId)
  }
  return { swept, kept, trackerReachable }
}

export const name = 'archived-sessions'
export const inject = ['sessionPersistence', 'workspaceRegistry', 'connection']

/**
 * Register the authenticated purge route on the shared Host fetch carrier.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @returns {void}
 */
export function apply(ctx) {
  ctx.connection.fetch.register({
    path: PURGE_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'GET') {
        return json(200, { route: PURGE_PATH, alive: true })
      }
      let body
      try {
        body = await request.json()
      } catch {
        return json(400, { error: 'invalid JSON body' })
      }
      try {
        if (body?.action === 'prune') return json(200, await pruneMissingArchived(ctx))
        if (body?.action === 'prunePending') return json(200, await prunePendingCreations(ctx))
        if (body?.action === 'sweep') {
          const ids = Array.isArray(body.sessionIds) ? body.sessionIds.filter((id) => typeof id === 'string') : []
          return json(200, await dropMissingSessions(ctx, ids))
        }
      } catch (error) {
        return json(500, { error: error instanceof Error ? error.message : String(error) })
      }
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      if (sessionId === '') return json(400, { error: 'sessionId is required' })
      try {
        const outcome = await purgeSession(ctx, sessionId)
        return json(200, outcome)
      } catch (error) {
        const code = error instanceof RemoteError ? error.code : 'archived-sessions/purge-failed'
        return json(500, { error: error instanceof Error ? error.message : String(error), code })
      }
    },
  })
}

/**
 * Build one JSON HTTP response.
 * @param {number} status - HTTP status.
 * @param {unknown} value - JSON body.
 * @returns {Response} the response.
 */
function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
