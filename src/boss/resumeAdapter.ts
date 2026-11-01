import type {
  BossEducation,
  BossCustomModule,
  BossProfile,
  BossProject,
  BossWorkExperience,
} from "../domain/types";
import type { BossImportResult, BossResumeContent } from "../domain/bossImport";
import type { BossFetchError } from "./types";
import { sectionOrderFromSort } from "../editor/sections";
import { splitSkillItems } from "../domain/skills";

/**
 * BossResumeAdapter：唯一接触直聘简历读取字段名的模块。
 *
 * 数据来源：cv.zhipin.com 的 myresume/query.json（参数 cvId）。字段名来自 2026-10-28 的真实录制：
 * - profileVO：name、gender（1 男 / 0 女）、birthday / workDate（YYYY.MM）、locationName、positionName、
 *   lowSalary / highSalary（K）、applyStatus、avatar、cvName、templateId；
 * - advantage；
 * - workExpVOList：company、positionName、startDateStr / endDateStr（YYYY.MM）、endDate（0 为至今）、responsibility、workPerformance；
 * - projectExpVOList：name、roleName、startDateStr / endDateStr、description、performance；
 * - eduExpVOList：school、major、degree（学历码）/ degreeName、startYear / endYear、description。
 * 没有映射到本地字段的 profileVO 字段原样保存在 unmappedFields。
 */

type Raw = Record<string, unknown>;

export type BossAdaptOutcome =
  | { ok: true; result: BossImportResult }
  | { ok: false; error: BossFetchError };

/** 直聘简历学历码 → 名称（与 uploadPlan.DEGREE_CODES 互逆）。 */
const DEGREE_NAMES: Record<number, string> = {
  209: "初中及以下",
  208: "中专/中技",
  206: "高中",
  202: "大专",
  203: "本科",
  204: "硕士",
  205: "博士",
};

/** profileVO 里已映射、或只属于直聘简历自身（模板、排序、ID 等）的字段，不进 unmappedFields。 */
const PROFILE_HANDLED = new Set([
  "name", "gender", "birthday", "workDate", "locationName", "positionName", "lowSalary", "highSalary", "applyStatus", "avatar",
  "cvName", "id", "geekId", "securityId", "templateId", "templateName", "templateType", "templateAvatarStyle", "templateLimitedFree",
  "templateLimitedType", "templateThumbnailUrl", "sort", "usedItemTypes", "updateTime", "cvScore", "lockStatus", "deletedTime",
  "deletedTimeDesc", "location", "locationLv1", "position", "age", "workDateDesc", "baseAvatar",
  "professionalSkillVOList", "professionalSkillList", "professionalSkills", "skillVOList", "skillList", "skills",
]);

function isRecord(value: unknown): value is Raw {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function list(value: unknown): Raw[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

const PROFESSIONAL_SKILL_KEYS = new Set([
  "professionalSkillVOList",
  "professionalSkillList",
  "professionalSkills",
  "skillVOList",
  "skillList",
  "skills",
]);

/** 直聘不同版本对技能条目的命名不完全一致，统一提取成可编辑的字符串。 */
function skillText(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") return text(value);
  if (!isRecord(value)) return undefined;
  for (const key of ["name", "skillName", "title", "label", "content", "value"]) {
    const result = text(value[key]);
    if (result) return result;
  }
  return undefined;
}

function professionalSkills(detail: Raw): string[] {
  const result: string[] = [];
  for (const key of PROFESSIONAL_SKILL_KEYS) {
    const value = detail[key];
    if (Array.isArray(value)) result.push(...value.map(skillText).filter((item): item is string => Boolean(item)));
    else if (value !== undefined) {
      const item = skillText(value);
      if (item) result.push(item);
    }
  }
  // 线上偶尔把整段技能描述塞进一条（内部含换行），按行拆成可编辑的条目。
  return [...new Set(splitSkillItems(result))];
}

function titleFromKey(key: string): string {
  return key
    .replace(/VO(List)?$/, "")
    .replace(/List$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (value) => value.toUpperCase()) || "其他模块";
}

/** 未识别的顶层数组按原始 key 保留，避免导入后上传/AI 编辑时静默丢模块。 */
function customModulesOf(detail: Raw): BossCustomModule[] {
  const handled = new Set([
    "profileVO", "advantage", "workExpVOList", "projectExpVOList", "eduExpVOList",
    ...PROFESSIONAL_SKILL_KEYS,
  ]);
  return Object.entries(detail)
    .filter(([key, value]) => !handled.has(key) && Array.isArray(value) && value.length > 0)
    .map(([key, value]) => ({ key, title: titleFromKey(key), items: structuredClone(value as unknown[]) }));
}

/** 支持 YYYY.MM、YYYY-MM、YYYY/MM、YYYY年MM、YYYYMM，统一为 YYYY-MM。 */
export function normalizeMonth(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const match = /^(\d{4})[-./年]?(\d{1,2})(?:\D|$)/.exec(raw);
  if (!match) return undefined;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? `${match[1]}-${String(month).padStart(2, "0")}` : undefined;
}

function yearMonth(value: unknown, month: string): string | undefined {
  const year = typeof value === "number" ? value : Number(text(value));
  return Number.isInteger(year) && year > 1900 ? `${year}-${month}` : undefined;
}

function isCurrent(raw: Raw): boolean {
  return raw.endDate === 0 || raw.endDate === "0" || /至今/.test(String(raw.endDateStr ?? ""));
}

function mapGender(value: unknown): BossProfile["gender"] {
  if (value === 1 || value === "1") return "male";
  if (value === 0 || value === "0") return "female";
  return undefined;
}

function mapWork(raw: Raw, index: number): BossWorkExperience {
  const current = isCurrent(raw);
  return {
    localId: `work-boss-${text(raw.id) ?? index}`,
    companyName: text(raw.company) ?? "",
    positionName: text(raw.positionName) ?? "",
    startDate: normalizeMonth(raw.startDateStr) ?? "",
    endDate: current ? undefined : normalizeMonth(raw.endDateStr),
    isCurrent: current || undefined,
    responsibilities: text(raw.responsibility),
    skills: [],
    achievements: text(raw.workPerformance),
  };
}

function mapProject(raw: Raw, index: number): BossProject {
  const current = isCurrent(raw);
  return {
    localId: `project-boss-${text(raw.id) ?? index}`,
    projectName: text(raw.name) ?? "",
    role: text(raw.roleName),
    startDate: normalizeMonth(raw.startDateStr) ?? "",
    endDate: current ? undefined : normalizeMonth(raw.endDateStr),
    isCurrent: current || undefined,
    description: text(raw.description),
    achievements: text(raw.performance),
  };
}

function mapEducation(raw: Raw, index: number): BossEducation {
  const code = typeof raw.degree === "number" ? raw.degree : Number(raw.degree);
  // 教育经历是年份制，直聘用 isToday 表示「至今」；没有这个字段时退回按文本判断。
  const current = raw.isToday === true || isCurrent(raw);
  return {
    localId: `education-boss-${text(raw.id) ?? index}`,
    schoolName: text(raw.school) ?? "",
    degree: text(raw.degreeName) ?? DEGREE_NAMES[code],
    major: text(raw.major),
    // 直聘简历教育经历只有年份；本地按 9 月入学、6 月毕业补齐月份。
    startDate: yearMonth(raw.startYear, "09"),
    endDate: current ? undefined : yearMonth(raw.endYear, "06"),
    isCurrent: current || undefined,
    campusExperience: text(raw.description),
  };
}

function salaryOf(profile: Raw): string | undefined {
  const low = Number(profile.lowSalary);
  const high = Number(profile.highSalary);
  return low > 0 && high >= low ? `${low}-${high}K` : undefined;
}

export const BossResumeAdapter = {
  /** detail：myresume/query.json 的 zpData。 */
  adaptDetail(cvId: string, detail: unknown, fetchedAt: string = new Date().toISOString()): BossAdaptOutcome {
    if (!isRecord(detail) || !isRecord(detail.profileVO)) {
      return { ok: false, error: { code: "UNEXPECTED_RESPONSE", message: "直聘简历详情格式与预期不符：缺少 profileVO" } };
    }
    const p = detail.profileVO;
    const works = list(detail.workExpVOList);
    const projects = list(detail.projectExpVOList);
    const educations = list(detail.eduExpVOList);

    const content: BossResumeContent = {
      profile: {
        name: text(p.name) ?? "",
        avatar: text(p.avatar),
        gender: mapGender(p.gender),
        workStartDate: normalizeMonth(p.workDate),
        birthDate: normalizeMonth(p.birthday),
      },
      advantage: text(detail.advantage) ?? "",
      jobIntent: {
        cities: text(p.locationName) ? [text(p.locationName)!] : [],
        positions: text(p.positionName) ? [text(p.positionName)!] : [],
        salary: salaryOf(p),
        industries: [],
      },
      workExperiences: works.map(mapWork),
      projects: projects.map(mapProject),
      educations: educations.map(mapEducation),
      professionalSkills: professionalSkills({ ...p, ...detail }),
      customModules: customModulesOf(detail),
      certificates: [],
      socialProfiles: [],
      volunteerExperiences: [],
      jobSearchStatus: { status: text(p.applyStatus) },
      sectionOrder: sectionOrderFromSort(p.sort),
    };

    const rest = Object.fromEntries(
      Object.entries(p).filter(([key, value]) => !PROFILE_HANDLED.has(key) && value !== null && value !== "" && value !== 0),
    );
    const groups = [
      { label: "基本信息", count: content.profile.name ? 1 : 0 },
      { label: "个人优势", count: content.advantage ? 1 : 0 },
      { label: "工作经历", count: works.length },
      { label: "项目经历", count: projects.length },
      { label: "教育经历", count: educations.length },
    ];
    if (content.professionalSkills?.length) groups.push({ label: "专业技能", count: content.professionalSkills.length });
    for (const module of content.customModules ?? []) groups.push({ label: module.title, count: module.items.length });

    return {
      ok: true,
      result: {
        cvName: text(p.cvName) ?? "直聘简历",
        templateId: text(p.templateId),
        content,
        unmappedFields: Object.keys(rest).length ? { profileVO: rest } : undefined,
        remoteSnapshot: { capturedAt: fetchedAt, source: "fetch", cvId, rawData: detail },
        report: {
          fetchedAt,
          readGroups: groups.filter((group) => group.count > 0),
          missingGroups: groups.filter((group) => group.count === 0).map((group) => group.label),
          warnings: [],
        },
      },
    };
  },
};
