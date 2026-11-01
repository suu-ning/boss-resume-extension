/**
 * 在线简历比对用的归一化工具（纯函数，无副作用）。
 *
 * 两套口径，用途不同：
 * - `multiline()`：**写入口径**，保留换行。长文本（工作内容、项目描述、个人优势、在校经历）
 *   在 BOSS 预览页按原文分段展示，压成空格会让整段挤成一坨。
 * - `plain()`：**比对口径**，去掉首尾空白并把换行、连续空白压成单个空格。宽松比较，
 *   线上即使被服务端压平或存成 HTML，也不会被误判成「有差异」而反复重写。
 * 其余规则：
 * - 月份：统一成 YYYY-MM；线上有 `birthdayDesc`（YYYY-MM）这类描述字段时优先用它，避免解析 8 位数字。
 * - 空值：一律视为空串，"没有值"和"空字符串"在业务上是同一件事。
 */

export function plain(value: string | undefined | null): string {
  return stripHtml(value).replace(/\s+/g, " ").trim();
}

/** 线上偶尔回传 HTML 片段（`<br>`、`<p>`），比对时视为换行/分隔，避免假差异。 */
function stripHtml(value: string | undefined | null): string {
  return (value ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?(p|div|li)[^>]*>/gi, " ");
}

/**
 * 写入口径：保留换行。
 * - `\r\n` / `\r` 统一成 `\n`；
 * - 每行去掉首尾空白（BOSS 编辑器会自己补空格，留着反而多出空行）；
 * - 连续 3 个以上换行压成 1 个空行，去掉首尾空行。
 */
export function multiline(value: string | undefined | null): string {
  return (value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sameText(left: string | undefined | null, right: string | undefined | null): boolean {
  return plain(left) === plain(right);
}

/** YYYYMMDD / YYYYMM / YYYY-MM / YYYY.MM / YYYY年M月 → YYYY-MM；无法识别返回空串。 */
export function monthOf(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const match = /^(\d{4})[-./年]?(\d{1,2})(?:\D|$)/.exec(String(value).trim());
  if (!match) return "";
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? `${match[1]}-${String(month).padStart(2, "0")}` : "";
}

export function sameMonth(left: string | undefined, right: string | undefined): boolean {
  return monthOf(left) === monthOf(right);
}

/** 年份：YYYY/YYYY-MM → YYYY；无法识别返回空串。 */
export function yearOf(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value) && value > 1900) return String(value);
  const match = /^(\d{4})/.exec(String(value ?? "").trim());
  return match ? match[1] : "";
}

const TRUNCATE_AT = 48;

/** 界面展示用：空值显式写成「（空）」，长文本截断，避免整段经历把弹窗撑开。 */
export function show(value: string | undefined | null): string {
  const text = plain(value);
  if (!text) return "（空）";
  return text.length > TRUNCATE_AT ? `${text.slice(0, TRUNCATE_AT)}…` : text;
}

export function showMonth(value: string | undefined): string {
  const month = monthOf(value);
  return month || "（空）";
}

export function showYear(value: string | undefined): string {
  const year = yearOf(value);
  return year || "（空）";
}

/** 字符串去重并去掉空项，保持原顺序。 */
export function unique(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const text = plain(value);
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}
