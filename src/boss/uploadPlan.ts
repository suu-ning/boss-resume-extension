import type { BossResumeDocument } from "../domain/types";
import { normalizeSectionOrder, SECTION_CODE } from "../editor/sections";

/**
 * 把本地简历转换为“上传到直聘简历”的提交计划（纯函数，不发请求）。
 *
 * 接口与字段来源：2026-10-28 录制的直聘简历编辑器真实请求（boss-upload-recording-*.json），
 * 以及 cv.zhipin.com 前端包里的默认值（学历码、空日期 -1、至今 endDate=0）。
 * 计划会作为 chrome.scripting.executeScript 的参数传进页面，必须可 JSON 序列化。
 */

export interface UploadMonth {
  /** 202003 */
  compact: string;
  /** 2020.03 */
  dot: string;
  /** 2020-03 */
  dash: string;
}

export interface UploadText {
  text: string;
  html: string;
}

export interface UploadWork {
  company: string;
  positionName: string;
  start?: UploadMonth;
  end?: UploadMonth;
  current: boolean;
  responsibility: UploadText;
  performance: UploadText;
}

export interface UploadProject {
  name: string;
  roleName: string;
  start?: UploadMonth;
  end?: UploadMonth;
  current: boolean;
  description: UploadText;
  performance: UploadText;
}

export interface UploadEducation {
  school: string;
  major: string;
  /** 直聘简历学历码；0 表示未填。 */
  degree: number;
  startYear?: number;
  endYear?: number;
  /** 仍在读，直聘那边勾「至今」，结束年份留空。 */
  current: boolean;
  description: UploadText;
}

export interface UploadPlan {
  cvName: string;
  /** 已绑定的直聘简历；直聘简历里还有这份时直接覆盖它，否则新建。 */
  cvId?: string;
  /** 直聘简历样式模板；从直聘简历拉取的简历会带上，保证上传后样式不变。 */
  templateId?: string;
  profile: {
    name: string;
    /** 1 男、0 女、-1 未填（直聘简历编辑器的取值）。 */
    gender: number;
    birthday?: UploadMonth;
    workDate?: UploadMonth;
    cityName?: string;
    positionName?: string;
    /** 单位 K；0/0 表示不展示薪资。 */
    lowSalary: number;
    highSalary: number;
  };
  advantage: UploadText;
  /** BOSS 专业技能字段（skills / skillsRichText）。 */
  professionalSkills: UploadText;
  /** 个人优势 / 工作经历 / 项目经历 / 教育经历的模块编码，按本地顺序排列（如 [1003, 1002, 1005, 1006]）。 */
  sectionCodes: number[];
  works: UploadWork[];
  projects: UploadProject[];
  educations: UploadEducation[];
  /** 本次不会上传的内容（直聘简历没有对应字段，或接口未经录制验证）。 */
  notUploaded: string[];
  /** 转换时做的取舍，上传前展示给用户。 */
  notes: string[];
  /** 不满足直聘简历限制、必须先改的问题；非空时不允许上传。 */
  blockers: string[];
}

/** 直聘简历编辑器限制：同一模块最多 10 段经历。 */
export const MAX_ITEMS_PER_MODULE = 10;

export const BOSS_UPLOAD_MESSAGE = "boss.upload-resume";

export type BossUploadErrorCode =
  | "EXTENSION_ONLY"
  | "NO_TAB"
  | "NOT_LOGGED_IN"
  | "RESUME_FULL"
  | "SECURITY_BLOCKED"
  | "RATE_LIMITED"
  | "NETWORK"
  | "API_ERROR"
  | "UNEXPECTED_RESPONSE";

export interface BossUploadError {
  code: BossUploadErrorCode;
  message: string;
  /** 失败时正在执行的步骤，例如“保存工作经历 2/3”。 */
  step?: string;
  detail?: string;
}

export type BossUploadResult =
  /** created 为 true 表示新建了一份，false 表示覆盖了已有的那份。 */
  | { ok: true; cvId: string; editUrl: string; created: boolean; warnings: string[] }
  /** created 为 true 表示失败前已经新建了简历（里面可能有模板示例内容）。 */
  | { ok: false; error: BossUploadError; cvId?: string; editUrl?: string; created?: boolean; warnings: string[] };

/** 直聘简历编辑器内置的学历选项（cv.zhipin.com 前端包 degreeList）。 */
export const DEGREE_CODES: Record<string, number> = {
  初中及以下: 209,
  初中: 209,
  "中专/中技": 208,
  中专: 208,
  中技: 208,
  高中: 206,
  大专: 202,
  专科: 202,
  本科: 203,
  学士: 203,
  硕士: 204,
  研究生: 204,
  博士: 205,
};

export function toUploadMonth(value: string | undefined): UploadMonth | undefined {
  const match = /^(\d{4})-(\d{2})/.exec(value?.trim() ?? "");
  if (!match) return undefined;
  const [, year, month] = match;
  return { compact: `${year}${month}`, dot: `${year}.${month}`, dash: `${year}-${month}` };
}

const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 纯文本 → 编辑器富文本：每行一个段落。 */
export function toUploadText(value: string | undefined): UploadText {
  const text = (value ?? "").trim();
  if (!text) return { text: "", html: "" };
  const html = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("");
  return { text, html };
}

/** "15-20K"、"15k~20k"、"15至20" → [15, 20]；无法识别返回 undefined。 */
export function parseSalary(value: string | undefined): [number, number] | undefined {
  const match = /(\d{1,3})\s*[kK千]?\s*[-~～—至到]\s*(\d{1,3})\s*[kK千]?/.exec(value ?? "");
  if (!match) return undefined;
  const low = Number(match[1]);
  const high = Number(match[2]);
  return low > 0 && high >= low ? [low, high] : undefined;
}

const yearOf = (value: string | undefined): number | undefined => {
  const match = /^(\d{4})/.exec(value?.trim() ?? "");
  return match ? Number(match[1]) : undefined;
};

export function buildUploadPlan(resume: BossResumeDocument): UploadPlan {
  const notes: string[] = [];
  const notUploaded: string[] = [];
  const intent = resume.jobIntent;

  const salary = parseSalary(intent.salary);
  if (intent.salary?.trim() && !salary) notes.push(`期望薪资“${intent.salary}”无法识别为 “15-20K” 这样的范围，将上传为不展示薪资`);
  if (intent.cities.length > 1) notes.push(`直聘简历只有一个期望城市，只上传第一个：${intent.cities[0]}`);
  if (intent.positions.length > 1) notes.push(`直聘简历只有一个期望职位，只上传第一个：${intent.positions[0]}`);

  const gender = resume.profile.gender === "male" ? 1 : resume.profile.gender === "female" ? 0 : -1;

  const educations = resume.educations.map((education): UploadEducation => {
    const degreeText = education.degree?.trim() ?? "";
    const degree = degreeText ? DEGREE_CODES[degreeText] ?? 0 : 0;
    if (degreeText && !degree) notes.push(`学历“${degreeText}”不在直聘简历的选项里（初中及以下、中专/中技、高中、大专、本科、硕士、博士），将留空`);
    const campus = [education.campusExperience, education.thesis ? `论文：${education.thesis}` : undefined].filter(Boolean).join("\n");
    return {
      school: education.schoolName.trim(),
      major: education.major?.trim() ?? "",
      degree,
      startYear: yearOf(education.startDate),
      endYear: education.isCurrent ? undefined : yearOf(education.endDate),
      current: Boolean(education.isCurrent),
      description: toUploadText(campus),
    };
  });

  const count = (items: unknown[], label: string) => {
    if (items.length) notUploaded.push(`${label} ${items.length} 条`);
  };
  count(resume.certificates, "资格证书");
  count(resume.socialProfiles, "社交主页");
  count(resume.volunteerExperiences, "志愿者服务");
  if (resume.customModules?.length) {
    notUploaded.push(resume.bossCvId
      ? `自定义模块 ${resume.customModules.length} 项：当前版本未验证写入接口，将沿用 BOSS 已有内容`
      : `自定义模块 ${resume.customModules.length} 项：当前版本未验证写入接口，新建简历不会自动添加`);
  }
  if (intent.industries.length) notUploaded.push("期望行业");
  if (intent.jobType || intent.jobPreference) notUploaded.push("求职类型与偏好");
  if (Object.values(resume.jobSearchStatus).some(Boolean)) notUploaded.push("求职状态");
  if (resume.workExperiences.some((work) => work.industry || work.department || work.skills.length)) notUploaded.push("工作经历中的行业、部门与技能标签");
  if (resume.projects.some((project) => project.link)) notUploaded.push("项目链接");

  const blockers: string[] = [];
  if (!resume.profile.name.trim()) blockers.push("请先填写姓名");
  const limit = (items: unknown[], label: string) => {
    if (items.length > MAX_ITEMS_PER_MODULE) blockers.push(`${label}有 ${items.length} 段，直聘简历每个模块最多 ${MAX_ITEMS_PER_MODULE} 段`);
  };
  limit(resume.workExperiences, "工作经历");
  limit(resume.projects, "项目经历");
  limit(resume.educations, "教育经历");

  return {
    blockers,
    cvName: resume.title.trim() || "未命名简历",
    cvId: resume.bossCvId,
    templateId: resume.bossTemplateId,
    profile: {
      name: resume.profile.name.trim(),
      gender,
      birthday: toUploadMonth(resume.profile.birthDate),
      workDate: toUploadMonth(resume.profile.workStartDate),
      cityName: intent.cities[0]?.trim() || undefined,
      positionName: intent.positions[0]?.trim() || undefined,
      lowSalary: salary?.[0] ?? 0,
      highSalary: salary?.[1] ?? 0,
    },
    advantage: toUploadText(resume.advantage),
    professionalSkills: toUploadText((resume.professionalSkills ?? []).map((item) => item.trim()).filter(Boolean).join("\n")),
    sectionCodes: (() => {
      return normalizeSectionOrder(resume.sectionOrder)
        .filter((id) => id !== "professionalSkills" || resume.professionalSkills?.some((item) => item.trim()))
        .map((id) => SECTION_CODE[id])
        .filter((code): code is number => code !== undefined);
    })(),
    works: resume.workExperiences.map((work) => ({
      company: work.companyName.trim(),
      positionName: work.positionName.trim(),
      start: toUploadMonth(work.startDate),
      end: work.isCurrent ? undefined : toUploadMonth(work.endDate),
      current: Boolean(work.isCurrent),
      responsibility: toUploadText(work.responsibilities),
      performance: toUploadText(work.achievements),
    })),
    projects: resume.projects.map((project) => ({
      name: project.projectName.trim(),
      roleName: project.role?.trim() ?? "",
      start: toUploadMonth(project.startDate),
      end: toUploadMonth(project.endDate),
      current: false,
      description: toUploadText(project.description),
      performance: toUploadText(project.achievements),
    })),
    educations,
    notUploaded,
    notes,
  };
}
