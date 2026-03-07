# 🐾 ccpoke — Cầu nối thông báo AI Agent

[English](./README.en.md) · [中文](./README.zh.md)

> Tương tác 2 chiều với Claude Code, Codex CLI, Cursor CLI và nhiều AI agent khác qua Telegram — lập trình mọi lúc mọi nơi.

---

## Vấn đề giải quyết

Bạn đang dùng Claude Code, Codex CLI hoặc Cursor CLI trên máy tính. Ra ngoài cầm điện thoại nhưng không biết AI agent đã xong chưa, muốn gửi thêm yêu cầu mà không cần mở laptop.

**ccpoke** là cầu nối 2 chiều giữa AI agent và Telegram — nhận thông báo, gửi yêu cầu, trả lời câu hỏi, quản lý nhiều phiên làm việc — tất cả từ điện thoại.

```
AI agent hoàn thành phản hồi
        ↓
  Stop Hook kích hoạt
        ↓
  ccpoke nhận sự kiện
        ↓
  Thông báo Telegram 📱
```

## Agent hỗ trợ

| | Claude Code | Codex CLI | Cursor CLI |
|---|---|---|---|
| Thông báo Telegram | ✅ macOS · Linux · Windows | ✅ macOS · Linux · Windows | ✅ macOS · Linux · Windows |
| Trò chuyện 2 chiều (Telegram ↔ Agent) | ✅ macOS · Linux | ✅ macOS · Linux | ✅ macOS · Linux |

Thêm agent mới qua kiến trúc plugin — hoan nghênh đóng góp!

## Tính năng

- 🔔 **Thông báo đẩy** — AI agent xong → Telegram nhận tin ngay, không cần kiểm tra liên tục, không trễ
- 💬 **Tương tác 2 chiều** — trò chuyện với AI agent từ Telegram, xem phiên làm việc, gửi yêu cầu, trả lời câu hỏi, phê duyệt quyền
- 🔀 **Đa phiên** — quản lý nhiều phiên AI agent cùng lúc, chuyển đổi nhanh, giám sát song song

## Yêu cầu

- **Node.js** ≥ 20
- **tmux** — cần cho tương tác 2 chiều (tự cài khi chạy lần đầu)
- **Telegram Bot Token** — tạo từ [@BotFather](https://t.me/BotFather)

## Bắt đầu

### Cách 1: npx (không cần cài đặt)

```bash
npx -y ccpoke
```

Lần đầu chạy → tự động thiết lập → khởi động bot. Một lệnh duy nhất.

### Cách 2: Cài đặt toàn cục (khuyến nghị — khởi động nhanh hơn)

```bash
npm i -g ccpoke
ccpoke
```

Trình hướng dẫn cài đặt sẽ dẫn bạn từng bước:

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
◇  Chọn AI agents (ấn cách để chọn)
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


## Sử dụng

### Khởi động bot

```bash
# npx (không cần cài đặt)
npx -y ccpoke

# Hoặc cài đặt toàn cục
ccpoke

```

Bot chạy xong → dùng Claude Code / Codex CLI / Cursor CLI bình thường → thông báo tự đến Telegram.

### Xem phiên làm việc đa agent

Khi chạy nhiều agent song song, ccpoke tạo phiên tmux để quản lý. Để xem:

```bash
# Cửa sổ dòng lệnh thường
tmux attach

# iTerm2 (tích hợp gốc)
tmux -CC attach
```

### Đăng ký dự án

Đăng ký dự án để tạo phiên agent mới trực tiếp từ Telegram — không cần mở máy tính.

**Bước 1: Thêm dự án qua dòng lệnh**

```bash
ccpoke project
```

```
┌  📂 Quản lý dự án
│
◇  Chọn thao tác
│  ➕ Thêm dự án mới
│
◇  Đường dẫn dự án
│  /path/to/your/project
│
◇  Tên dự án
│  my-project
│
└  ✅ Đã thêm: my-project → /path/to/your/project
```

**Bước 2: Tạo phiên agent từ Telegram**

Gửi `/projects` trên Telegram → chọn dự án → chọn agent (Claude Code / Codex CLI / Cursor CLI) → agent khởi chạy trong ô tmux mới.

### Lệnh Telegram

| Lệnh        | Chức năng                                                   |
|-------------|-------------------------------------------------------------|
| `/start`    | Đăng ký lại cuộc trò chuyện (tự động khi cài đặt, ít cần)  |
| `/sessions` | Xem danh sách phiên AI agent đang hoạt động                 |
| `/projects` | Xem danh sách dự án và mở phiên mới                         |

### Thông báo mẫu

```
🤖 Phản hồi Claude Code
📂 my-project | ⏱ 45 giây

Đã sửa lỗi xác thực trong login.go. Thay đổi chính:
- Sửa thiếu kiểm tra lỗi ở dòng 42
- Thêm kiểm tra đầu vào...
```

## Bảo mật & Tunnel

ccpoke sử dụng **Cloudflare Quick Tunnel** để agent hook từ Docker container hoặc máy remote có thể gọi về local server. Một số điểm cần lưu ý:

- **Hook endpoint (nội bộ)** — chỉ dùng để agent gọi về ccpoke, được bảo vệ bởi `X-CCPoke-Secret` (auto-generate, crypto hex random). Thiếu hoặc sai secret → `403 Forbidden`.
- **Response endpoint bảo vệ bằng UUID v4** — ID dùng `randomUUID()` (122-bit entropy, ~5.3 × 10³⁶ tổ hợp), brute-force không khả thi. Response tự expire sau 24h.
- **Quick Tunnel URL ngẫu nhiên** — URL dạng `https://random-words.trycloudflare.com`, thay đổi mỗi lần khởi động, không cố định và không public.

## Gỡ cài đặt

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

## Giấy phép

MIT

## Người đóng góp
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
