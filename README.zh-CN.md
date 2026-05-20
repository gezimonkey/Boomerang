# 🪃 Boomerang Notifier（中文说明）
<p align="center">
  <img src="assets/logo.png" width="128" alt="Boomerang Logo" />
</p>

Boomerang Notifier 是一个 VS Code / Cursor 插件，用于在 AI 代码生成或聊天输出结束时，通过多种通知渠道把提醒发送给你。

## ✨ 功能特性

- 检测编辑器改动与聊天生成结束事件。
- 支持多通道推送：PushPlus、Server酱 Turbo、Webhook 通道、Bark、WxPusher、ntfy.sh、Telegram。
- 支持在 `targetValue` 中通过 `main|your_keyword` 附加关键词（适配机器人关键词安全策略）。
- 当通道配置缺失或无效时，会在界面中给出明确提示，避免卡在“发送中”状态。
- 状态栏一键开启/关闭监控。
- 支持带 emoji 的友好界面提示，并支持英文/简体中文自动切换。

## ⚙️ 配置项

在设置里搜索 `boomerang`：

- `boomerang.pushChannel`  
  选择推送通道。
- `boomerang.targetValue`  
  通道目标值，支持 `main|keyword` 格式。
- `boomerang.idleTimeout`  
  静止阈值（毫秒）。
- `boomerang.notificationTemplate`  
  完成通知模板（支持 `{source}` 占位符）。

## 🚀 使用方法

1. 安装插件。
2. 配置 `boomerang.pushChannel` 和 `boomerang.targetValue`。
3. 在命令面板执行 `Boomerang: Toggle Monitoring`。
4. 开始 AI 编码/对话任务。
5. 当 AI 输出结束后，插件会自动发送通知。

## 🛠️ 调试排查

如果没有收到通知：

1. 打开 `View: Output`。
2. 选择输出通道 `Boomerang`。
3. 检查日志中的响应信息（`status`、`errcode`、`errmsg`）。


## ☕️ 支持作者 (Support)

Boomerang 是一款免费开源的插件，致力于为你节省盯着屏幕发呆的时间。
如果这个插件让你少熬了几个夜，或者让你安心地去喝了杯咖啡，欢迎请作者喝杯咖啡！你的支持是我持续维护和开发新功能的动力。

<a href="https://ko-fi.com/gezimonkey" target="_blank"><img src="https://storage.ko-fi.com/cdn/kofi2.png?v=3" alt="Buy Me a Coffee at ko-fi.com" height="45" style="border:0px;height:45px;" /></a>

<br><br>
<img src="https://raw.githubusercontent.com/gezimonkey/Boomerang/main/assets/weixin.jpg" width="300" alt="微信打赏">