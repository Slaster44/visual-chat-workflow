import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ChatControl, ChatSig, FlowEvent, FlowSnapshot, Layout, PauseMark, Picture } from '../types'

const PANE = 'chat-flow'
const TITLE = 'All chats workflow'

const snapshot = atom({ plugin: 'chat-flow', key: 'snapshot' } as const, null)
const log = atom({ plugin: 'chat-flow', key: 'log' } as const, [])
const zoom = atom({ plugin: 'chat-flow', key: 'zoom' } as const, 1)
const paused = atom({ plugin: 'chat-flow', key: 'paused' } as const, {})
// chats seen finishing, kept on the page until you press Seen: transcript id -> finished at
const finished = atom({ plugin: 'chat-flow', key: 'finished' } as const, {})
const BUSY = new Set(['working', 'needs', 'asks', 'paused', 'resuming'])
const pics = atom({ plugin: 'chat-flow', key: 'pics' } as const, { slots: [null, null], front: 0 })

// Every new picture reloads its frame and restarts its animations, which flickers.
// So a new picture loads hidden in the back slot and swaps to the front once it
// has had time to draw, and swaps come at most every few seconds: a burst of
// changes keeps the old picture up and shows only the newest one.
const SWAP_AFTER_MS = 700
const SWAP_GAP_MS = 3000
let swapTimer: { cancel: () => void } | null = null
let lastSwap = 0

async function showPicture($: EngineInterface, pic: Picture) {
  const cur = await read($, pics)
  const front = cur?.front ?? 0
  const shown = cur?.slots[front]
  if (shown && JSON.stringify(shown) === JSON.stringify(pic)) {
    swapTimer?.cancel()
    swapTimer = null

    return
  }
  const back = 1 - front
  if (!shown) {
    await update($, pics, () => ({ slots: front === 0 ? [pic, null] : [null, pic], front }))

    return
  }
  await update($, pics, old => {
    const slots: [Picture | null, Picture | null] = [...(old?.slots ?? [null, null])]
    slots[back] = pic

    return { slots, front }
  })
  swapTimer?.cancel()
  const now = await $.clock.now()
  const wait = Math.max(SWAP_AFTER_MS, lastSwap + SWAP_GAP_MS - now)
  swapTimer = $.clock.after(wait, async () => {
    swapTimer = null
    lastSwap = await $.clock.now()
    await update($, pics, old => ({ slots: old?.slots ?? [null, null], front: back }))
  })
}

const KIND_COLOR: Record<string, string> = {
  work: '#d97757', ok: '#8bbf6e', fail: '#e5634f', warn: '#e3ab4f', info: '#a29f95',
}
const KIND_LABEL: Record<string, string> = {
  work: 'WORK', ok: 'DONE', fail: 'FAIL', warn: 'YOU', info: 'INFO',
}

// What changed across the chats between two reads, as lines for the activity list.
function changes(a: ChatSig[] | undefined, b: ChatSig[]): Omit<FlowEvent, 'ts'>[] {
  if (!a) return [{ kind: 'info', text: `Watching ${b.length} chat${b.length === 1 ? '' : 's'}` }]
  const before = new Map(a.map(s => [s.id, s]))
  const ev: Omit<FlowEvent, 'ts'>[] = []
  for (const s of b) {
    const p = before.get(s.id)
    const name = s.title
    if (!p) {
      ev.push({ kind: 'work', text: `New chat: ${name}` })
      continue
    }
    if (s.prompts > p.prompts) ev.push({ kind: 'info', text: `${name}: you sent a new prompt` })
    if (s.step && s.step !== p.step) ev.push({ kind: 'work', text: `${name}: ${s.step}` })
    if (s.done > p.done && s.steps === p.steps) ev.push({ kind: 'ok', text: `${name}: step ${s.done} of ${s.steps} done` })
    if (s.errors > p.errors) ev.push({ kind: 'fail', text: `${name}: an action failed` })
    if (s.status !== p.status) {
      if (s.status === 'needs') ev.push({ kind: 'warn', text: `${name} is asking you a question` })
      else if (s.status === 'asks') ev.push({ kind: 'warn', text: `${name} finished and waits for your call` })
      else if (s.status === 'done') ev.push({ kind: 'ok', text: `${name} finished its task list` })
      else if (s.status === 'idle' && p.status === 'working') ev.push({ kind: 'info', text: `${name} stopped` })
      else if (s.status === 'working' && p.status !== 'needs') ev.push({ kind: 'work', text: `${name} started working` })
    }
  }

  return ev
}

let inFlight: Promise<void> | null = null

// one read at a time; a caller that comes while one runs waits for that one
function refresh($: EngineInterface) {
  inFlight ??= readOnce($).finally(() => {
    inFlight = null
  })

  return inFlight
}

async function readOnce($: EngineInterface) {
  try {
    const prev = await read($, snapshot)
    const now = await $.clock.now()
    const marks = (await read($, paused)) ?? {}
    const done = (await read($, finished)) ?? {}
    const ran = await $.process.run(['node', `${$.plugin.root}/scripts/chats.cjs`, `--paused=${JSON.stringify(marks)}`, `--finished=${JSON.stringify(done)}`, `--self=${selfId($)}`], { timeoutMs: 20000 })
    let next: FlowSnapshot
    try {
      next = { ...(JSON.parse(ran.stdout) as Omit<FlowSnapshot, 'checkedAt'>), checkedAt: now }
    } catch {
      next = { error: (ran.stderr || ran.stdout || 'The reader printed nothing').slice(0, 300), checkedAt: now }
    }
    if (next.controls) await settle($, next.controls, now)
    if (next.sigs && prev?.sigs) await noteFinished($, prev.sigs, next.sigs, now)
    if (next.sigs) {
      const lines = changes(prev?.sigs, next.sigs)
      if (lines.length) {
        const ts = new Date(now).toISOString()
        await update($, log, old => [...(old ?? []), ...lines.map(l => ({ ...l, ts }))].slice(-40))
      }
    }
    // the pictures live in their own slots, not in the snapshot
    const { narrow, wide } = next
    delete next.narrow
    delete next.wide
    // redraw only when something changed, so the diagram's animations keep running smoothly
    const { checkedAt: _a, ...fresh } = next
    const { checkedAt: _b, ...old } = prev ?? { checkedAt: 0 }
    if (JSON.stringify(fresh) !== JSON.stringify(old)) await update($, snapshot, () => next)
    if (narrow && wide) await showPicture($, { narrow, wide })
  } catch (err) {
    const now = await $.clock.now()
    await update($, snapshot, old => ({ ...(old ?? {}), error: String(err).slice(0, 300), checkedAt: now }))
  }
}

// ---------- pausing and resuming other chats ----------

const SESSIONS = 'ccd_session_mgmt'
const RESUME_TEXT = 'Continue where you left off.'
const RESUME_GRACE_MS = 60 * 1000

// this chat's own transcript id: the session folder the mod was written in
function selfId($: EngineInterface) {
  return /dev-mods[\\/]([0-9a-f-]{36})[\\/]/i.exec($.plugin.root)?.[1] ?? ''
}

type AppSession = { sessionId: string; title: string; cwd?: string; lastActivityAt?: string }
let sessionList: { at: number; list: AppSession[] } | null = null

function textOf(r: { content: { type: string; text?: string }[] }) {
  return r.content.map(b => (b.type === 'text' ? b.text ?? '' : '')).join('\n')
}

// The app's id for a chat, found by its title (and folder and last activity when titles repeat).
async function appIdFor($: EngineInterface, c: ChatControl) {
  const now = await $.clock.now()
  if (!sessionList || now - sessionList.at > 15000) {
    const r = await $.mcp.call(SESSIONS, 'list_sessions', { limit: 60 })
    let list: AppSession[] = []
    try { list = JSON.parse(textOf(r)) as AppSession[] } catch { list = [] }
    sessionList = { at: now, list }
  }
  const same = sessionList.list.filter(s => s.title === c.title)
  const pick = (same.filter(s => !c.cwd || s.cwd === c.cwd).length ? same.filter(s => !c.cwd || s.cwd === c.cwd) : same)
    .sort((a, b) => Math.abs(Date.parse(a.lastActivityAt ?? '') - c.last) - Math.abs(Date.parse(b.lastActivityAt ?? '') - c.last))[0]

  return pick?.sessionId ?? null
}

async function pause($: EngineInterface, c: ChatControl) {
  try {
    const local = await appIdFor($, c)
    if (!local) {
      $.ui.toast(`Couldn't find "${c.title}" in the app's chat list`)
      return
    }
    const r = await $.mcp.call(SESSIONS, 'stop_session', { session_id: local })
    if (r.isError) {
      $.ui.toast(`Couldn't pause "${c.title}": ${textOf(r).slice(0, 160)}`)
      return
    }
    const at = await $.clock.now()
    await update($, paused, old => ({ ...(old ?? {}), [c.id]: { at, local } }))
    $.ui.toast(`Paused "${c.title}"`)
  } catch (err) {
    $.ui.toast(`Couldn't pause "${c.title}": ${String(err).slice(0, 160)}`)
  }
  await refresh($)
}

async function resume($: EngineInterface, c: ChatControl) {
  const mark = ((await read($, paused)) ?? {})[c.id]
  try {
    const local = mark?.local ?? (await appIdFor($, c))
    if (!local) {
      $.ui.toast(`Couldn't find "${c.title}" in the app's chat list`)
      return
    }
    const r = await $.mcp.call(SESSIONS, 'send_message', { session_id: local, message: RESUME_TEXT })
    if (r.isError) {
      $.ui.toast(`Couldn't resume "${c.title}": ${textOf(r).slice(0, 160)}`)
      return
    }
    const resumed = await $.clock.now()
    await update($, paused, old => ({ ...(old ?? {}), [c.id]: { at: mark?.at ?? resumed, local, resumed } }))
    $.ui.toast(`Resumed "${c.title}"`)
  } catch (err) {
    $.ui.toast(`Couldn't resume "${c.title}": ${String(err).slice(0, 160)}`)
  }
  await refresh($)
}

// forget pauses that are over: the chat runs again, or a resume had its minute
async function settle($: EngineInterface, controls: ChatControl[], now: number) {
  const marks = (await read($, paused)) ?? {}
  const keep: Record<string, PauseMark> = {}
  for (const [id, m] of Object.entries(marks)) {
    const c = controls.find(x => x.id === id)
    const isRunning = c?.status === 'working'
    if (m.resumed ? !isRunning && now - m.resumed < RESUME_GRACE_MS : !isRunning) keep[id] = m
  }
  if (Object.keys(keep).length !== Object.keys(marks).length) await update($, paused, () => keep)
}

// a chat that was busy and now is not has finished: keep it until Seen; one busy again drops out
async function noteFinished($: EngineInterface, before: ChatSig[], after: ChatSig[], now: number) {
  const was = new Map(before.map(s => [s.id, s.status]))
  const marks = (await read($, finished)) ?? {}
  const next = { ...marks }
  for (const s of after) {
    const old = was.get(s.id)
    if (BUSY.has(s.status) && s.status !== 'asks') delete next[s.id]
    else if (old && BUSY.has(old) && !BUSY.has(s.status) && s.status !== 'finished') next[s.id] = now
  }
  if (JSON.stringify(next) !== JSON.stringify(marks)) await update($, finished, () => next)
}

async function seen($: EngineInterface, c: ChatControl) {
  await update($, finished, old => {
    const next = { ...(old ?? {}) }
    delete next[c.id]

    return next
  })
  await refresh($)
}

function clock(ts?: string) {
  if (!ts) return '        '
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'chat-flow',
      description: 'Open the live workflow of all your Claude Code chats',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    void refresh($)
    $.clock.every(2000, () => refresh($))

    return started
  })

  on('command.run', { command: 'chat-flow' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await refresh($)

    return { text: 'Showing the workflow of all your chats live in its pane.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const snap = await read($, snapshot)
    const feed: FlowEvent[] = ((await read($, log)) ?? []).slice(-18)
    const sum = snap?.summary
    const status = !snap
      ? 'Reading your chats…'
      : snap.error
        ? `Problem: ${snap.error}`
        : `${sum?.working ? 'LIVE' : 'Quiet'} · ${sum?.chats ?? 0} chats · ${sum?.working ?? 0} working · ${sum?.needs ?? 0} waiting on you`

    if (e.surface === 'desktop' || e.surface === 'vscode' || e.surface === 'mobile') {
      const { Box, Text, Button, Svg } = $.ui.resolve(e)
      const scale = (await read($, zoom)) ?? 1
      // the pane's size in cells, about 8 by 20 CSS pixels each on the graphical surfaces
      const paneW = Math.max(320, (e.props.bodyColumns ?? 100) * 8 - 24)
      // a wide pane (fullscreen) gets two columns of chats with the activity list beside them
      const isWide = paneW >= 1100
      // the whole picture fits the pane, by width and by height, so nothing needs scrolling
      // (the narrow pane keeps room for the header and 3 activity rows above it)
      const paneH = Math.max(240, (e.props.scroll?.bodyRows ?? 50) * 20 - (isWide ? 60 : 150))
      const roomW = isWide ? paneW * 0.78 : paneW
      // SVG units to pixels for a layout: the whole layout fits the room
      const fit = (L: Layout) => Math.max(0.2, Math.min(roomW / L.W, paneH / L.H)) * scale
      const pictures = (await read($, pics)) ?? { slots: [null, null], front: 0 }
      const rows = feed.map((ev, i) => (
        <Text key={`f${i}`} size="footnote">
          <Text color="#77746c" tabular>{clock(ev.ts)} </Text>
          <Text color={KIND_COLOR[ev.kind] ?? '#ece9df'} weight="semibold">
            {(KIND_LABEL[ev.kind] ?? ev.kind.toUpperCase()).padEnd(5, ' ')}{' '}
          </Text>
          <Text color={ev.kind === 'fail' ? '#f08a78' : '#ece9df'}>{ev.text}</Text>
        </Text>
      ))
      const self = selfId($)
      const controls = snap?.controls ?? []
      // a card's Pause / Resume button, laid over the control strip at the card's bottom
      const cardButton = (id: string) => {
        const c = controls.find(x => x.id === id)
        if (!c) return null
        if (c.status === 'finished') return <Button key={`ctl-${c.id}`} variant="primary" label={`✓ Seen ${c.num}`} onPress={() => seen($, c)} />
        if (c.id === self) return null
        if (c.status === 'paused') return <Button key={`ctl-${c.id}`} variant="primary" label={`▶ Resume ${c.num}`} onPress={() => resume($, c)} />
        if (c.status === 'working') return <Button key={`ctl-${c.id}`} label={`⏸ Pause ${c.num}`} onPress={() => pause($, c)} />

        return null
      }
      const alt = `Workflow of all Claude Code chats: ${status}. ${snap?.running ? 'Working now: ' + snap.running : ''}`
      const tiles = (L: Layout, k: number) => {
        const s = fit(L)
        const px = (n: number) => Math.round(n * s)

        return (
          <Box flexDirection="column">
            <Svg key={`head-${k}`} source={L.header} width={px(L.W)} height={px(L.headerH)} isInteractive alt={alt} />
            <Box flexDirection="row">
              {L.cols.map((col, ci) => (
                <Box key={`col-${k}-${ci}`} flexDirection="column">
                  {col.cards.map(card => {
                    const button = cardButton(card.id)

                    return (
                      <Box key={`card-${k}-${card.id}`} position="relative">
                        <Svg source={card.svg} width={px(col.w)} height={px(card.h)} isInteractive alt={alt} />
                        {button && (
                          <Box position="absolute" bottom={1} right={2}>
                            {button}
                          </Box>
                        )}
                      </Box>
                    )
                  })}
                  {col.filler && <Svg key={`fill-${k}-${ci}`} source={col.filler.svg} width={px(col.w)} height={px(col.filler.h)} alt="" />}
                </Box>
              ))}
            </Box>
          </Box>
        )
      }
      const diagram = (
        <Box flexDirection="column">
          {pictures.slots.map((pic, i) => (
            <Box key={`picture-${i}`} display={i === pictures.front ? 'flex' : 'none'}>
              {pic ? tiles(isWide ? pic.wide : pic.narrow, i) : null}
            </Box>
          ))}
        </Box>
      )

      return (
        <Box flexDirection="column" gap="sm">
          <Box flexDirection="row" justifyContent="space-between" alignItems="center">
            <Text size="footnote" color={snap?.error ? '#e5634f' : sum?.working ? '#d97757' : '#a29f95'}>
              {status}
            </Text>
            <Box flexDirection="row" gap="xs" alignItems="center">
              <Text size="caption" color="#a29f95">Size</Text>
              <Button key="zoom-out" label="−" onPress={() => update($, zoom, z => Math.max(0.4, (z ?? 1) - 0.1))} />
              <Button key="zoom-fit" label="Fit" onPress={() => update($, zoom, () => 1)} />
              <Button key="zoom-in" label="+" onPress={() => update($, zoom, z => Math.min(3, (z ?? 1) + 0.1))} />
              <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
            </Box>
          </Box>
          {isWide ? (
            <Box flexDirection="row" gap="lg" alignItems="flex-start" justifyContent="center">
              {diagram}
              <Box flexDirection="column" gap="xs" width="20%">
                <Text size="caption" weight="semibold" color="#d97757">LIVE ACTIVITY</Text>
                {rows}
              </Box>
            </Box>
          ) : (
            <Box flexDirection="column" gap="sm">
              <Text size="caption" weight="semibold" color="#a29f95">LIVE ACTIVITY (newest last)</Text>
              {rows.slice(-3)}
              {diagram}
            </Box>
          )}
        </Box>
      )
    }

    const { Box, Text } = $.ui.resolve(e)
    const room = Math.max(3, (e.viewport?.rows ?? 24) - 4)

    return (
      <Box flexDirection="column">
        <Text color={sum?.working ? '#d97757' : undefined}>{status}</Text>
        {snap?.running && <Text color="#d97757">Working now: {snap.running}</Text>}
        {feed.slice(-room).map((ev, i) => (
          <Text key={`f${i}`}>
            <Text dimColor>{clock(ev.ts)} </Text>
            <Text color={KIND_COLOR[ev.kind]}>{(KIND_LABEL[ev.kind] ?? ev.kind).padEnd(5, ' ')} </Text>
            {ev.text}
          </Text>
        ))}
      </Box>
    )
  })
}
