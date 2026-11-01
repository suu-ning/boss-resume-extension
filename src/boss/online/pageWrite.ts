import type { CvApi, CvApiError } from "../cvPageApi";
import type { BossFetchError } from "../types";
import type { OnlineOperation, OnlineOperationResult, OnlineWriteResult } from "./types";

/**
 * 在 www.zhipin.com 页面主世界执行（须先注入 installCvApiInPage），按顺序把写操作发出去。
 *
 * 设计口径：
 * - 只做「发请求 + 前置校验 + 收集结果」，不拼字段；字段怎么来是 execute.ts 的纯函数职责。
 * - 每条之间留间隔，避免连续保存触发限流（BOSS 每次保存还会连带刷新十几个接口）。
 * - 前置校验返回的 dialog 非空时**放弃这一条**，不当作成功：那通常意味着要人工确认。
 * - 登录失效 / 安全校验 / 限流属于「再写下去只会更糟」，立即停下，把剩下的标成未执行；
 *   其他业务错误只记这一条并继续，模块之间互不影响。
 * - 不自动重试写接口（唯一例外：带了 token 却被判未登录，去掉 token 再试一次，因为此时请求已被拒绝、没有落库）。
 *
 * 函数会被序列化后注入页面，不能引用模块作用域内的任何变量或导入（类型除外）。
 */
export async function onlineResumeWriteInPage(operations: OnlineOperation[]): Promise<OnlineWriteResult> {
  type Raw = Record<string, unknown>;
  const WRITE_GAP_MS = 350;
  const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

  const done: OnlineOperationResult[] = [];
  const failed: OnlineOperationResult[] = [];
  const skipped: string[] = [];
  const ids: Record<string, string> = {};

  const api = (window as unknown as Raw)["__bossResumeCvApi__"] as CvApi | undefined;
  if (!api) {
    return {
      ok: false,
      done,
      failed,
      skipped: operations.map((operation) => operation.label),
      ids,
      error: { code: "PAGE_UNAVAILABLE", message: "BOSS 页面没有装上请求工具，请重新加载扩展后重试" },
    };
  }

  const cookie = (name: string): string => {
    const hit = document.cookie.split("; ").find((part) => part.startsWith(`${name}=`));
    return hit ? decodeURIComponent(hit.slice(name.length + 1)) : "";
  };

  const tokenHeaders = (): Record<string, string> | undefined => {
    let stored = "";
    try {
      stored = window.localStorage.getItem("token") ?? "";
    } catch {
      stored = "";
    }
    const token = cookie("zp_at") || stored;
    return token ? { token } : undefined;
  };

  const asError = (error: unknown): BossFetchError => {
    if (isRecord(error) && error.cvApiError === true) {
      const known = error as unknown as CvApiError;
      return { code: known.code, message: known.message, detail: known.detail };
    }
    return { code: "UNEXPECTED_RESPONSE", message: "写入在线简历时出现意外错误", detail: error instanceof Error ? error.message : String(error) };
  };

  /** 需要立刻停下的错误：再写下去只会更糟。 */
  const fatal = new Set(["NOT_LOGGED_IN", "SECURITY_BLOCKED", "RATE_LIMITED", "PAGE_UNAVAILABLE"]);

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const headers = tokenHeaders();
  let stop: BossFetchError | undefined;

  let index = 0;
  for (; index < operations.length; index += 1) {
    const operation = operations[index];
    try {
      if (operation.precheck) {
        const pre = await api.call(operation.precheck.method, operation.precheck.path, operation.precheck.payload, headers);
        const dialog = isRecord(pre) ? pre.dialog : undefined;
        if (dialog !== undefined && dialog !== null && dialog !== false) {
          const text =
            typeof dialog === "string"
              ? dialog
              : isRecord(dialog) && typeof dialog.title === "string"
                ? dialog.title
                : isRecord(dialog) && typeof dialog.content === "string"
                  ? dialog.content
                  : "BOSS 要求先确认一条提示";
          failed.push({ key: operation.key, label: operation.label, ok: false, code: "API_ERROR", message: `需要先确认：${text}` });
          continue;
        }
      }

      const send = (extra?: Record<string, string>) => api.call("POST", operation.path, operation.payload, extra);
      let data: unknown;
      try {
        data = await send(headers);
      } catch (error) {
        // token 头有可能取错值：被判未登录时去掉它重试一次（此时请求已被拒绝，不存在重复写入）。
        const first = asError(error);
        if (!headers || first.code !== "NOT_LOGGED_IN") throw error;
        data = await send(undefined);
      }

      if (isRecord(data) && typeof data.encryptId === "string" && data.encryptId) ids[operation.key] = data.encryptId;
      done.push({ key: operation.key, label: operation.label, ok: true });
    } catch (error) {
      const info = asError(error);
      failed.push({ key: operation.key, label: operation.label, ok: false, code: info.code, message: info.message });
      if (fatal.has(info.code)) {
        stop = info;
        index += 1;
        break;
      }
    }
    await sleep(WRITE_GAP_MS);
  }

  for (; index < operations.length; index += 1) skipped.push(operations[index].label);

  return { ok: failed.length === 0, done, failed, skipped, ids, error: stop };
}
