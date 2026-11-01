import type { AiSettings } from "./settings";
import { readSseData } from "./sse";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: ChatContent;
}

export interface ChatContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export type ChatContent = string | ChatContentPart[];

export class AiError extends Error {}

export interface ChatOptions {
  signal?: AbortSignal;
  maxTokens?: number;
}

const STATUS_MESSAGE: Record<number, string> = {
  400: "请求格式错误，请检查模型名称",
  401: "API Key 无效，请到 AI 设置里重新填写",
  402: "账户余额不足",
  403: "接口拒绝了这次请求，请在接口服务里放行浏览器扩展来源",
  422: "请求参数错误，请检查模型名称",
  429: "请求太频繁，请稍后再试",
  500: "AI 服务出错，请稍后再试",
  502: "AI 上游服务出错，请稍后再试",
  503: "AI 服务繁忙，请稍后再试",
  504: "AI 服务响应超时，请稍后再试",
};

/** 一次对话补全的汇总结果，流式与非流式归一到同一形状。 */
export interface Completion {
  content: string;
  finishReason?: string;
}

/** OpenAI 兼容接口的错误信封：`{ error: { message } }`，部分网关是 `{ error: "..." }` 或 `{ message }`。 */
function errorMessageOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { error?: unknown; message?: unknown; choices?: unknown };
  if (typeof record.error === "string" && record.error) return record.error;
  if (record.error && typeof record.error === "object") {
    const message = (record.error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  // 正常的 completion / chunk 不带顶层 message；只在没有 choices 时才把它当错误
  if (!("choices" in record) && typeof record.message === "string" && record.message) return record.message;
  return undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

type ChunkChoice = { delta?: { content?: unknown }; finish_reason?: unknown };

/**
 * 读取 `chat.completion.chunk` 流：拼接 `choices[0].delta.content`，记录最后出现的 `finish_reason`。
 * `reasoning_content`（思维链）、`role` 声明、`choices: []` 的 usage 尾包都不计入正文；遇到 `[DONE]` 停止。
 */
async function readStream(body: ReadableStream<Uint8Array>): Promise<Completion> {
  let content = "";
  let finishReason: string | undefined;
  for await (const data of readSseData(body)) {
    if (data.trim() === "[DONE]") break;
    const chunk = parseJson(data);
    if (chunk === undefined) continue;
    const error = errorMessageOf(chunk);
    if (error) throw new AiError(`AI 接口返回错误：${error.slice(0, 200)}`);
    const choice = (chunk as { choices?: ChunkChoice[] }).choices?.[0];
    if (!choice) continue;
    if (typeof choice.delta?.content === "string") content += choice.delta.content;
    if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
  }
  return { content, finishReason };
}

/** 非流式 `chat.completion`：服务端忽略 stream 参数时走这里。 */
function readCompletion(data: unknown): Completion {
  const error = errorMessageOf(data);
  if (error) throw new AiError(`AI 接口返回错误：${error.slice(0, 200)}`);
  const choice = (data as { choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }> } | undefined)?.choices?.[0];
  if (!choice) throw new AiError("AI 返回的数据无法识别，请检查接口地址是否为 OpenAI 兼容接口");
  return {
    content: typeof choice.message?.content === "string" ? choice.message.content : "",
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : undefined,
  };
}

/** 调用 OpenAI 兼容的 /chat/completions（流式），返回拼好的正文。 */
export async function chatCompletion(settings: AiSettings, messages: ChatMessage[], options: ChatOptions = {}): Promise<Completion> {
  let response: Response;
  try {
    response = await fetch(`${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream, application/json", Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model: settings.model,
        messages,
        response_format: { type: "json_object" },
        max_tokens: options.maxTokens ?? 8192,
        stream: true,
      }),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new AiError("连不上 AI 接口，请检查网络和接口地址");
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const message = STATUS_MESSAGE[response.status] ?? `AI 接口返回错误（HTTP ${response.status}）`;
    const reason = errorMessageOf(parseJson(detail)) ?? detail.trim();
    throw new AiError(reason ? `${message}：${reason.slice(0, 200)}` : message);
  }

  try {
    const isStream = (response.headers.get("content-type") ?? "").includes("text/event-stream");
    if (isStream && response.body) return await readStream(response.body);
    const text = await response.text();
    // 少数网关返回 SSE 却不带 content-type，按开头兜底判断
    if (/^\s*(data|:)/.test(text)) return await readStream(new Response(text).body!);
    return readCompletion(parseJson(text));
  } catch (error) {
    if (error instanceof AiError || (error instanceof DOMException && error.name === "AbortError")) throw error;
    throw new AiError("读取 AI 响应时连接中断，请重试");
  }
}

/**
 * 从模型正文里取出 JSON 对象。没有原生 JSON 模式的接口（如 kiro2api 转发的 Claude）
 * 常在对象外包一层 ```json 代码块或前后带说明文字，这里依次尝试：整段、代码块、第一个配平的 `{...}`。
 */
export function extractJsonObject(text: string): unknown {
  const direct = parseLenient(text.trim());
  if (direct !== undefined) return direct;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  if (fenced) {
    const value = parseLenient(fenced.trim());
    if (value !== undefined) return value;
  }
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    const end = matchingBrace(text, start);
    if (end < 0) break;
    const value = parseLenient(text.slice(start, end + 1));
    if (value !== undefined) return value;
  }
  return undefined;
}

/** 先按标准 JSON 解析；失败再把字符串里的裸换行、制表符转义后重试（Claude 写多行文案时常见）。 */
function parseLenient(text: string): unknown {
  return parseJson(text) ?? parseJson(escapeControlCharsInStrings(text));
}

function escapeControlCharsInStrings(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === "\\") {
        out += char + (text[i + 1] ?? "");
        i += 1;
        continue;
      }
      if (char === '"') inString = false;
      else if (char === "\n") { out += "\\n"; continue; }
      else if (char === "\r") { out += "\\r"; continue; }
      else if (char === "\t") { out += "\\t"; continue; }
    } else if (char === '"') {
      inString = true;
    }
    out += char;
  }
  return out;
}

/** 跳过字符串字面量，找到与 `start` 处 `{` 配对的 `}`；没有则返回 -1。 */
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return i;
  }
  return -1;
}

/** kiro2api 上游失败时仍返回 200，把错误作为正文 `API Error: …` 发出。 */
const UPSTREAM_ERROR_PREFIX = "API Error:";

export interface ChatReply {
  /** 模型的原始正文（已去首尾空白）。 */
  text: string;
  /** 能从正文中取出 JSON 时的解析结果；模型只回了一段文字时为 undefined。 */
  json?: unknown;
}

/**
 * 调用对话补全，返回正文和其中的 JSON（若有）。提示词里必须出现「json」字样（DeepSeek JSON Output 的要求）。
 * 接口错误、截断、空内容抛错；正文不是 JSON 不算错误，由调用方决定如何处理。
 */
export async function chatReply(settings: AiSettings, messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatReply> {
  const { content, finishReason } = await chatCompletion(settings, messages, options);
  const text = content.trim();
  if (text.startsWith(UPSTREAM_ERROR_PREFIX)) {
    throw new AiError(`AI 接口返回错误：${text.slice(UPSTREAM_ERROR_PREFIX.length).trim().slice(0, 200)}`);
  }
  if (finishReason === "length") throw new AiError("AI 输出太长被截断了，请把要求拆小一点再试");
  if (!text) throw new AiError("AI 返回了空内容，请重试");
  return { text, json: extractJsonObject(text) };
}

/** 严格版：正文必须是 JSON。 */
export async function chatJson(settings: AiSettings, messages: ChatMessage[], options: ChatOptions = {}): Promise<unknown> {
  const { json } = await chatReply(settings, messages, options);
  if (json === undefined) throw new AiError("AI 返回的内容不是有效的 JSON，请重试");
  return json;
}

/** 用一次极小的请求验证 Key、地址和模型是否可用。 */
export async function pingAi(settings: AiSettings): Promise<void> {
  await chatJson(
    settings,
    [
      { role: "system", content: '只输出 json：{"ok": true}' },
      { role: "user", content: "ping" },
    ],
    // 留出代码块包裹的余量，避免被 length 截断误判为失败
    { maxTokens: 64 },
  );
}
