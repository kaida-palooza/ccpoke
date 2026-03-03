import{R as s,L as i,E as a,M as n,G as r}from"./MarkdownBody.CgFMBbZr.js";import{u as e}from"./jsxRuntime.module.kJjLVEAC.js";import{k as o}from"./preact.module.EGlgVV74.js";import"./hooks.module.BVG3ayJl.js";/* empty css                          */const c=`# So Sánh Các Platform Bot

## 1. Table cơ bản (3 cột)

| Platform | Độ khó | Tại sao |
|----------|--------|--------|
| **Discord** | ⭐ Dễ | Webhook + event-driven, library Discord.py/discord.js rất tốt |
| **Slack** | ⭐ Dễ | Bolt framework, event streaming rõ ràng |
| **Line** | ⭐⭐ Dễ | Similar to Telegram API structure |

## 2. Table nhiều cột (scroll ngang)

| Tính Năng | Quarkus | Spring Boot | Go | Node.js | Python | Rust | .NET |
|-----------|---------|-------------|-----|---------|--------|------|------|
| Startup Time | ~0.1-0.5s | 5-10s | 0.05-0.2s | 0.3-1s | 0.5-2s | 0.01-0.1s | 2-5s |
| Memory Usage | 50-150 MB | 300-500 MB | 10-50 MB | 50-150 MB | 80-200 MB | 5-30 MB | 100-300 MB |
| Native Image | ✅ Yes (GraalVM) | ✅ Yes | N/A | N/A | N/A | N/A | ✅ AOT |
| Developer Experience | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| Ecosystem | Trung bình | Rất lớn | Lớn | Rất lớn | Rất lớn | Nhỏ | Lớn |
| Concurrency Model | Virtual Threads | Thread Pool | Goroutines | Event Loop | Async/GIL | Async/Tokio | Task-based |

## 3. Table text dài trong cell

| Component | Mô tả chi tiết | Ghi chú |
|-----------|----------------|---------|
| Authentication Service | Xử lý toàn bộ flow đăng nhập bao gồm OAuth2, JWT token generation, refresh token rotation, và session management với Redis cluster | Cần review security audit trước khi deploy production |
| Rate Limiter | Sử dụng sliding window algorithm với Redis sorted sets, hỗ trợ rate limit per-user, per-IP, và per-endpoint với configurable thresholds | Đã benchmark với 10k req/s, p99 < 5ms |
| Message Queue | RabbitMQ với dead letter exchange, retry mechanism exponential backoff, và poison message handling cho reliable message delivery | Migration từ Kafka sang RabbitMQ để giảm operational overhead |

## 4. Table nhỏ (2 cột)

| Key | Value |
|-----|-------|
| Version | 2.4.1 |
| License | MIT |
| Status | Stable |

## 5. Table có code trong cell

| Lệnh | Ý nghĩa | Ví dụ |
|-------|---------|-------|
| \`git rebase -i\` | Interactive rebase | \`git rebase -i HEAD~3\` |
| \`git cherry-pick\` | Áp dụng commit cụ thể | \`git cherry-pick abc123\` |
| \`git bisect\` | Tìm commit gây bug | \`git bisect start\` |
| \`git stash\` | Lưu tạm thay đổi | \`git stash push -m "wip"\` |
| \`git reflog\` | Lịch sử HEAD | \`git reflog show --date=relative\` |

## 6. Table emoji / unicode

| Trạng thái | Icon | Mô tả |
|------------|------|-------|
| Hoàn thành | ✅ 🎉 | Task đã done, đã test kỹ |
| Đang làm | 🔄 ⚡ | Đang trong sprint hiện tại |
| Blocked | 🚫 ❌ | Cần input từ team khác |
| Planning | 📋 💭 | Chưa estimate, cần refinement |
| Bug | 🐛 🔥 | Critical bug cần fix gấp |

## 7. Table số liệu (nhiều số)

| Metric | Q1 2025 | Q2 2025 | Q3 2025 | Q4 2025 | YoY Growth |
|--------|---------|---------|---------|---------|------------|
| MAU | 1,250,000 | 1,480,000 | 1,720,000 | 2,100,000 | +68% |
| DAU | 420,000 | 510,000 | 605,000 | 780,000 | +85.7% |
| Revenue ($) | 125,000 | 180,000 | 245,000 | 310,000 | +148% |
| ARPU ($) | 0.10 | 0.12 | 0.14 | 0.15 | +50% |
| Churn Rate | 8.2% | 7.1% | 5.8% | 4.5% | -45% |
| NPS Score | 42 | 48 | 55 | 62 | +47.6% |

Bạn muốn thêm bot cho platform nào? Mình có thể tạo plan để extend codebase Telegram hiện tại.`,l=[{status:"modified",file:"src/auth/middleware.ts"},{status:"modified",file:"src/auth/token-service.ts"},{status:"added",file:"src/auth/refresh-token.ts"},{status:"added",file:"src/auth/rate-limiter.ts"},{status:"modified",file:"src/routes/api.ts"},{status:"deleted",file:"src/auth/legacy-session.ts"},{status:"modified",file:"package.json"},{status:"renamed",file:"src/auth/index.ts"},{status:"added",file:"tests/auth/token.test.ts"},{status:"added",file:"tests/auth/flow.test.ts"},{status:"modified",file:"src/config/env.ts"}];function f(){const t=new URLSearchParams(window.location.search).get("mode")??"success";return e("div",{class:"rv",children:e("main",{class:"rv__body",children:[e(s,{project:"claudecode-tele",durationMs:6118809,timestamp:"2026-02-21T12:44:19.009Z",model:"claude-sonnet-4-10"}),t==="loading"&&e(i,{}),t==="error"&&e(a,{message:"Dữ liệu response đã hết hạn. Thông tin cơ bản hiển thị ở trên."}),t==="success"&&e(o,{children:[e(n,{content:c}),e(r,{changes:l,locale:"en"})]})]})})}export{f as default};
