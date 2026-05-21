# 🪃 Boomerang Notifier
<p align="center">
  <img src="assets/logo.png" width="128" alt="Boomerang Logo" />
</p>
<p align="center">
  <a href="https://github.com/gezimonkey/Boomerang/stargazers"><img src="https://img.shields.io/github/stars/gezimonkey/Boomerang?style=flat-square&color=blue" alt="GitHub stars"></a>
  <a href="https://github.com/gezimonkey/Boomerang/network/members"><img src="https://img.shields.io/github/forks/gezimonkey/Boomerang?style=flat-square&color=blue" alt="GitHub forks"></a>
  <a href="https://github.com/gezimonkey/Boomerang/issues"><img src="https://img.shields.io/github/issues/gezimonkey/Boomerang?style=flat-square&color=blue" alt="GitHub issues"></a>
  <a href="https://github.com/gezimonkey/Boomerang/blob/main/LICENSE"><img src="https://img.shields.io/github/license/gezimonkey/Boomerang?style=flat-square&color=blue" alt="License"></a>
</p>

<p align="center">
  <a href="https://star-history.com/#gezimonkey/Boomerang&Date">
    <img src="https://api.star-history.com/svg?repos=gezimonkey/Boomerang&type=Date" alt="Star History Chart" width="500">
  </a>
</p>

Boomerang Notifier is a VS Code / Cursor extension that alerts you when AI output is complete through multiple notification channels.

For Chinese documentation, see [README.zh-CN.md](./README.zh-CN.md).

## ✨ Features

- Detects AI activity from editor changes and chat generation events.
- Sends notifications via multiple channels: PushPlus, ServerChan Turbo, Webhook channel, Bark, WxPusher, ntfy.sh, and Telegram.
- Supports keyword suffix in `targetValue` with format `main|your_keyword`.
- Shows clear in-app warnings when channel config is invalid or missing.
- One-click monitoring control from the status bar with friendly emoji UI messages.
- English and Simplified Chinese UI messages (auto-detected from IDE language).

## 🧩 Compatibility

- VS Code `< 1.90` is not supported.
- On VS Code, Boomerang supports chat lifecycle signals from:
  - `GitHub Copilot Chat.log` (`exthost/GitHub.copilot-chat/GitHub Copilot Chat.log`)
  - `Codex.log` (`exthost/openai.chatgpt/Codex.log`)
- Claude local sessions:
  - `~/.claude/projects/**/*.jsonl` (new file = session start; appended lines = activity; idle timeout = session end)

## ⚙️ Configuration

Set these in Settings (search `boomerang`):

- `boomerang.pushChannel`  
  Select your push channel.
- `boomerang.targetValue`  
  Channel target value. Supports `main|keyword`.
- `boomerang.idleTimeout`  
  Idle timeout threshold in milliseconds.
- `boomerang.claudeIdleSeconds`  
  Claude JSONL session idle timeout in seconds (default `600`).
- `boomerang.notificationTemplate`  
  Custom completion notification template (`{source}` supported).

## 🚀 Usage

1. Install the extension.
2. Configure `boomerang.pushChannel` and `boomerang.targetValue`.
3. Run `Boomerang: Toggle Monitoring` from Command Palette.
4. Start an AI coding/chat task.
5. When AI output ends, Boomerang sends a notification via your configured channel.

## 🛠️ Debugging

If notifications are not delivered:

1. Open `View: Output`.
2. Select `Boomerang` in the channel dropdown.
3. Check webhook response logs (`status`, `errcode`, `errmsg`).


## ☕️ Support the Author

Boomerang is a free and open-source extension. If it has saved you from staring at the screen for hours and allowed you to grab a coffee in peace, consider buying me one! Your support is my motivation to keep maintaining and developing new features.

<a href="https://ko-fi.com/gezimonkey" target="_blank"><img src="https://storage.ko-fi.com/cdn/kofi2.png?v=3" alt="Buy Me a Coffee at ko-fi.com" height="45" style="border:0px;height:45px;" /></a>

<br><br>
<img src="https://raw.githubusercontent.com/gezimonkey/Boomerang/main/assets/weixin.jpg" width="300" alt="WeChat Donation">