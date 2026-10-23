import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'chat-flow',
  component: 'Pane',
  requestId: 'chat-flow',
  surface: 'desktop',
  props: {
    title: 'All chats workflow',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const RUN = { command: 'chat-flow', args: '' } as never
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 20"><rect width="10" height="10"/></svg>'
const BOT = { id: 'bot-transcript', num: 1, title: 'Crypto bot', cwd: 'D:\\bot', last: 5_000 }
const tiles = { W: 10, H: 20, header: SVG, headerH: 5, cols: [{ w: 10, cards: [{ id: BOT.id, svg: SVG, h: 10 }], filler: null }] }

// the reader: the bot works, then its turn ends; it shows as finished while the pane passes a mark for it
function answer(isDone: boolean, args: readonly string[]) {
  const isMarked = args.some(a => a.startsWith('--finished=') && a.includes(BOT.id))
  const status = !isDone ? 'working' : isMarked ? 'finished' : 'done'
  const shown = status !== 'done'

  return JSON.stringify({
    summary: { chats: 1, working: isDone ? 0 : 1, needs: 0, failing: 0 },
    running: null,
    controls: shown ? [{ ...BOT, status }] : [],
    sigs: [{ id: BOT.id, title: BOT.title, status, prompts: 1, step: null, done: 0, steps: 0, errors: 0 }],
    narrow: shown ? tiles : { ...tiles, cols: [] },
    wide: shown ? tiles : { ...tiles, cols: [] },
  })
}

test('a finished workflow stays until Seen is pressed', async ($, on) => {
  let isDone = false
  let lastArgs: readonly string[] = []
  on('command.register', () => ({ value: { command: 'chat-flow' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.after', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    lastArgs = e.argv

    return { value: { exitCode: 0, stdout: answer(isDone, e.argv), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(RUN)
  isDone = true
  await $.command.run(RUN) // sees the turn end and marks it finished
  await $.command.run(RUN) // draws it as finished

  let ui = await $.ui.mount(PANE as never)
  expect(await ui.find({ type: 'Button', text: /Seen 1/ })).toBeTruthy()
  await ui.press({ key: 'ctl-bot-transcript' } as never)
  await ui.unmount()
  expect(lastArgs.find(a => a.startsWith('--finished='))).toBe('--finished={}')

  ui = await $.ui.mount(PANE as never)
  expect(await ui.find({ type: 'Button', text: /Seen 1/ })).toBeFalsy()
  await ui.unmount()
})
