/**
 * 直聘简历（cv.zhipin.com）页面内的请求工具，读取与上传共用。
 *
 * 注入方式：chrome.scripting.executeScript({ world: "MAIN", func: installCvApiInPage }) 先装到 window 上，
 * 随后注入的任务函数（pageFetch / pageUpload）从 window[CV_API_GLOBAL] 取用。
 * 注入函数会被序列化执行，installCvApiInPage 必须自包含，不能引用模块作用域内的变量或导入。
 *
 * 请求格式照搬直聘简历编辑器：application/x-www-form-urlencoded，数组按 key[i] 展开；
 * 请求头 x-requested-with、traceId、zp_token（取自 bst Cookie，与页面自身一致）。
 */

/** 与 installCvApiInPage 内部写死的字面量一致。 */
export const CV_API_GLOBAL = "__bossResumeCvApi__";

export type CvApiErrorCode = "NOT_LOGGED_IN" | "SECURITY_BLOCKED" | "RATE_LIMITED" | "NETWORK" | "API_ERROR" | "UNEXPECTED_RESPONSE";

/** call() 抛出的错误；任务函数据 cvApiError 标记识别。 */
export interface CvApiError {
  cvApiError: true;
  code: CvApiErrorCode;
  message: string;
  detail?: string;
}

export interface CvApi {
  /**
   * 成功返回 zpData；code !== 0 或网络失败时抛出 CvApiError。
   * extraHeaders 用于 www.zhipin.com 特有的请求头（见 pageRead），不传时行为与之前完全一致。
   */
  call(method: "GET" | "POST", path: string, params?: Record<string, unknown>, extraHeaders?: Record<string, string>): Promise<unknown>;
}

export function installCvApiInPage(): void {
  type Raw = Record<string, unknown>;
  const fail = (code: CvApiErrorCode, message: string, detail?: string): CvApiError => ({ cvApiError: true, code, message, detail });
  const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

  const cookie = (name: string): string => {
    const hit = document.cookie.split("; ").find((part) => part.startsWith(`${name}=`));
    return hit ? decodeURIComponent(hit.slice(name.length + 1)) : "";
  };

  /** 复刻页面 util 包的 TraceID：F- + 24 位（10 位时间戳、6 位设备标识、随机位、第 23 位校验）。 */
  const traceId = (): string => {
    const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
    const timePositions = [1, 3, 4, 7, 9, 12, 14, 17, 19, 22];
    const devicePositions = [0, 2, 5, 6, 8, 10];
    const random = () => alphabet[Math.floor(Math.random() * alphabet.length)];
    let time = "";
    for (let value = Date.now(); value > 0; value = Math.floor(value / 31)) time = alphabet[value % 31] + time;
    time = time.padStart(10, alphabet[0]);
    const chars: string[] = Array.from({ length: 24 }, random);
    timePositions.forEach((position, index) => (chars[position] = time[index]));
    devicePositions.forEach((position) => (chars[position] = random()));
    let sum = 0;
    chars.forEach((char, index) => {
      if (index !== 23) sum += alphabet.indexOf(char) * (index + 1);
    });
    chars[23] = alphabet[sum % 31];
    return `F-${chars.join("")}`;
  };

  /**
   * 表单编码：数组按 key[i] 展开，数组里的对象继续展开成 key[i][子字段]。
   *
   * 嵌套是必需的：在线简历 expect/save 的 multiExpectInfos 就是 [{position}]，
   * 只展开一层会把它拼成 "[object Object]"，接口返回 code 0 却什么都没写。
   */
  const encode = (params: Raw): URLSearchParams => {
    const search = new URLSearchParams();
    const put = (key: string, value: unknown) => search.append(key, value === undefined || value === null ? "" : String(value));
    const walk = (key: string, value: unknown): void => {
      if (Array.isArray(value)) value.forEach((item, index) => walk(`${key}[${index}]`, item));
      else if (isRecord(value)) for (const [child, item] of Object.entries(value)) walk(`${key}[${child}]`, item);
      else put(key, value);
    };
    for (const [key, value] of Object.entries(params)) walk(key, value);
    return search;
  };

  const call: CvApi["call"] = async (method, path, params = {}, extraHeaders) => {
    const url = new URL(path, location.origin);
    const headers: Record<string, string> = {
      accept: "application/json, text/plain, */*",
      "x-requested-with": "XMLHttpRequest",
      traceId: traceId(),
      zp_token: cookie("bst"),
    };
    // 直聘简历用不到额外请求头；www.zhipin.com 的接口还会带 token，由调用方按需补。
    if (extraHeaders) for (const [key, value] of Object.entries(extraHeaders)) if (value) headers[key] = value;
    let body: string | undefined;
    if (method === "GET") encode(params).forEach((value, key) => url.searchParams.append(key, value));
    else {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = encode(params).toString();
    }

    let response: Response;
    try {
      response = await fetch(url.href, { method, headers, body, credentials: "include" });
    } catch (error) {
      throw fail("NETWORK", "网络请求失败，请检查网络后重试", error instanceof Error ? error.message : String(error));
    }
    if (!response.ok) throw fail("NETWORK", `BOSS 返回 HTTP ${response.status}`);
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw fail("UNEXPECTED_RESPONSE", "BOSS 返回的不是 JSON");
    }
    if (!isRecord(json) || typeof json.code !== "number") throw fail("UNEXPECTED_RESPONSE", "BOSS 返回格式与预期不符");
    if (json.code !== 0) {
      const message = typeof json.message === "string" && json.message ? json.message : `错误码 ${json.code}`;
      if (json.code === 37) throw fail("NOT_LOGGED_IN", "BOSS 登录状态无效，请在浏览器中重新登录求职者账号");
      if (json.code === 121 || json.code === 122) throw fail("SECURITY_BLOCKED", `BOSS 触发了安全校验：${message}，请先在 BOSS 页面完成验证`);
      if (json.code === 9) throw fail("RATE_LIMITED", `操作过于频繁：${message}，请稍后再试`);
      throw fail("API_ERROR", message, `code=${json.code}`);
    }
    return json.zpData;
  };

  Object.defineProperty(window, "__bossResumeCvApi__", { value: Object.freeze({ call }), configurable: true });
}
