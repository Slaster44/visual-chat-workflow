export type FlowEvent = { kind: string; text: string; ts?: string }

export type ChatSig = {
  id: string
  title: string
  status: string
  prompts: number
  step: string | null
  done: number
  steps: number
  errors: number
}

// an active chat the pane draws a Pause / Resume button for, numbered as its card
export type ChatControl = { id: string; num: number; title: string; status: string; cwd: string; last: number }

// chats paused from the pane, by transcript id: when, and when Resume was pressed
export type PauseMark = { at: number; resumed?: number; local: string }

export type FlowSnapshot = {
  summary?: { chats: number; working: number; needs: number; failing: number }
  running?: string | null
  controls?: ChatControl[]
  sigs?: ChatSig[]
  narrow?: Layout
  wide?: Layout
  error?: string
  checkedAt: number
}

// the two picture slots: a new picture loads hidden in the back one, then swaps to the front
export type Pictures = { slots: [Picture | null, Picture | null]; front: number }
export type Picture = { narrow: Layout; wide: Layout }

// the picture as tiles, in SVG units: the header, then columns of cards, each its own SVG
// so its Pause / Resume button can sit on it
export type Tile = { svg: string; h: number }
export type Layout = {
  W: number
  H: number
  header: string
  headerH: number
  cols: { w: number; cards: (Tile & { id: string })[]; filler: Tile | null }[]
}

declare module 'claude-code' {
  interface PluginState {
    'chat-flow': { snapshot: FlowSnapshot | null; log: FlowEvent[]; zoom: number; pics: Pictures; paused: Record<string, PauseMark>; finished: Record<string, number> }
  }
}
