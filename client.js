/**
 * Archived Sessions — Client half.
 *
 * One Settings page listing archived sessions grouped by Workspace, with
 * unarchive and permanent delete. Data comes from the shipped Client
 * controllers (`ctx.workspaces` and the Session list snapshot); the log purge
 * is performed by the Host half over this package's loopback Remote.
 *
 * This module runs as a plain `window.__ModuleLoader__.load` factory where only
 * `require('react')` is available, so every runtime face arrives through `ctx`
 * and the slot props, and the stylesheet is inserted here.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-archived-sessions',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useCallback, useRef } = React

    const NS = 'archivedSessions'
    const STYLE_ID = 'dsh-archived-sessions-styles'

    const zh = {
      nav: '归档会话',
      intro: '取消归档让会话回到侧边栏；彻底删除会永久移除记录。',
      sessions: '{count} 个会话',
      workspaces: '{count} 个工作区',
      unarchive: '取消归档',
      unarchiveAll: '全部取消归档',
      purge: '彻底删除',
      purgeAll: '清空全部',
      empty: '暂无归档会话',
      noTitle: '未命名会话',
      orphaned: '未归属工作区',
      missing: '记录已不存在',
      updated: '更新 {time}',
      created: '创建 {time}',
      confirmTitle: '彻底删除会话',
      confirmDesc: '将永久删除「{name}」的会话记录与日志，无法恢复。',
      confirmAllTitle: '清空全部归档会话',
      confirmDescAll: '将永久删除 {count} 个归档会话的记录与日志，无法恢复。',
      cancel: '取消',
      confirmDelete: '永久删除',
      working: '处理中…',
      failed: '操作失败：{reason}',
      unknown: '未知错误',
      partial: '完成 {ok} 个，{failed} 个失败',
      done: '完成 {ok} 个',
      busy: '该会话仍被占用，稍后再试',
      busySkipped: '{count} 个会话仍被占用，已跳过',
      pruned: '已清理 {count} 条失效的归档记录',
      stale: '已移除 {count} 条残留的会话条目',
      purgedChildren: '同时删除了 {count} 个子智能体会话',
      childrenBusy: '{count} 个子智能体会话仍被占用，未能删除',
    }

    const en = {
      nav: 'Archived sessions',
      intro: 'Unarchive returns a session to the sidebar; permanent delete removes it for good.',
      sessions: '{count} sessions',
      workspaces: '{count} workspaces',
      unarchive: 'Unarchive',
      unarchiveAll: 'Unarchive all',
      purge: 'Delete',
      purgeAll: 'Delete all',
      empty: 'No archived sessions',
      noTitle: 'Untitled session',
      orphaned: 'Without a workspace',
      missing: 'Record is gone',
      updated: 'Updated {time}',
      created: 'Created {time}',
      confirmTitle: 'Delete session permanently',
      confirmDesc: 'Permanently deletes the saved record and log of “{name}”. This cannot be undone.',
      confirmAllTitle: 'Delete every archived session',
      confirmDescAll: 'Permanently deletes the records and logs of {count} archived sessions. This cannot be undone.',
      cancel: 'Cancel',
      confirmDelete: 'Delete permanently',
      working: 'Working…',
      failed: 'Failed: {reason}',
      unknown: 'Unknown error',
      partial: '{ok} finished, {failed} failed',
      done: '{ok} finished',
      busy: 'This session is still in use; try again later',
      busySkipped: '{count} sessions were in use and were skipped',
      pruned: 'Removed {count} archived entries whose log was already gone',
      stale: 'Removed {count} leftover session entries',
      purgedChildren: 'Also deleted {count} subagent session(s)',
      childrenBusy: '{count} subagent session(s) were in use and were kept',
    }

    const CSS = [
      '.dsh-arch-root{display:flex;flex-direction:column;gap:16px;padding:8px 0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:22px}',
      '.dsh-arch-hint{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dsh-arch-hint svg{flex:none;opacity:.8}',
      '.dsh-arch-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.dsh-arch-stats{display:flex;align-items:center;gap:14px;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsh-arch-stat{display:inline-flex;align-items:center;gap:5px}',
      '.dsh-arch-tools{display:flex;align-items:center;gap:8px}',
      '.dsh-arch-tools svg{width:14px;height:14px}',
      '.dsh-arch-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}',
      '.dsh-arch-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-arch-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.dsh-arch-btn:disabled{opacity:.5;cursor:default}',
      '.dsh-arch-btn[data-variant="danger"]{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,transparent)}',
      '.dsh-arch-btn[data-variant="danger"]:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent)}',
      '.dsh-arch-groups{display:flex;flex-direction:column;gap:14px}',
      '.dsh-arch-group{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.dsh-arch-group-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.dsh-arch-group-icon{flex:none;display:flex;color:var(--dsw-alias-label-secondary)}',
      '.dsh-arch-group-name{font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-arch-group-meta{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-arch-badge{flex:none;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:19px;text-align:center}',
      '.dsh-arch-row{display:flex;align-items:center;gap:12px;padding:10px 16px;border-top:.5px solid var(--dsw-alias-border-l1)}',
      '.dsh-arch-row:first-of-type{border-top:none}',
      '.dsh-arch-row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-arch-row-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.dsh-arch-title{display:flex;align-items:center;gap:6px;font-size:13px;overflow:hidden}',
      '.dsh-arch-title-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-arch-title[data-missing="true"] .dsh-arch-title-text{color:var(--dsw-alias-label-secondary);font-style:italic}',
      '.dsh-arch-time{flex:none;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12px}',
      '.dsh-arch-id{color:var(--dsw-alias-label-secondary);font-size:12px;font-family:var(--ds-font-family-code,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.75}',
      '.dsh-arch-row-actions{flex:none;display:flex;align-items:center;gap:8px}',
      '.dsh-arch-icon-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dsh-arch-icon-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsh-arch-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.dsh-arch-icon-btn:disabled{opacity:.45;cursor:default}',
      '.dsh-arch-icon-btn[data-variant="danger"]{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 38%,transparent)}',
      '.dsh-arch-icon-btn[data-variant="danger"]:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.dsh-arch-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:36px 16px;color:var(--dsw-alias-label-secondary);border:.5px dashed var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xl)}',
      '.dsh-arch-status{display:flex;align-items:center;gap:6px;font-size:12px}',
      '.dsh-arch-status[data-kind="error"]{color:var(--dsw-alias-state-error-primary)}',
      '.dsh-arch-status[data-kind="notice"]{color:var(--dsw-alias-label-secondary)}',
      '.dsh-arch-mask{position:fixed;inset:0;z-index:1100;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent)}',
      '.dsh-arch-dialog{box-sizing:border-box;width:min(420px,calc(100vw - 48px));border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);padding:20px;display:flex;flex-direction:column;gap:12px}',
      '.dsh-arch-dialog-head{display:flex;align-items:center;gap:8px}',
      '.dsh-arch-dialog-head svg{color:var(--dsw-alias-state-error-primary)}',
      '.dsh-arch-dialog-title{font-size:15px;font-weight:500}',
      '.dsh-arch-dialog-desc{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-arch-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}',
    ].join('\n')

    /* ---- icons: 16px stroke glyphs inheriting currentColor ---- */

    /**
     * Build one outlined icon element.
     * @param {Array<ReactElement>} children - path elements.
     * @param {number} size - pixel size.
     * @returns {ReactElement} the svg.
     */
    function icon(children, size) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false',
      }, children)
    }

    const ArchiveIcon = () => icon([
      h('rect', { key: 'a', x: 2, y: 2.5, width: 12, height: 3, rx: 1 }),
      h('path', { key: 'b', d: 'M3.2 5.5v6.6a1.4 1.4 0 0 0 1.4 1.4h6.8a1.4 1.4 0 0 0 1.4-1.4V5.5' }),
      h('path', { key: 'c', d: 'M6.3 8.6h3.4' }),
    ], 16)

    const UnarchiveIcon = (props) => h('svg', {
      width: props?.size ?? 14, height: props?.size ?? 14, viewBox: '0 0 1024 1024',
      fill: 'currentColor', 'aria-hidden': 'true', focusable: 'false',
    }, [
      h('path', {
        key: 'arrow',
        d: 'M904 767.04v-0.32c0-3.84-1.28-7.552-3.52-10.688l-0.128-0.192a22.72 22.72 0 0 0-2.688-3.392l-0.32-0.32-135.296-135.488a22.656 22.656 0 0 0-32.128 0l-0.256 0.256a22.72 22.72 0 0 0 0.256 31.872l99.2 99.328H522.944a18.944 18.944 0 0 0-18.944 18.944v2.624a18.944 18.944 0 0 0 18.944 18.688h306.176l-99.2 99.264a22.72 22.72 0 0 0 32.128 32.128l135.296-135.488 0.32-0.32a23.232 23.232 0 0 0 2.496-3.072l0.192-0.32v0.064a18.88 18.88 0 0 0 3.648-11.264v-2.304z',
      }),
      h('path', {
        key: 'box',
        d: 'M576 841.152H265.152c-16.448 0-27.456-11.008-27.456-27.456V347.52h548.608V576h54.848V341.952a82.56 82.56 0 0 0 54.848-76.8v-54.848C896 166.4 857.6 128 813.696 128H210.304C166.4 128 128 166.4 128 210.304v54.848c0 38.4 21.952 65.792 54.848 76.8v471.744c0 43.904 38.4 82.304 82.304 82.304H576v-54.848z m237.696-548.608H210.304c-16.448 0-27.456-10.944-27.456-27.392v-54.848c0-16.448 11.008-27.456 27.456-27.456h603.392c16.448 0 27.456 11.008 27.456 27.456v54.848c0 16.448-11.008 27.392-27.456 27.392z',
      }),
      h('path', {
        key: 'line',
        d: 'M649.152 566.848H374.848c-16.448 0-27.392-10.944-27.392-27.392 0-16.512 10.944-27.456 27.392-27.456h274.304c16.448 0 27.392 10.944 27.392 27.456 0 16.448-10.944 27.392-27.392 27.392z',
      }),
    ])

    const TrashIcon = () => icon([
      h('path', { key: 'a', d: 'M2.8 4.4h10.4' }),
      h('path', { key: 'b', d: 'M6.4 4.4V3a.8.8 0 0 1 .8-.8h1.6a.8.8 0 0 1 .8.8v1.4' }),
      h('path', { key: 'c', d: 'M4.2 4.4l.6 8.2a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.2' }),
      h('path', { key: 'd', d: 'M6.8 7v4M9.2 7v4' }),
    ], 14)

    const FolderIcon = () => icon([
      h('path', { key: 'a', d: 'M2 5.2A1.2 1.2 0 0 1 3.2 4h2.6l1.3 1.5h5.7A1.2 1.2 0 0 1 14 6.7v5.1A1.2 1.2 0 0 1 12.8 13H3.2A1.2 1.2 0 0 1 2 11.8z' }),
    ], 16)

    const SessionIcon = () => icon([
      h('path', { key: 'a', d: 'M13.5 9.2a2 2 0 0 1-2 2H6.4L3 13.2V4.1a2 2 0 0 1 2-2h6.5a2 2 0 0 1 2 2z' }),
    ], 16)

    const InfoIcon = () => icon([
      h('circle', { key: 'a', cx: 8, cy: 8, r: 5.8 }),
      h('path', { key: 'b', d: 'M8 7.4v4M8 4.9v.1' }),
    ], 14)

    const AlertIcon = () => icon([
      h('path', { key: 'a', d: 'M8 2.6 14 13H2z' }),
      h('path', { key: 'b', d: 'M8 6.6v3M8 11.2v.1' }),
    ], 16)

    const CheckIcon = () => icon([h('path', { key: 'a', d: 'M3 8.4 6.3 11.7 13 5' })], 14)

    /**
     * Insert this plugin's stylesheet once; safe to call on every activation.
     * @returns {void}
     */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.dataset.plugin = '@local/dsh-archived-sessions'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /**
     * Remove this plugin's stylesheet; runs when the Client half unloads.
     * @returns {void}
     */
    function removeStyles() {
      if (typeof document === 'undefined') return
      document.getElementById(STYLE_ID)?.remove()
    }

    /**
     * Re-render a component whenever the active locale or dictionaries change.
     * @param {object | undefined} locale - the Client locale service.
     * @returns {void}
     */
    function useLocaleRevision(locale) {
      const [, setRevision] = useState(0)
      useEffect(() => {
        if (locale === undefined || typeof locale.subscribe !== 'function') return undefined
        return locale.subscribe(() => setRevision((value) => value + 1))
      }, [locale])
    }

    /**
     * Format one epoch-millisecond timestamp as a short local date-time.
     * @param {number | undefined} time - epoch milliseconds.
     * @returns {string} the formatted time, or an empty string.
     */
    function formatTime(time) {
      if (typeof time !== 'number' || !Number.isFinite(time) || time <= 0) return ''
      const date = new Date(time)
      try {
        return date.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      } catch {
        return date.toISOString()
      }
    }

    /**
     * Format a Workspace creation timestamp (ISO string).
     * @param {string | undefined} iso - ISO timestamp.
     * @returns {string} the formatted time, or an empty string.
     */
    function formatDate(iso) {
      const time = typeof iso === 'string' ? Date.parse(iso) : Number.NaN
      return Number.isNaN(time) ? '' : formatTime(time)
    }

    /* ---- delete helpers ---- */

    /**
     * Group archived sessions by Workspace, keeping Workspace order and the
     * Session order recorded inside each Workspace.
     * @param {object} input - Workspace snapshot and Session list snapshot.
     * @returns {{ sessions: number, workspaces: number, groups: Array<object> }} the model.
     */
    function deriveModel(input) {
      const summaries = input.sessionList?.byId ?? {}
      const archived = new Set(Array.isArray(input.archivedIds) ? input.archivedIds : [])
      const seen = new Set()
      const groups = []
      const rowOf = (sessionId) => {
        const summary = summaries[sessionId]
        return {
          sessionId,
          title: typeof summary?.displayTitle === 'string' ? summary.displayTitle : '',
          updatedAt: summary?.updatedAt ?? 0,
          cwd: summary?.cwd,
          missing: summary === undefined,
        }
      }
      for (const workspace of input.workspaces ?? []) {
        const rows = []
        for (const sessionId of workspace.sessionIds ?? []) {
          seen.add(sessionId)
          if (archived.has(sessionId)) {
            const row = rowOf(sessionId)
            rows.push({ ...row, cwd: row.cwd ?? workspace.path })
          }
        }
        if (rows.length === 0) continue
        groups.push({
          key: workspace.workspaceId,
          title: workspace.title ?? '',
          path: workspace.path ?? '',
          createdAt: workspace.createdAt,
          orphaned: false,
          rows,
        })
      }
      // Archived ids no live Workspace accounts for: a deleted Workspace or a
      // hand-edited registry. They still need both actions.
      const loose = []
      for (const sessionId of archived) {
        if (seen.has(sessionId)) continue
        seen.add(sessionId)
        loose.push(rowOf(sessionId))
      }
      if (loose.length > 0) {
        groups.push({ key: '__orphaned__', title: '', path: '', createdAt: undefined, orphaned: true, rows: loose })
      }
      return {
        sessions: groups.reduce((total, group) => total + group.rows.length, 0),
        workspaces: groups.length,
        groups,
      }
    }

    /**
     * A text button; `variant="danger"` marks the destructive treatment.
     * @param {object} props - button props plus `variant`.
     * @returns {ReactElement} the button.
     */
    function Btn(props) {
      const { variant, children, ...rest } = props
      return h('button', { type: 'button', className: 'dsh-arch-btn', 'data-variant': variant, ...rest }, children)
    }

    /**
     * A square icon-only button; the label is its accessible name and tooltip.
     * @param {object} props - button props plus `variant`, `label`, `children`.
     * @returns {ReactElement} the button.
     */
    function IconBtn(props) {
      const { variant, label, children, ...rest } = props
      return h('button', {
        type: 'button',
        className: 'dsh-arch-icon-btn',
        'data-variant': variant,
        title: label,
        'aria-label': label,
        ...rest,
      }, children)
    }

    /**
     * One destructive-action confirmation above the settings panel.
     * @param {object} props - copy, pending state, and callbacks.
     * @returns {ReactElement} the dialog.
     */
    function ConfirmDialog(props) {
      const { title, description, cancelLabel, confirmLabel, workingLabel, pending, onCancel, onConfirm } = props
      const confirm = useRef(null)
      useEffect(() => {
        confirm.current?.focus()
      }, [])
      useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          if (!pending) onCancel()
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [pending, onCancel])
      return h('div', {
        className: 'dsh-arch-mask',
        role: 'presentation',
        onClick: (event) => {
          if (event.target === event.currentTarget && !pending) onCancel()
        },
      }, h('div', {
        className: 'dsh-arch-dialog',
        role: 'alertdialog',
        'aria-modal': 'true',
        'aria-label': title,
      }, [
        h('div', { className: 'dsh-arch-dialog-head', key: 'head' }, [h(AlertIcon, { key: 'i' }), h('span', { className: 'dsh-arch-dialog-title', key: 't' }, title)]),
        h('div', { className: 'dsh-arch-dialog-desc', key: 'desc' }, description),
        h('div', { className: 'dsh-arch-dialog-actions', key: 'actions' }, [
          h(Btn, { key: 'cancel', ref: confirm, disabled: pending, onClick: onCancel }, cancelLabel),
          h(Btn, { key: 'ok', variant: 'danger', disabled: pending, onClick: onConfirm }, pending ? workingLabel : confirmLabel),
        ]),
      ]))
    }

    /**
     * The Archived Sessions settings section.
     * @param {object} props - composed slot props, owner props, and injected operations.
     * @returns {ReactElement} the section.
     */
    function ArchivedSessionsSection(props) {
      const { t, useWorkspaces, useSessions, locale, services } = props
      useLocaleRevision(locale)
      const workspaceSnapshot = useWorkspaces((state) => state)
      const sessionList = useSessions((state) => state)
      const [pendingId, setPendingId] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [confirm, setConfirm] = useState(null)

      // Purging a session has to erase its row everywhere, not just in this
      // Settings page. Two leftovers make the sidebar disagree: the
      // `api-session/removed` control frame arrives in a later microtask, so
      // the list can be rebuilt before the removal lands, and a Workspace that
      // still counts a deleted id renders it under "未分组". Both are cleaned
      // here — the local row by asking the controller to drop an unknown id
      // outright, the durable one through the Host sweep.
      const forgetLocally = useCallback((sessionId) => {
        if (typeof services?.forget !== 'function') return
        try {
          services.forget(sessionId)
        } catch (reason) {
          console.warn('archived-sessions: dropping a purged session row failed:', reason)
        }
      }, [services])

      // Archived ids whose log was removed out of band can never open again, so
      // the page sweeps them once per mount instead of offering dead rows. The
      // same pass forgets unmaterialized creations nothing backs any more — the
      // Session list merges those straight from Host memory, so they outlive both
      // the log and the Workspace slot and surface as "未分组" rows. The baseline
      // pull afterwards makes every other surface agree with what the Host
      // actually holds.
      const prunedRef = useRef(false)
      useEffect(() => {
        if (prunedRef.current) return
        prunedRef.current = true
        if (typeof services?.prune !== 'function') return
        services.prune().then(async (result) => {
          const count = Array.isArray(result?.pruned) ? result.pruned.length : 0
          if (count === 0) return
          setNotice(t('pruned', { count }))
          await services.refresh?.().catch?.(() => undefined)
        }, () => undefined)
      }, [services, t])

      const pendingPrunedRef = useRef(false)
      useEffect(() => {
        if (pendingPrunedRef.current) return
        pendingPrunedRef.current = true
        if (typeof services?.prunePending !== 'function') return
        services.prunePending().then(async (result) => {
          const count = Array.isArray(result?.swept) ? result.swept.length : 0
          if (count === 0) return
          for (const sessionId of result.swept) forgetLocally(sessionId)
          setNotice(t('stale', { count }))
          await services.refresh?.().catch?.(() => undefined)
        }, () => undefined)
      }, [services, forgetLocally, t])

      // The same test for every row the sidebar shows: an id the Host can no
      // longer resolve is stale accounting, not a session. Rows still counted by
      // a Workspace are tested even without a projection cache — that is exactly
      // the shape a just-deleted row takes (cached-looking, but its log is gone
      // and the Workspace's own `sessionIds` getter hides it, so it lands in
      // "未分组"). A row the Host still reports as live is never re-tested.
      const sweptRef = useRef(new Set())
      useEffect(() => {
        if (typeof services?.sweep !== 'function') return
        if (sessionList?.phase !== 'ready' || sessionList?.error != null) return
        const archived = new Set(Array.isArray(workspaceSnapshot?.archivedSessionIds) ? workspaceSnapshot.archivedSessionIds : [])
        const suspected = []
        for (const item of sessionList?.items ?? []) {
          const itemId = item?.sessionId
          if (typeof itemId !== 'string' || itemId === '') continue
          if (archived.has(itemId)) continue
          if (sweptRef.current.has(itemId)) continue
          if (item.agentAvailable === true || item.formatStatus === 'current') {
            sweptRef.current.add(itemId)
            continue
          }
          suspected.push(itemId)
        }
        if (suspected.length === 0) return
        for (const itemId of suspected) sweptRef.current.add(itemId)
        services.sweep(suspected).then(async (result) => {
          const dropped = Array.isArray(result?.dropped) ? result.dropped : []
          if (dropped.length === 0) return
          for (const itemId of dropped) forgetLocally(itemId)
          setNotice(t('stale', { count: dropped.length }))
          // A baseline pull that started before the Host forgot these ids can
          // re-add them, so settle the list on the Host's own answer.
          await services.refresh?.()
        }, () => undefined)
      }, [services, sessionList, workspaceSnapshot, forgetLocally, t])

      const model = useMemo(() => deriveModel({
        workspaces: workspaceSnapshot?.items,
        sessionList,
        archivedIds: workspaceSnapshot?.archivedSessionIds,
      }), [workspaceSnapshot, sessionList])

      const reasonOf = useCallback((reason) => {
        if (reason === null || reason === undefined) return t('unknown')
        const rpc = reason.rpcError ?? reason
        if (typeof rpc?.message === 'string' && rpc.message !== '') return rpc.message
        if (typeof reason?.message === 'string' && reason.message !== '') return reason.message
        return String(reason)
      }, [t])

      /**
       * Run one operation with shared busy, error, and notice handling.
       * @param {string} id - row identity while it runs.
       * @param {() => Promise<unknown>} operation - the work.
       * @returns {Promise<boolean>} whether it succeeded.
       */
      const run = useCallback(async (id, operation) => {
        setBusy(true)
        setPendingId(id)
        setError(null)
        setNotice(null)
        try {
          await operation()
          return true
        } catch (reason) {
          setError(t('failed', { reason: reasonOf(reason) }))
          return false
        } finally {
          setBusy(false)
          setPendingId(null)
        }
      }, [reasonOf, t])

      /**
       * Sequential batch: every row settles, and partial failures are summed up
       * once instead of aborting the sweep. A still-in-use row is reported as a
       * skip, not a failure, so one busy session does not fail the whole run.
       * @param {string[]} sessionIds - rows to process.
       * @param {(sessionId: string) => Promise<unknown>} operation - one row's work.
       * @returns {Promise<void>} after every row settled.
       */
      const runAll = useCallback(async (sessionIds, operation) => {
        if (sessionIds.length === 0) return
        setBusy(true)
        setPendingId('*')
        setError(null)
        setNotice(null)
        let ok = 0
        let failed = 0
        let skipped = 0
        let firstReason = null
        for (const sessionId of sessionIds) {
          try {
            await operation(sessionId)
            ok += 1
          } catch (reason) {
            if (reason?.busy === true) {
              skipped += 1
              continue
            }
            failed += 1
            if (firstReason === null) firstReason = reason
          }
        }
        setBusy(false)
        setPendingId(null)
        const parts = [t('done', { ok })]
        if (skipped > 0) parts.push(t('busySkipped', { count: skipped }))
        setNotice(parts.join(' · '))
        if (failed > 0) setError(t('failed', { reason: reasonOf(firstReason) }))
      }, [reasonOf, t])

      const allRows = useMemo(() => model.groups.flatMap((group) => group.rows), [model])
      const allPurgeRequests = useMemo(() => allRows.map((row) => ({ sessionId: row.sessionId, cwd: row.cwd })), [allRows])

      const requestPurge = useCallback((row) => {
        setConfirm({
          title: t('confirmTitle'),
          description: t('confirmDesc', { name: row.title || row.sessionId }),
          purgeRequests: [{ sessionId: row.sessionId, cwd: row.cwd }],
        })
      }, [t])

      const requestPurgeAll = useCallback(() => {
        setConfirm({
          title: t('confirmAllTitle'),
          description: t('confirmDescAll', { count: allPurgeRequests.length }),
          purgeRequests: allPurgeRequests,
        })
      }, [allPurgeRequests, t])

      const settleConfirm = useCallback(async () => {
        const current = confirm
        if (current === null) return
        // Subagent sessions are removed with their parent, so the per-row notice
        // has to say so: a child is never listed in the archive view, and a user
        // who does not know they existed would read the count as wrong.
        let childCount = 0
        let failedChildren = 0
        const settle = async (request) => {
          const outcome = await services.purge(request)
          childCount += Array.isArray(outcome?.removedChildren) ? outcome.removedChildren.length : 0
          failedChildren += Array.isArray(outcome?.childrenFailed) ? outcome.childrenFailed.length : 0
          forgetLocally(request.sessionId)
          // Force a fresh baseline pull: one already in flight may have listed
          // the row before the Host dropped it, and merging would keep it. A
          // second removal afterwards covers a baseline that re-applied the row
          // between the purge and this pull — nothing in it can bring the id back
          // again, because the Host no longer stores it.
          await services.refresh?.()
          forgetLocally(request.sessionId)
          return outcome
        }
        if (current.purgeRequests.length === 1) {
          const only = current.purgeRequests[0]
          await run(only.sessionId, () => settle(only))
        } else {
          const byId = new Map(current.purgeRequests.map((request) => [request.sessionId, request]))
          await runAll([...byId.keys()], (sessionId) => settle(byId.get(sessionId)))
        }
        setConfirm(null)
        if (childCount > 0) setNotice(t('purgedChildren', { count: childCount }))
        if (failedChildren > 0) setError(t('childrenBusy', { count: failedChildren }))
      }, [confirm, run, runAll, services, forgetLocally, t])

      const cancelConfirm = useCallback(() => {
        if (!busy) setConfirm(null)
      }, [busy])

      const status = error !== null
        ? h('div', { className: 'dsh-arch-status', 'data-kind': 'error', role: 'alert', key: 'error' }, [h(AlertIcon, { key: 'i' }), h('span', { key: 't' }, error)])
        : notice !== null
          ? h('div', { className: 'dsh-arch-status', 'data-kind': 'notice', role: 'status', key: 'notice' }, [h(CheckIcon, { key: 'i' }), h('span', { key: 't' }, notice)])
          : null

      return h('section', { className: 'dsh-arch-root', 'aria-label': t('nav'), 'aria-busy': busy ? 'true' : undefined }, [
        h('div', { className: 'dsh-arch-hint', key: 'hint' }, [h(InfoIcon, { key: 'i' }), h('span', { key: 't' }, t('intro'))]),
        h('div', { className: 'dsh-arch-bar', key: 'bar' }, [
          h('div', { className: 'dsh-arch-stats', key: 'stats' }, [
            h('span', { className: 'dsh-arch-stat', key: 'sessions' }, [h(SessionIcon, { key: 'i' }), h('span', { key: 't' }, t('sessions', { count: model.sessions }))]),
            h('span', { className: 'dsh-arch-stat', key: 'workspaces' }, [h(FolderIcon, { key: 'i' }), h('span', { key: 't' }, t('workspaces', { count: model.workspaces }))]),
          ]),
          model.sessions === 0 ? null : h('div', { className: 'dsh-arch-tools', key: 'tools' }, [
            h(Btn, { key: 'unarchive-all', disabled: busy, onClick: () => runAll(allRows.map((row) => row.sessionId), services.unarchive) },
              [h(UnarchiveIcon, { key: 'i' }), h('span', { key: 't' }, t('unarchiveAll'))]),
            h(Btn, { key: 'purge-all', variant: 'danger', disabled: busy, onClick: requestPurgeAll },
              [h(TrashIcon, { key: 'i' }), h('span', { key: 't' }, t('purgeAll'))]),
          ]),
        ]),
        status,
        model.sessions === 0
          ? h('div', { className: 'dsh-arch-empty', key: 'empty' }, [h(ArchiveIcon, { key: 'i' }), h('span', { key: 't' }, t('empty'))])
          : h('div', { className: 'dsh-arch-groups', key: 'groups' }, model.groups.map((group) => h('div', { className: 'dsh-arch-group', key: group.key }, [
            h('div', { className: 'dsh-arch-group-head', key: 'head' }, [
              h('span', { className: 'dsh-arch-group-icon', key: 'icon' }, h(group.orphaned ? ArchiveIcon : FolderIcon, {})),
              h('span', { className: 'dsh-arch-group-name', key: 'name', title: group.path }, group.orphaned ? t('orphaned') : (group.title || group.path)),
              group.orphaned
                ? null
                : h('span', { className: 'dsh-arch-group-meta', key: 'meta' },
                  [group.path, formatDate(group.createdAt) === '' ? '' : t('created', { time: formatDate(group.createdAt) })].filter(Boolean).join(' · ')),
              h('span', { className: 'dsh-arch-badge', key: 'count', title: t('sessions', { count: group.rows.length }) }, String(group.rows.length)),
            ]),
            ...group.rows.map((row) => h('div', { className: 'dsh-arch-row', key: row.sessionId }, [
              h('div', { className: 'dsh-arch-row-main', key: 'main' }, [
                h('div', { className: 'dsh-arch-title', 'data-missing': row.missing ? 'true' : undefined, key: 'title' }, [
                  h('span', { className: 'dsh-arch-title-text', key: 'text', title: row.title || row.sessionId },
                    row.title || (row.missing ? t('missing') : t('noTitle'))),
                  row.updatedAt > 0
                    ? h('span', { className: 'dsh-arch-time', key: 'time' }, t('updated', { time: formatTime(row.updatedAt) }))
                    : null,
                ]),
                h('span', { className: 'dsh-arch-id', key: 'id', title: row.sessionId }, row.sessionId),
              ]),
              h('div', { className: 'dsh-arch-row-actions', key: 'actions' }, [
                h(IconBtn, {
                  key: 'unarchive',
                  label: t('unarchive'),
                  disabled: busy || row.missing,
                  onClick: () => run(row.sessionId, () => services.unarchive(row.sessionId)),
                }, h(UnarchiveIcon, {})),
                h(IconBtn, {
                  key: 'purge',
                  variant: 'danger',
                  label: t('purge'),
                  disabled: busy,
                  onClick: () => requestPurge(row),
                }, h(TrashIcon, {})),
              ]),
            ])),
          ]))),
        confirm === null
          ? null
          : h(ConfirmDialog, {
            key: 'confirm',
            title: confirm.title,
            description: confirm.description,
            cancelLabel: t('cancel'),
            confirmLabel: t('confirmDelete'),
            pending: busy,
            workingLabel: t('working'),
            onCancel: cancelConfirm,
            onConfirm: settleConfirm,
          }),
      ])
    }

    /**
     * Call this package's Host route.
     * @param {object} payload - request body.
     * @returns {Promise<any>} the parsed JSON outcome.
     */
    async function callHost(payload) {
      const response = await fetch('/api/session.purgeArchived', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      let body
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      if (!response.ok) {
        const error = new Error(body?.error ?? `the Host refused the request (HTTP ${response.status})`)
        error.rpcError = { code: body?.code ?? 'archived-sessions/failed', message: error.message }
        throw error
      }
      return body
    }

    /**
     * The operations the page calls: `unarchive` through the shipped Workspace
     * controller; `purge`, `prune`, and `sweep` through the Host route; `forget`
     * and `refresh` through the shipped Session controller, so a deleted or
     * stale id leaves the sidebar list itself.
     * @param {object} ctx - Client plugin context.
     * @returns {object} operations.
     */
    function createOperations(ctx) {
      const workspaces = ctx.get('workspaces')
      const sessions = ctx.get('sessions')
      const unarchive = async (sessionId) => {
        if (workspaces === undefined) throw new Error('the workspace controller is not available')
        await workspaces.unarchiveSession(sessionId)
      }
      const purge = async (request) => {
        const outcome = await callHost({ sessionId: request.sessionId })
        if (outcome?.reason === 'busy') {
          // The log is still held open by a live writer; deleting it now would
          // truncate history, so nothing was committed and the row stays.
          const error = new Error(zh.busy)
          error.busy = true
          throw error
        }
        return outcome
      }
      const prune = async () => callHost({ action: 'prune' })
      // Unmaterialized creations the Host still lists from memory while nothing
      // backs them: no log, no Workspace slot, no live Agent.
      const prunePending = async () => callHost({ action: 'prunePending' })
      const sweep = async (sessionIds) => callHost({ action: 'sweep', sessionIds })
      // `handleSessionRemoved` rides the list-mutation channel and only reaches
      // `summaries` while a `listMutations` window is open; a freshly applied
      // baseline merges the row straight back. Records are keyed by session id,
      // so dropping the matching ones is the one removal no later pull undoes.
      const forget = (sessionId) => {
        if (sessions !== undefined) {
          const recordIds = (entries) => {
            if (Array.isArray(entries) === false) return undefined
            return entries.filter((entry) => entry?.sessionId !== sessionId)
          }
          const manager = typeof sessions.manager === 'object' && sessions.manager !== null ? sessions.manager : sessions
          const summaries = recordIds(manager.summaries)
          if (summaries !== undefined) manager.summaries = summaries
          const mutations = recordIds(manager.listMutations)
          if (mutations !== undefined && Array.isArray(manager.listMutations)) manager.listMutations = mutations
          for (const [key, record] of [['entryCache', 'delete'], ['projectionStores', 'delete']]) {
            const map = manager[key]
            if (typeof map?.delete === 'function') map.delete(sessionId)
          }
        }
        if (typeof sessions?.handleSessionRemoved === 'function') sessions.handleSessionRemoved(sessionId)
      }
      const refresh = async () => {
        if (typeof sessions?.refresh !== 'function') return
        await sessions.refresh()
      }
      return { unarchive, purge, prune, prunePending, sweep, forget, refresh }
    }

    /**
     * Register the Settings page once its slot declaration is on the ledger.
     * @param {object} ctx - Client plugin context.
     * @returns {void}
     */
    function apply(ctx) {
      ensureStyles()
      ctx.effect(() => removeStyles, 'archived-sessions: stylesheet')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'archived-sessions: dictionaries')
      const operations = createOperations(ctx)
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'archived-sessions',
        order: 25,
        // A thunk is re-read on every projection, so the nav label follows the active locale.
        label: () => ctx.locale.bind(NS)('nav'),
        locale: NS,
        inject: () => ({ services: operations }),
      }, ArchivedSessionsSection))
    }

    return {
      name: '@local/dsh-archived-sessions',
      inject: ['slots', 'locale', 'workspaces', 'sessions', 'remote'],
      apply,
    }
  },
})
