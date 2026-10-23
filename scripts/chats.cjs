// Reads every Claude Code chat transcript (~/.claude/projects/*/*.jsonl) and prints
// JSON: a summary, a change signature per chat and two animated SVGs (narrow and
// wide) of each chat's workflow: its task list, what it is doing now and its result.
// Usage: node chats.cjs [projects folder] [--paused=<json>] [--finished=<json>] [--self=<id>]. Only new bytes of a transcript are read;
// what was read so far is kept in a cache file in the temp folder.
// CHAT_FLOW_NOW=<ms> fixes the clock and CHAT_FLOW_CACHE=<file> the cache (tests).
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { C, short, kit, wrap } = require('./kit.cjs')

const ARGS = process.argv.slice(2)
const ROOT = ARGS.find(a => !a.startsWith('--')) || path.join(os.homedir(), '.claude', 'projects')
// chats paused from the pane: { [transcript id]: { at, resumed? } } (ms)
const PAUSED = (() => {
  const arg = ARGS.find(a => a.startsWith('--paused='))
  try { return arg ? JSON.parse(arg.slice('--paused='.length)) : {} } catch { return {} }
})()
const RESUME_GRACE_MS = 60 * 1000
// chats the pane saw finish and you have not marked Seen: { [transcript id]: finished at (ms) }
const FINISHED = (() => {
  const arg = ARGS.find(a => a.startsWith('--finished='))
  try { return arg ? JSON.parse(arg.slice('--finished='.length)) : {} } catch { return {} }
})()
const CACHE = process.env.CHAT_FLOW_CACHE || path.join(os.tmpdir(), 'chat-flow-cache.json')
const NOW = Number(process.env.CHAT_FLOW_NOW) || Date.now()
const VERSION = 7
const MAX_AGE = 14 * 24 * 3600 * 1000 // chats quiet for longer are left out
const STALL_MS = 15 * 60 * 1000 // a turn with no writes for this long counts as stopped
const NEW_MS = 10 * 60 * 1000
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

function readJson(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null }
}

const base = p => String(p || '').split(/[\\/]/).filter(Boolean).pop() || ''

// the text a person typed, without the app's tags around pasted or attached content
function promptText(content) {
  let s = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b && b.type === 'text').map(b => b.text).join(' ') : ''
  s = s.replace(/<(system-reminder|command-[a-z-]+|local-command-[a-z]+)>[\s\S]*?<\/\1>/g, ' ')
  s = s.replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, ' [pasted text] ')
  s = s.replace(/<[^>]{1,80}>/g, ' ')
  return s.replace(/\s+/g, ' ').trim()
}

// one line for a tool call: "Bash · List files", "Edit · register.tsx"
function toolLabel(name, input) {
  input = input || {}
  if (name.startsWith('mcp__')) {
    const parts = name.split('__')
    name = parts.slice(2).join(' ').replace(/_/g, ' ') || parts[1]
  }
  const say = input.description || input.file_path && base(input.file_path) || input.pattern || input.query || input.skill || input.url || input.command || input.prompt || ''
  return say ? `${name} · ${String(say).replace(/\s+/g, ' ')}` : name
}

function blank() {
  return {
    off: 0, title: null, cwd: null, firstTs: 0, lastTs: 0, prompts: 0, lastPrompt: '', tools: 0, edits: 0,
    files: [], lastTool: null, pending: null, ended: true, turnErrors: 0, lastError: null, steps: [], plans: 0,
    recap: null, ask: null, stopped: false, recent: [], promptTs: 0, cost: 0, costBase: 0, runCost: 0,
  }
}

// apply one update_plan call to the task list
function plan(a, input) {
  if (Array.isArray(input.items)) {
    a.plans++
    a.steps = input.items.map(it => ({ text: String(it.content || ''), status: it.status || 'pending' }))
    return
  }
  const st = a.steps
  if (input.advance) {
    const i = st.findIndex(s => s.status === 'in_progress')
    if (i >= 0) st[i].status = 'completed'
    const j = st.findIndex((s, k) => k > i && s.status === 'pending')
    if (j >= 0) st[j].status = 'in_progress'
  }
  for (const n of input.done || []) if (st[n - 1]) st[n - 1].status = 'completed'
  if (input.start && st[input.start - 1]) {
    for (const s of st) if (s.status === 'in_progress') s.status = 'completed'
    st[input.start - 1].status = 'in_progress'
  }
}

function eat(a, o) {
  const ts = o.timestamp ? Date.parse(o.timestamp) : 0
  if (ts) {
    if (!a.firstTs) a.firstTs = ts
    if (ts > a.lastTs) a.lastTs = ts
  }
  if (o.type === 'custom-title' && o.customTitle) a.title = o.customTitle
  else if (o.type === 'cost-state' && typeof o.totalCostUSD === 'number') {
    if (o.totalCostUSD < a.runCost) a.costBase += a.runCost
    a.runCost = o.totalCostUSD
    a.cost = a.costBase + a.runCost
  }
  else if (o.type === 'system' && o.subtype === 'stop_hook_summary' && !o.isSidechain) {
    a.ended = true
    a.pending = null
    for (const x of a.recent) if (x.state === 'run') x.state = 'ok'
  } else if (o.type === 'user' && !o.isSidechain && o.message) {
    if (o.cwd && !a.cwd) a.cwd = o.cwd
    const c = o.message.content
    const results = Array.isArray(c) ? c.filter(b => b && b.type === 'tool_result') : []
    if (results.length) {
      a.pending = null
      for (const r of results) {
        const done = a.recent.find(x => x.id === r.tool_use_id)
        if (done) done.state = r.is_error ? 'fail' : 'ok'
        if (r.is_error) {
          a.turnErrors++
          const t = Array.isArray(r.content) ? r.content.map(b => b.text || '').join(' ') : String(r.content || '')
          a.lastError = t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
        }
      }
    } else if (!o.isMeta && !o.isCompactSummary && (!o.origin || o.origin.kind === 'human')) {
      const text = promptText(c)
      if (text.startsWith('[Request interrupted')) {
        a.ended = true
        a.pending = null
        a.stopped = true
      } else if (text) {
        a.stopped = false
        a.prompts++
        a.promptTs = ts || a.lastTs
        a.lastPrompt = text.slice(0, 300)
        a.ended = false
        a.turnErrors = 0
        a.lastError = null
        a.recap = null
        a.ask = null
      }
    }
  } else if (o.type === 'assistant' && !o.isSidechain && o.message && Array.isArray(o.message.content)) {
    a.ended = false
    for (const b of o.message.content) {
      if (!b || b.type !== 'tool_use') continue
      const name = String(b.name || '')
      const input = b.input || {}
      if (name.endsWith('update_plan')) { plan(a, input); continue }
      if (name.endsWith('wrap_up')) {
        for (const s of a.steps) s.status = 'completed'
        a.recap = input.recap || null
        a.ask = input.ask || null
        continue
      }
      a.tools++
      a.lastTool = toolLabel(name, input)
      a.pending = { name, at: ts || a.lastTs }
      // the latest actions, newest last, for the detailed card
      a.recent = [...a.recent, { id: b.id, at: ts || a.lastTs, label: a.lastTool, state: 'run' }].slice(-14)
      if (EDIT_TOOLS.has(name) && input.file_path) {
        a.edits++
        const f = base(input.file_path)
        a.files = [f, ...a.files.filter(x => x !== f)].slice(0, 300)
      }
    }
  }
}

// read the transcript's new complete lines into its accumulator
function scan(file, size, a) {
  if (size < a.off) a = blank()
  if (size === a.off) return a
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(size - a.off)
    fs.readSync(fd, buf, 0, buf.length, a.off)
    const end = buf.lastIndexOf(10)
    if (end < 0) return a
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      eat(a, o)
    }
    a.off += end + 1
  } finally {
    fs.closeSync(fd)
  }
  return a
}

function collect() {
  const old = readJson(CACHE)
  const cache = old && old.v === VERSION ? old.files : {}
  const fresh = {}
  const chats = []
  for (const dir of fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : []) {
    const full = path.join(ROOT, dir)
    let names = []
    try { names = fs.readdirSync(full).filter(n => n.endsWith('.jsonl')) } catch { continue }
    for (const n of names) {
      const file = path.join(full, n)
      let st
      try { st = fs.statSync(file) } catch { continue }
      if (NOW - st.mtimeMs > MAX_AGE) continue
      const a = scan(file, st.size, cache[file] || blank())
      fresh[file] = a
      if (!a.prompts) continue
      chats.push({ id: n.replace(/\.jsonl$/, ''), mtime: st.mtimeMs, ...a })
    }
  }
  try { fs.writeFileSync(CACHE, JSON.stringify({ v: VERSION, files: fresh })) } catch {}
  return chats
}

function statusOf(c) {
  const quiet = NOW - Math.max(c.mtime, c.lastTs)
  const p = PAUSED[c.id]
  if (p && !p.resumed && !(c.promptTs > p.at)) return 'paused'
  if (p && p.resumed && (c.ended || c.lastTs <= p.resumed) && NOW - p.resumed < RESUME_GRACE_MS) return 'resuming'
  if (!c.ended && quiet < STALL_MS) return c.pending && c.pending.name === 'AskUserQuestion' ? 'needs' : 'working'
  // a question left at the end of a turn counts as going on for an hour
  if (c.ask && quiet < 3600 * 1000) return 'asks'
  // a finished workflow stays until you press Seen on it
  if (FINISHED[c.id]) return 'finished'
  if (c.steps.length && c.steps.every(s => s.status === 'completed')) return 'done'
  if (c.stopped) return 'stopped'
  return 'idle'
}

const hhmm = t => {
  const d = new Date(t)
  const p = n => String(n).padStart(2, '0')
  const sameDay = new Date(NOW).toDateString() === d.toDateString()
  return sameDay ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getDate()}.${d.getMonth() + 1} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// split text into at most `lines` lines of `n` characters
function wrapText(s, n, lines) {
  const words = String(s || '').split(' ')
  const out = []
  let cur = ''
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > n) {
      if (cur) out.push(cur)
      cur = w
      if (out.length === lines) break
    } else cur = (cur + ' ' + w).trim()
  }
  if (out.length < lines && cur) out.push(cur)
  if (out.length === lines && words.join(' ').length > out.join(' ').length) out[lines - 1] = short(out[lines - 1] + ' …', n)
  return out.map(l => short(l, n))
}

const LOOK = {
  working: { stroke: C.or, pill: 'WORKING', fill: C.or, ink: '#2a1a12' },
  needs: { stroke: C.am, pill: 'NEEDS YOU', fill: C.am, ink: '#2a1f0c' },
  asks: { stroke: C.am, pill: 'YOUR CALL', fill: C.bg, ink: C.am },
  finished: { stroke: C.gr, pill: '✓ FINISHED', fill: C.grb, ink: C.grl },
  paused: { stroke: C.mu, pill: '⏸ PAUSED', fill: C.card, ink: C.tx },
  resuming: { stroke: C.or, pill: '▶ RESUMING', fill: C.orb, ink: C.orl },
}

const hms = t => {
  const d = new Date(t)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// How much each card shows: fewer active chats leave room for more of each.
function detailFor(n) {
  return {
    actions: n <= 1 ? 12 : n === 2 ? 8 : n <= 4 ? 5 : 3,
    promptLines: n <= 2 ? 3 : 1,
    files: n <= 2,
  }
}

// Draws one chat's card and returns where its content ends. With h = 0 it only
// measures (the frame needs the height, which needs the content).
function drawCard(k, c, x, y, w, h, detail) {
  const { out, T, R, flow, particle, spinner, dots, ring } = k
  const look = LOOK[c.status]
  const live = c.status === 'working'
  if (h) {
    if (live) R(x - 4, y - 4, w + 8, h + 8, { rx: 15, fill: 'none', stroke: C.or, anim: '<animate attributeName="stroke-opacity" values="0.6;0;0.6" dur="2.4s" repeatCount="indefinite"/>' })
    R(x, y, w, h, { rx: 12, stroke: look.stroke, sw: live || c.status === 'needs' ? 1.8 : 1.1, fill: live ? 'url(#gMain)' : 'url(#gCard)', filter: live ? 'gOr' : c.status === 'finished' ? 'gGr' : undefined, pulse: c.status === 'needs' ? '1.2s' : c.status === 'finished' ? '3s' : undefined, title: `${c.title}\n${c.cwd || ''}\nsession ${c.id}` })
  }
  // a wide card puts the recent actions in a column beside the task list
  const split = w >= 900
  const lw = split ? Math.round(w * 0.56) : w
  const cpl = Math.floor((lw - 70) / 6.9)

  // header: status dot, title, pill
  const cx = x + 22, cy = y + 22
  out.push(`<circle cx="${cx}" cy="${cy}" r="9" fill="${look.stroke}" stroke="${look.stroke}"/>`)
  if (live) { ring(cx, cy, 9, 16, C.or, '1.6s'); spinner(cx, cy, '#2a1a12', 4.5) }
  else T(cx, cy + 4, c.status === 'paused' ? '❚❚' : c.status === 'resuming' ? '▶' : '!', { anchor: 'middle', size: c.status === 'paused' ? 8 : 11, w: 800, fill: '#1f140f' })
  const pw = look.pill.length * 7 + 20
  R(x + w - pw - 12, y + 12, pw, 19, { rx: 9.5, fill: look.fill, stroke: look.stroke })
  T(x + w - 12 - pw / 2, y + 25.5, look.pill, { anchor: 'middle', size: 9.5, w: 800, fill: look.ink, ls: 0.9 })
  if (NOW - c.firstTs < NEW_MS) {
    R(x + w - pw - 60, y + 12, 42, 19, { rx: 9.5, fill: C.orb, stroke: C.or })
    T(x + w - pw - 39, y + 25.5, 'NEW', { anchor: 'middle', size: 9.5, w: 800, fill: C.orl, ls: 0.9 })
  }
  T(x + 40, y + 26, short(`${c.num} · ${c.title}`, Math.floor((w - pw - 120) / 7.2)), { size: 13.5, w: 700, fill: live ? C.orl : C.tx })
  const meta = [base(c.cwd) || c.cwd || '', `${c.prompts} prompt${c.prompts === 1 ? '' : 's'}`, `${c.tools} actions`, c.edits ? `${c.files.length} file${c.files.length === 1 ? '' : 's'} edited` : null, c.cost ? '$' + c.cost.toFixed(2) : null, `last ${hhmm(c.lastTs || c.mtime)}`].filter(Boolean).join(' · ')
  T(x + 40, y + 43, short(meta, Math.floor((w - 56) / 6)), { size: 11, fill: C.mu })
  const asked = wrapText(c.lastPrompt, Math.floor((w - 84) / 6.9), detail.promptLines)
  T(x + 16, y + 66, 'ASKED', { size: 9.5, w: 800, fill: C.dim, ls: 1 })
  asked.forEach((l, i) => T(x + 58, y + 66 + i * 16, (i === 0 ? '“' : '') + l + (i === asked.length - 1 ? '”' : ''), { size: 11.5, fill: C.tx }))
  const top = y + 66 + 16 * Math.max(0, asked.length - 1) + 20

  // the task list as a chain of steps
  let sy = top
  const iw = lw - 28 // inner width of the left column
  if (!c.steps.length) {
    out.push(`<circle cx="${x + 30}" cy="${sy + 8}" r="8" fill="${C.bg}" stroke="${C.line}" stroke-dasharray="2 2"/>`)
    T(x + 48, sy + 12, live ? 'No task list yet: quick question or still planning' : 'No task list in this chat', { size: 11.5, fill: C.mu })
    sy += 26
  }
  const activeIdx = c.steps.findIndex(s => s.status === 'in_progress')
  c.steps.forEach((s, i) => {
    const ry = sy + i * 26
    const isNow = s.status === 'in_progress'
    const done = s.status === 'completed'
    if (i < c.steps.length - 1) {
      const d = `M${x + 30} ${ry + 17} L${x + 30} ${ry + 26 + 1}`
      out.push(`<path d="${d}" stroke="${done ? C.gr : C.line}" stroke-width="1.4" fill="none"/>`)
      if (live && done && i === activeIdx - 1) particle(d, C.grl, '0.9s', '0s', 2)
    }
    if (isNow) R(x + 14, ry - 4, iw, 24, { rx: 7, fill: C.orb, stroke: live ? C.or : C.line, pulse: live ? true : undefined })
    out.push(`<circle cx="${x + 30}" cy="${ry + 8}" r="8.5" fill="${done ? C.gr : isNow ? C.or : C.card}" stroke="${done ? C.gr : isNow ? C.or : C.line}"/>`)
    if (isNow && live) ring(x + 30, ry + 8, 8.5, 14, C.or, '1.6s')
    T(x + 30, ry + 12, done ? '✓' : String(i + 1), { anchor: 'middle', size: 10, w: 800, fill: done || isNow ? '#1f140f' : C.mu })
    T(x + 48, ry + 12.5, short(s.text + (isNow && !live ? (c.status === 'paused' ? '  · paused here' : '  · stopped here') : ''), cpl - (isNow ? 6 : 0)), { size: 12, w: isNow ? 600 : 400, fill: done ? C.grl : isNow ? C.orl : C.mu })
    if (isNow && live) spinner(x + 14 + iw - 18, ry + 8, C.or, 6)
  })
  sy += 26 * c.steps.length
  if (c.plans > 1) {
    T(x + 48, sy + 6, short(`↻ task list #${c.plans} of this chat · the earlier ones were finished or replaced`, cpl), { size: 10.5, fill: C.dim })
    sy += 16
  }
  sy += 14

  // what it is doing now, or what it waits on
  if (c.status === 'paused' || c.status === 'resuming') {
    const isPaused = c.status === 'paused'
    R(x + 14, sy - 6, iw, 26, { rx: 7, fill: C.bg, stroke: isPaused ? C.mu : C.or, dash: '4 3' })
    T(x + 24, sy + 11, isPaused ? 'PAUSED' : 'RESUMING', { size: 9.5, w: 800, fill: isPaused ? C.tx : C.or, ls: 1 })
    T(x + (isPaused ? 76 : 90), sy + 11, short(isPaused ? `paused ${hms(PAUSED[c.id].at)} · press Resume ${c.num} above to continue` : 'asked it to continue where it left off', cpl - 14), { size: 11.5, fill: isPaused ? C.mu : C.orl })
    if (!isPaused) dots(x + 14 + iw - 30, sy + 7, C.or)
    sy += 34
  } else if (live || c.status === 'needs') {
    const color = live ? C.or : C.am
    R(x + 14, sy - 6, iw, 26, { rx: 7, fill: C.bg, stroke: color, dash: '4 3', anim: live ? '<animate attributeName="stroke-dashoffset" values="14;0" dur="0.8s" repeatCount="indefinite"/>' : '' })
    T(x + 24, sy + 11, live ? 'NOW' : 'ASKING', { size: 9.5, w: 800, fill: color, ls: 1 })
    T(x + (live ? 58 : 72), sy + 11, short(live ? c.lastTool || 'thinking' : 'Waiting for your answer in that chat', cpl - 12), { size: 11.5, fill: live ? C.orl : C.am })
    if (live) dots(x + 14 + iw - 30, sy + 7, C.or)
    sy += 34
  } else {
    const isFinished = c.status === 'finished'
    T(x + 16, sy + 6, isFinished ? 'RESULT' : 'YOUR CALL', { size: 9.5, w: 800, fill: isFinished ? C.gr : C.am, ls: 1 })
    const lines = isFinished
      ? (c.recap ? wrapText(c.recap, cpl, detail.promptLines + 2) : [short(c.lastTool ? 'last action: ' + c.lastTool : 'answered without tools', cpl)])
      : c.recap ? [...wrapText(c.recap, cpl, detail.promptLines + 1), short('→ ' + c.ask, cpl)] : wrapText(c.ask || '', cpl, 2)
    lines.forEach((l, i) => T(x + 16, sy + 24 + i * 16, l, { size: 11.5, fill: i === lines.length - 1 && c.recap && !isFinished ? C.am : C.tx }))
    sy += 20 + 16 * lines.length
  }
  if (c.turnErrors) {
    R(x + 14, sy - 4, iw, 20, { rx: 6, fill: live ? C.rdb : C.bg, stroke: live ? C.rd : C.line })
    T(x + 24, sy + 10, short(`✗ ${c.turnErrors} failed action${c.turnErrors > 1 ? 's' : ''} this turn${c.lastError ? ': ' + c.lastError : ''}`, cpl + 2), { size: 11, fill: live ? C.rdl : C.mu })
    sy += 24
  }
  if (live && activeIdx >= 0) {
    // energy flowing from the card's status dot into the step being worked on
    const d = `M${x + 8} ${cy} L${x + 8} ${top + activeIdx * 26 + 8} L${x + 20} ${top + activeIdx * 26 + 8}`
    flow(d, C.or, '0.8s')
    particle(d, C.orl, '1.4s', '0s', 2.4)
  }

  // the latest actions and the files edited: beside the steps when wide, else below
  const ax = split ? x + lw + 8 : x
  const aw = split ? w - lw - 8 : w
  const acpl = Math.floor((aw - 110) / 6.2)
  let ay = split ? top : sy + 6
  const recent = (c.recent || []).slice(-detail.actions)
  if (recent.length) {
    if (split) out.push(`<path d="M${ax - 4} ${top - 4} L${ax - 4} ${Math.max(sy, top + 30 + recent.length * 19) - 10}" stroke="${C.line}" stroke-width="1" stroke-dasharray="2 4"/>`)
    T(ax + 16, ay + 6, 'RECENT ACTIONS', { size: 9.5, w: 800, fill: C.dim, ls: 1 })
    ay += 16
    recent.forEach((r, i) => {
      const ry = ay + i * 19
      const running = r.state === 'run' && live && i === recent.length - 1
      T(ax + 16, ry + 12, hms(r.at), { size: 10.5, fill: C.dim })
      if (running) spinner(ax + 76, ry + 8, C.or, 5)
      else T(ax + 76, ry + 12, r.state === 'fail' ? '✗' : r.state === 'run' ? '·' : '✓', { anchor: 'middle', size: 11, w: 800, fill: r.state === 'fail' ? C.rd : r.state === 'run' ? C.mu : C.gr })
      T(ax + 90, ry + 12, short(r.label, acpl), { size: 11, fill: r.state === 'fail' ? C.rdl : running ? C.orl : C.tx })
    })
    ay += recent.length * 19 + 8
  }
  if (detail.files && c.files.length) {
    T(ax + 16, ay + 6, 'FILES EDITED', { size: 9.5, w: 800, fill: C.dim, ls: 1 })
    wrapText(c.files.slice(0, 12).join(', ') + (c.files.length > 12 ? ` +${c.files.length - 12} more` : ''), Math.floor((aw - 32) / 6.2), 2)
      .forEach((l, i) => T(ax + 16, ay + 22 + i * 15, l, { size: 11, fill: C.mu }))
    ay += 22 + 15 * Math.min(2, Math.ceil(c.files.join(', ').length / Math.floor((aw - 32) / 6.2)))
  }

  return Math.max(sy, ay)
}

// Each card is its own picture (a tile), so the pane can lay its Pause / Resume
// button over the card's control strip; the header (title, legend, hub) is one more.
const TILE_M = 14 // margin around a card inside its tile
const TILE_TOP = 26 // room above a card for the connector into it
const STRIP = 64 // the control strip at a card's bottom, where the button sits
const TILE_BOTTOM = 6 // room below a card, so the button's offset from the tile's bottom is fixed
const SELF = (ARGS.find(a => a.startsWith('--self=')) || '').slice('--self='.length)
const WAITING = new Set(['needs', 'asks'])

// The card's height: the same layout drawn into a throwaway kit, plus the control strip.
function tileCardHeight(c, w, detail) {
  // a card waiting for you is tall enough for the message drawn over it
  return Math.max(WAITING.has(c.status) ? 230 : 0, drawCard(kit([]), c, 0, 0, w, 0, detail) + 12 + STRIP)
}

function drawTile(c, tw, cardH, tileH, detail, isFirst) {
  const k = kit([])
  const { out, T, R, flow } = k
  const x = TILE_M, y = TILE_TOP, w = tw - 2 * TILE_M
  const live = c.status === 'working'
  const waiting = WAITING.has(c.status)
  // the connector from the hub (first card of a column) or from the card above
  const d = `M${tw / 2} 0 L${tw / 2} ${y - 4}`
  out.push(`<path d="${d}" stroke="${isFirst && (live || waiting) ? (live ? C.or : C.am) : C.line}" stroke-width="1.3" fill="none" marker-end="url(#${isFirst && live ? 'ao' : 'a'})"/>`)
  if (isFirst && live) flow(d, C.or, '0.8s')
  drawCard(k, c, x, y, w, cardH, detail)

  // the control strip: the pane lays the real button over its right end
  const sy = y + cardH - STRIP
  out.push(`<path d="M${x + 12} ${sy} L${x + w - 12} ${sy}" stroke="${C.line}" stroke-width="1" stroke-dasharray="3 4"/>`)
  T(x + 16, sy + 36, 'CONTROL', { size: 9.5, w: 800, fill: C.dim, ls: 1 })
  const say = c.status === 'finished' ? `finished ${hhmm(FINISHED[c.id])} · press Seen to clear it from here`
    : c.id === SELF ? 'this chat · it cannot pause itself'
    : c.status === 'paused' ? 'paused · Resume continues where it stopped'
      : c.status === 'resuming' ? 'resuming…'
        : waiting ? 'nothing to pause · it waits for you'
          : 'Pause stops its current turn'
  T(x + 76, sy + 36, say, { size: 11, fill: C.mu })

  // a chat waiting for you: a slowly blinking message over the whole card
  if (waiting) {
    const big = c.status === 'needs' ? 'WAITING FOR YOUR ANSWER' : 'WAITING FOR YOUR COMMAND'
    const sub = c.status === 'needs' ? 'It asked you a question. Open the chat to answer.' : (c.ask || 'It finished and waits for what to do next.')
    out.push(`<rect x="${x}" y="${y}" width="${w}" height="${cardH}" rx="12" fill="#1f1708" stroke="${C.am}" stroke-width="3" filter="url(#gOr)"><animate attributeName="fill-opacity" values="0.93;0.62;0.93" dur="3s" repeatCount="indefinite"/><animate attributeName="stroke-opacity" values="1;0.35;1" dur="3s" repeatCount="indefinite"/></rect>`)
    const my = y + cardH / 2
    const size = Math.min(34, Math.max(20, w / 22))
    out.push(`<g><animate attributeName="opacity" values="1;0.3;1" dur="3s" repeatCount="indefinite"/>`)
    T(x + w / 2, my - 18, '⚠', { anchor: 'middle', size: size * 1.2, fill: C.am, w: 800 })
    T(x + w / 2, my + size * 0.55, big, { anchor: 'middle', size, fill: C.am, w: 800, ls: 2 })
    out.push('</g>')
    T(x + w / 2, my + size * 0.55 + 30, `${c.num} · ${short(c.title, 40)}`, { anchor: 'middle', size: 14, fill: C.tx, w: 700 })
    wrapText(sub, Math.floor((w - 60) / 7.2), 2).forEach((l, i) => T(x + w / 2, my + size * 0.55 + 54 + i * 18, l, { anchor: 'middle', size: 13, fill: '#f0d9a8' }))
  }
  return wrap(tw, tileH, out, 0)
}

// The header: title, counts, legend and the hub with its lines down to each column.
function drawHeader(chats, W, cols, quiet) {
  const k = kit([])
  const { out, T, R, flow } = k
  let y = 30
  const working = chats.filter(c => c.status === 'working').length
  const needs = chats.filter(c => WAITING.has(c.status)).length
  T(20, y, 'CLAUDE CODE · ACTIVE CHATS', { size: 12, w: 800, fill: C.or, ls: 1.6 })
  const finished = chats.filter(c => c.status === 'finished').length
  T(W - 20, y, `${working} working${needs ? ` · ${needs} wait${needs === 1 ? 's' : ''} for you` : ''}${finished ? ` · ${finished} finished` : ''} · ${quiet} quiet chat${quiet === 1 ? '' : 's'} hidden`, { size: 12, fill: needs ? C.am : working ? C.orl : C.mu, anchor: 'end', w: 600 })
  y += 24
  const leg = [[C.or, C.orb, 'Working now'], [C.am, C.am, 'Waiting for you'], [C.gr, C.grb, 'Finished, not seen'], [C.mu, C.card, 'Paused'], [C.rd, C.rdb, 'Failure']]
  let lx = 20
  for (const [s, f, l] of leg) {
    R(lx, y - 9, 11, 11, { rx: 3, stroke: s, fill: f, sw: 1.3 })
    T(lx + 16, y, l, { size: 11, fill: C.mu })
    lx += 16 + l.length * 6.3 + 18
  }
  y += 22
  if (!chats.length) {
    R(20, y, W - 40, 90, { rx: 12, dash: '5 4', anim: '<animate attributeName="stroke-dashoffset" values="18;0" dur="2s" repeatCount="indefinite"/>' })
    T(W / 2, y + 40, 'Nothing is running right now', { anchor: 'middle', size: 14, w: 700, fill: C.tx })
    T(W / 2, y + 62, 'Start or continue a chat and its workflow shows up here by itself.', { anchor: 'middle', size: 12, fill: C.mu })
    return { svg: wrap(W, y + 110, out, 0), h: y + 110 }
  }
  const hubW = 250, hx = (W - hubW) / 2
  R(hx, y, hubW, 44, { rx: 11, fill: 'url(#gMain)', stroke: C.or, sw: 1.6, filter: working ? 'gOr' : undefined })
  T(W / 2, y + 19, 'YOU', { anchor: 'middle', size: 10.5, fill: C.or, w: 800, ls: 1.4 })
  T(W / 2, y + 35, 'every new chat lands here by itself', { anchor: 'middle', size: 11, fill: C.tx })
  const hubBottom = y + 44
  const h = hubBottom + 26
  const tw = W / cols
  for (let i = 0; i < Math.min(cols, chats.length); i++) {
    const first = chats[i]
    const tx = tw * i + tw / 2
    const d = `M${W / 2} ${hubBottom} L${W / 2} ${hubBottom + 12} L${tx} ${hubBottom + 12} L${tx} ${h}`
    const color = first.status === 'working' ? C.or : WAITING.has(first.status) ? C.am : first.status === 'finished' ? C.gr : C.line
    out.push(`<path d="${d}" stroke="${color}" stroke-width="1.3" fill="none"/>`)
    if (first.status === 'working') flow(d, C.or, '0.8s')
  }
  return { svg: wrap(W, h, out, 0), h }
}

// The whole picture as tiles: { W, H, header, headerH, cols: [{ w, cards: [{ id, svg, h }], filler }] }
function layout(chats, W, cols, quiet, detail) {
  const header = drawHeader(chats, W, cols, quiet)
  const tw = W / cols
  const placed = Array.from({ length: cols }, () => ({ h: 0, cards: [] }))
  // the first row goes left to right, so the hub's lines meet the first chats in order
  chats.forEach((c, i) => {
    const col = i < cols ? i : placed.indexOf(placed.reduce((a, b) => (b.h < a.h ? b : a)))
    const cardH = tileCardHeight(c, tw - 2 * TILE_M, detail)
    placed[col].cards.push({ c, cardH, isFirst: placed[col].cards.length === 0 })
    placed[col].h += TILE_TOP + cardH + TILE_BOTTOM
  })
  const body = Math.max(0, ...placed.map(p => p.h))
  return {
    W,
    H: header.h + body,
    header: header.svg,
    headerH: header.h,
    cols: placed.filter(p => p.cards.length).map(p => ({
      w: tw,
      cards: p.cards.map(t => {
        const tileH = TILE_TOP + t.cardH + TILE_BOTTOM
        return { id: t.c.id, h: tileH, svg: drawTile(t.c, tw, t.cardH, tileH, detail, t.isFirst) }
      }),
      // an empty tile below a shorter column, so the background stays whole
      filler: body - p.h > 0 ? { h: body - p.h, svg: wrap(tw, body - p.h, [], 0) } : null,
    })),
  }
}

function main() {
  const chats = collect().map(c => ({ ...c, status: statusOf(c), title: c.title || short(c.lastPrompt, 40) || 'Untitled chat' }))
  const rank = { needs: 0, asks: 0, working: 1, resuming: 1, finished: 2, paused: 2, done: 3, idle: 3, stopped: 3 }
  chats.sort((a, b) => rank[a.status] - rank[b.status] || (b.lastTs || b.mtime) - (a.lastTs || a.mtime))
  // only chats with something going on are drawn; the fewer there are, the more each shows
  const active = chats.filter(c => ['working', 'needs', 'asks', 'paused', 'resuming', 'finished'].includes(c.status)).slice(0, 9)
  const quiet = chats.length - active.length
  const n = active.length
  active.forEach((c, i) => { c.num = i + 1 })
  const detail = detailFor(n)
  // both are shrunk to fit the pane whole, so their columns keep them wide rather than tall
  const wideCols = Math.min(Math.max(n, 1), 3)
  const narrowCols = n >= 3 ? 2 : 1
  process.stdout.write(JSON.stringify({
    summary: {
      chats: chats.length,
      working: chats.filter(c => c.status === 'working').length,
      needs: chats.filter(c => WAITING.has(c.status)).length,
      failing: chats.filter(c => c.turnErrors).length,
    },
    running: active.filter(c => c.status === 'working').map(c => `${c.title}: ${c.lastTool || 'thinking'}`).join('; ') || null,
    // what the pane compares to write its activity list
    sigs: chats.map(c => ({
      id: c.id, title: c.title, status: c.status, prompts: c.prompts,
      step: (c.steps.find(s => s.status === 'in_progress') || {}).text || null,
      done: c.steps.filter(s => s.status === 'completed').length, steps: c.steps.length, errors: c.turnErrors,
    })),
    // the chats the pane draws Pause / Resume buttons for, numbered as their cards
    controls: active.map(c => ({ id: c.id, num: c.num, title: c.title, status: c.status, cwd: c.cwd || '', last: c.lastTs || c.mtime })),
    narrow: layout(active, narrowCols === 1 ? 680 : 900, narrowCols, quiet, detail),
    wide: layout(active, n <= 1 ? 1240 : wideCols * 620 + 40, wideCols, quiet, detail),
  }))
}

try { main() } catch (err) { process.stdout.write(JSON.stringify({ error: String(err && err.stack || err).slice(0, 400) })) }
