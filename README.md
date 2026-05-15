# 🪃 Boomerang Notifier

Boomerang Notifier is a VS Code / Cursor extension that alerts you on your phone when AI output is complete.

For Chinese documentation, see [README.zh-CN.md](./README.zh-CN.md).

## ✨ Features

- Detects AI activity from editor changes and chat generation events.
- Sends notifications via multiple channels: PushPlus, ServerChan Turbo, Webhook channel, Bark, WxPusher, ntfy.sh, and Telegram.
- Supports keyword suffix in `targetValue` with format `main|your_keyword`.
- Shows clear in-app warnings when channel config is invalid or missing.
- One-click monitoring control from the status bar with friendly emoji UI messages.
- English and Simplified Chinese UI messages (auto-detected from IDE language).

## ⚙️ Configuration

Set these in Settings (search `boomerang`):

- `boomerang.pushChannel`  
  Select your push channel.
- `boomerang.targetValue`  
  Channel target value. Supports `main|keyword`.
- `boomerang.idleTimeout`  
  Idle timeout threshold in milliseconds.
- `boomerang.notificationTemplate`  
  Custom completion notification template (`{source}` supported).
- `boomerang.slowNotificationTemplate`  
  Custom slow-response notification template (`{source}` supported).

## 🚀 Usage

1. Install the extension.
2. Configure `boomerang.pushChannel` and `boomerang.targetValue`.
3. Run `Boomerang: Toggle Monitoring` from Command Palette.
4. Start an AI coding/chat task.
5. When AI output ends, Boomerang sends a webhook notification.

## 🛠️ Debugging

If notifications are not delivered:

1. Open `View: Output`.
2. Select `Boomerang` in the channel dropdown.
3. Check webhook response logs (`status`, `errcode`, `errmsg`).
