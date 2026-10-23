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
// a layout of one column with a card per chat, as the reader prints it
const tiles = (chats: { id: string }[]) => ({
  W: 10, H: 20, header: SVG, headerH: 5,
  cols: [{ w: 10, cards: chats.map(c => ({ id: c.id, svg: SVG, h: 10 })), filler: null }],
})
const BOT = { id: 'bot-transcript', num: 1, title: 'Crypto bot', cwd: 'D:\\bot', last: 5_000 }

// the reader's answer: the bot paused when the pane passed it a pause mark
function answer(args: readonly string[]) {
  const isPaused = /bot-transcript/.test(args.join(' ')) && !/resumed/.test(args.join(' '))
  const status = isPaused ? 'paused' : 'working'

  return JSON.stringify({
    summary: { chats: 1, working: isPaused ? 0 : 1, needs: 0, failing: 0 },
    running: null,
    controls: [{ ...BOT, status }],
    sigs: [{ id: BOT.id, title: BOT.title, status, prompts: 1, step: null, done: 0, steps: 0, errors: 0 }],
    narrow: tiles([BOT]),
    wide: tiles([BOT]),
  })
}

test('Pause stops the chat in the app and Resume asks it to continue', async ($, on) => {
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  on('command.register', () => ({ value: { command: 'chat-flow' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.after', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_, e) => ({
    value: { exitCode: 0, stdout: answer(e.argv), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('mcp.call', (_, e) => {
    calls.push({ tool: e.tool, args: e.args })
    const text = e.tool === 'list_sessions'
      ? JSON.stringify([
          { sessionId: 'local_other', title: 'Crypto bot', cwd: 'C:\\', lastActivityAt: new Date(1_000_000).toISOString() },
          { sessionId: 'local_bot', title: 'Crypto bot', cwd: 'D:\\bot', lastActivityAt: new Date(5_000).toISOString() },
        ])
      : 'ok (delivery: delivered)'

    return { value: { content: [{ type: 'text', text }], isError: false } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(RUN)

  let ui = await $.ui.mount(PANE as never)
  await ui.press({ key: 'ctl-bot-transcript' } as never)
  await ui.unmount()
  expect(calls.find(c => c.tool === 'stop_session')?.args).toEqual({ session_id: 'local_bot' })

  ui = await $.ui.mount(PANE as never)
  expect(await ui.find({ type: 'Button', text: /Resume 1/ })).toBeTruthy()
  await ui.press({ key: 'ctl-bot-transcript' } as never)
  await ui.unmount()
  expect(calls.find(c => c.tool === 'send_message')?.args).toEqual({ session_id: 'local_bot', message: 'Continue where you left off.' })
})
