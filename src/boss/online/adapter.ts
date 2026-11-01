import type { BossFetchError } from "../types";
import { monthOf, yearOf } from "./normalize";
import type { OnlineCertificate, OnlineEducation, OnlineExpect, OnlineProject, OnlineResume, OnlineWork } from "./types";

/**
 * 在线简历适配器：唯一接触 `geek/preview/data.json` 字段名的模块。
 *
 * 字段名来自 2026-10-30 的脱敏录制（boss-attachment-sync-sample-*.json）：
 * - baseInfo：name、gender（1 男 / 0 女）、birthday（YYYYMMDD）/ birthdayDesc（YYYY-MM）、
 *   startWorkDateDesc（YYYY-MM）、degree、degreeName、workYears；
 * - userDesc：个人优势；professionalSkill：专业技能，是**一整段文本**，不是数组；
 * - expectList：每条一个城市 + 一个职位 + 薪资区间 + 行业；
 * - workExpList：companyName、positionName、department、industry{code,name}、workContent、
 *   workPerformance、startDate / startDateStr（YYYY.MM）、emphasis[]（技能标签）；
 * - projectExpList：name、roleName、projectDesc、performance、url、startDate / endDate；
 * - educationExpList：school、major、degree / degreeName、startYear / endYear、educationDesc、thesisTitle；
 * - certificationList：certName、certType、certId。
 *
 * 线上有内容但本地模型没有对应字段的模块（社交主页、荣誉等）只记名字，不猜结构。
 */

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

const num = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
};

const list = (value: unknown): Raw[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/** 线上有值、但本地模型没有对应字段的模块。 */
const EXTRA_MODULES: Array<[key: string, label: string]> = [
  ["socialContactList", "社交主页"],
  ["volunteerExpList", "志愿者服务"],
  ["honorList", "荣誉奖项"],
  ["clubExpList", "社团经历"],
  ["postExpList", "岗位经历"],
  ["trainingExpList", "培训经历"],
  ["designWorksImage", "设计作品"],
  ["designWorksVideo", "设计作品视频"],
  ["personalImage", "个人形象"],
  ["handicappedInfo", "残障信息"],
];

const hasContent = (value: unknown): boolean => {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object") return Object.keys(value as Raw).length > 0;
  return false;
};

function mapGender(value: unknown): OnlineResume["gender"] {
  if (value === 1 || value === "1") return "male";
  if (value === 0 || value === "0") return "female";
  return undefined;
}

function mapExpect(raw: Raw): OnlineExpect {
  return {
    id: str(raw.id),
    locationName: str(raw.locationName),
    positionName: str(raw.positionName),
    lowSalary: num(raw.lowSalary),
    highSalary: num(raw.highSalary),
    salaryDesc: str(raw.salaryDesc),
    industryDesc: str(raw.industryDesc),
  };
}

function mapWork(raw: Raw): OnlineWork {
  return {
    id: str(raw.id),
    companyName: str(raw.companyName) ?? "",
    positionName: str(raw.positionName) ?? "",
    department: str(raw.department),
    // 线上日期同时给了 startDate 与 startDateStr，字符串更稳（日期间隔符在不同版本里变过）。
    startDate: monthOf(raw.startDateStr) || monthOf(raw.startDate) || undefined,
    endDate: monthOf(raw.endDateStr) || monthOf(raw.endDate) || undefined,
    workContent: str(raw.workContent),
    workPerformance: str(raw.workPerformance),
    emphasis: Array.isArray(raw.emphasis) ? raw.emphasis.filter((item): item is string => typeof item === "string") : [],
  };
}

function mapProject(raw: Raw): OnlineProject {
  return {
    id: str(raw.id),
    name: str(raw.name) ?? "",
    roleName: str(raw.roleName),
    startDate: monthOf(raw.startDateStr) || monthOf(raw.startDate) || undefined,
    endDate: monthOf(raw.endDateStr) || monthOf(raw.endDate) || undefined,
    description: str(raw.projectDesc),
    performance: str(raw.performance),
    url: str(raw.url),
  };
}

function mapEducation(raw: Raw): OnlineEducation {
  return {
    id: str(raw.id),
    school: str(raw.school) ?? "",
    major: str(raw.major),
    degreeName: str(raw.degreeName),
    startYear: yearOf(raw.startYearStr ?? raw.startYear) || undefined,
    endYear: yearOf(raw.endYearStr ?? raw.endYear) || undefined,
    description: str(raw.educationDesc),
    thesis: str(raw.thesisTitle) ?? str(raw.thesisDesc),
  };
}

function mapCertificate(raw: Raw): OnlineCertificate {
  return { name: str(raw.certName) ?? "" };
}

export type OnlineAdaptOutcome =
  | { ok: true; resume: OnlineResume; raw: Record<string, unknown> }
  | { ok: false; error: BossFetchError };

export const OnlineResumeAdapter = {
  /** zpData：`GET /wapi/zpgeek/resume/geek/preview/data.json` 的返回值。 */
  adapt(zpData: unknown, fetchedAt: string = new Date().toISOString()): OnlineAdaptOutcome {
    if (!isRecord(zpData) || !isRecord(zpData.baseInfo)) {
      return { ok: false, error: { code: "UNEXPECTED_RESPONSE", message: "在线简历返回格式与预期不符：缺少 baseInfo" } };
    }
    const base = zpData.baseInfo;

    return {
      ok: true,
      raw: zpData,
      resume: {
        fetchedAt,
        lastUpdateTime: str(zpData.lastUpdateTime),
        name: str(base.name) ?? "",
        gender: mapGender(base.gender),
        // birthdayDesc 是 YYYY-MM；缺省时再解析 birthday 的 8 位数字。
        birthday: monthOf(base.birthdayDesc) || monthOf(base.birthday) || undefined,
        workStartDate: monthOf(base.startWorkDateDesc) || monthOf(base.startWorkDate) || undefined,
        advantage: str(zpData.userDesc) ?? "",
        professionalSkill: str(zpData.professionalSkill) ?? "",
        expects: list(zpData.expectList).map(mapExpect),
        works: list(zpData.workExpList).map(mapWork),
        projects: list(zpData.projectExpList).map(mapProject),
        educations: list(zpData.educationExpList).map(mapEducation),
        certificates: list(zpData.certificationList).map(mapCertificate),
        unknownModules: EXTRA_MODULES.filter(([key]) => hasContent(zpData[key])).map(([, label]) => label),
      },
    };
  },
};
