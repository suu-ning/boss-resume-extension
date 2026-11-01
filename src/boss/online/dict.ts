/**
 * 在线简历写入用的字典（名称 → 编码）。
 *
 * 为什么需要：本地档案里职位、行业、城市、学校都只有**文字**，而 BOSS 的保存接口要的是**编码**
 * （工作经历的 position 是 6 位数字、行业 industryCode 是编码、期望的 location/position 也是编码）。
 * 照文字硬塞编码会把行业、职位写错，所以写入前先从 BOSS 自己的字典接口取编码，再按名字匹配。
 *
 * 字典来源（均为 2026-10-30 录制中真实出现过、且不需要请求体的 GET 接口）：
 * - 职位：`/wapi/zpgeek/common/data/expectposition.json` 的 `zpData.config`（期望）
 *         `/wapi/zpgeek/workexp/position/config/query.json` 的 `zpData.config`（工作经历）
 * - 行业：`/wapi/zpCommon/data/industry.json` 的 `zpData`（数组）
 * - 城市：`/wapi/zpCommon/data/city.json` 的 `zpData`（数组，录制里响应体为空，取不到就退回线上原值）
 *
 * 匹配不到时**不猜**：调用方要么沿用线上原编码，要么把这条标成「本次没能同步」，
 * 绝不能拿 0 或随便一个编码顶上。
 */

export interface DictEntry {
  code: number;
  name: string;
  /** 上一级编码，城市这类层级字典需要它。 */
  parentCode: number;
}

export interface OnlineDicts {
  positions: DictEntry[];
  industries: DictEntry[];
  cities: DictEntry[];
}

export const EMPTY_DICTS: OnlineDicts = { positions: [], industries: [], cities: [] };

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 把字典树压平成「编码 + 名称」清单。
 *
 * leavesOnly 为 true 时只收叶子节点：父节点（如「技术」「互联网」）的编码不是合法的职位 / 行业编码，
 * 混进来会写出一个看似有值、实际无效的分类。
 */
export function flattenDict(nodes: unknown, leavesOnly = false, parentCode = 0, out: DictEntry[] = []): DictEntry[] {
  if (!Array.isArray(nodes)) return out;
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    const { code, name } = node;
    if (typeof code !== "number" || typeof name !== "string" || !name.trim()) continue;
    const children = node.subLevelModelList;
    const isLeaf = !Array.isArray(children) || children.length === 0;
    if (!leavesOnly || isLeaf) out.push({ code, name: name.trim(), parentCode });
    flattenDict(children, leavesOnly, code, out);
  }
  return out;
}

/** 名称归一化：去空白、去「市 / 省」这类后缀、小写，避免「北京」和「北京市」匹配不上。 */
export function normalizeDictName(name: string): string {
  return name
    .replace(/\s+/g, "")
    .replace(/(市|省|自治区|特别行政区)$/, "")
    .toLowerCase();
}

/**
 * 按名称找字典项：先精确匹配，再归一化匹配，最后做「包含」兜底（仅当结果唯一）。
 * 都匹配不到返回 undefined —— 由调用方决定是沿用线上编码还是报「没能同步」。
 */
export function findDictEntry(entries: DictEntry[], name: string | undefined): DictEntry | undefined {
  const text = (name ?? "").trim();
  if (!text || !entries.length) return undefined;
  const exact = entries.find((entry) => entry.name === text);
  if (exact) return exact;
  const target = normalizeDictName(text);
  if (!target) return undefined;
  const normalized = entries.filter((entry) => normalizeDictName(entry.name) === target);
  if (normalized.length === 1) return normalized[0];
  const contained = entries.filter((entry) => {
    const candidate = normalizeDictName(entry.name);
    return candidate.includes(target) || target.includes(candidate);
  });
  return contained.length === 1 ? contained[0] : undefined;
}
