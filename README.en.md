# 🐾 ccpoke — AI Agent Notification Bridge

[Tiếng Việt](./README.md) · [中文](./README.zh.md)

> Two-way interaction with Claude Code, Codex CLI, Cursor CLI and more via Telegram — code anytime, anywhere.

---

## Problem

You're using Claude Code, Codex CLI or Cursor CLI on your computer. You step away with your phone but have no idea if the AI agent is done yet, and you want to send more prompts without opening your laptop.

**ccpoke** is a two-way bridge between AI agents and Telegram — receive notifications, send prompts, answer questions, manage multiple sessions — all from your phone.

```
AI agent completes response
        ↓
  Stop Hook triggers
        ↓
  ccpoke receives event
        ↓
  Telegram notification 📱
```

## Supported Agents

| | Claude Code | Codex CLI | Cursor CLI |
|---|---|---|---|
| Telegram notifications | ✅ macOS · Linux · Windows | ✅ macOS · Linux · Windows | ✅ macOS · Linux · Windows |
| 2-way chat (Telegram ↔ Agent) | ✅ macOS · Linux | ✅ macOS · Linux | ✅ macOS · Linux |

Adding new agents is easy via the plugin architecture — contributions welcome!

## Features

- 🔔 **Push notification** — AI agent done → notification pushed instantly, no polling, no delay
- 💬 **Two-way interaction** — chat with your AI agent from Telegram, view sessions, send prompts, answer questions, approve permissions
- 🔀 **Multi-session** — manage multiple AI agent sessions simultaneously, switch quickly, parallel monitoring

## Requirements

- **Node.js** ≥ 20
- **tmux** — required for two-way interaction (auto-installed on first run)
- **Telegram Bot Token** — create from [@BotFather](https://t.me/BotFather)

## Getting Started

### Option 1: npx (zero install)

```bash
npx -y ccpoke
```

First run → auto setup → start bot. One command, that's it.

### Option 2: Global install (recommended — faster startup)

```bash
npm i -g ccpoke
ccpoke
```

The setup wizard will guide you step by step:

```
┌  🤖 ccpoke setup
│
◇  Language
│  English
│
◇  Telegram Bot Token
│  your-bot-token
│
◇  ✓ Bot: @your_bot
│
◇  Scan QR or open link to connect:
│  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
│  █ ▄▄▄▄▄ █▄▄████▀ ▄██▄▄█ ▄▄▄▄▄ █
│  █ █   █ █ ▀█ ▄▄▄▄▀▀▄▀ █ █   █ █
│  █ █▄▄▄█ █▄ ▄▄▀▄▀██▄  ▄█ █▄▄▄█ █
│  █▄▄▄▄▄▄▄█▄▀▄▀▄▀ █▄▀▄█▄█▄▄▄▄▄▄▄█
│  ...
│  █▄▄▄▄▄▄▄█▄███▄█▄███▄▄▄▄███▄█▄██
│  https://t.me/your_bot?start=setup
│
◇  Waiting for you to send /start to the bot...
│
◆  ✓ Connected! User ID: 123456789
│
◇  Select AI agents (space to toggle)
│  Claude Code, Codex CLI, Cursor CLI
│
◆  Config saved
◆  Hook installed for Claude Code
◆  Hook installed for Codex CLI
◆  Hook installed for Cursor CLI
◆  Chat ID registered
│
└  🎉 Setup complete!
```


## Usage

### Start the bot

```bash
# npx (zero install)
npx -y ccpoke

# Or global install
ccpoke

```

Once running, use Claude Code / Codex CLI / Cursor CLI as usual → notifications will arrive on Telegram.

### View multi-agent sessions

When running multiple agents in parallel, ccpoke creates a tmux session to manage them. To view:

```bash
# Regular terminal
tmux attach

# iTerm2 (native integration)
tmux -CC attach
```

### Register Projects

Register projects to create new agent sessions directly from Telegram — no need to open your computer.

**Step 1: Add a project via CLI**

```bash
ccpoke project
```

```
┌  📂 Manage Projects
│
◇  Select action
│  ➕ Add new project
│
◇  Project path
│  /path/to/your/project
│
◇  Project name
│  my-project
│
└  ✅ Added: my-project → /path/to/your/project
```

**Step 2: Create agent sessions from Telegram**

Send `/projects` on Telegram → pick a project → choose agent (Claude Code / Codex CLI / Cursor CLI) → agent starts in a new tmux pane.

### Telegram Commands

| Command     | Description                                         |
|-------------|-----------------------------------------------------|
| `/start`    | Re-register chat (auto during setup, rarely needed) |
| `/sessions` | View active AI agent sessions                       |
| `/projects` | View project list and start new sessions            |

### Sample Notification

```
🤖 Claude Code Response
📂 my-project | ⏱ 45s

Fixed authentication bug in login.go. Main changes:
- Fix missing error check at line 42
- Add input validation...
```

## Security & Tunnel

ccpoke uses **Cloudflare Quick Tunnel** so that agent hooks from Docker containers or remote machines can reach the local server. Key security notes:

- **Hook endpoints (internal)** — only used by agents calling back to ccpoke, protected by `X-CCPoke-Secret` (auto-generated, crypto hex random). Missing or wrong secret → `403 Forbidden`.
- **Response endpoint protected by UUID v4** — IDs use `randomUUID()` (122-bit entropy, ~5.3 × 10³⁶ combinations), brute-force is infeasible. Responses auto-expire after 24h.
- **Quick Tunnel URL is random** — format `https://random-words.trycloudflare.com`, changes on every restart, not fixed or publicly listed.

## Uninstall

```bash
ccpoke uninstall
```

```
┌  🗑️  Uninstalling ccpoke
│
◆  Hook removed from Claude Code
◆  Hook removed from Codex CLI
◆  Hook removed from Cursor CLI
◆  Removed ~/.ccpoke/ (config, state, hooks)
│
└  ccpoke uninstalled
```

## License

MIT

## Contributors
<a href="https://github.com/lethai2597">
  <img src="https://github.com/lethai2597.png" width="50" />
</a>
<a href="https://github.com/kaida-palooza">
  <img src="https://github.com/kaida-palooza.png" width="50" />
</a>
<a href="https://github.com/nghia1303">
  <img src="https://github.com/nghia1303.png" width="50" />
</a>
<a href="https://github.com/kabuto-png">
  <img src="https://github.com/kabuto-png.png" width="50" />
</a>
