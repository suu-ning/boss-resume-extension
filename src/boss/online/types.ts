import type { OnlineModuleId, OnlineSyncOptions } from "../../domain/types";
import type { BossFetchError, BossPageOutcome } from "../types";

/**
 * 在线简历（www.zhipin.com 求职者简历）的模型与同步计划类型。
 *
 * 字段来源：2026-10-30 录制的 `GET /wapi/zpgeek/resume/geek/preview/data.json`（boss-attachment-sync-sample）。
 * 该接口一次返回整份在线简历：baseInfo、userDesc、professionalSkill、expectList、workExpList、
 * projectExpList、educationExpList、certificationList，以及社交主页/志愿者/荣誉等模块。
 *
 * 与直聘简历（cv.zhipin.com）的模型分开：字段名、日期格式（YYYY.MM）、技能是单段文本、期望是多条，
 * 全都不同，硬套 uploadPlan 只会写出错数据。
 */

/** 扩展页 → Service Worker：读取当前账号的在线简历。 */
export const ONLINE_READ_MESSAGE = "boss.online-resume.read";
/** 扩展页 → Service Worker：读取写入用的字典（职位 / 行业 / 城市）。 */
export const ONLINE_DICT_MESSAGE = "boss.online-resume.dict";
/** 扩展页 → Service Worker：把写操作逐个写回在线简历。 */
export const ONLINE_WRITE_MESSAGE = "boss.online-resume.write";

/**
 * 一个写入动作（纯数据，可直接跨进程传给页面任务）。
 *
 * 只带接口路径和完整请求体：页面任务只负责「发请求、前置校验、收集结果」，
 * 不参与拼字段——拼字段是 execute.ts 的纯函数职责，必须能单测。
 */
export interface OnlineOperation {
  /** 稳定标识：报告里对应回具体哪一条。 */
  key: string;
  module: OnlineModuleId;
  /** 给用户看的动作名，例如「更新工作经历 · 某某公司」。 */
  label: string;
  action: "save" | "delete";
  path: string;
  payload: Record<string, unknown>;
  /** 保存类接口的前置校验；有就先校验，返回 dialog 非空时放弃这一条。 */
  precheck?: { method: "GET" | "POST"; path: string; payload: Record<string, unknown> };
  /** 这条动作的额外说明：没能写入的字段、用了线上原值的地方。 */
  note?: string;
}

export interface OnlineOperationResult {
  key: string;
  label: string;
  ok: boolean;
  code?: string;
  message?: string;
}

export interface OnlineWriteResult {
  /** 全部动作成功才算 true；有任何失败都要如实报出来。 */
  ok: boolean;
  done: OnlineOperationResult[];
  failed: OnlineOperationResult[];
  /** 因为登录失效 / 安全校验 / 限流而停下时，后面没执行的条目。 */
  skipped: string[];
  /** 新建条目接口返回的加密 id，按 key 记录。 */
  ids: Record<string, string>;
  error?: BossFetchError;
}

/** 页面读取结果：zpData 原样返回，由 adapter 转换。 */
export type OnlineReadOutcome = BossPageOutcome<Record<string, unknown>>;

export interface OnlineExpect {
  id?: string;
  locationName?: string;
  positionName?: string;
  lowSalary?: number;
  highSalary?: number;
  salaryDesc?: string;
  industryDesc?: string;
}

export interface OnlineWork {
  id?: string;
  companyName: string;
  positionName: string;
  department?: string;
  /** YYYY-MM */
  startDate?: string;
  endDate?: string;
  /** 工作内容 */
  workContent?: string;
  workPerformance?: string;
  /** 技能标签（线上 emphasis[]） */
  emphasis: string[];
}

export interface OnlineProject {
  id?: string;
  name: string;
  roleName?: string;
  startDate?: string;
  endDate?: string;
  description?: string;
  performance?: string;
  url?: string;
}

export interface OnlineEducation {
  id?: string;
  school: string;
  major?: string;
  degreeName?: string;
  startYear?: string;
  endYear?: string;
  description?: string;
  thesis?: string;
}

export interface OnlineCertificate {
  name: string;
}

export interface OnlineResume {
  fetchedAt: string;
  /** 线上「最近更新时间」，只用于界面展示。 */
  lastUpdateTime?: string;
  name: string;
  gender?: "male" | "female";
  /** YYYY-MM */
  birthday?: string;
  /** YYYY-MM */
  workStartDate?: string;
  advantage: string;
  professionalSkill: string;
  expects: OnlineExpect[];
  works: OnlineWork[];
  projects: OnlineProject[];
  educations: OnlineEducation[];
  certificates: OnlineCertificate[];
  /** 线上有内容、但本地档案没有对应字段的模块（社交主页、荣誉、社团等）。 */
  unknownModules: string[];
}

/** 定义在领域层：同步选项要持久化模块勾选，两边共用同一套 id。 */
export type { OnlineModuleId };

/** 全部可勾选模块，顺序即弹窗里的展示顺序。 */
export const ALL_ONLINE_MODULES: OnlineModuleId[] = [
  "baseInfo",
  "advantage",
  "professionalSkill",
  "expect",
  "work",
  "project",
  "education",
  "certificate",
];

export type ChangeKind = "create" | "update" | "delete" | "unchanged";

/** 一个字段的线上值 → 本地值。before 为空表示线上没有值，after 为空表示本地要清空它。 */
export interface FieldChange {
  label: string;
  before: string;
  after: string;
  changed: boolean;
}

export interface ItemChange {
  /** 展示序号，从 1 开始；与两侧数组下标无关（线上顺序由服务端排，和档案顺序不一定一致）。 */
  index: number;
  /** 对应本地数组的下标（0 基）；该条目只在线上存在时为 undefined。 */
  localIndex?: number;
  /** 对应线上数组的下标（0 基）；该条目只在本地存在时为 undefined。 */
  remoteIndex?: number;
  /** 条目标题（公司 / 项目 / 学校 / 期望岗位），给用户认条目用。 */
  title: string;
  kind: ChangeKind;
  fields: FieldChange[];
}

export interface OnlineModulePlan {
  id: OnlineModuleId;
  label: string;
  /** 模块级结论：有变更就是 update，全部一致就是 unchanged。 */
  kind: ChangeKind;
  /** 用户是否勾选了本次同步这个模块。未勾选时差异照常列出，但不写入、也不计入汇总。 */
  selected: boolean;
  /** 单值模块（基本资料 / 个人优势 / 专业技能）的字段变动。 */
  fields: FieldChange[];
  /** 列表模块（经历类）的逐条变动。 */
  items: ItemChange[];
  counts: { create: number; update: number; delete: number; unchanged: number };
  /** 该模块的取舍说明，例如「只同步名称」「保留线上求职状态」。 */
  note?: string;
  /** 需要用户注意的一句话，在模块标题上直接显示（折叠时也看得到）。 */
  hint?: string;
}

export interface OnlineSyncPlan {
  modules: OnlineModulePlan[];
  options: OnlineSyncOptions;
  /** 非空时不允许同步：先把本地改对。 */
  blockers: string[];
  /** 转换时的取舍，同步前展示给用户。 */
  warnings: string[];
  /** 明确保留线上原值、不参与一致性判定的字段。 */
  preserved: string[];
  /** 本地有、但这次不比对也不写入的内容。 */
  notCompared: string[];
  /** 用户没勾选的模块：线上原样保留，不写入也不计数。 */
  skipped: string[];
  /** 只统计勾选模块，也就是这次真正会执行的动作。 */
  counts: { create: number; update: number; delete: number; clear: number };
  /** 勾选模块里有变更的模块数；为 0 表示勾选的这部分已经一致。 */
  changedModules: number;
}

/** 默认开关：求职状态与期望行业都保留线上原值，模块默认全选。 */
export const DEFAULT_ONLINE_SYNC_OPTIONS: OnlineSyncOptions = {
  syncJobStatus: false,
  syncIndustries: false,
  // 只作为 resolveOnlineSyncOptions 的输入，调用方拿到的都是新数组。
  modules: [...ALL_ONLINE_MODULES],
};

/**
 * 归一化同步选项：旧档案没有 modules 字段时视为全选，非法 id 丢弃，重复去重并按展示顺序排列。
 * 所有读取 onlineSyncOptions 的地方都要过一遍，避免共享数组被就地修改。
 */
export function resolveOnlineSyncOptions(raw?: Partial<OnlineSyncOptions> | null): OnlineSyncOptions {
  const wanted = new Set<OnlineModuleId>(Array.isArray(raw?.modules) ? raw.modules : ALL_ONLINE_MODULES);
  return {
    syncJobStatus: raw?.syncJobStatus === true,
    syncIndustries: raw?.syncIndustries === true,
    modules: ALL_ONLINE_MODULES.filter((id) => wanted.has(id)),
  };
}

/** 在线简历最多 3 条期望（录制样本 expectList 已满 3 条且 canAddExpect=false）。 */
export const MAX_ONLINE_EXPECTS = 3;
