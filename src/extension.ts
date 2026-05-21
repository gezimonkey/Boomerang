import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { sendBoomerang, type PushChannel } from "./notifier";

type MonitorState = "idle" | "armed" | "monitoring" | "delayed" | "notifying";
type ActivitySource = "editor" | "chat";
type Locale = "en" | "zh-CN";
type IDEType = "vscode" | "cursor";

interface RendererWatcherState {
  filePath: string;
  source: "renderer" | "vscode-copilot-chat-log" | "vscode-codex-log";
  watcher: fs.FSWatcher;
  readOffsetBytes: number;
  pendingLine: string;
  pollTimer: NodeJS.Timeout;
}

interface ClaudeSessionState {
  filePath: string;
  sessionId: string;
  readOffsetBytes: number;
  pendingLine: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
  lastActiveAt: number;
  active: boolean;
  started: boolean;
}

const DEFAULT_EDITOR_IDLE_TIMEOUT_MS = 8000;
const DEFAULT_CLAUDE_IDLE_SECONDS = 600;
const VSCODE_COPILOT_CHAT_IDLE_END_MS = 10 * 60 * 1000;
const VSCODE_COPILOT_INFER_ACTIVE_MAX_AGE_MS = 12000;
const VSCODE_CODEX_STREAM_IDLE_END_MS = 10 * 60 * 1000;
const VSCODE_CODEX_INFER_ACTIVE_MAX_AGE_MS = 12000;
const MAX_RENDERER_SEARCH_DEPTH = 6;
const RENDERER_POLL_INTERVAL_MS = 2000;
const CLAUDE_SCAN_INTERVAL_MS = 2000;
const RENDERER_BOOTSTRAP_READ_BYTES = 256 * 1024;
const TARGET_VALUE_EXAMPLES: Record<PushChannel, string> = {
  "PushPlus": "your_pushplus_token",
  "Server酱 (Turbo版)": "SCTxxxxxxxxxxxxxxxxxxxxx",
  "Webhook 通道（企业微信/钉钉/飞书/Discord/Custom Webhook）": "https://example.com/webhook|your_keyword",
  "Bark": "https://api.day.app/your_device_key",
  "WxPusher": "AT_xxxxxxxxxxxxxxxxx/UID_xxxxxxxxxx",
  "ntfy.sh": "your-topic-name",
  "Telegram": "bot123456:ABCDEF/chat_id"
};
const DEFAULT_HUMOROUS_MESSAGES: Record<Locale, string[]> = {
  "zh-CN": [
    "🪃 AI 已收工，代码新鲜出炉，快来验收一下！（来源：{source}）",
    "☕ 你的 AI 小助手先去续杯了，成果已经放桌上啦！（来源：{source}）",
    "🎉 叮！本轮生成完成，你的灵感和代码都在线！（来源：{source}）",
    "🚀 AI 输出已停稳，准备进入“火眼金睛”验收模式！（来源：{source}）",
    "📦 新结果已打包送达，欢迎随时开箱检查！（来源：{source}）"
  ],
  "en": [
    "🪃 AI has wrapped up. Fresh results are ready for review! ({source})",
    "☕ Your AI teammate grabbed a break. The output is on your desk. ({source})",
    "🎉 Ding! Generation is complete and ready to inspect. ({source})",
    "🚀 Output has landed smoothly. Time for the review pass! ({source})",
    "📦 New result delivered. Open the box and take a look! ({source})"
  ]
};

let monitorState: MonitorState = "idle";
let lastActivitySource: ActivitySource = "chat";
let idleTimer: NodeJS.Timeout | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let rendererWatchers: RendererWatcherState[] = [];
let claudeSessionStates = new Map<string, ClaudeSessionState>();
let claudeScanTimer: NodeJS.Timeout | undefined;
let chatGenerationActive = false;
let vscodeCopilotChatIdleTimer: NodeJS.Timeout | undefined;
let vscodeCodexStreamEndTimer: NodeJS.Timeout | undefined;
let slowNotificationSent = false;
let slowNotificationInFlight = false;
let idleFallbackNotificationSent = false;
let idleFallbackNotificationInFlight = false;
let lastCopilotActivityAt: number = 0;  // 追踪最后一次检测到的 Copilot 活动时间戳

let lastIgnoredLogSignature = "";
let lastIgnoredLogAt = 0;
const locale: Locale = vscode.env.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
let detectedIDEType: IDEType = "vscode";
let userDataPath: string = "";

const TEXT: Record<Locale, Record<string, string>> = {
  "en": {
    monitorEnabled: "🪃 Boomerang: Monitoring enabled.",
    monitorDisabled: "🛑 Boomerang: Monitoring disabled.",
    channelMissing: "⚠️ Boomerang: `boomerang.pushChannel` is not configured.",
    targetMissing: "⚠️ Boomerang: `boomerang.targetValue` is not configured.",
    configInvalid: "⚠️ Boomerang: Channel configuration is invalid. Please check `pushChannel` and `targetValue` examples in Settings.",
    notifySent: "✅ Boomerang: Notification sent.",
    slowNotifySent: "⚠️ Boomerang: Slow response alert sent.",
    idleFallbackNotifySent: "⚠️ Boomerang: Idle fallback alert sent (monitoring continues).",
    notifyFailedPrefix: "❌ Boomerang: Notification failed - ",
    noRenderer: "Boomerang: No available chat lifecycle log found (renderer/Copilot/Codex/Claude); chat completion detection is unavailable.",
    sourceEditor: "Editor",
    sourceChat: "Chat",
    statusIdleText: "$(sleep) Idle",
    statusIdleTooltip: "Click to enable AI completion monitoring",
    statusArmedText: "$(eye) Monitoring On",
    statusArmedTooltip: "Armed and waiting for AI activity",
    statusMonitoringText: "$(sync~spin) AI Running...",
    statusMonitoringTooltip: "AI activity detected, waiting for end event or idle timeout",
    statusDelayedText: "$(warning) AI Delayed",
    statusDelayedTooltip: "AI may be delayed or disconnected; slow response alert has been triggered",
    statusNotifyingText: "$(bell) Sending Notification...",
    statusNotifyingTooltip: "Boomerang is sending notification"
  },
  "zh-CN": {
    monitorEnabled: "🪃 Boomerang: 监控已开启。",
    monitorDisabled: "🛑 Boomerang: 监控已关闭。",
    channelMissing: "⚠️ Boomerang: 未配置 `boomerang.pushChannel`，请先在设置中配置。",
    targetMissing: "⚠️ Boomerang: 未配置 `boomerang.targetValue`，请先在设置中配置。",
    configInvalid: "⚠️ Boomerang: 通道配置无效，请检查设置中的 `pushChannel` 和 `targetValue` 示例。",
    notifySent: "✅ Boomerang: 已发送提醒通知。",
    slowNotifySent: "⚠️ Boomerang: 已发送长耗时提醒。",
    idleFallbackNotifySent: "⚠️ Boomerang: 已发送超长未结束提醒（监控继续）。",
    notifyFailedPrefix: "❌ Boomerang: 通知发送失败 - ",
    noRenderer: "Boomerang: 未发现可用聊天生命周期日志（renderer/Copilot/Codex/Claude），聊天结束检测不可用。",
    sourceEditor: "文档",
    sourceChat: "聊天",
    statusIdleText: "$(sleep) 监控闲置",
    statusIdleTooltip: "点击开启 AI 生成监控",
    statusArmedText: "$(eye) 监控已开启",
    statusArmedTooltip: "监控已武装，等待 AI 活动",
    statusMonitoringText: "$(sync~spin) AI 输出中...",
    statusMonitoringTooltip: "检测到 AI 活动，等待结束事件或静默超时",
    statusDelayedText: "$(warning) AI 长耗时",
    statusDelayedTooltip: "AI 可能出现延迟或连接异常，已触发长耗时提醒",
    statusNotifyingText: "$(bell) 发送通知中...",
    statusNotifyingTooltip: "Boomerang 正在推送消息"
  }
};

function t(key: string): string {
  return TEXT[locale][key] ?? TEXT["en"][key] ?? key;
}

function detectIDEType(): { ide: IDEType; userDataPath: string } {
  const appName = vscode.env.appName.toLowerCase();
  
  // 检测IDE类型
  const isVSCode = appName.includes("visual studio code") || appName.includes("code");
  const isCursor = appName.includes("cursor");
  const ide: IDEType = isCursor ? "cursor" : "vscode";
  
  // 获取AppData路径
  let userDataPath = "";
  const platform = process.platform;
  const userHome = process.env.HOME || process.env.USERPROFILE || "";
  
  if (platform === "win32") {
    const appDataBase = process.env.APPDATA || path.join(userHome, "AppData", "Roaming");
    if (isCursor) {
      userDataPath = path.join(appDataBase, "Cursor");
    } else {
      userDataPath = path.join(appDataBase, "Code");
    }
  } else if (platform === "darwin") {
    if (isCursor) {
      userDataPath = path.join(userHome, "Library", "Application Support", "Cursor");
    } else {
      userDataPath = path.join(userHome, "Library", "Application Support", "Code");
    }
  } else {
    // Linux
    if (isCursor) {
      userDataPath = path.join(userHome, ".config", "Cursor");
    } else {
      userDataPath = path.join(userHome, ".config", "Code");
    }
  }
  
  return { ide, userDataPath };
}

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("Boomerang");
  
  // 检测IDE类型
  const { ide, userDataPath: detectedPath } = detectIDEType();
  detectedIDEType = ide;
  userDataPath = detectedPath;
  
  log("插件激活");
  log(`检测到的IDE: ${detectedIDEType}`);
  log(`用户数据路径: ${userDataPath}`);
  log(`当前窗口工作区: ${vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath).join(" | ") ?? "(none)"}`);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "boomerang.toggleMonitoring";
  updateStatusBar();
  statusBarItem.show();

  const toggleCommand = vscode.commands.registerCommand("boomerang.toggleMonitoring", async () => {
    if (monitorState === "idle") {
      setState("armed");
      startRendererWatchers(context);
      log("监控开启");
      void vscode.window.showInformationMessage(t("monitorEnabled"));
      return;
    }

    disarmMonitoring();
    log("监控关闭");
    void vscode.window.showInformationMessage(t("monitorDisabled"));
  });

  const textChangeListener = vscode.workspace.onDidChangeTextDocument((event) => {
    if (monitorState === "idle" || monitorState === "notifying") {
      return;
    }

    const editorTrack = shouldTrackEditorDocument(event.document);
    if (!editorTrack.track) {
      logIgnoredActivity(`忽略编辑器活动: reason=${editorTrack.reason}, uri=${event.document.uri.toString()}`);
      return;
    }

    registerActivity("editor");
  });

  const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration("boomerang.pushChannel")) {
      return;
    }
    const channel = vscode.workspace.getConfiguration("boomerang").get<PushChannel>("pushChannel");
    if (!channel) {
      return;
    }
    syncTargetValueExample(channel).catch((error) => {
      log(`配置同步错误: ${String(error instanceof Error ? error.message : error)}`);
    });
  });

  const initialChannel = vscode.workspace.getConfiguration("boomerang").get<PushChannel>("pushChannel");
  if (initialChannel) {
    syncTargetValueExample(initialChannel).catch((error) => {
      log(`初始化配置同步错误: ${String(error instanceof Error ? error.message : error)}`);
    });
  }

  context.subscriptions.push(
    toggleCommand,
    textChangeListener,
    configListener,
    statusBarItem,
    outputChannel,
    new vscode.Disposable(() => {
      disarmMonitoring();
    })
  );
}

export function deactivate(): void {
  disarmMonitoring();
}

function registerActivity(source: ActivitySource): void {
  lastActivitySource = source;
  log(`检测到活动: source=${source}`);

  if (source === "chat") {
    // 初始化 Copilot 活动时间戳
    lastCopilotActivityAt = Date.now();
  }

  if (monitorState === "armed") {
    setState("monitoring");
  }

  if (source === "editor") {
    scheduleEditorIdleDetection();
  }
}

function scheduleEditorIdleDetection(): void {
  resetIdleTimer();
  const timeout = getIdleTimeout();
  log(`重置编辑器静默计时器: timeoutMs=${timeout}`);

  idleTimer = setTimeout(() => {
    handleEditorIdleTimeout().catch((error) => {
      log(`编辑器空闲处理错误: ${String(error instanceof Error ? error.message : error)}`);
    });
  }, timeout);
}

async function handleEditorIdleTimeout(): Promise<void> {
  if (monitorState !== "monitoring" || lastActivitySource !== "editor") {
    log(`编辑器计时器触发但条件不满足: state=${monitorState}, lastSource=${lastActivitySource}`);
    return;
  }

  await notifyAndDisarm("editor", "editor-idle-timeout");
}

async function handleChatGenerationEnded(): Promise<void> {
  if (monitorState === "idle" || monitorState === "notifying") {
    log(`忽略聊天结束事件: state=${monitorState}`);
    return;
  }
  await notifyAndDisarm("chat", "renderer-generation-ended");
}

async function notifyAndDisarm(source: ActivitySource, reason: string): Promise<void> {
  log(`触发通知: source=${source}, reason=${reason}`);
  setState("notifying");
  try {
    await sendNotification(source);
  } catch (error) {
    // 理论上 sendNotification 内部已兜底；这里确保任何异常都不会让状态卡在 notifying。
    log(`notifyAndDisarm 兜底异常: ${String(error instanceof Error ? error.message : error)}`);
  } finally {
    disarmMonitoring();
  }
}

async function sendNotification(source: ActivitySource): Promise<void> {
  const channel = vscode.workspace.getConfiguration("boomerang").get<PushChannel>("pushChannel");
  const targetValue = vscode.workspace.getConfiguration("boomerang").get<string>("targetValue", "").trim();
  if (!channel) {
    log("通知失败: pushChannel为空");
    void vscode.window.showWarningMessage(t("channelMissing"));
    return;
  }
  if (!targetValue) {
    log("通知失败: targetValue为空");
    void vscode.window.showWarningMessage(t("targetMissing"));
    return;
  }

  const sourceLabel = source === "editor" ? t("sourceEditor") : t("sourceChat");
  const message = buildNotificationMessage(sourceLabel);

  try {
    const result = await sendBoomerangWithRetry(channel, targetValue, message, 3);
    log(`通知通道响应: channel=${channel}, status=${result.statusCode}, body=${truncateForLog(result.bodyText, 300)}`);
    log("通知发送成功");
    void vscode.window.showInformationMessage(t("notifySent"));
  } catch (error) {
    console.error("[Boomerang] 通知发送失败:", error);
    const message = error instanceof Error ? error.message : String(error);
    log(`通知发送失败: ${message}`);
    if (isConfigurationError(message)) {
      void vscode.window.showWarningMessage(`${t("configInvalid")} (${message})`);
      return;
    }
    void vscode.window.showErrorMessage(`${t("notifyFailedPrefix")}${message}`);
  }
}

async function sendSlowNotification(source: ActivitySource): Promise<void> {
  if (slowNotificationSent || slowNotificationInFlight) {
    return;
  }

  const channel = vscode.workspace.getConfiguration("boomerang").get<PushChannel>("pushChannel");
  const targetValue = vscode.workspace.getConfiguration("boomerang").get<string>("targetValue", "").trim();
  if (!channel || !targetValue) {
    log("长耗时提醒跳过: pushChannel 或 targetValue 未配置");
    void vscode.window.showWarningMessage(!channel ? t("channelMissing") : t("targetMissing"));
    return;
  }

  const sourceLabel = source === "editor" ? t("sourceEditor") : t("sourceChat");
  const message = buildSlowNotificationMessage(sourceLabel);
  slowNotificationInFlight = true;
  try {
    const result = await sendBoomerangWithRetry(channel, targetValue, message, 3);
    slowNotificationSent = true;
    log(`长耗时提醒响应: channel=${channel}, status=${result.statusCode}, body=${truncateForLog(result.bodyText, 300)}`);
    void vscode.window.showWarningMessage(t("slowNotifySent"));
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    log(`长耗时提醒发送失败: ${message}`);
    if (isConfigurationError(message)) {
      void vscode.window.showWarningMessage(`${t("configInvalid")} (${message})`);
      return;
    }
    void vscode.window.showErrorMessage(`${t("notifyFailedPrefix")}${message}`);
  } finally {
    slowNotificationInFlight = false;
  }
}

async function sendIdleFallbackNotification(source: ActivitySource): Promise<void> {
  if (idleFallbackNotificationSent || idleFallbackNotificationInFlight) {
    return;
  }

  const channel = vscode.workspace.getConfiguration("boomerang").get<PushChannel>("pushChannel");
  const targetValue = vscode.workspace.getConfiguration("boomerang").get<string>("targetValue", "").trim();
  if (!channel || !targetValue) {
    log("超长未结束提醒跳过: pushChannel 或 targetValue 未配置");
    void vscode.window.showWarningMessage(!channel ? t("channelMissing") : t("targetMissing"));
    return;
  }

  const sourceLabel = source === "editor" ? t("sourceEditor") : t("sourceChat");
  const message = buildIdleFallbackNotificationMessage(sourceLabel);
  idleFallbackNotificationInFlight = true;
  try {
    const result = await sendBoomerangWithRetry(channel, targetValue, message, 3);
    idleFallbackNotificationSent = true;
    log(`超长未结束提醒响应: channel=${channel}, status=${result.statusCode}, body=${truncateForLog(result.bodyText, 300)}`);
    void vscode.window.showWarningMessage(t("idleFallbackNotifySent"));
  } catch (error) {
    const msg = String(error instanceof Error ? error.message : error);
    log(`超长未结束提醒发送失败: ${msg}`);
    if (isConfigurationError(msg)) {
      void vscode.window.showWarningMessage(`${t("configInvalid")} (${msg})`);
      return;
    }
    void vscode.window.showErrorMessage(`${t("notifyFailedPrefix")}${msg}`);
  } finally {
    idleFallbackNotificationInFlight = false;
  }
}
async function sendBoomerangWithRetry(
  channel: PushChannel,
  targetValue: string,
  message: string,
  maxAttempts: number
): Promise<{ statusCode: number; bodyText: string }> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      log(`发送通知请求: channel=${channel}, attempt=${attempt}/${maxAttempts}`);
      const result = await sendBoomerang(channel, targetValue, message);
      return result;
    } catch (error) {
      lastError = error;
      const transient = isTransientNetworkError(error);
      log(`请求失败: attempt=${attempt}, transient=${transient}, error=${String(error instanceof Error ? error.message : error)}`);
      if (!transient || attempt === maxAttempts) {
        break;
      }
      await sleep(500 * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function startRendererWatchers(context: vscode.ExtensionContext): void {
  stopRendererWatchers();
  const claudeMonitoringReady = startClaudeSessionMonitoring();
  const sessionContext = locateSessionAndWindow(context.logUri.fsPath);
  const rendererLogPaths = discoverRendererLogFiles(context.logUri.fsPath);
  log(`renderer.log候选文件: ${rendererLogPaths.join(" | ") || "(none)"}`);
  const vscodeCopilotChatLogPaths = detectedIDEType === "vscode"
    ? discoverVSCodeCopilotChatLogFiles(userDataPath, sessionContext.sessionDir, sessionContext.windowDirName)
    : [];
  if (vscodeCopilotChatLogPaths.length > 0) {
    log(`VSCode Copilot Chat.log候选文件: ${vscodeCopilotChatLogPaths.join(" | ")}`);
  }
  const vscodeCodexLogPaths = detectedIDEType === "vscode"
    ? discoverVSCodeCodexLogFiles(userDataPath, sessionContext.sessionDir, sessionContext.windowDirName)
    : [];
  if (vscodeCodexLogPaths.length > 0) {
    log(`VSCode Codex.log候选文件: ${vscodeCodexLogPaths.join(" | ")}`);
  }

  const candidateSources = new Map<string, "renderer" | "vscode-copilot-chat-log" | "vscode-codex-log">();
  for (const filePath of rendererLogPaths) {
    candidateSources.set(filePath, "renderer");
  }
  for (const filePath of vscodeCopilotChatLogPaths) {
    if (!candidateSources.has(filePath)) {
      candidateSources.set(filePath, "vscode-copilot-chat-log");
    }
  }
  for (const filePath of vscodeCodexLogPaths) {
    if (!candidateSources.has(filePath)) {
      candidateSources.set(filePath, "vscode-codex-log");
    }
  }

  let inferredChatActive = false;

  for (const [filePath, source] of candidateSources.entries()) {
    try {
      const initialOffset = getFileSize(filePath);
      if (source === "renderer"
        && !inferredChatActive
        && inferChatGenerationActiveFromLog(filePath, source)) {
        inferredChatActive = true;
      }
      const watcher = fs.watch(filePath, (eventType) => {
        if (eventType !== "change") {
          return;
        }
        if (monitorState === "idle" || monitorState === "notifying") {
          return;
        }
        const state = rendererWatchers.find((item) => item.filePath === filePath);
        if (state) {
          consumeRendererLogDelta(state);
        }
      });

      watcher.on("error", (error) => {
        log(`renderer日志监听错误: file=${filePath}, error=${String(error instanceof Error ? error.message : error)}`);
      });

      const pollTimer = setInterval(() => {
        if (monitorState === "idle" || monitorState === "notifying") {
          return;
        }
        const state = rendererWatchers.find((item) => item.filePath === filePath);
        if (state) {
          consumeRendererLogDelta(state);
        }
      }, RENDERER_POLL_INTERVAL_MS);

      rendererWatchers.push({
        filePath,
        source,
        watcher,
        readOffsetBytes: initialOffset,
        pendingLine: "",
        pollTimer
      });
    } catch (error) {
      log(`${source}日志监听初始化失败: file=${filePath}, error=${String(error instanceof Error ? error.message : error)}`);
    }
  }

  if (rendererWatchers.length === 0 && !claudeMonitoringReady) {
    void vscode.window.showWarningMessage(t("noRenderer"));
  } else {
    log(`日志监听已启动: count=${rendererWatchers.length}, claude=${claudeMonitoringReady ? "on" : "off"}`);
    if (monitorState === "armed" && inferredChatActive) {
      chatGenerationActive = true;
      setState("monitoring");
      log("根据历史日志判定: 开启监控时聊天已在生成中");
    }
  }
}

function inferChatGenerationActiveFromLog(
  filePath: string,
  source: "renderer" | "vscode-copilot-chat-log" | "vscode-codex-log"
): boolean {
  const fileSize = getFileSize(filePath);
  if (fileSize <= 0) {
    return false;
  }

  const readStart = Math.max(0, fileSize - RENDERER_BOOTSTRAP_READ_BYTES);
  const bytesToRead = fileSize - readStart;
  if (bytesToRead <= 0) {
    return false;
  }

  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buffer, 0, bytesToRead, readStart);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    let active = false;
    let lastRelevantAt = 0;

    for (const line of lines) {
      if (source === "renderer") {
        const lower = line.toLowerCase();
        const isChatStart = lower.includes("reason=\"agent-loop\"")
          && (lower.includes("composerwakelockmanager") || lower.includes("acquired wakelock") || lower.includes("[buildrequestedmodel]"));
        const isTakingLongerThanExpected = isSlowResponseHintLine(lower);
        const isChatEnd = lower.includes("reason=\"generation-ended\"")
          && (lower.includes("composerwakelockmanager") || lower.includes("released wakelock"));

        if (isChatStart || isTakingLongerThanExpected) {
          active = true;
          continue;
        }
        if (isChatEnd) {
          active = false;
        }
        continue;
      }

      if (source === "vscode-copilot-chat-log") {
        const lower = line.toLowerCase();
        const isChatStart = isVSCodeCopilotChatLogStartLine(lower);
        const isTakingLongerThanExpected = isSlowResponseHintLine(lower);
        const isTerminal = isVSCodeCopilotTerminalLine(lower);
        const isChatActivity = isVSCodeCopilotChatLogActivityLine(lower);
        const eventAt = parseVSCodeLogLineTimestamp(line) ?? Date.now();
        if (isChatStart || isTakingLongerThanExpected) {
          active = true;
          lastRelevantAt = eventAt;
          continue;
        }
        if (isTerminal) {
          active = false;
          lastRelevantAt = eventAt;
          continue;
        }
        if (isChatActivity && active) {
          lastRelevantAt = eventAt;
          continue;
        }
        continue;
      }

      const lower = line.toLowerCase();
      const isCodexStreamActivity = isVSCodeCodexStreamActivityLine(lower);
      const isCodexTerminal = isVSCodeCodexTerminalLine(lower);
      const eventAt = parseVSCodeLogLineTimestamp(line) ?? Date.now();
      if (isCodexStreamActivity) {
        active = true;
        lastRelevantAt = eventAt;
        continue;
      }
      if (isCodexTerminal) {
        active = false;
        lastRelevantAt = eventAt;
      }
    }

    if (source === "vscode-copilot-chat-log") {
      if (!active || lastRelevantAt <= 0) {
        return false;
      }
      return Date.now() - lastRelevantAt <= VSCODE_COPILOT_INFER_ACTIVE_MAX_AGE_MS;
    }
    if (source === "vscode-codex-log") {
      if (!active || lastRelevantAt <= 0) {
        return false;
      }
      return Date.now() - lastRelevantAt <= VSCODE_CODEX_INFER_ACTIVE_MAX_AGE_MS;
    }
    return active;
  } catch (error) {
    log(`历史renderer日志回看失败: file=${filePath}, error=${String(error instanceof Error ? error.message : error)}`);
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close error
      }
    }
  }
}

function consumeRendererLogDelta(state: RendererWatcherState): void {
  const fileSize = getFileSize(state.filePath);
  if (fileSize < state.readOffsetBytes) {
    // 日志轮转或清空
    state.readOffsetBytes = 0;
    state.pendingLine = "";
  }

  const bytesToRead = fileSize - state.readOffsetBytes;
  if (bytesToRead <= 0) {
    return;
  }

  const fd = fs.openSync(state.filePath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buffer, 0, bytesToRead, state.readOffsetBytes);
    state.readOffsetBytes = fileSize;

    const text = state.pendingLine + buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    state.pendingLine = lines.pop() ?? "";

    for (const line of lines) {
      if (state.source === "vscode-copilot-chat-log") {
        processVSCodeCopilotChatLogLine(line);
      } else if (state.source === "vscode-codex-log") {
        processVSCodeCodexLogLine(line);
      } else {
        processRendererLine(line);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

function processRendererLine(line: string): void {
  const lower = line.toLowerCase();
  const isChatStart = lower.includes("reason=\"agent-loop\"")
    && (lower.includes("composerwakelockmanager") || lower.includes("acquired wakelock") || lower.includes("[buildrequestedmodel]"));
  if (isChatStart) {
    chatGenerationActive = true;
    registerActivity("chat");
    log("命中聊天开始事件: renderer agent-loop acquired");
    return;
  }

  const isTakingLongerThanExpected = isSlowResponseHintLine(lower);
  if (isTakingLongerThanExpected) {
    const wasActive = chatGenerationActive;
    chatGenerationActive = true;
    // 兜底场景：如果漏掉了开始事件，遇到“耗时较长”提示时补记为聊天活跃。
    if (!wasActive) {
      registerActivity("chat");
    }
    if (monitorState === "armed" || monitorState === "monitoring") {
      setState("delayed");
    }
    sendSlowNotification("chat").catch((error) => {
      log(`长耗时通知错误: ${String(error instanceof Error ? error.message : error)}`);
    });
    log("命中聊天长耗时提示: taking longer than expected");
    return;
  }

  const isChatEnd = lower.includes("reason=\"generation-ended\"")
    && (lower.includes("composerwakelockmanager") || lower.includes("released wakelock"));
  if (isChatEnd) {
    chatGenerationActive = false;
    log("命中聊天结束事件: renderer generation-ended released");
    handleChatGenerationEnded().catch((error) => {
      log(`聊天生成结束处理错误: ${String(error instanceof Error ? error.message : error)}`);
    });
  }
}

function isSlowResponseHintLine(lowerLine: string): boolean {
  return lowerLine.includes("taking longer than expected");
}

function processVSCodeCopilotChatLogLine(line: string): void {
  const lower = line.toLowerCase();
  if (!isVSCodeCopilotChatLogActivityLine(lower)) {
    return;
  }

  // 记录最后一次活动时间戳（用于更精确的超时判定）
  lastCopilotActivityAt = Date.now();

  const isChatStart = isVSCodeCopilotChatLogStartLine(lower);
  const isRenderCompleted = isVSCodeCopilotRenderCompletedLine(lower);
  const isLikelyWorking = isVSCodeCopilotLikelyWorkingLine(lower);
  if (isChatStart) {
    if (!chatGenerationActive) {
      chatGenerationActive = true;
      registerActivity("chat");
    }
    log("命中VSCode Copilot Chat.log开始事件（发送/思考起点）");
  } else if (!chatGenerationActive && isLikelyWorking) {
    // 兜底：某些版本可能缺失 markdown 起始行，出现明确工作迹象时补记开始。
    chatGenerationActive = true;
    registerActivity("chat");
    log("命中VSCode Copilot工作迹象（兜底补记开始）");
  }

  if (isRenderCompleted) {
    if (!chatGenerationActive && (monitorState === "armed" || monitorState === "monitoring")) {
      // 兜底：即使漏掉开始事件，也在终态时补记一次，以保证完成通知闭环。
      chatGenerationActive = true;
      registerActivity("chat");
      log("命中渲染完成终态，但此前未捕获开始，已兜底补记");
    }
  }

  if (chatGenerationActive && isRenderCompleted) {
    chatGenerationActive = false;
    log("命中VSCode Copilot渲染完成事件（面板已收敛）");
    handleChatGenerationEnded().catch((error) => {
      log(`聊天生成结束处理错误: ${String(error instanceof Error ? error.message : error)}`);
    });
    return;
  }

  const isTakingLongerThanExpected = isSlowResponseHintLine(lower);
  if (isTakingLongerThanExpected) {
    const wasActive = chatGenerationActive;
    chatGenerationActive = true;
    if (!wasActive) {
      registerActivity("chat");
    }
    if (monitorState === "armed" || monitorState === "monitoring") {
      setState("delayed");
    }
    sendSlowNotification("chat").catch((error) => {
      log(`长耗时通知错误: ${String(error instanceof Error ? error.message : error)}`);
    });
    log("命中VSCode Copilot Chat.log长耗时提示: taking longer than expected");
  }
  refreshVSCodeCopilotChatIdleTimer();
}

function isVSCodeCopilotChatLogStartLine(lower: string): boolean {
  return lower.includes("ccreq:")
    && lower.includes(" | markdown")
    && !lower.includes("latest entry:");
}

function isVSCodeCopilotChatLogActivityLine(lower: string): boolean {
  return lower.includes("ccreq:")
    || lower.includes("finish reason:")
    || lower.includes("[messagesapi]")
    || lower.includes("[toolcallingloop]")
    || lower.includes("message 0 returned")
    || lower.includes("requestid:");
}

function isVSCodeCopilotTerminalLine(lower: string): boolean {
  return lower.includes("request done:")
    || lower.includes("finish reason:")
    || lower.includes(" | success |")
    || lower.includes(" | cancelled |")
    || lower.includes(" | failed |");
}

function isVSCodeCopilotRenderCompletedLine(lower: string): boolean {
  return lower.includes("[toolcallingloop] stop hook result: shouldcontinue=false");
}

function isVSCodeCopilotLikelyWorkingLine(lower: string): boolean {
  if (lower.includes("latest entry:")) {
    return false;
  }
  if (isVSCodeCopilotRenderCompletedLine(lower)) {
    return false;
  }
  return (lower.includes("ccreq:") && !isVSCodeCopilotTerminalLine(lower))
    || isVSCodeCopilotEarlyResponseLine(lower)
    || (lower.includes("[messagesapi]") && !lower.includes("finish reason:"))
    || lower.includes("[panel/editagent]");
}

function isVSCodeCopilotEarlyResponseLine(lower: string): boolean {
  if (!lower.includes("ccreq:")) {
    return false;
  }
  // 这些阶段通常出现在真正渲染前，能更早代表“已开始工作”。
  return lower.includes("[progressmessages]")
    || lower.includes("[title]")
    || lower.includes("[copilotlanguagemodelwrapper]");
}

function parseVSCodeLogLineTimestamp(line: string): number | undefined {
  const match = line.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})/);
  if (!match) {
    return undefined;
  }
  const parsed = Date.parse(`${match[1]}T${match[2]}`);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function refreshVSCodeCopilotChatIdleTimer(): void {
  if (vscodeCopilotChatIdleTimer) {
    clearTimeout(vscodeCopilotChatIdleTimer);
    vscodeCopilotChatIdleTimer = undefined;
  }
  vscodeCopilotChatIdleTimer = setTimeout(() => {
    if (!chatGenerationActive || monitorState === "idle" || monitorState === "notifying") {
      return;
    }

    // 双重检查：确认最后活动时间确实超过了阈值，避免轮询延迟导致的误判
    const timeSinceLastActivity = Date.now() - lastCopilotActivityAt;
    if (timeSinceLastActivity < VSCODE_COPILOT_CHAT_IDLE_END_MS) {
      log(`[防护] 活动时间戳检查：仅空闲${timeSinceLastActivity}ms（阈值${VSCODE_COPILOT_CHAT_IDLE_END_MS}ms），继续监控`);
      refreshVSCodeCopilotChatIdleTimer();  // 重新设置计时器
      return;
    }

    log(`VSCode Copilot Chat.log长时间静默（${timeSinceLastActivity}ms），触发兜底提醒但保持监控`);
    if (monitorState === "armed" || monitorState === "monitoring") {
      setState("delayed");
    }
    sendIdleFallbackNotification("chat").catch((error) => {
      log(`超长未结束提醒处理错误: ${String(error instanceof Error ? error.message : error)}`);
    });
    refreshVSCodeCopilotChatIdleTimer();
  }, VSCODE_COPILOT_CHAT_IDLE_END_MS);
}

function processVSCodeCodexLogLine(line: string): void {
  const lower = line.toLowerCase();
  const isStreamActivity = isVSCodeCodexStreamActivityLine(lower);
  const isTerminal = isVSCodeCodexTerminalLine(lower);
  const isTakingLongerThanExpected = isSlowResponseHintLine(lower);

  if (isStreamActivity) {
    if (!chatGenerationActive) {
      chatGenerationActive = true;
      registerActivity("chat");
      log("命中VSCode Codex流式事件（开始/活跃）");
    }
    refreshVSCodeCodexStreamEndTimer();
  }

  if (isTakingLongerThanExpected) {
    // 按 Codex 协议仅将 stream/read 作为生命周期节点；长耗时仅在活跃期告警。
    if (chatGenerationActive && (monitorState === "armed" || monitorState === "monitoring")) {
      setState("delayed");
      sendSlowNotification("chat").catch((error) => {
        log(`Codex长耗时通知错误: ${String(error instanceof Error ? error.message : error)}`);
      });
      log("命中VSCode Codex长耗时提示: taking longer than expected");
    }
  }

  if (chatGenerationActive && isTerminal) {
    chatGenerationActive = false;
    clearVSCodeCodexStreamEndTimer();
    log("命中VSCode Codex终态事件（thread-read-state-changed）");
    handleChatGenerationEnded().catch((error) => {
      log(`聊天生成结束处理错误: ${String(error instanceof Error ? error.message : error)}`);
    });
  }
}

function isVSCodeCodexStreamActivityLine(lower: string): boolean {
  return lower.includes("method=thread-stream-state-changed");
}

function isVSCodeCodexTerminalLine(lower: string): boolean {
  return lower.includes("method=thread-read-state-changed");
}

function refreshVSCodeCodexStreamEndTimer(): void {
  clearVSCodeCodexStreamEndTimer();
  vscodeCodexStreamEndTimer = setTimeout(() => {
    if (!chatGenerationActive || monitorState === "idle" || monitorState === "notifying") {
      return;
    }
    chatGenerationActive = false;
    log("VSCode Codex流式事件静默超过10分钟，判定本轮输出结束");
    handleChatGenerationEnded().catch((error) => {
      log(`Codex静默结束处理错误: ${String(error instanceof Error ? error.message : error)}`);
    });
  }, VSCODE_CODEX_STREAM_IDLE_END_MS);
}

function clearVSCodeCodexStreamEndTimer(): void {
  if (vscodeCodexStreamEndTimer) {
    clearTimeout(vscodeCodexStreamEndTimer);
    vscodeCodexStreamEndTimer = undefined;
  }
}

function startClaudeSessionMonitoring(): boolean {
  stopClaudeSessionMonitoring();
  const claudeProjectsRoot = getClaudeProjectsRoot();
  if (!claudeProjectsRoot || !fs.existsSync(claudeProjectsRoot)) {
    log(`Claude会话目录不存在，跳过监听: ${claudeProjectsRoot || "(empty)"}`);
    return false;
  }

  log(`启动Claude会话监听: root=${claudeProjectsRoot}`);
  scanClaudeSessionFiles(claudeProjectsRoot);
  claudeScanTimer = setInterval(() => {
    if (monitorState === "idle" || monitorState === "notifying") {
      return;
    }
    scanClaudeSessionFiles(claudeProjectsRoot);
  }, CLAUDE_SCAN_INTERVAL_MS);
  return true;
}

function stopClaudeSessionMonitoring(): void {
  if (claudeScanTimer) {
    clearInterval(claudeScanTimer);
    claudeScanTimer = undefined;
  }
  claudeSessionStates.clear();
}

function scanClaudeSessionFiles(claudeProjectsRoot: string): void {
  const files = collectClaudeJsonlFiles(claudeProjectsRoot);
  const seen = new Set(files);

  for (const filePath of files) {
    if (!claudeSessionStates.has(filePath)) {
      claudeSessionStates.set(filePath, {
        filePath,
        sessionId: path.basename(filePath, ".jsonl"),
        readOffsetBytes: 0,
        pendingLine: "",
        lastActiveAt: 0,
        active: false,
        started: false
      });
      log(`发现新的Claude会话文件: session=${path.basename(filePath, ".jsonl")}, file=${filePath}`);
    }

    const state = claudeSessionStates.get(filePath);
    if (state) {
      consumeClaudeJsonlDelta(state);
    }
  }

  for (const [filePath, state] of claudeSessionStates.entries()) {
    if (!seen.has(filePath)) {
      // 文件被删除/轮转时保留最近状态，按空闲超时自然收敛，不立刻触发结束。
      continue;
    }
    if (!state.active || state.lastActiveAt <= 0) {
      continue;
    }
    const idleMs = Date.now() - state.lastActiveAt;
    if (idleMs < getClaudeIdleTimeoutMs()) {
      continue;
    }
    state.active = false;
    const endTs = state.lastTimestamp ?? "(unknown)";
    log(`Claude会话结束(空闲超时): session=${state.sessionId}, lastTimestamp=${endTs}`);
    if (!hasActiveClaudeSessions() && chatGenerationActive) {
      chatGenerationActive = false;
      handleChatGenerationEnded().catch((error) => {
        log(`Claude会话结束处理错误: ${String(error instanceof Error ? error.message : error)}`);
      });
    }
  }
}

function collectClaudeJsonlFiles(rootDir: string): string[] {
  const files: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
        files.push(full);
      }
    }
  }
  return files;
}

function consumeClaudeJsonlDelta(state: ClaudeSessionState): void {
  const fileSize = getFileSize(state.filePath);
  if (fileSize < state.readOffsetBytes) {
    state.readOffsetBytes = 0;
    state.pendingLine = "";
  }
  const bytesToRead = fileSize - state.readOffsetBytes;
  if (bytesToRead <= 0) {
    return;
  }

  const fd = fs.openSync(state.filePath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buffer, 0, bytesToRead, state.readOffsetBytes);
    state.readOffsetBytes = fileSize;

    const text = state.pendingLine + buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    state.pendingLine = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      processClaudeJsonlLine(state, line);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function processClaudeJsonlLine(state: ClaudeSessionState, line: string): void {
  let type = "unknown";
  let tsIso = new Date().toISOString();
  let activeAt = Date.now();

  try {
    const parsed = JSON.parse(line) as { type?: unknown; timestamp?: unknown };
    if (typeof parsed.type === "string" && parsed.type.trim()) {
      type = parsed.type.trim();
    }
    const parsedTs = parseTimestampToIso(parsed.timestamp);
    if (parsedTs) {
      tsIso = parsedTs.iso;
      activeAt = parsedTs.ms;
    }
  } catch {
    // 兼容非JSON行，仍按活跃处理
  }

  if (!state.started) {
    state.started = true;
    state.firstTimestamp = tsIso;
    state.active = true;
    state.lastActiveAt = activeAt;
    state.lastTimestamp = tsIso;
    chatGenerationActive = true;
    registerActivity("chat");
    log(`Claude会话开始: session=${state.sessionId}, firstTimestamp=${state.firstTimestamp}`);
    return;
  }

  state.active = true;
  state.lastActiveAt = activeAt;
  state.lastTimestamp = tsIso;
  log(`Claude会话活跃: session=${state.sessionId}, type=${type}, timestamp=${tsIso}`);

  if (!chatGenerationActive) {
    chatGenerationActive = true;
    registerActivity("chat");
  }
}

function hasActiveClaudeSessions(): boolean {
  for (const state of claudeSessionStates.values()) {
    if (state.active) {
      return true;
    }
  }
  return false;
}

function parseTimestampToIso(value: unknown): { iso: string; ms: number } | undefined {
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) {
      return { iso: new Date(ms).toISOString(), ms };
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // 兼容秒级时间戳
    const ms = value > 1e12 ? value : value * 1000;
    return { iso: new Date(ms).toISOString(), ms };
  }
  return undefined;
}

function getClaudeProjectsRoot(): string {
  const userHome = process.env.HOME || process.env.USERPROFILE || "";
  if (!userHome) {
    return "";
  }
  return path.join(userHome, ".claude", "projects");
}

function discoverRendererLogFiles(baseLogPath: string): string[] {
  const unique = new Set<string>();
  const now = Date.now();
  const recentThresholdMs = 30 * 60 * 1000;

  log(`使用IDE配置 ${detectedIDEType} 发现日志，baseLogPath: ${baseLogPath}`);

  const contextInfo = locateSessionAndWindow(baseLogPath);
  if (contextInfo.sessionDir) {
    log(`检测到会话目录: ${contextInfo.sessionDir}`);
  }
  if (contextInfo.windowDirName) {
    log(`检测到当前窗口目录: ${contextInfo.windowDirName}`);
  }

  // 第一阶段：从baseLogPath向上搜索renderer.log
  let current = baseLogPath;
  for (let i = 0; i <= MAX_RENDERER_SEARCH_DEPTH; i += 1) {
    const candidate = path.join(current, "renderer.log");
    if (fs.existsSync(candidate) && getFileSize(candidate) > 0) {
      unique.add(candidate);
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  // 优先当前窗口族（window12 + window12_wb*），避免监听所有历史窗口日志。
  if (contextInfo.sessionDir && contextInfo.windowDirName) {
    const baseWindowKey = contextInfo.windowDirName.match(/^window\d+/i)?.[0] ?? contextInfo.windowDirName;
    try {
      const children = fs.readdirSync(contextInfo.sessionDir, { withFileTypes: true });
      for (const child of children) {
        if (!child.isDirectory()) {
          continue;
        }
        const nameLower = child.name.toLowerCase();
        const baseLower = baseWindowKey.toLowerCase();
        if (!(nameLower === baseLower || nameLower.startsWith(`${baseLower}_wb`))) {
          continue;
        }
        const rendererPath = path.join(contextInfo.sessionDir, child.name, "renderer.log");
        if (fs.existsSync(rendererPath) && getFileSize(rendererPath) > 0) {
          unique.add(rendererPath);
        }
      }
    } catch (error) {
      log(`扫描当前窗口族失败: dir=${contextInfo.sessionDir}, error=${String(error instanceof Error ? error.message : error)}`);
    }
  }

  // 兜底：若仍为空，扫描会话下最近活跃的 window 日志（最近30分钟）。
  if (unique.size === 0 && contextInfo.sessionDir) {
    try {
      const children = fs.readdirSync(contextInfo.sessionDir, { withFileTypes: true });
      for (const child of children) {
        if (!child.isDirectory() || !child.name.toLowerCase().startsWith("window")) {
          continue;
        }
        const rendererPath = path.join(contextInfo.sessionDir, child.name, "renderer.log");
        const size = getFileSize(rendererPath);
        const mtime = getFileMtimeMs(rendererPath);
        if (size > 0 && mtime > 0 && now - mtime <= recentThresholdMs) {
          unique.add(rendererPath);
        }
      }
    } catch (error) {
      log(`扫描最近活跃window目录失败: dir=${contextInfo.sessionDir}, error=${String(error instanceof Error ? error.message : error)}`);
    }
  }

  // IDE特定的补充搜索策略
  if (unique.size === 0) {
    searchIDESpecificLogPaths(userDataPath, unique, now, recentThresholdMs);
  }

  const result = Array.from(unique).sort((a, b) => getFileMtimeMs(b) - getFileMtimeMs(a));
  for (const filePath of result) {
    const mtime = getFileMtimeMs(filePath);
    log(`renderer候选详情: file=${filePath}, mtime=${mtime > 0 ? new Date(mtime).toISOString() : "unknown"}`);
  }
  return result;
}

function searchIDESpecificLogPaths(
  userDataPath: string,
  unique: Set<string>,
  now: number,
  recentThresholdMs: number
): void {
  log(`执行IDE特定日志搜索: IDE=${detectedIDEType}, basePath=${userDataPath}`);
  
  if (!fs.existsSync(userDataPath)) {
    log(`用户数据路径不存在: ${userDataPath}`);
    return;
  }

  const logsDir = path.join(userDataPath, "logs");
  if (!fs.existsSync(logsDir)) {
    log(`日志目录不存在: ${logsDir}`);
    return;
  }

  try {
    const sessionDirs = fs.readdirSync(logsDir, { withFileTypes: true });
    for (const sessionEntry of sessionDirs) {
      if (!sessionEntry.isDirectory()) {
        continue;
      }
      
      // 匹配时间戳格式的目录（YYYYMMDDTHHMMSS）
      if (!/^\d{8}T\d{6}$/.test(sessionEntry.name)) {
        continue;
      }

      const sessionPath = path.join(logsDir, sessionEntry.name);
      const mtime = getFileMtimeMs(sessionPath);
      
      // 只检查最近30分钟内的会话
      if (mtime > 0 && now - mtime > recentThresholdMs) {
        continue;
      }

      // 搜索该会话下所有window目录下的renderer.log
      try {
        const entries = fs.readdirSync(sessionPath, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || !entry.name.toLowerCase().startsWith("window")) {
            continue;
          }
          
          const rendererPath = path.join(sessionPath, entry.name, "renderer.log");
          const size = getFileSize(rendererPath);
          if (size > 0) {
            unique.add(rendererPath);
            log(`[IDE搜索] 发现renderer.log: ${rendererPath}`);
          }
        }
      } catch (error) {
        log(`[IDE搜索] 扫描会话失败: ${sessionPath}, error=${String(error instanceof Error ? error.message : error)}`);
      }
    }
  } catch (error) {
    log(`[IDE搜索] 扫描logs目录失败: ${logsDir}, error=${String(error instanceof Error ? error.message : error)}`);
  }
}

function discoverVSCodeCopilotChatLogFiles(
  baseUserDataPath: string,
  currentSessionDir?: string,
  currentWindowDirName?: string
): string[] {
  const unique = new Set<string>();
  const logsDir = path.join(baseUserDataPath, "logs");
  if (!fs.existsSync(logsDir)) {
    return [];
  }

  if (currentSessionDir && currentWindowDirName) {
    const baseWindowKey = currentWindowDirName.match(/^window\d+/i)?.[0] ?? currentWindowDirName;
    try {
      const entries = fs.readdirSync(currentSessionDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const nameLower = entry.name.toLowerCase();
        const baseLower = baseWindowKey.toLowerCase();
        if (!(nameLower === baseLower || nameLower.startsWith(`${baseLower}_wb`))) {
          continue;
        }
        const chatLogPath = path.join(
          currentSessionDir,
          entry.name,
          "exthost",
          "GitHub.copilot-chat",
          "GitHub Copilot Chat.log"
        );
        if (getFileSize(chatLogPath) > 0) {
          unique.add(chatLogPath);
        }
      }
    } catch (error) {
      log(`扫描当前会话Copilot Chat.log失败: dir=${currentSessionDir}, error=${String(error instanceof Error ? error.message : error)}`);
    }
    if (unique.size > 0) {
      return Array.from(unique).sort((a, b) => getFileMtimeMs(b) - getFileMtimeMs(a));
    }
  }

  try {
    const sessionDirs = fs.readdirSync(logsDir, { withFileTypes: true });
    let latestSessionPath = "";
    let latestSessionMtime = 0;
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory() || !/^\d{8}T\d{6}$/i.test(sessionDir.name)) {
        continue;
      }
      const sessionPath = path.join(logsDir, sessionDir.name);
      const mtime = getFileMtimeMs(sessionPath);
      if (mtime > latestSessionMtime) {
        latestSessionMtime = mtime;
        latestSessionPath = sessionPath;
      }
    }
    if (!latestSessionPath) {
      return [];
    }
    const windowDirs = fs.readdirSync(latestSessionPath, { withFileTypes: true });
    for (const windowDir of windowDirs) {
      if (!windowDir.isDirectory() || !windowDir.name.toLowerCase().startsWith("window")) {
        continue;
      }
      const chatLogPath = path.join(
        latestSessionPath,
        windowDir.name,
        "exthost",
        "GitHub.copilot-chat",
        "GitHub Copilot Chat.log"
      );
      if (getFileSize(chatLogPath) > 0) {
        unique.add(chatLogPath);
      }
    }
  } catch (error) {
    log(`扫描VSCode logs目录失败: dir=${logsDir}, error=${String(error instanceof Error ? error.message : error)}`);
  }

  return Array.from(unique).sort((a, b) => getFileMtimeMs(b) - getFileMtimeMs(a));
}

function discoverVSCodeCodexLogFiles(
  baseUserDataPath: string,
  currentSessionDir?: string,
  currentWindowDirName?: string
): string[] {
  const unique = new Set<string>();
  const logsDir = path.join(baseUserDataPath, "logs");
  if (!fs.existsSync(logsDir)) {
    return [];
  }

  if (currentSessionDir && currentWindowDirName) {
    const baseWindowKey = currentWindowDirName.match(/^window\d+/i)?.[0] ?? currentWindowDirName;
    try {
      const entries = fs.readdirSync(currentSessionDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const nameLower = entry.name.toLowerCase();
        const baseLower = baseWindowKey.toLowerCase();
        if (!(nameLower === baseLower || nameLower.startsWith(`${baseLower}_wb`))) {
          continue;
        }
        const codexLogPath = path.join(
          currentSessionDir,
          entry.name,
          "exthost",
          "openai.chatgpt",
          "Codex.log"
        );
        if (getFileSize(codexLogPath) > 0) {
          unique.add(codexLogPath);
        }
      }
    } catch (error) {
      log(`扫描当前会话Codex.log失败: dir=${currentSessionDir}, error=${String(error instanceof Error ? error.message : error)}`);
    }
    if (unique.size > 0) {
      return Array.from(unique).sort((a, b) => getFileMtimeMs(b) - getFileMtimeMs(a));
    }
  }

  try {
    const sessionDirs = fs.readdirSync(logsDir, { withFileTypes: true });
    let latestSessionPath = "";
    let latestSessionMtime = 0;
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory() || !/^\d{8}T\d{6}$/i.test(sessionDir.name)) {
        continue;
      }
      const sessionPath = path.join(logsDir, sessionDir.name);
      const mtime = getFileMtimeMs(sessionPath);
      if (mtime > latestSessionMtime) {
        latestSessionMtime = mtime;
        latestSessionPath = sessionPath;
      }
    }
    if (!latestSessionPath) {
      return [];
    }
    const windowDirs = fs.readdirSync(latestSessionPath, { withFileTypes: true });
    for (const windowDir of windowDirs) {
      if (!windowDir.isDirectory() || !windowDir.name.toLowerCase().startsWith("window")) {
        continue;
      }
      const codexLogPath = path.join(
        latestSessionPath,
        windowDir.name,
        "exthost",
        "openai.chatgpt",
        "Codex.log"
      );
      if (getFileSize(codexLogPath) > 0) {
        unique.add(codexLogPath);
      }
    }
  } catch (error) {
    log(`扫描VSCode Codex日志目录失败: dir=${logsDir}, error=${String(error instanceof Error ? error.message : error)}`);
  }

  return Array.from(unique).sort((a, b) => getFileMtimeMs(b) - getFileMtimeMs(a));
}

function locateSessionAndWindow(baseLogPath: string): { sessionDir?: string; windowDirName?: string } {
  let current = baseLogPath;
  let sessionDir: string | undefined;
  let windowDirName: string | undefined;

  for (let i = 0; i <= MAX_RENDERER_SEARCH_DEPTH; i += 1) {
    const baseName = path.basename(current);
    if (!windowDirName && /^window\d+(_wb\d+)?$/i.test(baseName)) {
      windowDirName = baseName;
    }
    if (/^\d{8}T\d{6}$/i.test(baseName)) {
      sessionDir = current;
      break;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return { sessionDir, windowDirName };
}

function getFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function getFileMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function getIdleTimeout(): number {
  const configured = vscode.workspace.getConfiguration("boomerang").get<number>("idleTimeout", DEFAULT_EDITOR_IDLE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_EDITOR_IDLE_TIMEOUT_MS;
}

function getClaudeIdleTimeoutMs(): number {
  const configured = vscode.workspace.getConfiguration("boomerang").get<number>("claudeIdleSeconds", DEFAULT_CLAUDE_IDLE_SECONDS);
  const seconds = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CLAUDE_IDLE_SECONDS;
  return seconds * 1000;
}

function buildNotificationMessage(sourceLabel: string): string {
  const config = vscode.workspace.getConfiguration("boomerang");
  const customTemplate = config.get<string>("notificationTemplate", "").trim();
  if (customTemplate) {
    return customTemplate.replace(/\{source\}/g, sourceLabel);
  }

  const candidates = DEFAULT_HUMOROUS_MESSAGES[locale] ?? DEFAULT_HUMOROUS_MESSAGES.en;
  const selected = candidates[Math.floor(Math.random() * candidates.length)] ?? candidates[0];
  return selected.replace(/\{source\}/g, sourceLabel);
}

function buildSlowNotificationMessage(sourceLabel: string): string {
  if (locale === "zh-CN") {
    return `⏳ AI 输出出现长耗时，可能是网络波动或连接短暂异常。建议你看一眼聊天窗口确认状态。（来源：${sourceLabel}）`;
  }
  return `⏳ AI output is taking longer than expected. This may indicate network jitter or a temporary connection issue. Please check the chat window. (${sourceLabel})`;
}

function buildIdleFallbackNotificationMessage(sourceLabel: string): string {
  if (locale === "zh-CN") {
    return `⌛ AI 已经 10 分钟还没结束，这一轮可能卡住或异常中断。你要不回来看看？（来源：${sourceLabel}）`;
  }
  return `⌛ AI has not finished for 10 minutes. This run might be stuck or interrupted. Please come back and take a look. (${sourceLabel})`;
}

async function syncTargetValueExample(channel: PushChannel): Promise<void> {
  const config = vscode.workspace.getConfiguration("boomerang");
  const current = config.get<string>("targetValue", "").trim();
  const nextExample = TARGET_VALUE_EXAMPLES[channel];
  if (!nextExample) {
    return;
  }
  if (current === nextExample) {
    return;
  }
  if (current.length > 0 && !Object.values(TARGET_VALUE_EXAMPLES).includes(current)) {
    return;
  }

  const inspected = config.inspect<string>("targetValue");
  const target = inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await config.update("targetValue", nextExample, target);
  log(`已同步 targetValue 示例: channel=${channel}, value=${nextExample}`);
}

function disarmMonitoring(): void {
  resetIdleTimer();
  if (vscodeCopilotChatIdleTimer) {
    clearTimeout(vscodeCopilotChatIdleTimer);
    vscodeCopilotChatIdleTimer = undefined;
  }
  clearVSCodeCodexStreamEndTimer();
  stopRendererWatchers();
  stopClaudeSessionMonitoring();
  chatGenerationActive = false;
  slowNotificationSent = false;
  slowNotificationInFlight = false;
  idleFallbackNotificationSent = false;
  idleFallbackNotificationInFlight = false;
  lastCopilotActivityAt = 0;  // 重置活动时间戳
  log("监控解除并重置状态");
  setState("idle");
}

function resetIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
}

function stopRendererWatchers(): void {
  if (rendererWatchers.length > 0) {
    for (const item of rendererWatchers) {
      item.watcher.close();
      clearInterval(item.pollTimer);
    }
    rendererWatchers = [];
  }
}

function shouldTrackEditorDocument(document: vscode.TextDocument): { track: boolean; reason: string } {
  if (document.uri.scheme !== "file") {
    return { track: false, reason: `scheme=${document.uri.scheme}` };
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    return { track: false, reason: "not-in-current-workspace-window" };
  }

  const visible = vscode.window.visibleTextEditors.some((editor) => editor.document.uri.toString() === document.uri.toString());
  if (!visible) {
    return { track: false, reason: "not-visible-editor" };
  }

  return { track: true, reason: "ok" };
}

function setState(next: MonitorState): void {
  log(`状态变更: ${monitorState} -> ${next}`);
  monitorState = next;
  updateStatusBar();
}

function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toUpperCase();
  return message.includes("ECONNRESET") || message.includes("ETIMEDOUT") || message.includes("EAI_AGAIN");
}

function isConfigurationError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("targetvalue must")
    || lower.includes("invalid url")
    || lower.includes("targetvalue is empty")
    || lower.includes("invalid channel")
    || lower.includes("must be")
    || lower.includes("format invalid")
    || lower.includes("missing receiver")
    || lower.includes("apptoken must");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function log(message: string): void {
  const now = new Date().toISOString();
  try {
    outputChannel?.appendLine(`[${now}] ${message}`);
  } catch {
    // extension dispose 阶段 output channel 可能已关闭，忽略即可。
  }
}

function truncateForLog(value: string, maxLen: number): string {
  return value.length > maxLen ? `${value.slice(0, maxLen)}...(truncated)` : value;
}

function logIgnoredActivity(message: string): void {
  const now = Date.now();
  if (message === lastIgnoredLogSignature && now - lastIgnoredLogAt < 2000) {
    return;
  }
  lastIgnoredLogSignature = message;
  lastIgnoredLogAt = now;
  log(message);
}

function updateStatusBar(): void {
  if (!statusBarItem) {
    return;
  }

  switch (monitorState) {
    case "idle":
      statusBarItem.text = t("statusIdleText");
      statusBarItem.tooltip = t("statusIdleTooltip");
      statusBarItem.backgroundColor = undefined;
      return;
    case "armed":
      statusBarItem.text = t("statusArmedText");
      statusBarItem.tooltip = t("statusArmedTooltip");
      statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      return;
    case "monitoring":
      statusBarItem.text = t("statusMonitoringText");
      statusBarItem.tooltip = t("statusMonitoringTooltip");
      statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      return;
    case "delayed":
      statusBarItem.text = t("statusDelayedText");
      statusBarItem.tooltip = t("statusDelayedTooltip");
      statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      return;
    case "notifying":
      statusBarItem.text = t("statusNotifyingText");
      statusBarItem.tooltip = t("statusNotifyingTooltip");
      statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      return;
  }
}
