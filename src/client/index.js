/**
 * Magic Context — the adapter's browser half.
 *
 * This file is plain JavaScript on purpose. The official client build preset
 * (`@deepseek-ai/dsh-client-tsdown`) is not published (npm E404), so the bundle
 * is hand-written in the shape that preset emits: a `__ModuleLoader__.load`
 * registration whose factory returns the Cordis plugin object. `scripts/copy-client.mjs`
 * copies this file verbatim to `lib/client.js`; there is no compile step, so the
 * served artifact and this source are byte-identical by construction.
 *
 * The half contributes two surfaces, both of which degrade to nothing when the
 * deployment does not offer their seat or data:
 *
 *  1. `shell.overlay` — a telemetry badge/pill. It follows the Host half's
 *     `/mc-telemetry/events` SSE stream (falling back to one
 *     `/mc-telemetry/summary` read) and renders adapter state plus the most
 *     recent journal events. Collapsed it is a small pill; clicking it opens the
 *     detail panel. The overlay layer is click-through, so the pill opts back
 *     into pointer events itself. Nothing here is a credential or a message
 *     body: only the trimmed telemetry the Host route already exposes.
 *
 *  2. The Plugins page settings card for the row's `magic-context-dsh` settings
 *     namespace (`ctx.configForms`). It writes through the shared settings form,
 *     i.e. `remote.settings.mutate` → config editor → the profile's
 *     `cordis.patch.yml` override row. This half never touches a file.
 *
 * Only modules from the shell's static module table are required (`react`,
 * `@deepseek-ai/dsh-client-ui-primitives`); every other collaborator arrives as
 * a Cordis service (`slots`, `configForms`).
 */

window.__ModuleLoader__.load({
  /**
   * The registered id must equal `name` in package.json. The harness keys the
   * boot-graph row, the `/plugins/??<id>/client.js&rev=…` URL, and the
   * "loaded without registering <id>" check that gates module materialization
   * all by the package name — not by the Loader row id (`magic-context-dsh`),
   * which is only the settings namespace.
   */
  id: '@cortexkit/dsh-magic-context',
  factory: (require) => {
    const React = require('react')
    const { useEffect, useRef, useState } = React
    const el = React.createElement

    /* ------------------------------------------------------------------ *
     * Contracts
     * ------------------------------------------------------------------ */

    /** Loader row id of the Host half; also the settings namespace. */
    const CFG_NS = 'magic-context-dsh'
    /** Package name; the `plugins.row.config` key is `<package name>#<row id>`. */
    const PKG_NAME = '@cortexkit/dsh-magic-context'
    const ROW_CONFIG_KEY = PKG_NAME + '#' + CFG_NS
    /** Host telemetry routes (loopback only, no auth — telemetry only). */
    const SUMMARY_URL = '/mc-telemetry/summary'
    const EVENTS_URL = '/mc-telemetry/events'

    /**
     * Scope a telemetry URL to one Session.
     *
     * The badge sits in a session-scoped seat, so it asks the Host for that
     * Session's rows (`?session=`), which is what makes the counts and the
     * project identity belong to the work in front of the user rather than to
     * every project on the machine. Without an id — an older shell, or a seat
     * that hands the plugin no id — the request keeps the Host's original
     * whole-store view.
     */
    function telemetryUrl(base, sessionId) {
      return typeof sessionId === 'string' && sessionId !== ''
        ? base + '?session=' + encodeURIComponent(sessionId)
        : base
    }

    /** `git:a81f6372` — enough of a project identity to tell projects apart. */
    function shortIdentity(identity) {
      if (typeof identity !== 'string' || identity === '') return undefined
      const separator = identity.indexOf(':')
      if (separator === -1 || identity.length <= separator + 9) return identity
      return identity.slice(0, separator + 1) + identity.slice(separator + 1, separator + 9)
    }
    /** How many recent events the expanded panel keeps (records + noise alike). */
    const MAX_RECENT = 48
    /** How often the open panel re-reads `/mc-telemetry/summary` for its header counters. */
    const HEALTH_REFRESH_MS = 60_000
    /**
     * The composer's DOCK row — the "status bar" beneath the input line.
     *
     * The composer is two rows: the input line (left `+` / permission / `input.left`
     * and right `input.right` / model selector) and the dock row
     * (`InputBar`'s `data-composer-dock`), which already carries the session
     * statistics: `ui-chat` registers an activity pill (order 0) and the Token
     * usage pill (order 1) here, and the context meter follows the slot. That is
     * where the user expects project telemetry, so we append at order 2.
     *
     * `list` + `session` scope: the seat hands us the current `sessionId`, which
     * is what scopes our telemetry requests to this conversation.
     */
    const STATUS_SEAT = 'conversation.composer.dock'
    /** Position after the activity (0) and usage (1) pills, before the context meter. */
    const STATUS_SEAT_ORDER = 2
    /** The overlay only appears when the status seat is still absent after this long (an older shell). */
    const OVERLAY_FALLBACK_MS = 1_500

    /**
     * `@deepseek-ai/dsh-client-ui-primitives` is one of the shell's platform
     * modules. The require is guarded so a deployment whose module table lacks
     * it still materializes this bundle and keeps the telemetry badge; the
     * settings card falls back to plain controls.
     */
    let ui = {}
    try {
      ui = require('@deepseek-ai/dsh-client-ui-primitives') || {}
    } catch (error) {
      ui = {}
    }
    const SettingsForm = typeof ui.SettingsForm === 'function' ? ui.SettingsForm : undefined
    const SettingsValueField = typeof ui.SettingsValueField === 'function' ? ui.SettingsValueField : undefined
    const Switch = typeof ui.Switch === 'function' ? ui.Switch : undefined
    /** The official dark tooltip bubble (side top, 200ms delay) — same skin as the context meter's. */
    const Tooltip = typeof ui.Tooltip === 'function' ? ui.Tooltip : undefined

    /* ------------------------------------------------------------------ *
     * The editable settings surface
     * ------------------------------------------------------------------ */

    /**
     * One leaf the card edits.
     *
     * `path` is the path inside the settings namespace section (`policy` is a
     * nested object in the Host `Config`), and the Host writes it as
     * `{ op: 'set', path: ['policy', 'executeThreshold'], value }` — the shared
     * `ConfigForm` accepts nested paths even though the convenience
     * `SettingsFormModel` only models flat fields, which is why this card owns
     * its own small staging model.
     */
    const FIELDS = [
      {
        path: ['policy', 'executeThreshold'], kind: 'number', label: 'Execute threshold (%)',
        hint: 'Adoption percentage at which the execute band opens (0-100).',
      },
      {
        path: ['policy', 'forceThreshold'], kind: 'number', label: 'Force threshold (%)',
        hint: 'Adoption percentage at which reclaim becomes unconditional (0-100).',
      },
      {
        path: ['policy', 'ttlMs'], kind: 'number', label: 'Reclaim TTL (ms)',
        hint: 'How long a reclaimed compartment stays reversible.',
      },
      {
        path: ['policy', 'protectedToolResults'], kind: 'number', label: 'Protected tool results',
        hint: 'Newest tool results the policy never reclaims.',
      },
      {
        path: ['policy', 'historianMinNodes'], kind: 'number', label: 'Historian minimum nodes',
        hint: 'Assistant/tool nodes required before the historian runs.',
      },
      {
        path: ['policy', 'historianMaxTokens'], kind: 'number', label: 'Historian max tokens',
        hint: 'Generation cap for one historian call; anything below 8192 is raised to 8192.',
      },
      {
        path: ['policy', 'historianMaxTokensCeiling'], kind: 'number', label: 'Historian retry ceiling',
        hint: 'Ceiling the historian may escalate to after a token-cap truncation (doubles per attempt).',
      },
      {
        path: ['policy', 'historianTimeoutMs'], kind: 'number', label: 'Historian timeout (ms)',
        hint: 'Wall-clock budget for one historian run; a spent budget journals a failed run.',
      },
      {
        path: ['policy', 'baselineTokens'], kind: 'number', label: 'Baseline tokens',
        hint: 'Token budget reserved for the m[0]/m[1] baseline.',
      },
      {
        path: ['policy', 'memoryBudgetTokens'], kind: 'number', label: 'Memory budget tokens',
        hint: 'Token budget the recalled-memory block may spend.',
      },
      {
        path: ['policy', 'memoryLimit'], kind: 'number', label: 'Memory row limit',
        hint: 'Maximum shared memory rows recalled per pass.',
      },
      {
        path: ['journal', 'retentionDays'], kind: 'number', label: 'Journal retention (days)',
        hint: 'How long journal rows are kept.',
      },
      { path: ['historianEnabled'], kind: 'boolean', label: 'Historian enabled', hint: 'Run the out-of-band historian.' },
      {
        path: ['registerCompactionEngine'], kind: 'boolean', label: 'Register compaction engine',
        hint: 'Register the adapter as the compaction engine seam.',
      },
      { path: ['journal', 'enabled'], kind: 'boolean', label: 'Journal enabled', hint: 'Record adapter activity.' },
      { path: ['journal', 'mirror'], kind: 'boolean', label: 'Journal text mirror', hint: 'Also write the one-line activity mirror file.' },
    ]

    /** Copy the shared settings form frame renders. */
    const FORM_LABELS = {
      unavailable: 'Magic Context settings are not served by this deployment.',
      readOnly: 'This deployment stores settings read-only.',
      saveFailed: 'The Host did not accept the save; the values below are unsaved.',
      save: 'Save',
      saving: 'Saving…',
    }

    /** Read a value along a path inside a nested plain object. */
    function readPath(root, path) {
      let current = root
      for (let index = 0; index < path.length; index += 1) {
        if (current === null || typeof current !== 'object') return undefined
        current = current[path[index]]
      }
      return current
    }

    /** Whether the raw user layer carries an entry at this exact path. */
    function hasPath(root, path) {
      let current = root
      for (let index = 0; index < path.length; index += 1) {
        if (current === null || typeof current !== 'object') return false
        if (index === path.length - 1) return Object.prototype.hasOwnProperty.call(current, path[index])
        current = current[path[index]]
      }
      return false
    }

    /** Render a number field's stored value as draft text (empty when absent). */
    function formatNumber(value) {
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
    }

    /**
     * Convert draft text into the write the field stages.
     * @returns `{ kind: 'clear' }`, `{ kind: 'set', value }`, or `undefined` for
     *   text this field does not accept (which blocks the save).
     */
    function parseNumberText(text) {
      const trimmed = String(text).trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
    }

    /** Coerce a stored/undefined value to a checkbox state. */
    function asBool(value) {
      return value === true
    }

    /** The path key a draft is staged under. */
    function fieldKey(path) {
      return path.join('.')
    }

    /**
     * Build the Plugins page card bound to the shared configuration form of the
     * `magic-context-dsh` namespace.
     *
     * Staging mirrors the official cards: nothing is written until Save, and a
     * save posts every staged edit as one revision-fenced mutation. The
     * `SettingsFormModel` is not reused because it addresses only flat section
     * fields, while every interesting magic-context threshold lives under
     * `policy`/`journal`.
     *
     * @param scope - the `ConfigForm` for the namespace (`ctx.configForms.get`).
     * @returns the React component the two configuration seats register.
     */
    function makeCard(scope) {
      return function MagicContextCard(props) {
        const [, setRevision] = useState(0)
        const drafts = useRef(new Map())
        const [saving, setSaving] = useState(false)
        const [failed, setFailed] = useState(false)

        useEffect(() => scope.subscribe(() => setRevision((value) => value + 1)), [scope])

        const snapshot = scope.getSnapshot()
        const staged = drafts.current

        // The summary view is the one-liner the Plugins page shows in its list
        // (and as a row's description fallback); it must render without the form.
        if (props.view === 'summary') {
          const execute = formatNumber(readPath(snapshot.value, ['policy', 'executeThreshold']))
          const force = formatNumber(readPath(snapshot.value, ['policy', 'forceThreshold']))
          const historian = asBool(readPath(snapshot.value, ['historianEnabled']))
          if (snapshot.status !== 'ready') return 'Magic Context adapter settings'
          return 'execute ' + (execute || '—') + '% · force ' + (force || '—') + '% · historian '
            + (historian ? 'on' : 'off')
        }

        /** Stage one field's draft and re-render. */
        const stage = (key, draft) => {
          staged.set(key, draft)
          setFailed(false)
          setRevision((value) => value + 1)
        }
        /** Drop every draft. */
        const discard = () => {
          if (staged.size === 0 && !failed) return
          staged.clear()
          setFailed(false)
          setRevision((value) => value + 1)
        }

        /** The current view of one field: draft, effective value, override mark. */
        const view = (spec) => {
          const key = fieldKey(spec.path)
          const draft = staged.get(key)
          const sectionValue = readPath(snapshot.value, spec.path)
          const baseValue = readPath(snapshot.base, spec.path)
          const stored = hasPath(snapshot.user, spec.path)
          if (spec.kind === 'boolean') {
            const value = draft === undefined
              ? asBool(sectionValue)
              : (draft.clear ? asBool(baseValue) : draft.bool === true)
            return {
              value,
              overridden: draft === undefined ? stored : (draft.clear ? false : value !== asBool(baseValue)),
            }
          }
          const text = draft === undefined
            ? formatNumber(sectionValue)
            : (draft.clear ? formatNumber(baseValue) : draft.text)
          const write = draft === undefined || draft.clear ? undefined : parseNumberText(draft.text)
          return {
            text,
            invalid: draft !== undefined && !draft.clear && write === undefined,
            overridden: draft === undefined ? stored : (draft.clear ? false : write !== undefined),
          }
        }

        /**
         * The mutations a save would post, in field order. `blocked` is true when
         * a staged draft is not a value its field accepts (save refuses rather
         * than dropping the edit).
         */
        const plan = () => {
          const ops = []
          let blocked = false
          for (const spec of FIELDS) {
            const draft = staged.get(fieldKey(spec.path))
            if (draft === undefined) continue
            if (draft.clear) {
              ops.push({ op: 'unset', path: spec.path.slice() })
              continue
            }
            if (spec.kind === 'boolean') {
              ops.push({ op: 'set', path: spec.path.slice(), value: draft.bool === true })
              continue
            }
            const write = parseNumberText(draft.text)
            if (write === undefined) {
              blocked = true
              continue
            }
            if (write.kind === 'clear') ops.push({ op: 'unset', path: spec.path.slice() })
            else ops.push({ op: 'set', path: spec.path.slice(), value: write.value })
          }
          return { ops, blocked }
        }

        const save = () => {
          if (saving || !snapshot.writable || staged.size === 0) return
          const { ops, blocked } = plan()
          if (blocked || ops.length === 0) return
          setSaving(true)
          setFailed(false)
          Promise.resolve(scope.mutate(ops, snapshot.revision)).then((accepted) => {
            if (accepted) staged.clear()
            setSaving(false)
            setFailed(!accepted)
            setRevision((value) => value + 1)
          }, () => {
            setSaving(false)
            setFailed(true)
            setRevision((value) => value + 1)
          })
        }

        const shell = {
          available: snapshot.status === 'ready',
          writable: snapshot.writable === true,
          dirty: staged.size > 0,
          invalid: plan().blocked,
          saving,
          failed,
        }

        // Plain-control fallback for a module table without ui-primitives: the
        // same staging and the same writes, only the chrome differs.
        if (SettingsForm === undefined || SettingsValueField === undefined) {
          const rows = FIELDS.map((spec) => {
            const state = view(spec)
            const id = 'mc-field-' + fieldKey(spec.path)
            if (spec.kind === 'boolean') {
              return el('div', { key: id, style: { margin: '6px 0' } }, [
                el('input', {
                  key: 'input',
                  id,
                  type: 'checkbox',
                  checked: state.value,
                  disabled: !shell.writable,
                  onChange: (event) => stage(fieldKey(spec.path), { clear: false, bool: event.target.checked }),
                }),
                el('label', { key: 'label', htmlFor: id, style: { marginLeft: 6, fontSize: 12 } }, spec.label),
              ])
            }
            return el('div', { key: id, style: { margin: '6px 0' } }, [
              el('label', { key: 'label', htmlFor: id, style: { display: 'block', fontSize: 12 } }, spec.label),
              el('input', {
                key: 'input',
                id,
                type: 'text',
                value: state.text,
                disabled: !shell.writable,
                onChange: (event) => stage(fieldKey(spec.path), { clear: false, text: event.target.value }),
              }),
            ])
          })
          return el('div', { style: { display: 'grid', gap: 4, maxWidth: 520 } }, [
            el('p', { key: 'unavailable', style: { margin: 0, fontSize: 12 } },
              shell.available ? '' : FORM_LABELS.unavailable),
            ...rows,
            el('button', {
              key: 'save', type: 'button', disabled: !shell.dirty || shell.invalid || shell.saving || !shell.writable,
              onClick: save,
            }, shell.saving ? FORM_LABELS.saving : FORM_LABELS.save),
            failed ? el('span', { key: 'failed', style: { color: 'var(--dsw-alias-label-error, #c33)', fontSize: 12 } },
              FORM_LABELS.saveFailed) : null,
          ])
        }

        const controls = FIELDS.map((spec) => {
          const state = view(spec)
          const id = 'mc-field-' + fieldKey(spec.path)
          if (spec.kind === 'boolean') {
            return el('div', { key: id, style: { display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0' } }, [
              el('span', { key: 'label', style: { fontSize: 12 } }, spec.label),
              Switch !== undefined
                ? el(Switch, {
                  key: 'switch',
                  checked: state.value,
                  disabled: !shell.writable,
                  label: spec.label,
                  onChange: (next) => stage(fieldKey(spec.path), { clear: false, bool: next }),
                })
                : el('input', {
                  key: 'switch',
                  type: 'checkbox',
                  checked: state.value,
                  disabled: !shell.writable,
                  'aria-label': spec.label,
                  onChange: (event) => stage(fieldKey(spec.path), { clear: false, bool: event.target.checked }),
                }),
              state.overridden
                ? el('button', {
                  key: 'reset',
                  type: 'button',
                  disabled: !shell.writable,
                  onClick: () => stage(fieldKey(spec.path), { clear: true }),
                }, 'Reset')
                : null,
            ])
          }
          return el(SettingsValueField, {
            key: id,
            id,
            label: spec.label,
            hint: spec.hint,
            numeric: true,
            text: state.text,
            overridden: state.overridden,
            invalid: state.invalid,
            overriddenLabel: 'Modified',
            resetLabel: 'Reset',
            invalidLabel: 'Not a number',
            disabled: !shell.writable,
            onEdit: (text) => stage(fieldKey(spec.path), { clear: false, text }),
            onReset: () => stage(fieldKey(spec.path), { clear: true }),
          })
        })

        return el(SettingsForm, {
          labels: FORM_LABELS,
          state: shell,
          onSave: save,
          onDiscard: discard,
        }, controls)
      }
    }

    /* ------------------------------------------------------------------ *
     * The telemetry badge
     * ------------------------------------------------------------------ */

    /** Trim the Host summary into what the badge renders. */
    function trimSummary(summary) {
      const adapter = summary && typeof summary.adapter === 'object' && summary.adapter !== null ? summary.adapter : {}
      const health = summary && typeof summary.health === 'object' && summary.health !== null ? summary.health : {}
      const project = summary && typeof summary.project === 'object' && summary.project !== null ? summary.project : {}
      return {
        scope: summary && summary.scope === 'session' ? 'session' : 'global',
        schemaVersion: adapter.schemaVersion,
        engine: typeof adapter.engine === 'string' ? adapter.engine : 'unknown',
        uptimeMs: adapter.uptimeMs,
        memory: adapter.memory,
        memoryWrite: adapter.memoryWrite,
        // The shipped Host half names this `toolsMode`; the contract sketch said
        // `tools`. Read both so neither revision renders an empty row.
        tools: adapter.tools === undefined ? adapter.toolsMode : adapter.tools,
        projectIdentity: shortIdentity(project.identity),
        projectMemories: typeof project.memories === 'number' ? project.memories : undefined,
        journalRows: health.journalRows,
        journalRowsAll: health.journalRowsAll,
        lastEventAt: health.lastEventAt,
        passes24h: health.passes24h,
        errorsSinceBoot: health.errorsSinceBoot,
        errors24h: health.errors24h,
        drops24h: health.drops24h,
        compartments24h: health.compartments24h,
        memoriesRecalled: health.memoriesRecalled,
        // The density pass: the numbers a user actually acts on.
        lastPressure: typeof health.lastPressure === 'number' ? health.lastPressure : undefined,
        emergency24h: typeof health.emergency24h === 'number' ? health.emergency24h : undefined,
        promote24h: typeof health.promote24h === 'number' ? health.promote24h : undefined,
        reclaimed24h: typeof health.reclaimed24h === 'number' ? health.reclaimed24h : undefined,
        // Panel v3: absolute context size + the dreamer-slice KPIs.
        lastTokens: typeof health.lastTokens === 'number' ? health.lastTokens : undefined,
        lastContextWindow: typeof health.lastContextWindow === 'number' ? health.lastContextWindow : undefined,
        memoryStats: health.memoryStats !== null && typeof health.memoryStats === 'object'
          ? {
            verified: typeof health.memoryStats.verified === 'number' ? health.memoryStats.verified : undefined,
            unverified: typeof health.memoryStats.unverified === 'number' ? health.memoryStats.unverified : undefined,
          }
          : undefined,
        maintenanceLast: health.maintenanceLast !== null && typeof health.maintenanceLast === 'object'
          ? {
            at: typeof health.maintenanceLast.at === 'number' ? health.maintenanceLast.at : undefined,
            expired: typeof health.maintenanceLast.expired === 'number' ? health.maintenanceLast.expired : undefined,
            verified: typeof health.maintenanceLast.verified === 'number' ? health.maintenanceLast.verified : undefined,
            updated: typeof health.maintenanceLast.updated === 'number' ? health.maintenanceLast.updated : undefined,
            archived: typeof health.maintenanceLast.archived === 'number' ? health.maintenanceLast.archived : undefined,
          }
          : undefined,
      }
    }

    /** `HH:MM` for an epoch-millisecond stamp — the record row's stamp. */
    function timeShort(at) {
      const full = timeOf(at)
      return full === '' ? '' : full.slice(0, 5)
    }

    /** Compact token figure: `1.2M` / `840k` / `912` — module-level so the
     * record mappers (drop-landed) and the panel's ledger share one form. */
    function compactTok(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return ''
      if (value >= 1_000_000) return (value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1) + 'M'
      if (value >= 1_000) return (value / 1_000).toFixed(value >= 100_000 ? 0 : 1) + 'k'
      return String(Math.round(value))
    }

    /** `HH:MM:SS` for an epoch-millisecond stamp, when it is one. */
    function timeOf(at) {
      if (typeof at !== 'number' || !Number.isFinite(at)) return ''
      try {
        return new Date(at).toLocaleTimeString()
      } catch (error) {
        return ''
      }
    }

    /* ------------------------------------------------------------------ *
     * Operation records (what the adapter just did, in the operator's words)
     * ------------------------------------------------------------------ */

    /**
     * The categories the panel groups operations into.
     *
     * The panel is the window onto the three things a reviewing operator cares
     * about — memories going in, memories coming out, and context being
     * reclaimed or dropped — so every journal kind that represents one of them
     * is mapped here. Process chatter (`pass` defers, boots, engine notices,
     * session-first-seen) is counted but never listed, otherwise 480 defer rows
     * bury the handful of real operations.
     */
    const RECORD_CATEGORIES = {
      write: { icon: '🧠', label: '写入记忆', tone: '#a371f7' },
      read: { icon: '🔎', label: '加载记忆', tone: '#2f81f7' },
      reclaim: { icon: '✂️', label: '压缩上下文', tone: '#22a06b' },
      drop: { icon: '🗑️', label: '丢弃上下文', tone: '#d08700' },
      maintain: { icon: '🧰', label: '维护', tone: '#8250df' },
      archive: { icon: '🧭', label: '历史归档', tone: '#8a8f98' },
      error: { icon: '⚠️', label: '失败', tone: '#e5484d' },
    }
    /** Kinds that are process noise unless they carry a real operation. */
    const NOISE_KINDS = { pass: true, boot: true, 'session-first-seen': true, engine: true }
    /** How many records the panel lists (the stream keeps `MAX_RECENT`). */
    const MAX_RECORDS = 12

    function numberField(data, key) {
      if (data === null || typeof data !== 'object') return undefined
      const value = data[key]
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    }

    function arrayLength(data, key) {
      if (data === null || typeof data !== 'object') return undefined
      return Array.isArray(data[key]) ? data[key].length : undefined
    }

    /** `97,658 tok` / `−9,766 tok`; '' when the Host sent no number. */
    function tokensOf(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return ''
      const sign = value < 0 ? '−' : ''
      return sign + Math.abs(Math.round(value)).toLocaleString() + ' tok'
    }

    /** `135ms` / `9.7s`; '' when the Host sent no number. */
    function spanOf(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return ''
      return value < 1000 ? Math.round(value) + 'ms' : (value / 1000).toFixed(1) + 's'
    }

    function joinDetail(parts) {
      return parts.filter((part) => typeof part === 'string' && part !== '').join(' · ')
    }

    /**
     * One journal row → one record, or null for noise.
     *
     * `detail` reads numbers off the SSE payload; the snapshot strip carries no
     * `data`, so those rows fall back to the Host's one-line summary (rendered
     * by the caller) instead of losing their content entirely.
     */
    function recordOf(event) {
      if (event === null || typeof event !== 'object') return null
      const kind = typeof event.kind === 'string' ? event.kind : 'event'
      const data = event.data !== null && typeof event.data === 'object' ? event.data : undefined
      const level = typeof event.level === 'string' ? event.level : 'info'
      const at = typeof event.at === 'number' ? event.at : undefined
      const action = data !== undefined && typeof data.action === 'string' ? data.action : undefined
      const record = (category, text, detail) => ({ category, text, detail: joinDetail(detail), at, summary: event.summary })
      switch (kind) {
        case 'pass': {
          if (data === undefined || data.decision !== 'execute') return null
          // An execute pass that moved 0 tokens is a no-op: the real reclamation
          // is already reported by its `compartment-published`/`baseline` rows,
          // so listing it would bury them under "0 tok" lines.
          const delta = numberField(data, 'tokensDelta')
          if (delta === undefined || delta === 0) return null
          return record('reclaim', '执行回收', [
            numberField(data, 'pressure') === undefined ? '' : numberField(data, 'pressure') + '%',
            tokensOf(delta),
          ])
        }
        case 'memory-promote': {
          const inserted = arrayLength(data, 'inserted')
          const seenAgain = arrayLength(data, 'seenAgain')
          const skipped = arrayLength(data, 'skipped')
          return record('write', '记忆提升', [
            inserted === undefined ? '' : '新增 ' + inserted,
            seenAgain ? '去重命中 ' + seenAgain : '',
            skipped ? '跳过 ' + skipped : '',
          ])
        }
        case 'tool-call': {
          const writeish = action === 'write' || action === 'update' || action === 'archive' || action === 'merge'
          const readish = action === 'list' || action === 'get'
          if (!writeish && !readish) return null
          const verbs = { write: '写入', update: '更新', archive: '归档', merge: '合并', list: '检索', get: '读取' }
          const verb = action !== undefined && verbs[action] !== undefined ? verbs[action] : action
          return record(writeish ? 'write' : 'read', writeish ? '写入记忆' : '检索记忆', [
            verb,
            data !== undefined && data.ok === false ? '被拒' : '',
            spanOf(numberField(data, 'ms')),
          ])
        }
        case 'memory-recall': {
          // Every pass re-reports the same injection; the per-turn beat lives
          // in the beat line, not the record list.
          return null
        }
        case 'compartment-published': {
          const nodes = numberField(data, 'nodes')
          const reclaimed = numberField(data, 'estTokensReclaimed')
          return record('reclaim', '压缩上下文', [
            nodes === undefined ? '' : '替换 ' + nodes + ' 节点',
            reclaimed === undefined ? '' : '回收 ' + reclaimed + ' tok',
          ])
        }
        case 'baseline': {
          // A SOFT refresh is the engine's per-execute heartbeat; only a HARD
          // rebuild (a priced cache bust) is worth a row.
          if (data === undefined || data.mode !== 'hard') return null
          const bytes = numberField(data, 'bytes')
          const est = numberField(data, 'estTokens')
          return record('reclaim', '基线重建 (HARD)', [
            bytes === undefined ? '' : bytes + ' B',
            est === undefined ? '' : est + ' tok',
          ])
        }
        case 'emergency-reclaim': {
          const dropped = numberField(data, 'dropped')
          return record('drop', '丢弃上下文', [
            dropped === undefined ? '' : '丢弃 ' + dropped + ' 条工具输出',
            data !== undefined && typeof data.reason === 'string' ? data.reason : '',
          ])
        }
        case 'drop-landed': {
          const count = numberField(data, 'count')
          const est = numberField(data, 'estTokens')
          return record('drop', '丢弃落地', [
            count === undefined ? '' : count + ' 条工具输出',
            est === undefined ? '' : '回收 ' + compactTok(est) + ' tok',
          ])
        }
        case 'historian': {
          const phase = data === undefined || typeof data.phase !== 'string' ? '' : data.phase
          if (phase === 'failed') {
            // A remount-killed run is repaired host-side at the next mount —
            // it is bookkeeping, not an operation failure, so it reads as a
            // dim archive row instead of a red one.
            if (data !== undefined && data.kind === 'adapter-remount') {
              return record('maintain', '重挂载恢复', ['补记中断的历史归档'])
            }
            const reason = typeof data.reason === 'string' ? data.reason : ''
            return record('error', '历史归档失败', [reason.slice(0, 42)])
          }
          if (phase !== 'stored') return null // start/done are the run's inner beat
          const facts = numberField(data, 'facts')
          return record('archive', '归档已存', [
            data !== undefined && typeof data.compartmentId === 'number' ? '§C' + String(data.compartmentId) + '§' : '',
            facts === undefined ? '' : 'facts ' + facts,
            numberField(data, 'nodes') === undefined ? '' : numberField(data, 'nodes') + ' 节点',
            spanOf(numberField(data, 'durationMs')),
          ])
        }
        case 'maintenance': {
          const parts = [
            numberField(data, 'expired') === undefined ? '' : 'TTL 归档 ' + String(data.expired),
            numberField(data, 'verified') === undefined ? '' : '验证 ' + String(data.verified),
            numberField(data, 'updated') === undefined ? '' : '修订 ' + String(data.updated),
          ]
          if (parts.every((part) => part === '')) {
            return record('maintain', '维护巡检', ['无需处理'])
          }
          return record('maintain', '维护巡检', parts)
        }
        case 'session-notice':
          // The notice is the conversation's own inline row; mirroring it here
          // duplicates what the transcript already shows.
          return null
        default:
          if (level === 'error') return record('error', '执行失败', [kind])
          return NOISE_KINDS[kind] === true ? null : record('archive', kind, [])
      }
    }

    /**
     * Newest-first records out of the raw stream, with adjacent repeats folded.
     *
     * The automatic m[0]/m[1] injection runs on every turn and reports the same
     * "m[0] 40 条 · m[1] +26 条" line each time; listing that forty times would
     * hide the operations that actually changed something. Consecutive identical
     * records therefore collapse into one with a `×N` count (the same way a
     * repeated tool call reads in a coding agent's transcript).
     */
    function recordsOf(events) {
      const out = []
      for (const event of events) {
        const record = recordOf(event)
        if (record === null) continue
        const last = out.length === 0 ? undefined : out[out.length - 1]
        if (last !== undefined && last.category === record.category && last.text === record.text && last.detail === record.detail) {
          out[out.length - 1] = { ...last, count: last.count + 1 }
          continue
        }
        out.push({ ...record, count: 1 })
      }
      return out
    }

    /** `[{category, icon, label, tone, count}]`, only for categories that occurred. */
    function recordCounts(records) {
      const out = []
      for (const key of Object.keys(RECORD_CATEGORIES)) {
        let count = 0
        for (const record of records) if (record.category === key) count++
        if (count > 0) out.push({ key, count, ...RECORD_CATEGORIES[key] })
      }
      return out
    }

    /** The per-turn beats worth one folded line: routine injections only. */
    function noiseLine(events) {
      const counts = {}
      for (const event of events) {
        if (event === null || typeof event !== 'object' || typeof event.kind !== 'string') continue
        if (event.kind === 'memory-recall') counts['加载记忆'] = (counts['加载记忆'] || 0) + 1
        else if (event.kind === 'baseline' && !(event.data !== null && typeof event.data === 'object' && event.data.mode === 'hard')) counts['基线刷新'] = (counts['基线刷新'] || 0) + 1
      }
      return Object.keys(counts).sort((a, b) => counts[b] - counts[a])
        .map((kind) => kind + ' ×' + counts[kind]).join(' · ')
    }

    /* ------------------------------------------------------------------ *
     * Inline records in the conversation itself
     * ------------------------------------------------------------------ */

    // The per-Turn tail blocks and the live strip were removed (see `apply`):
    // their shared SSE plumbing (`subscribeLive`, the TURN_*/LIVE maps) went
    // with them. The record model below (`recordOf`/`recordsOf`/`recordCounts`/
    // `noiseLine`) stays — the pill's expanded panel still renders journal
    // rows with it.

    /** Where the expanded panel opens when the pill cannot be measured. */
    const PANEL_FALLBACK_ANCHOR = { right: 12, bottom: 44, maxHeight: 400 }

    /**
     * Anchor the panel just above and right-aligned with the pill.
     *
     * The panel is `position: fixed` on purpose: the status bar sits inside the
     * composer, whose scroll/overflow containers would otherwise clip a panel
     * opened upward. Measuring the pill keeps it attached to whichever seat
     * rendered it, and the values are clamped so the panel cannot leave the
     * viewport.
     */
    function anchorAbove(node) {
      if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function' || typeof window === 'undefined') {
        return PANEL_FALLBACK_ANCHOR
      }
      try {
        const rect = node.getBoundingClientRect()
        const viewportHeight = typeof window.innerHeight === 'number' ? window.innerHeight : 0
        const viewportWidth = typeof window.innerWidth === 'number' ? window.innerWidth : 0
        const bottom = Math.max(8, viewportHeight - rect.top + 8)
        return {
          right: Math.max(8, viewportWidth - rect.right),
          bottom,
          maxHeight: Math.max(160, Math.min(480, viewportHeight - bottom - 8)),
        }
      } catch (error) {
        return PANEL_FALLBACK_ANCHOR
      }
    }

    /**
     * The telemetry pill.
     *
     * It is rendered in whichever seat the plugin managed to take: the composer
     * status bar (`placement: 'statusbar'`, the intended home) or the
     * `shell.overlay` fallback (`placement: 'overlay'`) for a shell that never
     * declares the status seat. Collapsed it is one very short line — the
     * status bar already carries three statistics — and the hover title holds
     * the full summary. The expanded panel always renders above the pill.
     *
     * The Host route is optional: an absent route (404 on `EventSource`, or no
     * `EventSource` at all) makes the badge read `MC · —` and nothing else in
     * the UI is affected. The overlay layer is click-through, so both the pill
     * and the panel opt back into pointer events.
     */
    function TelemetryBadge(props) {
      const placement = props !== undefined && props.placement === 'statusbar' ? 'statusbar' : 'overlay'
      const sessionId = props !== undefined && typeof props.sessionId === 'string' && props.sessionId !== ''
        ? props.sessionId
        : undefined
      const eventsUrl = telemetryUrl(EVENTS_URL, sessionId)
      const summaryUrl = telemetryUrl(SUMMARY_URL, sessionId)
      const [state, setState] = useState({ status: 'connecting', summary: null, recent: [] })
      const [open, setOpen] = useState(false)
      const [anchor, setAnchor] = useState(null)
      const [hovered, setHovered] = useState(false)
      const pillRef = useRef(null)

      useEffect(() => {
        let disposed = false
        let sawSnapshot = false

        const acceptSummary = (payload) => {
          if (disposed || payload === null || typeof payload !== 'object') return
          sawSnapshot = true
          const recent = Array.isArray(payload.recent) ? payload.recent.slice(-MAX_RECENT).reverse() : []
          setState({ status: 'ok', summary: payload, recent })
        }
        const acceptEvent = (event) => {
          if (disposed || event === null || typeof event !== 'object') return
          setState((previous) => {
            if (previous.status === 'unavailable') return previous
            return { status: 'ok', summary: previous.summary, recent: [event, ...previous.recent].slice(0, MAX_RECENT) }
          })
        }
        // One tolerant reader for both framings: the Host's named `snapshot` /
        // `journal` events, and a bare `data:` frame from an older revision.
        const acceptAny = (payload) => {
          if (payload === null || typeof payload !== 'object') return
          if (payload.adapter !== undefined || payload.health !== undefined) acceptSummary(payload)
          else if (payload.kind !== undefined || payload.summary !== undefined) acceptEvent(payload)
        }
        const parseFrame = (data, accept) => {
          try {
            accept(JSON.parse(data))
          } catch (error) {
            /* a malformed frame must not break the badge */
          }
        }
        const probe = () => {
          if (disposed || sawSnapshot || typeof fetch !== 'function') return
          Promise.resolve(fetch(summaryUrl, { headers: { accept: 'application/json' } })).then(
            (response) => (response !== undefined && response.ok ? response.json() : Promise.reject(new Error('unavailable'))),
          ).then((payload) => {
            if (!disposed) acceptSummary(payload)
          }, () => {
            if (!disposed && !sawSnapshot) setState((previous) => (previous.summary !== null ? previous : { status: 'unavailable', summary: null, recent: [] }))
          })
        }

        if (typeof EventSource !== 'function') {
          probe()
        } else {
          let source
          try {
            source = new EventSource(eventsUrl)
          } catch (error) {
            source = undefined
          }
          if (source === undefined) {
            probe()
          } else {
            source.addEventListener('snapshot', (event) => parseFrame(event.data, acceptSummary))
            source.addEventListener('journal', (event) => parseFrame(event.data, acceptEvent))
            source.onmessage = (event) => parseFrame(event.data, acceptAny)
            source.onerror = () => {
              // The browser reconnects a dropped stream by itself; a route that
              // was never mounted settles as CLOSED and is probed once instead.
              if (source.readyState === 2 /* CLOSED */ && !sawSnapshot) probe()
            }
            return () => {
              disposed = true
              source.close()
            }
          }
        }
        return () => { disposed = true }
      }, [eventsUrl])

      // The stream's `snapshot` frame is read once, at connect, so the header
      // counters would grow stale for as long as the page stays open. Refresh
      // the summary while (and only while) the panel is open: immediately on
      // open, then every HEALTH_REFRESH_MS. `recent` stays owned by the live
      // frames, and a failed refresh keeps the last good header.
      useEffect(() => {
        if (!open) return undefined
        let disposed = false
        const refresh = () => {
          if (typeof fetch !== 'function') return
          Promise.resolve(fetch(summaryUrl, { headers: { accept: 'application/json' } })).then(
            (response) => (response !== undefined && response.ok ? response.json() : Promise.reject(new Error('unavailable'))),
          ).then((payload) => {
            if (disposed || payload === null || typeof payload !== 'object') return
            setState((previous) => ({ status: 'ok', summary: payload, recent: previous.recent }))
          }, () => {
            /* the last good header stays on screen */
          })
        }
        refresh()
        const timer = setInterval(refresh, HEALTH_REFRESH_MS)
        return () => {
          disposed = true
          clearInterval(timer)
        }
      }, [open, summaryUrl])

      // The panel is a popover, so it closes the moment it stops being the thing
      // the user is looking at: a pointer press outside it, Escape, or the
      // window losing focus. Both surfaces carry `data-mc-surface` (the panel is
      // `position: fixed`, so hit-testing its box would be fragile).
      useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          const target = event === null || event === undefined ? null : event.target
          const inside = target !== null && target !== undefined
            && typeof target.closest === 'function' && target.closest('[data-mc-surface]') !== null
          if (!inside) setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event !== null && event !== undefined && event.key === 'Escape') setOpen(false)
        }
        const onWindowBlur = () => setOpen(false)
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('blur', onWindowBlur)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('blur', onWindowBlur)
        }
      }, [open])

      const summary = state.summary
      const health = trimSummary(summary)
      // The pill answers "is anything wrong NOW": prefer the errors the running
      // process reported, so a restart clears failures the current build already
      // fixed instead of keeping the badge red for a whole day.
      const errors = typeof health.errorsSinceBoot === 'number'
        ? health.errorsSinceBoot
        : typeof health.errors24h === 'number'
          ? health.errors24h
          : 0
      const passes = typeof health.passes24h === 'number' ? health.passes24h : 0
      // The one number that matters is the context pressure, not the pass
      // count (92% of passes are defers — noise). Tone follows it: green
      // below the execute band, amber approaching, orange inside it.
      const pressure = health.lastPressure
      const tone = state.status === 'unavailable' ? '#d08700'
        : state.status !== 'ok' ? '#8a8f98'
        : errors > 0 ? '#e5484d'
        : pressure === undefined ? '#22a06b'
        : pressure >= 65 ? '#e5484d'
        : pressure >= 50 ? '#d08700'
        : '#22a06b'
      const pressureText = pressure === undefined ? '' : Math.round(pressure) + '%'
      // Shortest possible line: the pressure, or the error count when red.
      const collapsed = state.status === 'unavailable'
        ? 'MC · —'
        : state.status !== 'ok'
          ? 'MC · …'
          : errors > 0
            ? 'MC · ' + errors + ' err'
            : pressureText !== ''
              ? 'MC · ' + pressureText
              : 'MC · ' + passes + ' pass'
      const lastSeen = timeOf(health.lastEventAt)
      const scopeLabel = health.scope === 'session' ? 'this session' : 'all sessions'
      // The pill's hover bubble mirrors the native pills' tooltip (one dark
      // rounded line); the full diagnostic title lives on the panel only.
      const tipText = state.status === 'unavailable'
        ? '遥测不可用'
        : state.status !== 'ok'
          ? '连接中…'
          : errors > 0
            ? errors + ' 个错误'
            : pressureText !== ''
              ? '上下文已用 ' + pressureText + (health.projectMemories !== undefined ? ' · 记忆 ' + health.projectMemories + ' 条' : '')
              : 'Magic Context 运行中'

      const inDock = placement === 'statusbar'
      // The official pill skin: hover + open keep the interactive background
      // (injected once — inline styles cannot express :hover), and the pill
      // rides in the official Tooltip bubble when the primitives module exists.
      const pillCore = el('button', {
        type: 'button',
        'data-mc-surface': '1',
        ref: pillRef,
        'aria-label': tipText,
        'aria-expanded': open,
        onClick: () => {
          if (!open) setAnchor(anchorAbove(pillRef === null || pillRef === undefined ? null : pillRef.current))
          setOpen((value) => !value)
        },
        // The official pill's hover/open skin, driven by state: an injected
        // :hover rule kept losing to (or sticking past) the inline styles, so
        // the background is computed here instead — same token, no specificity.
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
        style: {
          pointerEvents: 'auto',
          display: 'inline-flex',
          alignItems: 'center',
          // In the dock row: adopt the neighbouring pills' skin (12/20 tertiary
          // tier, transparent, nowrap, tabular figures) so the row reads as one
          // set. The overlay fallback keeps its own compact monospace badge.
          gap: inDock ? 5 : 6,
          font: inDock ? 'inherit' : '11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
          fontVariantNumeric: inDock ? 'tabular-nums' : undefined,
          padding: inDock ? '1px 8px' : '4px 9px',
          borderRadius: inDock ? 'var(--dsw-radius-sm, 6px)' : 999,
          border: inDock ? 'none' : '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.35))',
          // Hover/open skin (the official pill's token), computed from state.
          // The dock's own stylesheet paints buttons a static grey, so the
          // resting state must be an EXPLICIT transparent — leaving it unset
          // lets that grey through, and a :hover rule cannot win against the
          // inline style anyway.
          background: inDock
            ? (hovered || open ? 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16))' : 'transparent')
            : 'transparent',
          color: errors > 0 && state.status === 'ok'
            ? 'var(--dsw-alias-label-error, #e5484d)'
            : inDock
              ? 'var(--dsw-alias-label-tertiary, currentColor)'
              : 'var(--dsw-alias-label-secondary, currentColor)',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          transition: 'background-color .12s ease',
        },
      }, [
        el('span', {
          key: 'dot',
          style: {
            width: inDock ? 6 : 7,
            height: inDock ? 6 : 7,
            borderRadius: '50%',
            background: tone,
            display: 'inline-block',
            flex: '0 0 auto',
          },
        }),
        el('span', { key: 'text' }, collapsed),
      ])
      const pill = Tooltip !== undefined
        ? el(Tooltip, { label: tipText, side: 'top', delayMs: 200, disabled: open }, pillCore)
        : pillCore

      const place = anchor === null ? PANEL_FALLBACK_ANCHOR : anchor

      if (!open) {
        return placement === 'overlay'
          ? el('div', { style: { position: 'fixed', right: 12, bottom: 10, zIndex: 40, pointerEvents: 'none' } }, pill)
          // Dock entry root: shrink-wraps the pill (like the neighbouring stat
          // pills' anchor) and inherits the dock row's 12/20 text tier, so the
          // fixed-position panel measures the pill and the row stays one line.
          : el('div', {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              minWidth: 0,
              pointerEvents: 'auto',
              fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
              lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
            },
          }, pill)
      }

      // ---- Panel v3: status dot + pressure gauge, label-grid summary,
      // categorized operation feed. System font for prose, tabular numerals
      // for figures; the old full-monospace panel read like a debug console.
      const statusMeta = {
        ok: ['正常', '#22a06b'],
        connecting: ['连接中', '#d08700'],
        unavailable: ['不可用', '#e5484d'],
      }
      const [statusLabel, statusTone] = statusMeta[state.status] ?? [String(state.status), '#8a8f98']
      const pressureValue = pressure === undefined ? undefined : Math.round(pressure)
      const pressureTone = pressureValue === undefined ? 'inherit' : pressureValue >= 85 ? '#e5484d' : pressureValue >= 60 ? '#d08700' : '#22a06b'

      /** One dense self-labeled line: figures only, `·`-joined. */
      const kv = (cells) => {
        const text = cells.filter((cell) => cell !== '' && cell !== undefined && cell !== null).join(' · ')
        if (text === '') return null
        return el('div', { key: 'kv-' + text.slice(0, 8), style: { padding: '2.5px 0', fontVariantNumeric: 'tabular-nums', minWidth: 0 } }, text)
      }

      // The project ledger must read from ONE source: the stats' total row
      // count. Two occupancy figures are shown and LABELLED because they are
      // different truths: 占用 = the native meter's own projection (the next
      // request's answer); 压缩后账面 = the post-compaction surface account,
      // which only moves when a management pass runs.
      const projectTotal = health.memoryStats !== undefined && health.memoryStats.total !== undefined
        ? health.memoryStats.total
        : health.projectMemories
      const summaryRows = [
        kv([
          pressureValue !== undefined ? '占用 ' + pressureValue + '%' : '',
          health.lastTokens !== undefined && health.lastContextWindow
            ? '压缩后账面 ' + compactTok(health.lastTokens) + ' / ' + compactTok(health.lastContextWindow) + ' tok'
            : '',
          projectTotal !== undefined ? '记忆 ' + projectTotal + ' 条' : '',
          health.promote24h > 0 ? '24h 提升 ' + health.promote24h : '',
          health.memoryStats !== undefined && health.memoryStats.unverified !== undefined
            ? '待验证 ' + health.memoryStats.unverified
            : '',
        ]),
        health.maintenanceLast !== undefined
          ? kv([
            typeof health.maintenanceLast.at === 'number' ? '维护 ' + timeShort(health.maintenanceLast.at) : '维护',
            health.maintenanceLast.expired ? 'TTL 归档 ' + health.maintenanceLast.expired : '',
            health.maintenanceLast.verified ? '验证 ' + health.maintenanceLast.verified : '',
            health.maintenanceLast.updated ? '修订 ' + health.maintenanceLast.updated : '',
          ])
          : null,
        errors > 0 ? kv(['异常 本进程 ' + errors + ' · 24h ' + (health.errors24h ?? '?')]) : null,
      ].filter(Boolean)

      const records = recordsOf(state.recent)
      const noise = noiseLine(state.recent)
      const recordNodes = records.length === 0
        ? [el('div', { key: 'empty', style: { padding: '4px 0', opacity: 0.55 } }, state.status === 'unavailable' ? '此宿主未挂遥测路由' : '暂无操作记录')]
        : records.slice(0, MAX_RECORDS).map((record, index) => {
          const meta = RECORD_CATEGORIES[record.category] === undefined ? RECORD_CATEGORIES.archive : RECORD_CATEGORIES[record.category]
          const body = record.detail !== '' ? record.detail : typeof record.summary === 'string' ? record.summary : ''
          const folded = record.count > 1 ? body + ' · ' + record.count + ' 次' : body
          return el('div', {
            key: 'record-' + index,
            title: meta.label + (record.count > 1 ? ' ×' + record.count : '') + (record.summary !== '' && record.summary !== body ? '\n' + record.summary : ''),
            style: {
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              padding: '5px 0',
              borderTop: index === 0 ? 'none' : '1px solid rgba(127,127,127,.12)',
            },
          }, [
            el('span', { key: 'dot', style: { flex: '0 0 auto', width: 7, height: 7, borderRadius: 4, background: meta.tone } }),
            el('span', { key: 'label', style: { flex: '0 0 auto' } }, meta.label),
            el('span', {
              key: 'detail',
              style: { flex: '1 1 auto', minWidth: 0, opacity: 0.6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
            }, folded),
            el('span', { key: 'at', style: { flex: '0 0 auto', opacity: 0.45, fontVariantNumeric: 'tabular-nums' } }, timeShort(record.at)),
          ])
        })

      const sectionTitle = (key, title, extra) => el('div', {
        key,
        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', margin: '10px 0 3px' },
      }, [
        el('span', { key: 't', style: { fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', opacity: 0.5 } }, title),
        extra === undefined ? null : el('span', { key: 'e', style: { fontSize: 10.5, opacity: 0.5 } }, extra),
      ])

      const panel = el('div', {
        'data-mc-surface': '1',
        style: {
          position: 'fixed',
          right: place.right,
          bottom: place.bottom,
          zIndex: 60,
          pointerEvents: 'auto',
          width: 352,
          maxWidth: 'calc(100vw - 24px)',
          maxHeight: place.maxHeight,
          overflowY: 'auto',
          padding: '12px 14px 10px',
          borderRadius: 12,
          border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.3))',
          background: 'var(--dsw-alias-bg-layer-1, rgba(24,24,27,.97))',
          color: 'var(--dsw-alias-label-primary, #e6e6e6)',
          boxShadow: '0 12px 32px rgba(0,0,0,.22)',
          font: '12px/1.55 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
        },
      }, [
        el('div', { key: 'head', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, [
          el('div', { key: 'who', style: { display: 'flex', alignItems: 'center', gap: 7 } }, [
            el('span', { key: 'dot', style: { width: 8, height: 8, borderRadius: 4, background: statusTone, boxShadow: '0 0 6px ' + statusTone } }),
            el('strong', { key: 'title', style: { fontSize: 12.5, fontWeight: 600, letterSpacing: '.01em' } }, 'Magic Context'),
            el('span', { key: 'status', style: { fontSize: 10.5, opacity: 0.55 } }, statusLabel),
          ]),
          pressureValue === undefined
            ? el('span', { key: 'p', style: { fontSize: 10.5, opacity: 0.4 } }, '—')
            : el('span', {
              key: 'p',
              style: { fontSize: 17, fontWeight: 600, lineHeight: 1, color: pressureTone, fontVariantNumeric: 'tabular-nums' },
            }, pressureValue + '%'),
        ]),
        el('div', { key: 'summary', style: { marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(127,127,127,.14)' } }, summaryRows),
        sectionTitle('records-head', '最近操作', records.length === 0 ? undefined : '近 ' + records.length + ' 项'),
        el('div', { key: 'records', style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' } }, recordNodes),
        el('div', {
          key: 'foot',
          title: noise === '' ? undefined : '节拍: ' + noise,
          style: { marginTop: 8, paddingTop: 6, borderTop: '1px solid rgba(127,127,127,.14)', opacity: 0.45, fontSize: 10.5 },
        }, '悬停条目看详情 · /ctx-status 看全量'),
      ])

      return placement === 'overlay'
        ? el('div', {
          style: { position: 'fixed', right: 12, bottom: 10, zIndex: 40, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', pointerEvents: 'none' },
        }, [panel, pill])
        : el('div', {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            minWidth: 0,
            pointerEvents: 'auto',
            fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
            lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
          },
        }, [panel, pill])
    }

    /**
     * The dock pill (`conversation.composer.dock`, the composer's status row).
     *
     * The seat is session-scoped, so the framework hands the component the
     * current `sessionId`; that id is what scopes both telemetry requests to the
     * conversation in front of the user. A shell that omits it (or an older
     * shell) degrades to the Host's whole-store view instead of failing.
     */
    function StatusBarBadge(props) {
      return TelemetryBadge({
        placement: 'statusbar',
        sessionId: props === undefined || props === null ? undefined : props.sessionId,
      })
    }

    /** The floating pill (`shell.overlay`), used only when the status seat never appears. */
    function OverlayBadge() {
      return TelemetryBadge({ placement: 'overlay' })
    }

    /* ------------------------------------------------------------------ *
     * Plugin face
     * ------------------------------------------------------------------ */

    /**
     * Register the telemetry pill and the settings card.
     *
     * The pill goes into the composer's dock row (`conversation.composer.dock`,
     * the "status bar" under the input line) next to the activity and Token
     * usage pills, but ONLY there — one seat, so no duplicate pill. The
     * `shell.overlay` registration is the fallback for a shell that never
     * declares that seat, and it is dropped as soon as the dock seat arrives
     * (so the two never coexist). The overlay is mounted only after
     * {@link OVERLAY_FALLBACK_MS} so a normal boot shows no corner flash, and
     * a shell whose composer never mounts still gets a badge.
     *
     * Both seats are taken through `ctx.slots.inject`, which tolerates a late
     * declaration, and both registrations live on the parent context, so the
     * badge survives a deployment without the settings domain. The card waits
     * on `configForms` through `ctx.inject` rather than a hard plugin
     * dependency, so the badge is never held back by it.
     *
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      // The live strip (conversation.input.dock) and the per-Turn frozen blocks
      // (conversation.chat.turnTail) were REMOVED by decision on 2026-10-07:
      // the session stream now carries the durable record — one `notice` entry
      // per action-bearing management pass, appended by the adapter itself
      // (src/dsh/session-notice.ts) and rendered natively by the transcript.
      // The pill + panel below remain the real-time/telemetry surface.

      ctx.effect(() => {
        let overlayOff
        let seatTaken = false
        const mountOverlay = () => {
          if (seatTaken || overlayOff !== undefined) return
          overlayOff = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: 'magic-context.telemetry',
            order: 100,
            label: 'Magic Context telemetry',
          }, OverlayBadge))
        }
        const unmountOverlay = () => {
          if (overlayOff === undefined) return
          const off = overlayOff
          overlayOff = undefined
          off()
        }
        const fallback = setTimeout(mountOverlay, OVERLAY_FALLBACK_MS)
        const seatOff = ctx.slots.inject(STATUS_SEAT, () => {
          seatTaken = true
          clearTimeout(fallback)
          const offPill = ctx.slots.register({
            name: STATUS_SEAT,
            id: 'magic-context.telemetry',
            order: STATUS_SEAT_ORDER,
            label: 'Magic Context telemetry',
          }, StatusBarBadge)
          unmountOverlay()
          return offPill
        })
        return () => {
          clearTimeout(fallback)
          seatOff()
          unmountOverlay()
        }
      }, 'magic-context: telemetry badge')

      ctx.inject(['configForms'], (settingsCtx) => {
        const scope = settingsCtx.configForms.get(CFG_NS)
        const Card = makeCard(scope)
        settingsCtx.effect(() => settingsCtx.configForms.whileServed([CFG_NS], () => {
          const offItem = ctx.slots.inject('plugins.item', () => ctx.slots.register({
            name: 'plugins.item',
            id: CFG_NS,
            order: 20,
            label: 'Magic Context',
          }, Card))
          const offRow = ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
            name: 'plugins.row.config',
            key: ROW_CONFIG_KEY,
            order: 20,
          }, Card))
          return () => {
            offItem()
            offRow()
          }
        }), 'magic-context: settings card')
      })
    }

    /**
     * `apply` is the only thing the loader needs. `__diagnostics` exists so the
     * record mapping can be exercised against a real journal outside a browser
     * (this repo has no client test runner): feed it journal rows and compare
     * what the panel would print. It is pure and reads nothing.
     */
    return { name: 'magic-context-client', inject: ['slots'], apply, __diagnostics: { recordOf, recordsOf, recordCounts, noiseLine } }
  },
})
