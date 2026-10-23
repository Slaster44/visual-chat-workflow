import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'chat-flow',
  component: 'Pane',
  requestId: 'chat-flow',
  props: {
    title: 'All chats workflow',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SIG = { id: 'a', title: 'Crypto bot', status: 'working', prompts: 2, step: 'Test the bot', done: 1, steps: 3, errors: 0 }
// the run as the engine stamps it; the test reads only the command's name
const RUN = { command: 'chat-flow', args: '' } as never
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 20"><rect width="10" height="10" fill="#d97757"/></svg>'
// a layout of one column with a card per chat, as the reader prints it
const tiles = (chats: { id: string }[]) => ({
  W: 10, H: 20, header: SVG, headerH: 5,
  cols: [{ w: 10, cards: chats.map(c => ({ id: c.id, svg: SVG, h: 10 })), filler: null }],
})

function answer(sigs: (typeof SIG)[]) {
  return JSON.stringify({
    summary: { chats: sigs.length, working: 1, needs: 0, failing: 0 },
    running: 'Crypto bot: Bash · Run tests',
    sigs,
    narrow: tiles(sigs),
    wide: tiles(sigs),
  })
}

test('the pane shows every chat and logs what changes', async ($, on) => {
  let out = answer([SIG])
  on('command.register', () => ({ value: { command: 'chat-flow' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(RUN)
  // a new chat opens and the first one moves to its next step
  out = answer([{ ...SIG, step: 'Ship it', done: 2 }, { ...SIG, id: 'b', title: 'Stream setup' }])
  await $.command.run(RUN)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /LIVE · 2 chats · 1 working/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /New chat: Stream setup/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Crypto bot: Ship it/ })).toBeTruthy()
    if (surface !== 'terminal') expect(await ui.find({ type: 'Svg' })).toBeTruthy()
    await ui.unmount()
  }
  const wide = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 220, scroll: { offset: 0, bodyRows: 50 } } })
  expect(await wide.find({ type: 'Text', text: /^LIVE ACTIVITY$/ })).toBeTruthy()
  await wide.unmount()
})
