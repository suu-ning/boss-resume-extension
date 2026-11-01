import type { CvApi } from "../cvPageApi";
import type { BossPageOutcome } from "../types";

/** 字典树的原始结构，压平在扩展页做（flattenDict 是纯函数，便于单测）。 */
export interface OnlineDictTrees {
  /** 工作经历的职位字典：zpData.config */
  workPositions: unknown;
  /** 求职期望的职位字典：zpData.config */
  expectPositions: unknown;
  /** 行业字典：zpData（数组） */
  industries: unknown;
  /** 城市字典：zpData（数组） */
  cities: unknown;
}

/**
 * 在 www.zhipin.com 页面主世界读取写入所需的字典（只读，不改任何数据）。
 *
 * 本地档案只有文字，BOSS 的保存接口要编码，所以写入前先按 BOSS 自己的字典把文字转成编码。
 * 这几个接口都是录制里真实出现过的 GET，无需请求体。任一接口失败只让那一类字典为空，
 * 不影响其他字典，也不阻断整个流程——调用方会退化成「沿用线上原编码 / 不新建这条」。
 *
 * 函数会被序列化后注入页面，不能引用模块作用域内的任何变量或导入（类型除外）。
 */
export async function onlineDictInPage(): Promise<BossPageOutcome<OnlineDictTrees>> {
  type Raw = Record<string, unknown>;
  const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

  const api = (window as unknown as Raw)["__bossResumeCvApi__"] as CvApi | undefined;
  if (!api) return { ok: false, error: { code: "PAGE_UNAVAILABLE", message: "BOSS 页面没有装上请求工具，请重新加载扩展后重试" } };

  const cookie = (name: string): string => {
    const hit = document.cookie.split("; ").find((part) => part.startsWith(`${name}=`));
    return hit ? decodeURIComponent(hit.slice(name.length + 1)) : "";
  };

  const headers = (() => {
    let stored = "";
    try {
      stored = window.localStorage.getItem("token") ?? "";
    } catch {
      stored = "";
    }
    const token = cookie("zp_at") || stored;
    return token ? { token } : undefined;
  })();

  const readPath = async (path: string): Promise<unknown> => {
    try {
      return (await api.call("GET", path, {}, headers)) ?? null;
    } catch {
      // 带 token 被拒时退回不带 token；仍失败就当作空字典。
      if (!headers) return null;
      try {
        return (await api.call("GET", path)) ?? null;
      } catch {
        return null;
      }
    }
  };

  const configOf = (data: unknown): unknown => (isRecord(data) ? data.config : null);

  const [workPositionConfig, expectPositionConfig, industries, cities] = await Promise.all([
    readPath("/wapi/zpgeek/workexp/position/config/query.json"),
    readPath("/wapi/zpgeek/common/data/expectposition.json"),
    readPath("/wapi/zpCommon/data/industry.json"),
    readPath("/wapi/zpCommon/data/city.json"),
  ]);

  return {
    ok: true,
    data: {
      workPositions: configOf(workPositionConfig),
      expectPositions: configOf(expectPositionConfig),
      industries,
      cities,
    },
  };
}
