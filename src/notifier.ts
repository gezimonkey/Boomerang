import * as http from "http";
import * as https from "https";

export type PushChannel =
  | "PushPlus"
  | "Server酱 (Turbo版)"
  | "Webhook 通道（企业微信/钉钉/飞书/Discord/Custom Webhook）"
  | "Bark"
  | "WxPusher"
  | "ntfy.sh"
  | "Telegram";

interface HttpResult {
  statusCode: number;
  bodyText: string;
}

export interface SendResult {
  channel: PushChannel;
  statusCode: number;
  bodyText: string;
}

interface TargetParsed {
  main: string;
  keyword: string;
}

interface WxPusherParsedTarget {
  appToken: string;
  uids: string[];
}

export async function sendBoomerang(channel: PushChannel, targetValue: string, baseMessage: string): Promise<SendResult> {
  const parsed = parseTargetValue(targetValue);
  if (!parsed.main) {
    throw new Error("targetValue is empty");
  }
  if (channel === "Webhook 通道（企业微信/钉钉/飞书/Discord/Custom Webhook）" && !parsed.keyword) {
    throw new Error("Webhook targetValue must be webhook_url|keyword");
  }

  const message = parsed.keyword ? `${parsed.keyword} ${baseMessage}`.trim() : baseMessage;

  const strategies: Record<PushChannel, () => Promise<HttpResult>> = {
    "PushPlus": async () => {
      const url = new URL("https://www.pushplus.plus/send");
      url.searchParams.set("token", parsed.main);
      url.searchParams.set("title", "Boomerang");
      url.searchParams.set("content", message);
      return get(url.toString());
    },
    "Server酱 (Turbo版)": async () => {
      const url = `https://sctapi.ftqq.com/${parsed.main}.send`;
      return postJson(url, {
        title: "Boomerang",
        desp: message
      });
    },
    "Webhook 通道（企业微信/钉钉/飞书/Discord/Custom Webhook）": async () => {
      const url = parsed.main;
      const lower = url.toLowerCase();
      if (lower.includes("qyapi.weixin.qq.com") || lower.includes("dingtalk.com")) {
        return postJson(url, { msgtype: "text", text: { content: message } });
      }
      if (lower.includes("feishu.cn") || lower.includes("larksuite.com")) {
        return postJson(url, { msg_type: "text", content: { text: message } });
      }
      return postJson(url, { content: message });
    },
    "Bark": async () => {
      const normalized = parsed.main.endsWith("/") ? parsed.main.slice(0, -1) : parsed.main;
      return get(`${normalized}/${encodeURIComponent(message)}`);
    },
    "WxPusher": async () => {
      const wxTarget = parseWxPusherTarget(parsed.main);
      const payload: Record<string, unknown> = {
        appToken: wxTarget.appToken,
        content: message,
        summary: "Boomerang",
        contentType: 1
      };
      if (wxTarget.uids.length > 0) {
        payload.uids = wxTarget.uids;
      }
      return postJson("https://wxpusher.zjiecode.com/api/send/message", payload);
    },
    "ntfy.sh": async () => {
      return postText(`https://ntfy.sh/${parsed.main}`, message);
    },
    "Telegram": async () => {
      const [botToken, chatId] = parsed.main.split("/", 2);
      if (!botToken || !chatId) {
        throw new Error("Telegram targetValue must be botToken/chatId|keyword");
      }
      return postJson(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        chat_id: chatId,
        text: message
      });
    }
  };

  const httpResult = await strategies[channel]();
  ensureSuccessfulResponse(channel, httpResult);

  return {
    channel,
    statusCode: httpResult.statusCode,
    bodyText: httpResult.bodyText
  };
}

export function parseTargetValue(targetValue: string): TargetParsed {
  const [mainPart, keywordPart] = targetValue.split("|", 2);
  const main = (mainPart ?? "").trim();
  const keyword = (keywordPart ?? "").trim();
  return { main, keyword };
}

function parseWxPusherTarget(main: string): WxPusherParsedTarget {
  const parts = main
    .replace(/，/g, ",")
    .split(/[\/,\s;]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length < 2) {
    throw new Error("WxPusher targetValue format invalid. Use AT_xxx/UID_xxx|your_keyword");
  }

  const appToken = parts[0];
  if (!appToken.startsWith("AT_")) {
    throw new Error("WxPusher appToken must start with AT_. Example: AT_xxx/UID_xxx|your_keyword");
  }

  const uids: string[] = [];
  for (const receiver of parts.slice(1)) {
    if (receiver.startsWith("UID_")) {
      uids.push(receiver);
      continue;
    }
    throw new Error("WxPusher receiver must be UID_xxx. Example: AT_xxx/UID_xxx|your_keyword");
  }

  if (uids.length === 0) {
    throw new Error("WxPusher targetValue missing receiver. Provide UID_xxx.");
  }

  return { appToken, uids };
}

async function get(url: string): Promise<HttpResult> {
  return request("GET", url);
}

async function postJson(url: string, payload: unknown): Promise<HttpResult> {
  return request("POST", url, JSON.stringify(payload), {
    "Content-Type": "application/json"
  });
}

async function postText(url: string, content: string): Promise<HttpResult> {
  return request("POST", url, content, {
    "Content-Type": "text/plain"
  });
}

function request(
  method: "GET" | "POST",
  targetUrl: string,
  body?: string,
  headers: Record<string, string> = {}
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(targetUrl);
    } catch {
      reject(new Error(`Invalid URL: ${targetUrl}`));
      return;
    }

    const client = url.protocol === "https:" ? https : http;
    const requestHeaders: Record<string, string | number> = { ...headers };
    if (body) {
      requestHeaders["Content-Length"] = Buffer.byteLength(body);
    }

    const req = client.request(
      url,
      {
        method,
        headers: requestHeaders
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            bodyText: Buffer.concat(chunks).toString("utf8")
          });
        });
        res.on("error", reject);
      }
    );

    req.on("error", reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error("request timeout"));
    });
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function ensureSuccessfulResponse(channel: PushChannel, result: HttpResult): void {
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(`HTTP ${result.statusCode}`);
  }

  const text = result.bodyText.trim();
  if (!text || !text.startsWith("{")) {
    return;
  }

  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    if (typeof payload.errcode === "number" && payload.errcode !== 0) {
      throw new Error(`${channel}业务失败 errcode=${payload.errcode}, errmsg=${String(payload.errmsg ?? "")}`);
    }

    // 不同平台业务码定义不一致，需要按通道单独判断：
    // - PushPlus: code=200 表示成功
    // - Server酱(Turbo): code=0 表示成功
    // - WxPusher: code=1000 表示成功
    const code = typeof payload.code === "number" ? payload.code : undefined;
    if (code !== undefined) {
      if (channel === "PushPlus" && code !== 200) {
        throw new Error(`${channel}业务失败 code=${code}, msg=${String(payload.msg ?? payload.message ?? "")}`);
      }
      if (channel === "Server酱 (Turbo版)" && code !== 0) {
        throw new Error(`${channel}业务失败 code=${code}, msg=${String(payload.message ?? payload.msg ?? "")}`);
      }
      if (channel === "WxPusher" && code !== 1000) {
        throw new Error(`${channel}业务失败 code=${code}, msg=${String(payload.msg ?? payload.message ?? "")}`);
      }
    }

    // Telegram 常见返回: {"ok": true, ...}
    if (channel === "Telegram" && payload.ok === false) {
      throw new Error(`${channel}业务失败 response=${text}`);
    }

    if (payload.ok === false || payload.success === false) {
      throw new Error(`${channel}业务失败 response=${text}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("业务失败")) {
      throw error;
    }
  }
}
