/**
 * BOSS 在线简历的写入契约。
 *
 * 全部接口路径与字段名来自 2026-10-30 两次真实录制的请求体（`boss-attachment-sync-sample-*.json`），
 * 没有一个是推测的。字段值大多被脱敏成 `<string:12>` / `<format:9999-99>` 这种「只有格式」的标记，
 * 所以这里的构造函数只负责**确定的部分**（字段名、常量、可选性），取值来源由调用方决定。
 *
 * 两条贯穿全文的规则：
 *
 * 1. 本地档案里没有对应来源的字段（行业编码、职位编码、`industrySource` 这类），
 *    一律从线上原条目回传，绝不自己编。见 CARRY_OVER。
 * 2. 每次写都带 `xGeekBizSource`，缺了会被拒。录到的原值是 pc_online_resume。
 */

export interface GeekEndpoint {
  method: "GET" | "POST";
  path: string;
}

/** 在线简历（www.zhipin.com，求职者视角）的写接口。 */
export const GEEK_ENDPOINTS = {
  /** 基本资料：GET，无请求体，返回 { dialog } 供前端弹窗确认。 */
  baseInfoPrecheck: { method: "GET", path: "/wapi/zpgeek/resume/baseinfo/save/precheck.json" },
  baseInfoSave: { method: "POST", path: "/wapi/zpgeek/resume/baseinfo/save.json" },

  /** 个人优势：前置校验把字段名换成 userDesc，保存用 advantage。 */
  userDescPrecheck: { method: "POST", path: "/wapi/zpgeek/resume/userdesc/precheck.json" },
  userDescSave: { method: "POST", path: "/wapi/zpgeek/resume/userdesc/save.json" },

  /**
   * 工作经历：单条保存，编辑时带 id；新增不带 id，返回 encryptId。
   * 注意前置校验的字段名和保存不同（responsibility/workId ↔ workContent/id），不要混用。
   */
  workPrecheck: { method: "POST", path: "/wapi/zpgeek/geek/workexp/precheck.json" },
  workSave: { method: "POST", path: "/wapi/zpgeek/resume/workexp/save.json" },
  /** 删除按 id，与项目经历完全同构。 */
  workDelete: { method: "POST", path: "/wapi/zpgeek/resume/workexp/delete.json" },

  /** 项目经历：单条保存；删除是独立接口，只认 id。 */
  projectPrecheck: { method: "POST", path: "/wapi/zpgeek/resume/projectexp/precheck.json" },
  projectSave: { method: "POST", path: "/wapi/zpgeek/resume/projectexp/save.json" },
  projectDelete: { method: "POST", path: "/wapi/zpgeek/resume/projectexp/delete.json" },

  /** 教育经历：前置校验的请求体就是保存体去掉 xGeekBizSource。 */
  educationPrecheck: { method: "POST", path: "/wapi/zpgeek/geek/eduexp/precheck.json" },
  educationSave: { method: "POST", path: "/wapi/zpgeek/resume/eduexp/save.json" },

  /** 求职期望：单条保存，带 id；没有录到前置校验。 */
  expectSave: { method: "POST", path: "/wapi/zpgeek/resume/expect/save.json" },
  /**
   * 求职期望的删除 **按 positionType 整组删**，不是按 id 删单条。
   *
   * 录制现场：线上有 4 条期望（1 条 positionType=1，3 条 positionType=0），
   * 删掉那条 positionType=1 的时，请求体是 `{type: 1}` —— 传的是类型而不是 id。
   * 所以「线上 3 条、本地 2 条」这种情况无法只删 1 条：只能把该类型整组删掉再重建。
   */
  expectDelete: { method: "POST", path: "/wapi/zpgeek/resume/expect/delete.json" },

  /** 资格证书：整模块覆盖 —— 请求体是完整数组且没有 id，数组里少了哪条就等于删哪条。 */
  certificationSave: { method: "POST", path: "/wapi/zpgeek/resume/certification/save.json" },

  /**
   * 专业技能：整段技能文本 + 一次性的 `parserId`。
   *
   * 录制原值 `{parserId: 28 字符, skill: 375 字符, source: 1}`，其中 skill 的长度与附件解析结果
   * `professionalSkillDesc` 完全一致 —— 说明这里交的就是「（用户可编辑的）解析文本」，
   * parserId 只是这次解析的凭证，本地造不出来，只能从解析记录里取。
   */
  skillSave: { method: "POST", path: "/wapi/zpgeek/resume/professional/skill/save.json" },
} as const satisfies Record<string, GeekEndpoint>;

/** 每次写请求都带的来源标记（录制原值）。 */
export const GEEK_BIZ_SOURCE = "pc_online_resume";

/**
 * 本地没有可信来源、必须从线上原条目回传的字段。
 *
 * 这些是字典编码或服务端派生值，本地档案里只有文字；照着文字猜编码会把行业、职位写错，
 * 所以同步时整条透传线上值，只改本地真正拥有的那几个字段。
 */
export const CARRY_OVER: Record<string, string[]> = {
  workexp: ["industryCode", "industryName", "industrySource", "position", "customPositionName", "isPublic", "entrance", "workType"],
  projectexp: ["roleName", "url", "entrance"],
  eduexp: ["schoolId", "degree", "eduType", "entrance", "majorRanking"],
  expect: ["location", "locationName", "positionType", "subLocation", "otherLocationCodeStr", "freshGraduate", "multiExpectInfos"],
};

/**
 * 录制里取到的常量。
 *
 * `entrance` 在各模块取值不同（个人优势是 1，工作经历两次录制分别是 0 和 1），
 * 说明它随场景变化，**不能当全局常量**：这里只保存确认过的那一个用法。
 */
export const STATIC_FIELDS = {
  /** 个人优势保存时的入口标记；前置校验不带这个字段。 */
  userDescEntrance: 1,
  /** 各模块的风险提示开关，录制中恒为 1。 */
  riskTipType: 1,
  /** 期望保存的 fullUpdate，录制值 4 字符（即 true）。保存前后期望条数不变，说明它不清空其他条目。 */
  fullUpdate: "true",
} as const;

// ---------- 仅凭本地数据即可构造的请求体 ----------

export interface UserDescPayload {
  advantage: string;
  entrance: number;
  riskTipType: number;
  xGeekBizSource: string;
}

/** 个人优势：保存用 advantage，前置校验用 userDesc，两者同值。 */
export function buildUserDescPayload(advantage: string): UserDescPayload {
  return {
    advantage,
    entrance: STATIC_FIELDS.userDescEntrance,
    riskTipType: STATIC_FIELDS.riskTipType,
    xGeekBizSource: GEEK_BIZ_SOURCE,
  };
}

/** 经历类（工作 / 项目）的删除体：只认 id。 */
export function buildExperienceDeletePayload(id: string): { id: string; xGeekBizSource: string } {
  return { id, xGeekBizSource: GEEK_BIZ_SOURCE };
}

/**
 * 期望的删除体：`type` 是 positionType，语义是「删掉该类型的整组期望」。
 *
 * 调用方必须先确认这个类型下没有想保留的条目，否则会把它们一起删掉。
 */
export function buildExpectDeletePayload(positionType: number): { type: number; xGeekBizSource: string } {
  return { type: positionType, xGeekBizSource: GEEK_BIZ_SOURCE };
}

export function buildUserDescPrecheck(advantage: string): { userDesc: string } {
  return { userDesc: advantage };
}

export interface CertificationItemPayload {
  name: string;
  type: number;
}

/**
 * 证书：整模块覆盖，所以必须把「线上最终应该有的全部证书」一次性交齐。
 * 传空数组等于清空整个模块 —— 调用方要自己保证这是用户的意图。
 */
export function buildCertificationPayload(names: string[]): { certJson: CertificationItemPayload[] } {
  return { certJson: names.map((name) => name.trim()).filter(Boolean).map((name) => ({ name, type: 0 })) };
}

/**
 * 专业技能：手工编辑这条路径只需要一段文本，**没有** parserId。
 *
 * 两份录制对比（同一路径、两个入口）：
 * - 附件解析后点「应用」：`{ parserId(28), skill(375), source: 1 }` —— 消耗一次性解析凭证；
 * - 在线简历里直接编辑技能再保存：`{ skill(375) }` —— 无凭证、可重复调用（13:20 样本，返回 code 0，
 *   随后 preview 的 professionalSkill 变成提交的那 375 字）。
 *
 * 所以要常态化同步技能，走后者即可，不必依赖附件解析记录。
 */
export interface SkillPayload {
  /** 整段技能文本，行之间用 \n 分隔（本地每行一条技能）。 */
  skill: string;
}

export function buildSkillPayload(skill: string): SkillPayload {
  return { skill };
}

export interface BaseInfoPayload {
  name: string;
  gender: number;
  /** YYYY-MM，样本里是 7 位（1995-08）。 */
  birthday: string;
  /** YYYY-MM，参加工作时间。 */
  startWorkDate: string;
  applyStatus: number;
  freshGraduate: number;
  nameShowType: number;
  xGeekBizSource: string;
}

/**
 * 基本资料。
 *
 * applyStatus 与 freshGraduate 在界面上是开关（默认保留线上值），
 * 所以这两个由调用方从线上原值带入，不在这里给默认值。
 */
export function buildBaseInfoPayload(input: Omit<BaseInfoPayload, "nameShowType" | "xGeekBizSource"> & { nameShowType?: number }): BaseInfoPayload {
  return {
    ...input,
    nameShowType: input.nameShowType ?? 0,
    xGeekBizSource: GEEK_BIZ_SOURCE,
  };
}
