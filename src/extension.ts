import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { sendBoomerang, type PushChannel } from "./notifier";

type MonitorState = "idle" | "armed" | "monitoring" | "delayed" | "notifying";
type ActivitySource = "editor" | "chat";
type Locale = "en" | "zh-CN";

interface RendererWatcherState {
  filePath: string;
  watcher: fs.FSWatcher;
  readOffsetBytes: number;
  pendingLine: string;
  pollTimer: NodeJS.Timeout;
}

const DEFAULT_EDITOR_IDLE_TIMEOUT_MS = 8000;
const MAX_RENDERER_SEARCH_DEPTH = 6;
const RENDERER_POLL_INTERVAL_MS = 2000;
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
let chatGenerationActive = false;
let slowNotificationSent = false;
let slowNotificationInFlight = false;

let lastIgnoredLogSignature = "";
let lastIgnoredLogAt = 0;
const locale: Locale = vscode.env.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";

const TEXT: Record<Locale, Record<string, string>> = {
  "en": {
    monitorEnabled: "🪃 Boomerang: Monitoring enabled.",
    monitorDisabled: "🛑 Boomerang: Monitoring disabled.",
    channelMissing: "⚠️ Boomerang: `boomerang.pushChannel` is not configured.",
    targetMissing: "⚠️ Boomerang: `boomerang.targetValue` is not configured.",
    configInvalid: "⚠️ Boomerang: Channel configuration is invalid. Please check `pushChannel` and `targetValue` examples in Settings.",
    notifySent: "✅ Boomerang: Notification sent.",
    slowNotifySent: "⚠️ Boomerang: Slow response alert sent.",
    notifyFailedPrefix: "❌ Boomerang: Notification failed - ",
    noRenderer: "Boomerang: No available renderer.log found; chat completion detection is unavailable.",
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
    notifyFailedPrefix: "❌ Boomerang: 通知发送失败 - ",
    noRenderer: "Boomerang: 未发现可用 renderer.log，聊天结束检测不可用。",
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

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("Boomerang");
  log("插件激活");
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
    void syncTargetValueExample(channel);
  });

  const initialChannel = vscode.workspace.getConfiguration("boomerang").get<PushChannel>("pushChannel");
  if (initialChannel) {
    void syncTargetValueExample(initialChannel);
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
    void handleEditorIdleTimeout();
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
  const rendererLogPaths = discoverRendererLogFiles(context.logUri.fsPath);
  log(`renderer.log候选文件: ${rendererLogPaths.join(" | ") || "(none)"}`);

  for (const filePath of rendererLogPaths) {
    try {
      const initialOffset = getFileSize(filePath);
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
        watcher,
        readOffsetBytes: initialOffset,
        pendingLine: "",
        pollTimer
      });
    } catch (error) {
      log(`renderer日志监听初始化失败: file=${filePath}, error=${String(error instanceof Error ? error.message : error)}`);
    }
  }

  if (rendererWatchers.length === 0) {
    void vscode.window.showWarningMessage(t("noRenderer"));
  } else {
    log(`renderer日志监听已启动: count=${rendererWatchers.length}`);
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
      processRendererLine(line);
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

  const isTakingLongerThanExpected = lower.includes("taking longer than expected")
    && (lower.includes("chat") || lower.includes("agent") || lower.includes("composer") || lower.includes("copilot") || lower.includes("openai"));
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
    void sendSlowNotification("chat");
    log("命中聊天长耗时提示: taking longer than expected");
    return;
  }

  const isChatEnd = lower.includes("reason=\"generation-ended\"")
    && (lower.includes("composerwakelockmanager") || lower.includes("released wakelock"));
  if (isChatEnd) {
    chatGenerationActive = false;
    log("命中聊天结束事件: renderer generation-ended released");
    void handleChatGenerationEnded();
  }
}

function discoverRendererLogFiles(baseLogPath: string): string[] {
  const unique = new Set<string>();
  const now = Date.now();
  const recentThresholdMs = 30 * 60 * 1000;

  const contextInfo = locateSessionAndWindow(baseLogPath);
  if (contextInfo.sessionDir) {
    log(`检测到会话目录: ${contextInfo.sessionDir}`);
  }
  if (contextInfo.windowDirName) {
    log(`检测到当前窗口目录: ${contextInfo.windowDirName}`);
  }

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

  const result = Array.from(unique).sort((a, b) => getFileMtimeMs(b) - getFileMtimeMs(a));
  for (const filePath of result) {
    const mtime = getFileMtimeMs(filePath);
    log(`renderer候选详情: file=${filePath}, mtime=${mtime > 0 ? new Date(mtime).toISOString() : "unknown"}`);
  }
  return result;
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
  const config = vscode.workspace.getConfiguration("boomerang");
  const customTemplate = config.get<string>("slowNotificationTemplate", "").trim();
  if (customTemplate) {
    return customTemplate.replace(/\{source\}/g, sourceLabel);
  }

  if (locale === "zh-CN") {
    return `⏳ AI 输出出现长耗时，可能是网络波动或连接短暂异常。建议你看一眼聊天窗口确认状态。（来源：${sourceLabel}）`;
  }
  return `⏳ AI output is taking longer than expected. This may indicate network jitter or a temporary connection issue. Please check the chat window. (${sourceLabel})`;
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
  stopRendererWatchers();
  chatGenerationActive = false;
  slowNotificationSent = false;
  slowNotificationInFlight = false;
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
