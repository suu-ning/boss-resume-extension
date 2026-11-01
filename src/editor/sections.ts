/** 编辑页的模块定义，编辑表单、左侧菜单与预览共用。求职意向与直聘简历一样并在基本资料里。 */
export type SectionId = "profile" | "professionalSkills" | "customModules" | "advantage" | "work" | "projects" | "education";

/** 兼容旧调用方的名称；现在所有模块都可拖动。 */
export type MovableSectionId = SectionId;

export const SECTION_LABEL: Record<SectionId, string> = {
  profile: "基本资料",
  professionalSkills: "专业技能",
  customModules: "自定义模块",
  advantage: "个人优势",
  work: "工作经历",
  projects: "项目经历",
  education: "教育经历",
};

/** 直聘简历 profileVO.sort 里的已确认模块编码；自定义模块暂无可靠编码。 */
export const SECTION_CODE: Partial<Record<SectionId, number>> = {
  profile: 1001,
  professionalSkills: 2001,
  advantage: 1002,
  work: 1003,
  projects: 1005,
  education: 1006,
};

/** 默认顺序与当前导航一致；所有模块都通过同一列表排序。 */
export const DEFAULT_SECTION_ORDER: readonly SectionId[] = ["profile", "advantage", "professionalSkills", "work", "projects", "education", "customModules"];
export const MOVABLE_SECTIONS = DEFAULT_SECTION_ORDER;

/** 本地顺序缺失或不完整时按默认顺序补齐，保证每个模块都在且不重复。 */
export function normalizeSectionOrder(order?: readonly string[]): SectionId[] {
  const result: SectionId[] = [];
  for (const id of order ?? []) {
    if ((DEFAULT_SECTION_ORDER as readonly string[]).includes(id) && !result.includes(id as SectionId)) result.push(id as SectionId);
  }
  if (!result.length) return [...DEFAULT_SECTION_ORDER];

  if (!result.includes("profile")) result.unshift("profile");
  for (const id of DEFAULT_SECTION_ORDER) {
    if (id !== "professionalSkills" && id !== "customModules" && !result.includes(id)) result.push(id);
  }
  if (!result.includes("professionalSkills")) {
    const advantageIndex = result.indexOf("advantage");
    result.splice(advantageIndex >= 0 ? advantageIndex + 1 : 1, 0, "professionalSkills");
  }
  if (!result.includes("customModules")) result.push("customModules");
  return result;
}

/** 直聘简历的 sort（模块编码列表）→ 本地可拖动模块顺序。 */
export function sectionOrderFromSort(sort: unknown): SectionId[] {
  const codes = Array.isArray(sort) ? sort.map(Number) : typeof sort === "string" ? sort.split(",").map(Number) : [];
  const ids = codes
    .map((code) => DEFAULT_SECTION_ORDER.find((id) => SECTION_CODE[id] === code))
    .filter((id): id is SectionId => Boolean(id));
  return normalizeSectionOrder(ids);
}
