# 🐾 ccpoke — AI 代理通知桥接

[English](./README.en.md) · [Tiếng Việt](./README.md)

> 通过 Telegram 与 Claude Code、Codex CLI、Cursor CLI 等 AI 代理双向交互——随时随地编程。

---

## 解决的问题

你在电脑上使用 Claude Code、Codex CLI 或 Cursor CLI。出门只带手机，却不知道 AI 代理是否已完成，想发送更多指令却不想打开电脑。

**ccpoke** 是 AI 代理与 Telegram 之间的双向桥接——接收通知、发送指令、回答问题、管理多个会话——全部通过手机完成。

```
AI 代理完成响应
        ↓
  Stop Hook 触发
        ↓
  ccpoke 接收事件
        ↓
  Telegram 通知 📱
```

## 支持的代理

| | Claude Code | Codex CLI | Cursor CLI |
|---|---|---|---|
| Telegram 通知 | ✅ macOS · Linux · Windows | ✅ macOS · Linux · Windows | ✅ macOS · Linux · Windows |
| 双向聊天 (Telegram ↔ 代理) | ✅ macOS · Linux | ✅ macOS · Linux | ✅ macOS · Linux |

通过插件架构轻松添加新代理——欢迎贡献！

## 功能

- 🔔 **推送通知** — AI 代理完成 → 立即推送通知，无需轮询，无延迟
- 💬 **双向交互** — 从 Telegram 与 AI 代理聊天，查看会话、发送指令、回答问题、审批权限
- 🔀 **多会话** — 同时管理多个 AI 代理会话，快速切换，并行监控

## 前置要求

- **Node.js** ≥ 20
- **tmux** — 双向交互需要（首次运行自动安装）
- **Telegram Bot Token** — 从 [@BotFather](https://t.me/BotFather) 创建

## 快速开始

### 方式一：npx（零安装）

```bash
npx -y ccpoke
```

首次运行 → 自动设置 → 启动机器人。一条命令搞定。

### 方式二：全局安装（推荐——启动更快）

```bash
npm i -g ccpoke
ccpoke
```

设置向导将逐步引导你：

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
◇  选择 AI agents（按空格选择）
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


## 使用方法

### 启动机器人

```bash
# npx（零安装）
npx -y ccpoke

# 或全局安装
ccpoke

```

机器人启动后 → 正常使用 Claude Code / Codex CLI / Cursor CLI → 通知自动发送到 Telegram。

### 查看多代理会话

当多个代理并行运行时，ccpoke 会创建 tmux 会话进行管理。查看方法：

```bash
# 普通终端
tmux attach

# iTerm2（原生集成）
tmux -CC attach
```

### 注册项目

注册项目后，可以直接从 Telegram 创建新的代理会话——无需打开电脑。

**第一步：通过命令行添加项目**

```bash
ccpoke project
```

```
┌  📂 管理项目
│
◇  选择操作
│  ➕ 添加新项目
│
◇  项目路径
│  /path/to/your/project
│
◇  项目名称
│  my-project
│
└  ✅ 已添加: my-project → /path/to/your/project
```

**第二步：从 Telegram 创建代理会话**

在 Telegram 发送 `/projects` → 选择项目 → 选择代理（Claude Code / Codex CLI / Cursor CLI）→ 代理在新的 tmux 面板中启动。

### Telegram 命令

| 命令        | 功能                                          |
|-------------|-----------------------------------------------|
| `/start`    | 重新注册聊天（设置时自动完成，很少需要）      |
| `/sessions` | 查看活跃的 AI 代理会话                        |
| `/projects` | 查看项目列表并启动新会话                      |

### 通知示例

```
🤖 Claude Code 响应
📂 my-project | ⏱ 45秒

修复了 login.go 中的身份验证错误。主要变更：
- 修复第 42 行缺失的错误检查
- 添加输入验证...
```

## 安全与隧道

ccpoke 使用 **Cloudflare Quick Tunnel**，使 Docker 容器或远程机器中的 agent hook 能够访问本地服务器。安全要点：

- **Hook 端点（内部）** — 仅供 agent 回调 ccpoke 使用，由 `X-CCPoke-Secret` 保护（自动生成，加密十六进制随机）。缺少或错误的密钥 → `403 Forbidden`。
- **Response 端点由 UUID v4 保护** — ID 使用 `randomUUID()`（122 位熵，~5.3 × 10³⁶ 种组合），暴力破解不可行。响应在 24 小时后自动过期。
- **Quick Tunnel URL 是随机的** — 格式为 `https://random-words.trycloudflare.com`，每次重启都会变化，不固定且不公开。

## 卸载

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

## 许可证

MIT

## 贡献者
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
