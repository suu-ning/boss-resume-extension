const MAX_DEPTH = 10;
const MAX_ARRAY_ITEMS = 2;
const FORMAT_MAX_LENGTH = 25;

/**
 * 这些字段是接口约定的常量（埋点来源标识之类），不是个人信息。
 * 复刻写请求时必须原样带上，所以保留原值——否则样本里只剩长度，等于没录到。
 */
const RAW_VALUE_KEYS = new Set(["xGeekBizSource"]);

/**
 * 字符串只暴露“格式”，不暴露内容：
 * - 1–3 位纯数字（表单里的枚举码，如 gender=1）保留原值；
 * - 只由数字与日期分隔符组成的短串（日期、时间戳、手机号）把数字换成 9，保留格式，如 "2020.03" → "9999.99"；
 * - 其余只保留长度。
 */
function describeString(value: string): string {
  if (/^\d{1,3}$/.test(value)) return `<digits:${value}>`;
  if (value.length <= FORMAT_MAX_LENGTH && /\d/.test(value) && /^[\d\s\-./:+TZ]+$/.test(value)) {
    return `<format:${value.replace(/\d/g, "9")}>`;
  }
  return `<string:${value.length}>`;
}

/**
 * 把 BOSS 原始数据转换为“只有字段结构、没有个人内容”的样本，用于校准适配器。
 *
 * - 字符串按 describeString 处理；浮点数、大整数（ID、时间戳、手机号）只保留类型。
 * - 0–999 的整数与布尔值保留原值：它们通常是性别、学历、开关等枚举，映射时需要知道取值。
 * - 数组只保留前两项结构和总长度。
 * - RAW_VALUE_KEYS 里的常量字段保留原值，用 `<raw:…>` 标记，与脱敏值区分开。
 */
export function buildStructureSample(value: unknown, depth = 0, key?: string): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (key && RAW_VALUE_KEYS.has(key)) return `<raw:${value}>`;
    return describeString(value);
  }
  if (typeof value === "boolean") return `<boolean:${value}>`;
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 0 && value <= 999) return `<integer:${value}>`;
    return Number.isInteger(value) ? "<integer>" : "<number>";
  }
  if (depth >= MAX_DEPTH) return "<truncated>";
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    return [`<array:${value.length}>`, ...value.slice(0, MAX_ARRAY_ITEMS).map((item) => buildStructureSample(item, depth + 1))];
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, item]) => [
        entryKey,
        buildStructureSample(item, depth + 1, entryKey),
      ]),
    );
  }
  return `<${typeof value}>`;
}
