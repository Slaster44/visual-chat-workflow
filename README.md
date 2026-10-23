# Visual chat workflow

A Claude Code mod that adds a live pane showing the workflow of every Claude Code chat you have going.

- Each active chat gets its own box with its plan steps, its current action, recent actions, edited files and cost. The boxes get more detailed when fewer chats are active.
- A chat waiting for your answer gets a slowly blinking message over its whole box.
- **Pause** and **Resume** buttons sit inside each working chat's box (in the Claude desktop app).
- A finished workflow stays as a green box with its result until you press **Seen** on it.
- Everything fits the pane without scrolling. Idle chats are left out.

It reads the chat history files in `~/.claude/projects` on your own computer, so it costs no tokens.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install chat-flow --marketplace slaster44/visual-chat-workflow
```

Answer `y` to add the marketplace, then pick a scope. The pane opens when a session starts. You can also open it with `/chat-flow`.

Needs Node.js on your PATH.
