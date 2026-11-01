import type { BossCertificate, BossEducation, BossProject, BossResumeDocument, BossWorkExperience, OnlineSyncOptions } from "../../domain/types";
import { parseSalary } from "../uploadPlan";
import { monthOf, plain, sameMonth, sameText, show, showMonth, showYear, unique, yearOf } from "./normalize";
import {
  MAX_ONLINE_EXPECTS,
  resolveOnlineSyncOptions,
  type ChangeKind,
  type FieldChange,
  type ItemChange,
  type OnlineEducation,
  type OnlineExpect,
  type OnlineModulePlan,
  type OnlineProject,
  type OnlineResume,
  type OnlineSyncPlan,
  type OnlineWork,
} from "./types";

/**
 * 本地档案 → 在线简历同步计划（纯函数，不发请求）。
 *
 * 目标是「写完之后，在线简历的业务内容与这份档案一致」，所以计划里既有要写的值，也有要删的条目：
 * - 线上多出来的条目 → delete；
 * - 线上有值、本地为空 → 写空（这是旧内容残留的根因，不能跳过）；
 * - 本地没有可信来源的字段（手机号、邮箱、头像、求职状态等）→ preserved，明确保留线上原值。
 *
 * 列表按**内容**配对，不按位置：BOSS 的在线简历顺序由服务端排（项目经历按开始时间倒序，实测与档案顺序不同），
 * 按下标对齐会把两条不相干的经历配成一条，界面上显示成整段重写、写入时还会改错那一行。
 * 配对规则见 align()：先「名称 + 开始时间」，再只按名称，剩余的才按顺序补。
 */

interface ExpectTarget {
  city: string;
  position: string;
}

function textField(label: string, before: string | undefined, after: string | undefined): FieldChange {
  return { label, before: show(before), after: show(after), changed: !sameText(before, after) };
}

function monthField(label: string, before: string | undefined, after: string | undefined): FieldChange {
  return { label, before: showMonth(before), after: showMonth(after), changed: !sameMonth(before, after) };
}

/** 结束时间：空值在两边都表示「至今」。 */
function endField(label: string, before: string | undefined, after: string | undefined): FieldChange {
  return {
    label,
    before: before ? showMonth(before) : "至今",
    after: after ? showMonth(after) : "至今",
    changed: !sameMonth(before, after),
  };
}

function yearField(label: string, before: string | undefined, after: string | undefined): FieldChange {
  const left = yearOf(before);
  const right = yearOf(after);
  return { label, before: showYear(before), after: showYear(after), changed: left !== right };
}

/** 结束年份：空值在两边都表示「至今」。 */
function endYearField(label: string, before: string | undefined, after: string | undefined): FieldChange {
  const left = yearOf(before);
  const right = yearOf(after);
  return { label, before: left ? showYear(before) : "至今", after: right ? showYear(after) : "至今", changed: left !== right };
}

const salaryText = (low: number | undefined, high: number | undefined): string =>
  low && high && low > 0 && high >= low ? `${low}-${high}K` : "";

/** 本地期望展开成「城市 × 职位」的条目：在线简历每条期望只能有一个城市 + 一个职位。 */
function expectTargets(resume: BossResumeDocument): { targets: ExpectTarget[]; dropped: number } {
  const cities = unique(resume.jobIntent.cities);
  const positions = unique(resume.jobIntent.positions);
  const targets: ExpectTarget[] = [];
  for (const city of cities.length ? cities : [""]) {
    for (const position of positions.length ? positions : [""]) {
      targets.push({ city, position });
    }
  }
  return { targets: targets.slice(0, MAX_ONLINE_EXPECTS), dropped: Math.max(0, targets.length - MAX_ONLINE_EXPECTS) };
}

/** 条目配对用的键：strong 是「名称 + 时间」，weak 只按名称。 */
interface MatchKeys {
  strong: string;
  weak: string;
}

/**
 * 把本地条目与线上条目配对。
 *
 * **不能按下标硬对**：BOSS 的列表顺序由服务端决定（项目经历按开始时间倒序，实测线上顺序与档案顺序不同），
 * 而下标对齐会把两条完全不相干的项目配成「同一条」，界面上显示成整段重写，写入时还会去改错那一行。
 *
 * 所以先按业务键配对：先「名称 + 开始时间」，再只按「名称」，两条都只在**未配对的两侧都唯一命中**时才配；
 * 剩下的才按顺序补（本地多出的算新增，线上多出的算删除）。
 */
function align<TLocal, TRemote>(
  locals: TLocal[],
  remotes: TRemote[],
  compare: (local: TLocal | undefined, remote: TRemote | undefined) => { title: string; fields: FieldChange[] },
  localKey: (item: TLocal) => MatchKeys,
  remoteKey: (item: TRemote) => MatchKeys,
): ItemChange[] {
  const localUsed = locals.map(() => false);
  const remoteUsed = remotes.map(() => false);
  const pairs: { local?: number; remote?: number }[] = [];

  const join = (localIndex: number, remoteIndex: number): void => {
    localUsed[localIndex] = true;
    remoteUsed[remoteIndex] = true;
    pairs.push({ local: localIndex, remote: remoteIndex });
  };

  const matchRound = (pick: (keys: MatchKeys) => string): void => {
    for (let localIndex = 0; localIndex < locals.length; localIndex += 1) {
      if (localUsed[localIndex]) continue;
      const key = pick(localKey(locals[localIndex]));
      if (!key) continue;
      const hits: number[] = [];
      for (let remoteIndex = 0; remoteIndex < remotes.length; remoteIndex += 1) {
        if (remoteUsed[remoteIndex]) continue;
        if (pick(remoteKey(remotes[remoteIndex])) === key) hits.push(remoteIndex);
      }
      // 命中多条时宁可不配：交给顺序兜底，也好过把两条同名条目张冠李戴。
      if (hits.length === 1) join(localIndex, hits[0]);
    }
  };

  matchRound((keys) => keys.strong);
  matchRound((keys) => keys.weak);

  const restLocal = locals.map((_, index) => index).filter((index) => !localUsed[index]);
  const restRemote = remotes.map((_, index) => index).filter((index) => !remoteUsed[index]);
  for (let index = 0; index < Math.max(restLocal.length, restRemote.length); index += 1) {
    pairs.push({ local: restLocal[index], remote: restRemote[index] });
  }

  // 展示顺序跟本地档案走；只在线上存在的条目（要删的）排在后面。
  const ordered = [
    ...pairs.filter((pair) => pair.local !== undefined).sort((left, right) => (left.local ?? 0) - (right.local ?? 0)),
    ...pairs.filter((pair) => pair.local === undefined),
  ];

  return ordered.map((pair, position) => {
    const local = pair.local === undefined ? undefined : locals[pair.local];
    const remote = pair.remote === undefined ? undefined : remotes[pair.remote];
    const { title, fields } = compare(local, remote);
    const kind: ChangeKind =
      local === undefined ? "delete" : remote === undefined ? "create" : fields.some((field) => field.changed) ? "update" : "unchanged";
    // index 是展示序号；真正取数据用 localIndex / remoteIndex（0 基），写入时才不会改错行。
    return { index: position + 1, localIndex: pair.local, remoteIndex: pair.remote, title, kind, fields };
  });
}

function countOf(items: ItemChange[]): OnlineModulePlan["counts"] {
  const counts = { create: 0, update: 0, delete: 0, unchanged: 0 };
  for (const item of items) counts[item.kind] += 1;
  return counts;
}

function listModule(
  id: OnlineModulePlan["id"],
  label: string,
  items: ItemChange[],
  selected: boolean,
  note?: string,
): OnlineModulePlan {
  const counts = countOf(items);
  const changed = counts.create + counts.update + counts.delete > 0;
  return { id, label, kind: changed ? "update" : "unchanged", selected, fields: [], items, counts, note };
}

function valueModule(
  id: OnlineModulePlan["id"],
  label: string,
  fields: FieldChange[],
  selected: boolean,
  note?: string,
): OnlineModulePlan {
  const changed = fields.some((field) => field.changed);
  return {
    id,
    label,
    kind: changed ? "update" : "unchanged",
    selected,
    fields,
    items: [],
    counts: { create: 0, update: changed ? 1 : 0, delete: 0, unchanged: changed ? 0 : 1 },
    note,
  };
}

const GENDER_LABEL: Record<string, string> = { male: "男", female: "女", unknown: "不便透露" };

/** 配对用的业务键：先「名称 + 开始时间」，再退到只按名称。 */
const keysOf = (name: string | undefined, start: string | undefined): MatchKeys => {
  const title = plain(name);
  const month = monthOf(start);
  return { strong: title && month ? `${title}|${month}` : "", weak: title };
};

const expectKeys = (item: { city?: string; locationName?: string; position?: string; positionName?: string }): MatchKeys => {
  const city = plain(item.city ?? item.locationName);
  const position = plain(item.position ?? item.positionName);
  return { strong: city && position ? `${city}|${position}` : "", weak: `${city}|${position}` };
};

const workKeys = (item: { companyName?: string; startDate?: string }): MatchKeys => keysOf(item.companyName, item.startDate);
const projectKeys = (item: { projectName?: string; name?: string; startDate?: string }): MatchKeys =>
  keysOf(item.projectName ?? item.name, item.startDate);
const educationKeys = (item: { schoolName?: string; school?: string; startDate?: string; startYear?: string }): MatchKeys =>
  keysOf(item.schoolName ?? item.school, yearOf(item.startDate ?? item.startYear));
const certificateKeys = (item: { name?: string }): MatchKeys => keysOf(item.name, undefined);

/** 技能标签：线上可能返回数组，也可能被存成一个逗号串，两种都按标签集合比较。 */
const splitTags = (values: string[] | undefined): string[] =>
  unique(
    (values ?? [])
      .flatMap((value) => plain(value).split(/[,，、;；/|]+/))
      .map((value) => value.trim())
      .filter(Boolean),
  ).sort();

function tagsField(before: string[] | undefined, after: string[] | undefined): FieldChange {
  const left = splitTags(before);
  const right = splitTags(after);
  return {
    label: "技能标签",
    before: show(left.join("、")),
    after: show(right.join("、")),
    changed: left.join("|") !== right.join("|"),
  };
}

const compareWork = (local: BossWorkExperience | undefined, remote: OnlineWork | undefined) => ({
  title: local?.companyName || remote?.companyName || "未命名公司",
  fields: [
    textField("公司", remote?.companyName, local?.companyName),
    textField("职位", remote?.positionName, local?.positionName),
    textField("所属部门", remote?.department, local?.department),
    monthField("开始时间", remote?.startDate, local?.startDate),
    endField("结束时间", remote?.endDate, local?.isCurrent ? undefined : local?.endDate),
    textField("工作内容", remote?.workContent, local?.responsibilities),
    textField("工作成果", remote?.workPerformance, local?.achievements),
    tagsField(remote?.emphasis, local?.skills),
  ],
});

/**
 * 项目「担任角色」是**自由文本**，不是字典下拉。
 *
 * 网页端（www.zhipin.com 项目经历编辑页）该字段就是一个输入框，校验只有「2-12 个字」；
 * 读接口 preview/data 回的也是同一段文字（老条目里能看到 12 字的中文角色）。
 * 之前把它当成字典编码，是因为脱敏样本把 1-3 位纯数字原样保留（`<digits:343>`），
 * 那条其实是录制时随手敲的测试值 —— 编码对照表这条路根本不存在，也不需要。
 *
 * 所以两边直接按文字比、按文字写。唯一要守的是页面的长度校验：
 * 超出 2-12 字提交会被服务端拒掉并中断整轮同步，这种角色就不写、保留线上值，并在说明里点出来。
 */
export const ROLE_MIN_CHARS = 2;
export const ROLE_MAX_CHARS = 12;

/** 角色字段归一：数字（老数据里出现过 `343`）也当文字处理。 */
export function roleText(value: unknown): string {
  if (typeof value === "number") return String(value);
  return plain(typeof value === "string" ? value : "");
}

/** 页面只收 2-12 个字，写之前先按同一口径卡一遍，别把整轮同步拖挂。 */
export function roleWritable(text: string): boolean {
  const length = [...text].length;
  return length >= ROLE_MIN_CHARS && length <= ROLE_MAX_CHARS;
}

const compareProject = (local: BossProject | undefined, remote: OnlineProject | undefined) => {
  const localRole = roleText(local?.role);
  const remoteRole = roleText(remote?.roleName);
  // 本地没填 → 不动线上；超出 2-12 字 → 不写（提交必被拒）。其余按文字严格比。
  const roleChanged = Boolean(localRole) && roleWritable(localRole) && localRole !== remoteRole;
  return {
    title: local?.projectName || remote?.name || "未命名项目",
    fields: [
      textField("项目名称", remote?.name, local?.projectName),
      {
        label: "担任角色",
        before: show(remoteRole),
        after: show(localRole),
        changed: roleChanged,
      },
      monthField("开始时间", remote?.startDate, local?.startDate),
      endField("结束时间", remote?.endDate, local?.isCurrent ? undefined : local?.endDate),
      textField("项目描述", remote?.description, local?.description),
      textField("项目成果", remote?.performance, local?.achievements),
      textField("项目链接", remote?.url, local?.link),
    ],
  };
};

/**
 * 项目经历的取舍说明：把「哪条角色这次写不进去」说在明面上。
 *
 * 角色本身是自由文本、能直接写；写不进去只有一种情况 —— 字数不在页面允许的 2-12 之间。
 * 这种条目仍然会同步其它字段，只是角色保留线上值，别让人以为漏了。
 */
function projectNote(resume: BossResumeDocument): string | undefined {
  const roles = unique(resume.projects.map((project) => roleText(project.role)).filter(Boolean));
  if (!roles.length) return undefined;
  const tooLong = roles.filter((role) => !roleWritable(role));
  if (!tooLong.length) return undefined;
  return `担任角色是 2-12 字的自由文本：${tooLong
    .slice(0, 3)
    .map((role) => `「${role}」（${[...role].length} 字）`)
    .join("、")} 超出长度，这次保留线上原值，其余项目照常写入`;
}

const compareEducation = (local: BossEducation | undefined, remote: OnlineEducation | undefined) => ({  title: local?.schoolName || remote?.school || "未命名学校",
  fields: [
    textField("学校", remote?.school, local?.schoolName),
    textField("专业", remote?.major, local?.major),
    textField("学历", remote?.degreeName, local?.degree),
    yearField("开始年份", remote?.startYear, local?.startDate),
    endYearField("结束年份", remote?.endYear, local?.isCurrent ? undefined : local?.endDate),
    textField("在校经历", remote?.description, local?.campusExperience),
    textField("论文 / 研究课题", remote?.thesis, local?.thesis),
  ],
});

const compareCertificate = (local: BossCertificate | undefined, remote: { name: string } | undefined) => ({
  title: local?.name || remote?.name || "未命名证书",
  fields: [textField("证书名称", remote?.name, local?.name)],
});

export function buildOnlineSyncPlan(
  resume: BossResumeDocument,
  remote: OnlineResume,
  options: OnlineSyncOptions,
): OnlineSyncPlan {
  const warnings: string[] = [];
  const preserved: string[] = [];
  const notCompared: string[] = [];
  const blockers: string[] = [];
  const skipped: string[] = [];

  // 未勾选的模块仍然算差异（界面上要看得到「不勾会留下什么」），但不写入、不计数、不阻断。
  const resolved = resolveOnlineSyncOptions(options);
  const picked = new Set(resolved.modules);
  const isPicked = (id: OnlineModulePlan["id"]): boolean => picked.has(id);

  if (isPicked("baseInfo") && !resume.profile.name.trim()) blockers.push("请先填写姓名：在线简历的姓名是必填项");

  const localGender = resume.profile.gender ? GENDER_LABEL[resume.profile.gender] : "";
  const remoteGender = remote.gender === "male" ? "男" : remote.gender === "female" ? "女" : "";
  const baseFields = [
    textField("姓名", remote.name, resume.profile.name),
    // 本地未填性别时不比对：线上不允许留空，硬写空值只会让接口报错。
    resume.profile.gender
      ? textField("性别", remoteGender, localGender)
      : { label: "性别", before: show(remoteGender), after: "（保留线上）", changed: false },
    monthField("出生年月", remote.birthday, resume.profile.birthDate),
    monthField("参加工作时间", remote.workStartDate, resume.profile.workStartDate),
  ];

  const { targets, dropped } = expectTargets(resume);
  if (dropped > 0) {
    warnings.push(
      `在线简历最多 ${MAX_ONLINE_EXPECTS} 条期望，本地的 ${unique(resume.jobIntent.cities).length} 个城市 × ${unique(resume.jobIntent.positions).length} 个职位要展开成 ${targets.length + dropped} 条，超出的 ${dropped} 条不会同步`,
    );
  }
  if (unique(resume.jobIntent.cities).length > 1 || unique(resume.jobIntent.positions).length > 1) {
    warnings.push(`期望按「城市 × 职位」逐条展开，线上会变成多条期望：${targets.map((target) => `${target.city || "不限"}·${target.position || "不限"}`).join("、")}`);
  }
  const salary = parseSalary(resume.jobIntent.salary);
  if (plain(resume.jobIntent.salary) && !salary) {
    warnings.push(`期望薪资“${resume.jobIntent.salary}”不是「15-20K」这样的区间，线上薪资会留空`);
  }

  const expectFields = (local: ExpectTarget | undefined, remoteExpect: OnlineExpect | undefined): FieldChange[] => {
    const fields = [
      textField("期望城市", remoteExpect?.locationName, local?.city),
      textField("期望职位", remoteExpect?.positionName, local?.position),
      textField("期望薪资", salaryText(remoteExpect?.lowSalary, remoteExpect?.highSalary), local ? salaryText(salary?.[0], salary?.[1]) : ""),
    ];
    if (resolved.syncIndustries) {
      fields.push(textField("期望行业", remoteExpect?.industryDesc, resume.jobIntent.industries.join("、")));
    }
    return fields;
  };

  const modules: OnlineModulePlan[] = [
    valueModule("baseInfo", "基本资料", baseFields, isPicked("baseInfo"), "手机号、邮箱、微信号、头像不在本地档案里，保留线上原值"),
    valueModule("advantage", "个人优势", [textField("个人优势", remote.advantage, resume.advantage)], isPicked("advantage")),
    valueModule(
      "professionalSkill",
      "专业技能",
      [textField("专业技能", remote.professionalSkill, resume.professionalSkills.join("\n"))],
      isPicked("professionalSkill"),
    ),
    listModule(
      "expect",
      "求职期望",
      align(
        targets,
        remote.expects,
        (local, remoteExpect) => ({
          title: `${local?.city || remoteExpect?.locationName || "不限"}·${local?.position || remoteExpect?.positionName || "不限"}`,
          fields: expectFields(local, remoteExpect),
        }),
        expectKeys,
        expectKeys,
      ),
      isPicked("expect"),
      resolved.syncIndustries ? "期望行业按本地覆盖（已打开开关）" : "期望行业保留线上原值（开关未打开）",
    ),
    listModule(
      "work",
      "工作经历",
      align(resume.workExperiences, remote.works, compareWork, workKeys, workKeys),
      isPicked("work"),
      "所属行业线上是字典编码，本地是自由文本，本次不转码、保留线上原值",
    ),
    listModule(
      "project",
      "项目经历",
      align(resume.projects, remote.projects, compareProject, projectKeys, projectKeys),
      isPicked("project"),
      projectNote(resume),
    ),
    listModule("education", "教育经历", align(resume.educations, remote.educations, compareEducation, educationKeys, educationKeys), isPicked("education")),
    listModule(
      "certificate",
      "资格证书",
      align(resume.certificates, remote.certificates, compareCertificate, certificateKeys, certificateKeys),
      isPicked("certificate"),
      "线上只有证书名称，发证机构与编号没有对应字段",
    ),
  ];

  // 角色超出 2-12 字时这条项目仍会同步其它字段，只是角色保留线上值。折叠着也要让人看见，
  // 所以在标题上挂一句 hint，而不是只藏在展开后的说明里。
  const overlongRoles = unique(resume.projects.map((project) => roleText(project.role)).filter((role) => role && !roleWritable(role)));
  const projectModule = modules.find((module) => module.id === "project");
  if (projectModule && overlongRoles.length) projectModule.hint = "角色超长未写";

  // ---------- 汇总 ----------
  const counts = { create: 0, update: 0, delete: 0, clear: 0 };
  for (const module of modules) {
    if (!module.selected) {
      skipped.push(module.label);
      continue;
    }
    counts.create += module.counts.create;
    counts.update += module.counts.update;
    counts.delete += module.counts.delete;
    // 只有「更新的条目/模块」里从有值变空才算清空；删除的条目已经算进 delete，不重复计。
    if (module.kind === "update") {
      for (const field of module.fields) if (field.changed && field.before !== "（空）" && field.after === "（空）") counts.clear += 1;
      for (const item of module.items) {
        if (item.kind !== "update") continue;
        for (const field of item.fields) if (field.changed && field.before !== "（空）" && field.after === "（空）") counts.clear += 1;
      }
    }
  }

  preserved.push("手机号、邮箱、微信号、头像：本地档案没有可信来源，保留线上原值");
  preserved.push("学历、工作年限：BOSS 按基本资料派生，不单独写入");
  // 求职状态在接口里是 applyStatus 数字编码，本地只有「离职-随时到岗」这类文字，转不了码，
  // 硬写一个猜出来的状态会直接影响推荐与投递，所以一律保留线上原值，不再提供开关。
  preserved.push("求职状态：本地档案没有 BOSS 的 applyStatus 编码，始终保留线上原值");
  if (!resolved.syncIndustries) preserved.push("期望行业：保留线上原值（开关未打开）");
  preserved.push("工作经历的所属行业：线上是字典编码，本地是自由文本，本次保留线上原值");

  if (remote.unknownModules.length) {
    notCompared.push(`线上已填但本地没有对应字段：${remote.unknownModules.join("、")}（接口结构未录制，本次不比对）`);
  }
  if (resume.socialProfiles.length) notCompared.push(`社交主页 ${resume.socialProfiles.length} 项：在线简历接口结构未录制`);
  if (resume.volunteerExperiences.length) notCompared.push(`志愿者服务 ${resume.volunteerExperiences.length} 项：在线简历接口结构未录制`);
  if (resume.customModules.length) notCompared.push(`自定义模块 ${resume.customModules.length} 项：来自直聘简历，在线简历没有对应字段`);
  if (plain(resume.profile.jobIdentity)) notCompared.push("求职身份：本地有值，线上该字段由 BOSS 判定，不写入");
  if (plain(resume.jobIntent.jobType) || plain(resume.jobIntent.jobPreference)) notCompared.push("工作类型与求职偏好：在线简历没有对应字段");
  for (const certificate of resume.certificates) {
    if (certificate.issuer || certificate.credentialId || certificate.issueDate) {
      notCompared.push("资格证书的发证机构、编号与日期：线上只保存名称");
      break;
    }
  }
  if (skipped.length) notCompared.push(`${skipped.join("、")}：本次没有勾选，线上原样保留、不写入`);

  return {
    modules,
    options: resolved,
    blockers,
    warnings,
    preserved,
    notCompared,
    skipped,
    counts,
    changedModules: modules.filter((module) => module.selected && module.kind !== "unchanged").length,
  };
}
