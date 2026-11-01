/**
 * 在 BOSS 页面主世界 document_start 注入（manifest content_scripts, world: "MAIN"）。
 *
 * 只服务“附件同步调研”录制：扩展录制开启时，把页面自己发出的 zhipin.com 请求的方法、URL、请求头名、请求体与
 * 响应文本经 window.postMessage 交给隔离世界的 content/captureBridge.ts，由 Service Worker 脱敏后保存（见 boss/recording.ts）。
 * 录制关闭时不观察任何请求。读取简历不依赖本脚本：扩展直接在直聘简历页调用它自己的接口（boss/pageFetch.ts）。
 *
 * 不发起任何请求，不读取 Cookie，不改动请求或响应；任何观察逻辑出错都不影响页面原请求。
 * 本文件不能有运行时 import：它以普通脚本形式注入。
 */
export {};

const INSTALLED_KEY = "__bossResumeRecorder__";
/** 与 content/captureBridge.ts 约定的消息通道键。 */
const CHANNEL = "__bossResumeExt__";
const MAX_BODY_CHARS = 512 * 1024;
/** 录制状态未知（桥接脚本尚未回话）期间暂存的记录数，覆盖页面加载初期的请求。 */
const MAX_PENDING_RECORDS = 50;

type RecordBody =
  | { kind: "none" }
  | { kind: "text"; text: string }
  | { kind: "entries"; entries: Array<[string, string]> }
  | { kind: "binary" };

interface RequestMeta {
  url: URL;
  method: string;
  headers: Array<[string, string]>;
  body: Promise<RecordBody>;
  at: number;
}

const host = window as unknown as Record<string, unknown>;

if (!host[INSTALLED_KEY]) {
  Object.defineProperty(host, INSTALLED_KEY, { value: true, configurable: false, enumerable: false });

  /** undefined：桥接脚本尚未告知录制状态。 */
  let recordingState: boolean | undefined;
  const pendingRecords: unknown[] = [];

  const zhipinUrl = (url: string | undefined): URL | undefined => {
    if (!url) return undefined;
    try {
      const parsed = new URL(url, location.href);
      return /(^|\.)zhipin\.com$/.test(parsed.hostname) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };
  const wantsRecord = (): boolean => recordingState !== false;

  const post = (record: unknown): void => window.postMessage({ [CHANNEL]: "record", record }, location.origin);

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || data[CHANNEL] !== "state" || typeof data.recording !== "boolean") return;
    recordingState = data.recording;
    const queued = pendingRecords.splice(0);
    if (recordingState) queued.forEach(post);
  });

  const describeBody = (body: unknown): RecordBody => {
    if (body === undefined || body === null || body === "") return { kind: "none" };
    if (typeof body === "string") return body.length > MAX_BODY_CHARS ? { kind: "binary" } : { kind: "text", text: body };
    if (body instanceof URLSearchParams) return { kind: "text", text: body.toString() };
    if (body instanceof FormData) {
      return { kind: "entries", entries: [...body.entries()].map(([key, value]) => [key, typeof value === "string" ? value : "<file>"]) };
    }
    return { kind: "binary" };
  };

  const implicitContentType = (body: unknown): string | undefined => {
    if (body instanceof URLSearchParams) return "application/x-www-form-urlencoded";
    if (body instanceof FormData) return "multipart/form-data";
    return undefined;
  };

  const headerPairs = (headers: HeadersInit | undefined): Array<[string, string]> => {
    if (!headers) return [];
    try {
      return [...new Headers(headers).entries()];
    } catch {
      return [];
    }
  };

  const withContentType = (headers: Array<[string, string]>, body: unknown): Array<[string, string]> => {
    const implicitType = implicitContentType(body);
    if (implicitType && !headers.some(([name]) => name.toLowerCase() === "content-type")) headers.push(["content-type", implicitType]);
    return headers;
  };

  const emitRecord = async (meta: RequestMeta, status: number, responseText: string): Promise<void> => {
    const contentType = meta.headers.find(([name]) => name.toLowerCase() === "content-type")?.[1];
    const record = {
      method: meta.method,
      url: meta.url.href,
      // 只交出请求头名字（令牌类请求头的值不离开页面）；content-type 的值用于解析请求体。
      headerNames: meta.headers.map(([name]) => name),
      contentType,
      requestBody: await meta.body,
      status,
      responseText: responseText.length > MAX_BODY_CHARS ? "" : responseText,
      at: meta.at,
    };
    if (recordingState === false) return;
    if (recordingState === undefined) {
      if (pendingRecords.length < MAX_PENDING_RECORDS) pendingRecords.push(record);
      return;
    }
    post(record);
  };

  // ---------- fetch ----------

  const describeFetch = (input: RequestInfo | URL, init?: RequestInit): RequestMeta | undefined => {
    if (!wantsRecord()) return undefined;
    const request = input instanceof Request ? input : undefined;
    const url = zhipinUrl(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!url) return undefined;

    const headers = withContentType([...headerPairs(request?.headers), ...headerPairs(init?.headers)], init?.body);
    let body: Promise<RecordBody> = Promise.resolve({ kind: "none" });
    if (init?.body !== undefined) body = Promise.resolve(describeBody(init.body));
    // Request 的请求体只能读一次，必须在交给原生 fetch 之前克隆。
    else if (request?.body) body = request.clone().text().then(describeBody, (): RecordBody => ({ kind: "binary" }));
    return { url, method: (init?.method ?? request?.method ?? "GET").toUpperCase(), headers, body, at: Date.now() };
  };

  const nativeFetch = window.fetch;
  window.fetch = function captureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let meta: RequestMeta | undefined;
    try {
      meta = describeFetch(input, init);
    } catch {
      meta = undefined;
    }
    const promise = nativeFetch.call(window, input, init);
    if (!meta) return promise;

    const observed = meta;
    promise
      .then((response) =>
        response
          .clone()
          .text()
          .then((text) => {
            if (wantsRecord()) void emitRecord(observed, response.status, text);
          }),
      )
      .catch(() => {
        if (wantsRecord()) void emitRecord(observed, 0, "");
      });
    return promise;
  };

  // ---------- XMLHttpRequest ----------

  const xhrMeta = new WeakMap<XMLHttpRequest, { method: string; url: string; headers: Array<[string, string]> }>();
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function captureOpen(this: XMLHttpRequest, ...args: unknown[]): void {
    xhrMeta.set(this, { method: String(args[0] ?? "GET").toUpperCase(), url: String(args[1]), headers: [] });
    (nativeOpen as (...rest: unknown[]) => void).apply(this, args);
  };

  XMLHttpRequest.prototype.setRequestHeader = function captureSetHeader(this: XMLHttpRequest, name: string, value: string): void {
    xhrMeta.get(this)?.headers.push([String(name), String(value)]);
    nativeSetHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function captureSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
    try {
      const opened = xhrMeta.get(this);
      const url = zhipinUrl(opened?.url);
      if (opened && url && wantsRecord()) {
        const meta: RequestMeta = {
          url,
          method: opened.method,
          headers: withContentType([...opened.headers], body),
          body: Promise.resolve(describeBody(body)),
          at: Date.now(),
        };
        this.addEventListener("loadend", () => {
          let text = "";
          try {
            text =
              this.responseType === "" || this.responseType === "text"
                ? this.responseText
                : this.responseType === "json"
                  ? JSON.stringify(this.response)
                  : "";
          } catch {
            // 响应不可读时忽略，不影响页面。
          }
          if (wantsRecord()) void emitRecord(meta, this.status, text);
        });
      }
    } catch {
      // 观察逻辑出错不影响页面请求。
    }
    nativeSend.call(this, body);
  };
}
