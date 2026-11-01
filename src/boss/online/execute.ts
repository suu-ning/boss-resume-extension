import type { BossEducation, BossProject, BossResumeDocument, BossWorkExperience, OnlineSyncOptions } from "../../domain/types";
import { parseSalary } from "../uploadPlan";
import {
  GEEK_BIZ_SOURCE,
  GEEK_ENDPOINTS,
  STATIC_FIELDS,
  buildBaseInfoPayload,
  buildCertificationPayload,
  buildExperienceDeletePayload,
  buildSkillPayload,
  buildUserDescPayload,
  buildUserDescPrecheck,
} from "./contract";
import { findDictEntry, type OnlineDicts } from "./dict";
import { monthOf, multiline, plain, unique, yearOf } from "./normalize";
import { roleText, roleWritable } from "./plan";
import { resolveOnlineSyncOptions, type OnlineModuleId, type OnlineOperation, type OnlineSyncPlan } from "./types";

/**
 * 同步计划 → 一串可执行的写操作（纯函数，不发请求）。
 *
 * 这里承担三件事，也是整个写入唯一需要人工判断的地方：
 *
 * 1. **能改的字段改成什么**：本地真正拥有的字段（公司、职位文字、起止月份、正文、证书名…）用本地值；
 *    本地没有可信来源的字段（行业编码、职位编码、学校 id、学历编码、entry 埋点字段…）从线上原条目透传。
 * 2. **写不了的显式列出来**：专业技能需要附件解析的 parserId、教育经历没有删除接口、期望只能整组删，
 *    这些都不会硬写，而是进 `skipped` 让用户知道「这一条得手动处理」。
 * 3. **新建需要编码时去查字典**：职位 / 行业 / 城市都有 BOSS 自己的字典接口，查不到就不建、报原因，
 *    绝不拿 0 顶上写出一条分类错误的经历。
 */

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const num = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
};

const rawList = (value: unknown): Raw[] => (Array.isArray(value) ? value.filter(isRecord) : []);

export interface OnlineWriteInput {
  resume: BossResumeDocument;
  /** `preview/data.json` 的原始 zpData：透传线上编码字段全靠它。 */
  remoteRaw: Record<string, unknown>;
  plan: OnlineSyncPlan;
  options: OnlineSyncOptions;
  dicts: OnlineDicts;
}

export interface OnlineWritePlan {
  operations: OnlineOperation[];
  /** 想同步、但这次写不了的条目与原因。 */
  skipped: string[];
  /** 转换时的取舍，写入前后都展示给用户。 */
  warnings: string[];
}

// ---------- 各模块的请求体 ----------

interface BuildContext {
  dicts: OnlineDicts;
  /** 同一类提示只提示一次，避免 10 条经历刷 10 行相同的话。 */
  warned: Set<string>;
  warnings: string[];
}

const warnOnce = (context: BuildContext, message: string): void => {
  if (context.warned.has(message)) return;
  context.warned.add(message);
  context.warnings.push(message);
};

function workPayload(local: BossWorkExperience, remote: Raw | undefined, context: BuildContext): Raw {
  const id = str(remote?.id);
  const industry = isRecord(remote?.industry) ? remote.industry : undefined;
  const positionHit = findDictEntry(context.dicts.positions, local.positionName);
  if (!positionHit) warnOnce(context, "工作经历的职位在 BOSS 职位字典里没有匹配到：保留线上原编码，职位文字写进「自定义职位」");
  // 行业以线上为准；新建时线上没有，就按本地文字查行业字典。
  const industryName = str(industry?.name) || plain(local.industry);
  const industryCode = num(industry?.code) ?? findDictEntry(context.dicts.industries, industryName)?.code ?? 0;
  if (industryName && !industryCode) {
    warnOnce(context, "工作经历的所属行业在 BOSS 行业字典里没有匹配到编码：这条的行业会留空，需要你到 BOSS 上选一次");
  }
  const payload: Raw = {
    companyName: plain(local.companyName),
    position: positionHit?.code ?? num(remote?.position) ?? 0,
    customPositionName: positionHit ? "" : plain(local.positionName),
    department: plain(local.department),
    // 线上 skill 标签在保存接口里是一个字符串，按逗号分隔。
    emphasis: unique(local.skills ?? []).join(","),
    startDate: monthOf(local.startDate),
    endDate: local.isCurrent ? "" : monthOf(local.endDate),
    workContent: multiline(local.responsibilities),
    workPerformance: multiline(local.achievements),
    industryCode,
    industryName,
    // 线上原值：本地从来没有这个字段。新建时按录制值 -1。
    industrySource: num(remote?.industrySource) ?? -1,
    isPublic: num(remote?.isPublic) ?? 0,
    workType: num(remote?.workType) ?? 0,
    entrance: num(remote?.entrance) ?? 0,
    riskTipType: STATIC_FIELDS.riskTipType,
    xGeekBizSource: GEEK_BIZ_SOURCE,
  };
  if (id) payload.id = id;
  return payload;
}

function projectPayload(local: BossProject, remote: Raw | undefined, context: BuildContext): Raw {
  const id = str(remote?.id);
  const role = roleText(local.role);
  const remoteRole = roleText(remote?.roleName);
  // 角色是自由文本（网页端就是 2-12 字输入框），直接提交文字。
  // 本地空 / 超长时不写，退回线上原值，避免把已有角色清掉或让整轮同步被校验拒掉。
  const roleName = role && roleWritable(role) ? role : remoteRole;
  if (role && !roleWritable(role)) {
    warnOnce(
      context,
      `项目经历「${plain(local.projectName) || "未命名项目"}」的担任角色是 ${[...role].length} 个字，BOSS 只收 2-12 个字：这次保留线上角色`,
    );
  }
  const payload: Raw = {
    name: plain(local.projectName),
    roleName,
    description: multiline(local.description),
    performance: multiline(local.achievements),
    url: plain(local.link),
    startDate: monthOf(local.startDate),
    endDate: local.isCurrent ? "" : monthOf(local.endDate),
    entrance: num(remote?.entrance) ?? 0,
    riskTipType: STATIC_FIELDS.riskTipType,
    xGeekBizSource: GEEK_BIZ_SOURCE,
  };
  if (id) payload.id = id;
  return payload;
}

function educationPayload(local: BossEducation, remote: Raw | undefined, context: BuildContext): Raw {
  const id = str(remote?.id);
  const school = plain(local.schoolName);
  // 学校 id 是编码。名称没变就沿用；改了名字又转不了码时置 0，让 BOSS 当作自由填写。
  const sameSchool = school === str(remote?.school);
  if (!sameSchool) warnOnce(context, "教育经历的学校名改了，但学校编码无法解析：可能需要你到 BOSS 页面上重新选择学校");
  const payload: Raw = {
    school,
    schoolId: sameSchool ? (num(remote?.schoolId) ?? 0) : 0,
    major: plain(local.major),
    degree: num(remote?.degree) ?? 0,
    eduType: num(remote?.eduType) ?? 0,
    majorRanking: num(remote?.majorRanking) ?? 0,
    entrance: num(remote?.entrance) ?? 1,
    // 教育经历的起止日期在保存接口里只有年份（录制值 4 位）。
    startDate: yearOf(local.startDate),
    endDate: local.isCurrent ? "" : yearOf(local.endDate),
    eduDescription: multiline(local.campusExperience),
    thesisTitle: plain(local.thesis),
    thesisDesc: "",
    course: "",
    riskTipType: STATIC_FIELDS.riskTipType,
    xGeekBizSource: GEEK_BIZ_SOURCE,
  };
  if (id) payload.id = id;
  return payload;
}

function expectPayload(
  target: { city: string; position: string },
  salary: [number, number] | undefined,
  industries: string[],
  remote: Raw | undefined,
  context: BuildContext,
): Raw | undefined {
  const cityHit = findDictEntry(context.dicts.cities, target.city);
  const positionHit = findDictEntry(context.dicts.positions, target.position);
  // 新建期望必须有城市与职位的编码，查不到就不写：写进去的会是一条分类错误的期望。
  if (!remote && (!cityHit || !positionHit)) return undefined;
  if (remote && target.city && !cityHit) warnOnce(context, "期望城市在 BOSS 城市字典里没有匹配到：这条保留了线上原城市");
  if (remote && target.position && !positionHit) warnOnce(context, "期望职位在 BOSS 职位字典里没有匹配到：这条保留了线上原职位");

  // 期望行业只有在开关打开时才写；线上这个字段是编码串（录制值为空串），按逗号拼。
  const industryCodes = industries
    .map((name) => findDictEntry(context.dicts.industries, name))
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .map((entry) => entry.code)
    .join(",");
  if (industries.length && !industryCodes) warnOnce(context, "期望行业在 BOSS 行业字典里没有匹配到编码：这次保留了线上原行业");

  const positionCode = positionHit?.code ?? num(remote?.position) ?? 0;
  const carried = Array.isArray(remote?.multiExpectInfos) ? remote.multiExpectInfos : undefined;
  const payload: Raw = {
    location: cityHit?.code ?? num(remote?.location) ?? 0,
    locationName: target.city || str(remote?.locationName),
    position: positionCode,
    positionType: num(remote?.positionType) ?? 0,
    subLocation: num(remote?.subLocation) ?? 0,
    otherLocationCodeStr: "",
    // 开关关着时传空串，等于「不改行业」；打开且转码成功才写。
    industryCodes,
    freshGraduate: num(remote?.freshGraduate) ?? 0,
    lowSalary: salary?.[0] ?? 0,
    highSalary: salary?.[1] ?? 0,
    // 多职位期望：录制里是 [{ position }]。能转码就用新编码，否则保留线上结构。
    multiExpectInfos: positionHit ? [{ position: positionCode }] : carried ?? [{ position: positionCode }],
    // 录制值：true。保存前后期望条数不变，说明它不清空其他条目。
    fullUpdate: "true",
    xGeekBizSource: GEEK_BIZ_SOURCE,
  };
  const id = str(remote?.id);
  if (id) payload.id = id;
  return payload;
}

// ---------- 主流程 ----------

const LABEL_DELETE_HINT: Partial<Record<OnlineModuleId, string>> = {
  education: "教育经历没有录制到删除接口，线上的多余条目不会自动删除，需要你手动删",
  expect: "期望的删除接口是按「类型」整组删除，无法只删多出来的某一条，所以不会自动删，需要你手动处理",
};

export function buildOnlineWritePlan(input: OnlineWriteInput): OnlineWritePlan {
  const operations: OnlineOperation[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  const context: BuildContext = { dicts: input.dicts, warned: new Set(), warnings };

  const resolved = resolveOnlineSyncOptions(input.options);
  const picked = new Set(resolved.modules);
  const moduleOf = (id: OnlineModuleId) => input.plan.modules.find((module) => module.id === id);
  const wanted = (id: OnlineModuleId): boolean => {
    const module = moduleOf(id);
    return Boolean(module && module.selected && picked.has(id) && module.kind !== "unchanged");
  };

  const remoteBase = isRecord(input.remoteRaw.baseInfo) ? input.remoteRaw.baseInfo : {};
  const salary = parseSalary(input.resume.jobIntent.salary);
  const industries = resolved.syncIndustries ? unique(input.resume.jobIntent.industries) : [];

  // ---------- 基本资料 ----------
  if (wanted("baseInfo")) {
    const genderCode =
      input.resume.profile.gender === "male" ? 1 : input.resume.profile.gender === "female" ? 0 : (num(remoteBase.gender) ?? 0);
    operations.push({
      key: "baseInfo",
      module: "baseInfo",
      label: "更新基本资料",
      action: "save",
      path: GEEK_ENDPOINTS.baseInfoSave.path,
      // 前置校验是 GET，无请求体；返回 dialog 非空时说明需要用户确认。
      precheck: { method: "GET", path: GEEK_ENDPOINTS.baseInfoPrecheck.path, payload: {} },
      payload: {
        ...buildBaseInfoPayload({
          name: plain(input.resume.profile.name),
          gender: genderCode,
          // 本地没填就保留线上，绝不写空：出生年月在 BOSS 上不允许为空。
          birthday: monthOf(input.resume.profile.birthDate) || monthOf(remoteBase.birthdayDesc) || monthOf(remoteBase.birthday),
          startWorkDate: monthOf(input.resume.profile.workStartDate) || monthOf(remoteBase.startWorkDateDesc) || monthOf(remoteBase.startWorkDate),
          applyStatus: num(remoteBase.applyStatus) ?? 0,
          freshGraduate: num(remoteBase.freshGraduate) ?? 0,
          nameShowType: num(remoteBase.nameShowType) ?? 0,
        }),
      },
      note: "手机号、邮箱、头像、求职状态不在本地档案里，回传线上原值",
    });
  }

  // ---------- 个人优势 ----------
  if (wanted("advantage")) {
    const advantage = multiline(input.resume.advantage);
    operations.push({
      key: "advantage",
      module: "advantage",
      label: "更新个人优势",
      action: "save",
      path: GEEK_ENDPOINTS.userDescSave.path,
      precheck: { method: "POST", path: GEEK_ENDPOINTS.userDescPrecheck.path, payload: buildUserDescPrecheck(advantage) },
      payload: { ...buildUserDescPayload(advantage) },
    });
  }

  // ---------- 专业技能 ----------
  if (wanted("professionalSkill")) {
    const skill = multiline((input.resume.professionalSkills ?? []).join("\n"));
    // 走「直接编辑技能」这条契约（只提交 skill 文本，不要 parserId），可重复调用，不消耗解析凭证。
    if (!skill) {
      skipped.push("专业技能：本地没有内容，这次不写");
    } else {
      operations.push({
        key: "professionalSkill",
        module: "professionalSkill",
        label: "更新专业技能",
        action: "save",
        path: GEEK_ENDPOINTS.skillSave.path,
        payload: { ...buildSkillPayload(skill) },
      });
    }
  }

  // ---------- 求职期望 ----------
  if (wanted("expect")) {
    const targets = expectTargetsOf(input.resume);
    const remoteExpects = rawList(input.remoteRaw.expectList);
    const module = moduleOf("expect");
    const items = module?.items ?? [];
    let extra = 0;
    for (const item of items) {
      if (item.kind === "unchanged") continue;
      const target = item.localIndex === undefined ? undefined : targets[item.localIndex];
      if (item.kind === "delete") {
        extra += 1;
        continue;
      }
      if (!target) continue;
      const remote = item.remoteIndex === undefined ? undefined : remoteExpects[item.remoteIndex];
      const payload = expectPayload(target, salary, industries, remote, context);
      if (!payload) {
        skipped.push(`求职期望「${item.title}」：城市或职位在 BOSS 字典里没有匹配到编码，没有写入`);
        continue;
      }
      operations.push({
        key: `expect-${item.index}`,
        module: "expect",
        label: `${item.kind === "create" ? "新增" : "更新"}求职期望 · ${item.title}`,
        action: "save",
        path: GEEK_ENDPOINTS.expectSave.path,
        payload,
      });
    }
    if (extra) skipped.push(`求职期望：线上多出 ${extra} 条，${LABEL_DELETE_HINT.expect}`);
  }

  // ---------- 工作经历 ----------
  if (wanted("work")) {
    const locals = input.resume.workExperiences;
    const remotes = rawList(input.remoteRaw.workExpList);
    for (const item of moduleOf("work")?.items ?? []) {
      if (item.kind === "unchanged") continue;
      const remote = item.remoteIndex === undefined ? undefined : remotes[item.remoteIndex];
      const local = item.localIndex === undefined ? undefined : locals[item.localIndex];
      if (item.kind === "delete") {
        const id = str(remote?.id);
        if (!id) {
          skipped.push(`工作经历「${item.title}」：线上条目缺少 id，没有删除`);
          continue;
        }
        operations.push({
          key: `work-${item.index}`,
          module: "work",
          label: `删除工作经历 · ${item.title}`,
          action: "delete",
          path: GEEK_ENDPOINTS.workDelete.path,
          payload: buildExperienceDeletePayload(id),
        });
        continue;
      }
      if (!local) continue;
      operations.push({
        key: `work-${item.index}`,
        module: "work",
        label: `${item.kind === "create" ? "新增" : "更新"}工作经历 · ${item.title}`,
        action: "save",
        path: GEEK_ENDPOINTS.workSave.path,
        payload: workPayload(local, remote, context),
        precheck: {
          method: "POST",
          path: GEEK_ENDPOINTS.workPrecheck.path,
          // 前置校验的字段名与保存不同：responsibility / workId，不要混用。
          payload: {
            responsibility: multiline(local.responsibilities),
            workPerformance: multiline(local.achievements),
            workId: str(remote?.id),
          },
        },
      });
    }
  }

  // ---------- 项目经历 ----------
  if (wanted("project")) {
    const locals = input.resume.projects;
    const remotes = rawList(input.remoteRaw.projectExpList);
    for (const item of moduleOf("project")?.items ?? []) {
      if (item.kind === "unchanged") continue;
      const remote = item.remoteIndex === undefined ? undefined : remotes[item.remoteIndex];
      const local = item.localIndex === undefined ? undefined : locals[item.localIndex];
      if (item.kind === "delete") {
        const id = str(remote?.id);
        if (!id) {
          skipped.push(`项目经历「${item.title}」：线上条目缺少 id，没有删除`);
          continue;
        }
        operations.push({
          key: `project-${item.index}`,
          module: "project",
          label: `删除项目经历 · ${item.title}`,
          action: "delete",
          path: GEEK_ENDPOINTS.projectDelete.path,
          payload: buildExperienceDeletePayload(id),
        });
        continue;
      }
      if (!local) continue;
      operations.push({
        key: `project-${item.index}`,
        module: "project",
        label: `${item.kind === "create" ? "新增" : "更新"}项目经历 · ${item.title}`,
        action: "save",
        path: GEEK_ENDPOINTS.projectSave.path,
        payload: projectPayload(local, remote, context),
        precheck: {
          method: "POST",
          path: GEEK_ENDPOINTS.projectPrecheck.path,
          // 前置校验用 description / performance / projectId（录制值）。
          payload: {
            description: multiline(local.description),
            performance: multiline(local.achievements),
            projectId: str(remote?.id),
          },
        },
      });
    }
  }

  // ---------- 教育经历 ----------
  if (wanted("education")) {
    const locals = input.resume.educations;
    const remotes = rawList(input.remoteRaw.educationExpList);
    for (const item of moduleOf("education")?.items ?? []) {
      if (item.kind === "unchanged") continue;
      if (item.kind === "delete") {
        skipped.push(`教育经历「${item.title}」：${LABEL_DELETE_HINT.education}`);
        continue;
      }
      const local = item.localIndex === undefined ? undefined : locals[item.localIndex];
      if (!local) continue;
      if (item.kind === "create") {
        skipped.push(`教育经历「${item.title}」：新增需要学校编码与学历编码，本地只有文字，这次不自动新增`);
        continue;
      }
      operations.push({
        key: `education-${item.index}`,
        module: "education",
        label: `更新教育经历 · ${item.title}`,
        action: "save",
        path: GEEK_ENDPOINTS.educationSave.path,
        payload: educationPayload(local, item.remoteIndex === undefined ? undefined : remotes[item.remoteIndex], context),
        precheck: {
          method: "POST",
          path: GEEK_ENDPOINTS.educationPrecheck.path,
          // 教育经历的前置校验体 = 保存体去掉 xGeekBizSource（录制对比得出）。
          payload: stripSource(educationPayload(local, item.remoteIndex === undefined ? undefined : remotes[item.remoteIndex], context)),
        },
      });
    }
  }

  // ---------- 资格证书：整模块覆盖 ----------
  if (wanted("certificate")) {
    const names = input.resume.certificates.map((certificate) => plain(certificate.name)).filter(Boolean);
    operations.push({
      key: "certificate",
      module: "certificate",
      label: names.length ? `覆盖资格证书（${names.length} 本）` : "清空资格证书",
      action: "save",
      path: GEEK_ENDPOINTS.certificationSave.path,
      payload: buildCertificationPayload(names),
      note: "证书是整模块覆盖：线上原有的会被这份清单整体替换",
    });
  }

  return { operations, skipped, warnings };
}

/** 教育经历前置校验体：保存体去掉来源标记。 */
function stripSource(payload: Raw): Raw {
  const { xGeekBizSource: _ignored, ...rest } = payload;
  return rest;
}

/** 与 plan.ts 的期望展开保持一致：城市 × 职位，超出上限的截断。 */
function expectTargetsOf(resume: BossResumeDocument): Array<{ city: string; position: string }> {
  const cities = unique(resume.jobIntent.cities);
  const positions = unique(resume.jobIntent.positions);
  const targets: Array<{ city: string; position: string }> = [];
  for (const city of cities.length ? cities : [""]) {
    for (const position of positions.length ? positions : [""]) targets.push({ city, position });
  }
  return targets;
}
