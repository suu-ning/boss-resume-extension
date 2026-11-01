import { buildStructureSample } from "./structureSample";

/**
 * BOSS 页面接口录制：用户手动操作时记录页面自己发出的请求，
 * 脱敏后导出为样本用于适配器调研。扩展自身不发起任何 BOSS 请求。
 *
 * 数据流：content/networkCapture.ts（MAIN）→ window.postMessage → content/captureBridge.ts（ISOLATED）
 * → Service Worker：sanitizeRecord 脱敏后写入 chrome.storage.session，原始值不落盘。
 * 两个内容脚本是普通脚本、不能导入本模块，消息类型字面量需与这里保持一致。
 */

export const RECORD_START_MESSAGE = "boss.record.start";
export const RECORD_STOP_MESSAGE = "boss.record.stop";
export const RECORD_STATUS_MESSAGE = "boss.record.status";
export const RECORD_APPEND_MESSAGE = "boss.record.append";
/** 扩展页 → Service Worker：把录制脚本重新注入已打开的 BOSS 标签。 */
export const RECORD_ATTACH_MESSAGE = "boss.record.attach";
/** Service Worker → 内容脚本：录制开关变化。 */
export const RECORD_STATE_MESSAGE = "boss.record.state";
/** Service Worker → 内容脚本：探活。扩展重载后旧内容脚本的运行时已失效，只能靠回话来确认。 */
export const RECORD_PING_MESSAGE = "boss.record.ping";

/**
 * 单次录制最多保留的请求条数。
 * BOSS 每保存一次会连带刷新十几个接口（preview/quality/city/optimizer…），200 条只够录 5–6 次操作就爆满截断，
 * 所以放到 800：一次录制足以覆盖全部模块的保存与删除。
 */
export const MAX_RECORDED_REQUESTS = 800;
const MAX_MESSAGE_CHARS = 120;

export type RawRecordBody =
  | { kind: "none" }
  | { kind: "text"; text: string }
  | { kind: "entries"; entries: Array<[string, string]> }
  | { kind: "binary" };

/** 页面发来的一条原始请求记录；请求头只有名字（content-type 带值），不含 Cookie。 */
export interface RawRequestRecord {
  method: string;
  url: string;
  headerNames: string[];
  contentType?: string;
  requestBody: RawRecordBody;
  status: number;
  responseText: string;
  at: number;
}

export type RecordedBodyKind = "none" | "json" | "form" | "text" | "binary";

/** 脱敏后的一条请求：只有结构与格式，没有个人内容。 */
export interface RecordedRequest {
  offsetMs: number;
  method: string;
  /** origin + pathname，路径中疑似 ID 的段替换为 {id}。 */
  path: string;
  query: unknown;
  headerNames: string[];
  contentType?: string;
  bodyKind: RecordedBodyKind;
  requestBody: unknown;
  status: number;
  /** BOSS 接口信封里的 code 原样保留；message 只保留长度，避免带出文件名等信息。 */
  responseCode?: number;
  responseMessage?: string;
  responseBody: unknown;
}

/**
 * 已打开的 BOSS 标签页与录制脚本的连通情况。
 *
 * `alive < matched` 就是「有人在录但页面那头没接上」：扩展重载后旧的 content script 会静默失效，
 * 表现为计数一直 0，所以每次打开弹窗都要把这件事显示出来，而不是让用户对着 0 猜。
 */
export interface RecordingTabs {
  /** 匹配到的 BOSS 标签数。 */
  matched: number;
  /** 探活有回话的标签数，即真正能录到的页面数。 */
  alive: number;
  /** 连通失败的原因，逐标签一条。 */
  failed: string[];
}

export interface RecordingStatus {
  recording: boolean;
  startedAt?: string;
  count: number;
  tabs?: RecordingTabs;
}

export interface RecordingSample {
  kind: "boss-upload-recording";
  version: 1;
  startedAt: string;
  stoppedAt: string;
  truncated: boolean;
  requests: RecordedRequest[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function isRawBody(value: unknown): value is RawRecordBody {
  if (!isObject(value)) return false;
  switch (value.kind) {
    case "none":
    case "binary":
      return true;
    case "text":
      return typeof value.text === "string";
    case "entries":
      return Array.isArray(value.entries) && value.entries.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((part) => typeof part === "string"));
    default:
      return false;
  }
}

/** 内容脚本的消息来自网页环境，逐字段校验后才处理。 */
export function isRawRequestRecord(value: unknown): value is RawRequestRecord {
  return (
    isObject(value) &&
    typeof value.method === "string" &&
    typeof value.url === "string" &&
    Array.isArray(value.headerNames) &&
    value.headerNames.every((name) => typeof name === "string") &&
    (value.contentType === undefined || typeof value.contentType === "string") &&
    isRawBody(value.requestBody) &&
    typeof value.status === "number" &&
    typeof value.responseText === "string" &&
    typeof value.at === "number"
  );
}

/** 同名键合并为数组，保持表单原始形态（如 skills=a&skills=b）。 */
function entriesToObject(entries: Iterable<[string, string]>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const existing = result[key];
    if (existing === undefined) result[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else result[key] = [existing, value];
  }
  return result;
}

function tryJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}

/** 表单字段的值常是 JSON 字符串（如 data={"name":…}），展开后才看得到结构。 */
function expandJsonValues(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (typeof item !== "string") return [key, item];
      const parsed = tryJson(item);
      return [key, parsed.ok ? parsed.value : item];
    }),
  );
}

export function parseRequestBody(body: RawRecordBody, contentType?: string): { kind: RecordedBodyKind; value: unknown } {
  switch (body.kind) {
    case "none":
      return { kind: "none", value: null };
    case "binary":
      return { kind: "binary", value: null };
    case "entries":
      return { kind: "form", value: expandJsonValues(entriesToObject(body.entries)) };
    case "text": {
      const json = tryJson(body.text);
      if (json.ok) return { kind: "json", value: json.value };
      const looksLikeForm = /urlencoded/i.test(contentType ?? "") || /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(body.text);
      if (looksLikeForm) return { kind: "form", value: expandJsonValues(entriesToObject(new URLSearchParams(body.text))) };
      return { kind: "text", value: body.text };
    }
  }
}

/** 路径段若像 ID（长数字、长随机串），替换为 {id}，避免把简历或账号标识带出。 */
export function maskPath(url: string): { path: string; query: Record<string, unknown> } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const pathname = parsed.pathname
    .split("/")
    .map((segment) => {
      const [, stem, extension] = /^(.*?)(\.[A-Za-z]{2,5})?$/.exec(segment) ?? [, segment, undefined];
      const looksLikeId = /^\d{6,}$/.test(stem ?? "") || /^[A-Za-z0-9_~-]{24,}$/.test(stem ?? "");
      return looksLikeId ? `{id}${extension ?? ""}` : segment;
    })
    .join("/");
  return { path: `${parsed.origin}${pathname}`, query: entriesToObject(parsed.searchParams) };
}

/** Service Worker 调用：把页面原始记录变成只含结构的记录。不在 zhipin.com 下的记录丢弃。 */
export function sanitizeRecord(raw: RawRequestRecord, startedAtMs: number): RecordedRequest | undefined {
  const location = maskPath(raw.url);
  if (!location || !/(^|\.)zhipin\.com$/.test(new URL(location.path).hostname)) return undefined;

  const body = parseRequestBody(raw.requestBody, raw.contentType);
  const response = tryJson(raw.responseText);
  const envelope = response.ok && isObject(response.value) ? response.value : undefined;
  const message = envelope?.message;

  return {
    offsetMs: Math.max(0, raw.at - startedAtMs),
    method: raw.method.toUpperCase(),
    path: location.path,
    query: buildStructureSample(location.query),
    headerNames: [...new Set(raw.headerNames.map((name) => name.toLowerCase()))].sort(),
    contentType: raw.contentType?.slice(0, 100),
    bodyKind: body.kind,
    requestBody: buildStructureSample(body.value),
    status: raw.status,
    responseCode: typeof envelope?.code === "number" ? envelope.code : undefined,
    responseMessage: typeof message === "string" && message.length <= MAX_MESSAGE_CHARS ? `<string:${message.length}>` : undefined,
    responseBody: response.ok ? buildStructureSample(response.value) : raw.responseText ? `<non-json:${raw.responseText.length}>` : null,
  };
}
