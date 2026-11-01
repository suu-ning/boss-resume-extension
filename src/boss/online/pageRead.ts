import type { CvApi, CvApiError } from "../cvPageApi";
import type { BossFetchError } from "../types";
import type { OnlineReadOutcome } from "./types";

/**
 * 在 www.zhipin.com 页面主世界执行，读取当前账号的在线简历。须先注入 installCvApiInPage。
 *
 * 只有一个请求：`GET /wapi/zpgeek/resume/geek/preview/data.json`（2026-10-30 录制确认）。
 * 它一次返回整份在线简历：baseInfo、userDesc、professionalSkill、expectList、workExpList、
 * projectExpList、educationExpList、certificationList。只读，不写任何数据。
 *
 * 函数会被序列化后注入页面，不能引用模块作用域内的任何变量或导入（类型除外）。
 *
 * 请求头：录制到的 www.zhipin.com 请求除 zp_token 外还带 `token`。它的来源没有确认（Cookie 里只有
 * zp_at / __zp_stoken__ / bst），所以这里按「zp_at → localStorage」取，取不到就不带；
 * 带上后被拒（登录失效 / 安全校验）时退回不带 token 再读一次——只读请求，重试没有副作用。
 */
export async function onlineResumeReadInPage(): Promise<OnlineReadOutcome> {
  type Raw = Record<string, unknown>;
  const PATH = "/wapi/zpgeek/resume/geek/preview/data.json";
  const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

  const fail = (error: BossFetchError): OnlineReadOutcome => ({ ok: false, error });

  const api = (window as unknown as Raw)["__bossResumeCvApi__"] as CvApi | undefined;
  if (!api) return fail({ code: "PAGE_UNAVAILABLE", message: "BOSS 页面没有装上请求工具，请重新加载扩展后重试" });

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
    return { code: "UNEXPECTED_RESPONSE", message: "读取在线简历时出现意外错误", detail: error instanceof Error ? error.message : String(error) };
  };

  let data: unknown;
  const headers = tokenHeaders();
  try {
    data = await api.call("GET", PATH, {}, headers);
  } catch (error) {
    if (!headers) return fail(asError(error));
    try {
      data = await api.call("GET", PATH);
    } catch (second) {
      return fail(asError(second));
    }
  }

  if (!isRecord(data) || !isRecord(data.baseInfo)) {
    return fail({ code: "UNEXPECTED_RESPONSE", message: "在线简历返回格式与预期不符：缺少 baseInfo" });
  }
  return { ok: true, data };
}
