import { describe, expect, it } from "vitest";
import { createBlankResume, type BossResumeDocument } from "../../src/domain";
import { buildOnlineSyncPlan, roleText, roleWritable } from "../../src/boss/online/plan";
import { DEFAULT_ONLINE_SYNC_OPTIONS, resolveOnlineSyncOptions, type OnlineResume, type OnlineWork } from "../../src/boss/online/types";

/** 与本地档案第一条工作经历完全一致的那条。 */
const workA: OnlineWork = {
  id: "w1",
  companyName: "A 公司",
  positionName: "前端",
  department: "增长",
  startDate: "2020-03",
  endDate: "2022-05",
  workContent: "负责增长",
  workPerformance: "",
  emphasis: ["React"],
};

/** 线上多出来的一条（本地没有），同步时必须被删掉。 */
const workB: OnlineWork = {
  id: "w2",
  companyName: "B 公司",
  positionName: "后端",
  startDate: "2016-07",
  endDate: "2019-12",
  workContent: "维护老系统",
  workPerformance: "",
  emphasis: [],
};

function local(overrides: Partial<BossResumeDocument> = {}): BossResumeDocument {
  const doc = createBlankResume({ createId: () => "r1" });
  doc.profile = { name: "张三", gender: "male", birthDate: "1995-06", workStartDate: "2018-07" };
  doc.advantage = "";
  doc.professionalSkills = ["TypeScript", "React"];
  doc.jobIntent = { cities: ["上海"], positions: ["前端工程师"], industries: [], salary: "25-35K" };
  doc.workExperiences = [
    {
      localId: "w1",
      companyName: "A 公司",
      positionName: "前端",
      department: "增长",
      startDate: "2020-03",
      endDate: "2022-05",
      responsibilities: "负责增长",
      achievements: "",
      skills: ["React"],
    },
  ];
  return { ...doc, ...overrides };
}

function remote(overrides: Partial<OnlineResume> = {}): OnlineResume {
  return {
    fetchedAt: "2026-10-30T00:00:00.000Z",
    lastUpdateTime: "2026.10.12 10:00",
    name: "张三",
    gender: "male",
    birthday: "1995-06",
    workStartDate: "2018-07",
    advantage: "旧的优势描述",
    professionalSkill: "TypeScript React",
    expects: [{ locationName: "上海", positionName: "前端工程师", lowSalary: 25, highSalary: 35 }],
    works: [workA, workB],
    projects: [],
    educations: [],
    certificates: [],
    unknownModules: [],
    ...overrides,
  };
}

const moduleOf = (plan: ReturnType<typeof buildOnlineSyncPlan>, id: string) => plan.modules.find((module) => module.id === id)!;

describe("buildOnlineSyncPlan", () => {
  it("技能标签按集合比较：线上存成一个逗号串也算一致，别因此反复重写工作经历", () => {
    const doc = local();
    doc.workExperiences[0] = { ...doc.workExperiences[0], skills: ["React", "TypeScript"] };
    const online = remote({ works: [{ ...workA, emphasis: ["React, TypeScript"] }, workB] });
    const plan = buildOnlineSyncPlan(doc, online, DEFAULT_ONLINE_SYNC_OPTIONS);
    expect(moduleOf(plan, "work").items[0].kind).toBe("unchanged");
  });

  it("线上顺序和档案顺序不同也按内容配对，不会判成整段重写", () => {
    const doc = local();
    doc.workExperiences = [
      { ...doc.workExperiences[0] },
      {
        localId: "w2",
        companyName: "B 公司",
        positionName: "后端",
        department: "",
        startDate: "2016-07",
        endDate: "2019-12",
        responsibilities: "维护老系统",
        achievements: "",
        skills: [],
      },
    ];
    // 线上是反序的（服务端按开始时间倒序）：按下标配会把 A 公司配到 B 公司上。
    const plan = buildOnlineSyncPlan(doc, remote({ works: [workB, workA] }), DEFAULT_ONLINE_SYNC_OPTIONS);
    const work = moduleOf(plan, "work");
    expect(work.items.every((item) => item.kind === "unchanged")).toBe(true);
    // 展示顺序跟档案走，并且指向线上真正对应的那条。
    expect(work.items[0].title).toBe("A 公司");
    expect(work.items[0].localIndex).toBe(0);
    expect(work.items[0].remoteIndex).toBe(1);
  });

  it("项目顺序不同：按名称配对，不是第 n 条对第 n 条", () => {
    const doc = local({
      projects: [
        { localId: "p1", projectName: "Swift App", role: "", startDate: "2025-08", endDate: "2026-08", isCurrent: false, description: "技术栈", achievements: "", link: "" },
        { localId: "p2", projectName: "AI 研发工作流", role: "前端开发工程师", startDate: "2026-08", endDate: "", isCurrent: true, description: "说明", achievements: "", link: "" },
      ],
    });
    const online = remote({
      projects: [
        { id: "r2", name: "AI 研发工作流", roleName: "前端开发工程师", startDate: "2026-08", endDate: "", description: "说明", performance: "", url: "" },
        { id: "r1", name: "Swift App", roleName: "", startDate: "2025-08", endDate: "2026-08", description: "技术栈", performance: "", url: "" },
      ],
    });
    const plan = buildOnlineSyncPlan(doc, online, DEFAULT_ONLINE_SYNC_OPTIONS);
    const project = moduleOf(plan, "project");
    // 顺序不同不再产生「整段重写」，内容本来就一致。
    expect(project.items.every((item) => item.kind === "unchanged")).toBe(true);
    expect(project.items[0].title).toBe("Swift App");
    expect(project.items[0].remoteIndex).toBe(1);
    expect(project.items[1].remoteIndex).toBe(0);
  });

  it("线上多出的条目要删、本地为空要清空，完全一致的部分不报差异", () => {
    const plan = buildOnlineSyncPlan(local(), remote(), DEFAULT_ONLINE_SYNC_OPTIONS);

    // 第一条工作经历逐字段一致：换行/空格差异不算差异。
    const work = moduleOf(plan, "work");
    expect(work.items).toHaveLength(2);
    expect(work.items[0].kind).toBe("unchanged");
    expect(work.items[1].kind).toBe("delete");
    expect(work.counts.delete).toBe(1);
    expect(plan.counts.delete).toBe(1);

    // 线上有个人优势、本地清空了 → 必须写空，算一次「清空」。
    const advantage = moduleOf(plan, "advantage");
    expect(advantage.kind).toBe("update");
    expect(advantage.fields[0].after).toBe("（空）");
    expect(plan.counts.clear).toBe(1);

    // 专业技能：本地数组拼成换行文本，与线上空格版等价。
    expect(moduleOf(plan, "professionalSkill").kind).toBe("unchanged");
    // 基本资料与期望都一致。
    expect(moduleOf(plan, "baseInfo").kind).toBe("unchanged");
    expect(moduleOf(plan, "expect").kind).toBe("unchanged");

    expect(plan.changedModules).toBe(2);
    expect(plan.blockers).toEqual([]);
  });

  it("默认不动期望行业，打开开关才比对", () => {
    const withIndustry = remote({ expects: [{ ...remote().expects[0], industryDesc: "互联网" }] });
    const base = local({ jobIntent: { cities: ["上海"], positions: ["前端工程师"], industries: ["在线教育"], salary: "25-35K" } });

    const off = buildOnlineSyncPlan(base, withIndustry, DEFAULT_ONLINE_SYNC_OPTIONS);
    expect(moduleOf(off, "expect").kind).toBe("unchanged");
    expect(off.preserved.some((item) => item.includes("期望行业"))).toBe(true);

    const on = buildOnlineSyncPlan(base, withIndustry, { ...DEFAULT_ONLINE_SYNC_OPTIONS, syncIndustries: true });
    const field = moduleOf(on, "expect").items[0].fields.find((entry) => entry.label === "期望行业");
    expect(field?.changed).toBe(true);
    expect(field?.after).toBe("在线教育");
  });

  it("多城市多职位按城市 × 职位展开，最多 3 条", () => {
    const plan = buildOnlineSyncPlan(
      local({ jobIntent: { cities: ["上海", "北京"], positions: ["前端工程师", "Node 工程师"], industries: [], salary: "25-35K" } }),
      remote(),
      DEFAULT_ONLINE_SYNC_OPTIONS,
    );
    const expectModule = moduleOf(plan, "expect");
    expect(expectModule.items).toHaveLength(3);
    expect(plan.warnings.some((warning) => warning.includes("最多 3 条"))).toBe(true);
  });

  it("姓名为空时阻断同步", () => {
    const plan = buildOnlineSyncPlan(local({ profile: { name: "" } }), remote(), DEFAULT_ONLINE_SYNC_OPTIONS);
    expect(plan.blockers).toHaveLength(1);
  });

  it("本地没有可信来源的字段列进保留清单，不参与一致", () => {
    const plan = buildOnlineSyncPlan(local(), remote(), { syncJobStatus: false, syncIndustries: false });
    expect(plan.preserved.some((item) => item.includes("手机号"))).toBe(true);
    expect(plan.preserved.some((item) => item.includes("求职状态：本地档案没有 BOSS 的 applyStatus 编码"))).toBe(true);
    expect(plan.preserved.some((item) => item.includes("工作经历的所属行业"))).toBe(true);
  });

  it("线上已填、本地没有模型的模块进「不比对」清单", () => {
    const plan = buildOnlineSyncPlan(local(), remote({ unknownModules: ["社交主页", "荣誉奖项"] }), DEFAULT_ONLINE_SYNC_OPTIONS);
    expect(plan.notCompared.some((item) => item.includes("社交主页"))).toBe(true);
  });

  it("只勾选部分模块时，未勾选的差异照常列出但不计入汇总", () => {
    const plan = buildOnlineSyncPlan(local(), remote(), { ...DEFAULT_ONLINE_SYNC_OPTIONS, modules: ["work"] });

    // 勾选的工作经历：线上多一条 → 计入删除。
    expect(moduleOf(plan, "work").selected).toBe(true);
    expect(plan.counts.delete).toBe(1);

    // 未勾选的个人优势：模块内仍然算出了「清空」，但不该出现在汇总里。
    const advantage = moduleOf(plan, "advantage");
    expect(advantage.selected).toBe(false);
    expect(advantage.kind).toBe("update");
    expect(plan.counts.clear).toBe(0);
    expect(plan.changedModules).toBe(1);
    expect(plan.skipped).toContain("个人优势");
    expect(plan.notCompared.some((item) => item.includes("本次没有勾选"))).toBe(true);
  });

  it("未勾选基本资料时，姓名为空不阻断", () => {
    const nameless = local({ profile: { name: "" } });
    const onlyWork = buildOnlineSyncPlan(nameless, remote(), { ...DEFAULT_ONLINE_SYNC_OPTIONS, modules: ["work"] });
    expect(onlyWork.blockers).toEqual([]);

    const withBase = buildOnlineSyncPlan(nameless, remote(), { ...DEFAULT_ONLINE_SYNC_OPTIONS, modules: ["baseInfo"] });
    expect(withBase.blockers).toHaveLength(1);
  });

  it("modules 缺省视为全选，空数组视为一个都不选", () => {
    // 旧档案没有 modules 字段：按全选处理，行为与加勾选前一致。
    const legacy = buildOnlineSyncPlan(local(), remote(), { syncJobStatus: false, syncIndustries: false });
    expect(legacy.modules.every((module) => module.selected)).toBe(true);
    expect(legacy.counts.delete).toBe(1);

    const none = buildOnlineSyncPlan(local(), remote(), { ...DEFAULT_ONLINE_SYNC_OPTIONS, modules: [] });
    expect(none.modules.some((module) => module.selected)).toBe(false);
    expect(none.counts).toEqual({ create: 0, update: 0, delete: 0, clear: 0 });
    expect(none.changedModules).toBe(0);
    expect(none.skipped).toHaveLength(none.modules.length);
  });

  it("选项归一化：去重、丢弃非法 id、按展示顺序排列", () => {
    const resolved = resolveOnlineSyncOptions({
      syncIndustries: true,
      modules: ["work", "work", "nope" as never, "baseInfo"],
    });
    expect(resolved.modules).toEqual(["baseInfo", "work"]);
    expect(resolved.syncIndustries).toBe(true);
    // 返回的必须是新数组：就地修改不能污染默认常量。
    expect(resolved.modules).not.toBe(DEFAULT_ONLINE_SYNC_OPTIONS.modules);
    const defaultLength = DEFAULT_ONLINE_SYNC_OPTIONS.modules!.length;
    resolved.modules!.push("project");
    expect(DEFAULT_ONLINE_SYNC_OPTIONS.modules).toHaveLength(defaultLength);
  });
});

describe("项目「担任角色」：自由文本，按文字比、按文字写", () => {
  const project = (overrides: Partial<BossResumeDocument["projects"][number]> = {}) => ({
    localId: "p1",
    projectName: "P1",
    role: "前端开发工程师",
    startDate: "2024-01",
    endDate: "",
    isCurrent: true,
    description: "做了点事",
    achievements: "",
    link: "",
    ...overrides,
  });

  const onlineProject = (overrides: Partial<OnlineResume["projects"][number]> = {}) => ({
    id: "p1",
    name: "P1",
    roleName: "",
    startDate: "2024-01",
    endDate: "",
    description: "做了点事",
    performance: "",
    url: "",
    ...overrides,
  });

  it("线上角色为空、本地有文字 → 算差异，把文字写上去", () => {
    const doc = local({ projects: [project()] });
    const plan = buildOnlineSyncPlan(doc, remote({ projects: [onlineProject()] }), DEFAULT_ONLINE_SYNC_OPTIONS);
    const module = plan.modules.find((item) => item.id === "project")!;
    const field = module.items[0].fields.find((item) => item.label === "担任角色")!;
    expect(field.before).toBe("（空）");
    expect(field.after).toBe("前端开发工程师");
    expect(field.changed).toBe(true);
    expect(module.items[0].kind).toBe("update");
  });

  it("线上角色文字与本地一致 → 不算差异（网页端读回来的就是同一段文字）", () => {
    const doc = local({ projects: [project()] });
    const online = remote({ projects: [onlineProject({ roleName: "前端开发工程师" })] });
    const module = buildOnlineSyncPlan(doc, online, DEFAULT_ONLINE_SYNC_OPTIONS).modules.find((item) => item.id === "project")!;
    expect(module.items[0].fields.find((item) => item.label === "担任角色")!.changed).toBe(false);
    expect(module.items[0].kind).toBe("unchanged");
    expect(module.counts.update).toBe(0);
  });

  it("线上有角色、本地为空 → 不清线上（角色是可选项，清空没有意义）", () => {
    const doc = local({ projects: [project({ role: "" })] });
    const online = remote({ projects: [onlineProject({ roleName: "核心开发工程师" })] });
    const module = buildOnlineSyncPlan(doc, online, DEFAULT_ONLINE_SYNC_OPTIONS).modules.find((item) => item.id === "project")!;
    const field = module.items[0].fields.find((item) => item.label === "担任角色")!;
    expect(field.before).toBe("核心开发工程师");
    expect(field.changed).toBe(false);
  });

  it("角色超出 2-12 字 → 不算差异，并在折叠态挂 hint 说明这次没写", () => {
    const long = "负责前端架构与团队管理的高级工程师";
    const doc = local({ projects: [project({ role: long })] });
    const module = buildOnlineSyncPlan(doc, remote({ projects: [onlineProject()] }), DEFAULT_ONLINE_SYNC_OPTIONS).modules.find(
      (item) => item.id === "project",
    )!;
    expect(module.items[0].fields.find((item) => item.label === "担任角色")!.changed).toBe(false);
    expect(module.hint).toBe("角色超长未写");
    expect(module.note).toContain("2-12 字");
  });

  it("数字角色（老数据里的 343）按文字处理，不当编码", () => {
    expect(roleText(343)).toBe("343");
    expect(roleText("  项目负责人 ")).toBe("项目负责人");
    expect(roleWritable("项目负责人")).toBe(true);
    expect(roleWritable("q")).toBe(false);
    expect(roleWritable("负责前端架构与团队管理的高级工程师")).toBe(false);
  });
});
