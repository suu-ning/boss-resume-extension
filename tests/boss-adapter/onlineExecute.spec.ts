import { describe, expect, it } from "vitest";
import { createBlankResume, type BossResumeDocument } from "../../src/domain";
import { OnlineResumeAdapter } from "../../src/boss/online/adapter";
import { buildOnlineWritePlan } from "../../src/boss/online/execute";
import { EMPTY_DICTS, type OnlineDicts } from "../../src/boss/online/dict";
import { buildOnlineSyncPlan } from "../../src/boss/online/plan";
import { DEFAULT_ONLINE_SYNC_OPTIONS, type OnlineSyncPlan } from "../../src/boss/online/types";
import type { OnlineSyncOptions } from "../../src/domain/types";

/**
 * 线上简历的原始结构（preview/data.json 的 zpData）。
 * 字段名照 2026-10-30 的脱敏录制：写回时要透传的编码字段（industry、position、industrySource、
 * positionType、schoolId、degree…）只有原始结构里有，所以这里必须用原始结构做夹具。
 */
const remoteRaw = {
  lastUpdateTime: "2026.10.12 10:00",
  baseInfo: { name: "张三", gender: 1, birthdayDesc: "1995-06", startWorkDateDesc: "2018-07", applyStatus: 0, freshGraduate: 0, nameShowType: 0, degree: 203 },
  userDesc: "旧的优势",
  professionalSkill: "TypeScript React",
  expectList: [
    {
      id: "e1",
      location: 101020100,
      locationName: "上海",
      position: 100101,
      positionName: "前端工程师",
      positionType: 0,
      lowSalary: 25,
      highSalary: 35,
      subLocation: 0,
      freshGraduate: 0,
      industryDesc: "互联网",
      multiExpectInfos: [{ position: 100101 }],
    },
    {
      id: "e2",
      location: 101010100,
      locationName: "北京",
      position: 100101,
      positionName: "前端工程师",
      positionType: 1,
      lowSalary: 20,
      highSalary: 30,
      subLocation: 0,
      freshGraduate: 0,
      industryDesc: "互联网",
    },
  ],
  workExpList: [
    {
      id: "w1",
      companyName: "A 公司",
      position: 100101,
      positionName: "前端",
      customPositionName: "",
      department: "增长",
      startDate: "2020.03",
      endDate: "2022.05",
      workContent: "负责增长",
      workPerformance: "",
      emphasis: [],
      industry: { code: 100020, name: "互联网" },
      industrySource: -1,
      isPublic: 0,
      workType: 1,
      entrance: 1,
    },
    {
      id: "w2",
      companyName: "B 公司",
      position: 100201,
      positionName: "后端",
      customPositionName: "",
      department: "",
      startDate: "2016.07",
      endDate: "2019.12",
      workContent: "维护老系统",
      workPerformance: "",
      emphasis: [],
      industry: { code: 100021, name: "企业服务" },
      industrySource: -1,
      isPublic: 0,
      workType: 0,
      entrance: 1,
    },
  ],
  projectExpList: [] as Record<string, unknown>[],
  educationExpList: [
    {
      id: "edu1",
      school: "某大学",
      schoolId: 12345,
      degree: 203,
      degreeName: "本科",
      eduType: 1,
      major: "计算机",
      startYear: "2014",
      endYear: "2018",
      educationDesc: "在校",
      thesisTitle: "",
      thesisDesc: "",
      entrance: 1,
      majorRanking: 0,
      course: "",
    },
  ],
  certificationList: [{ certName: "PMP", certType: 0 }],
};

function local(overrides: Partial<BossResumeDocument> = {}): BossResumeDocument {
  const doc = createBlankResume({ createId: () => "r1" });
  doc.profile = { name: "张三", gender: "male", birthDate: "1995-06", workStartDate: "2018-07" };
  doc.advantage = "旧的优势";
  doc.professionalSkills = ["TypeScript React"];
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
      skills: [],
    },
  ];
  doc.projects = [];
  doc.educations = [
    {
      localId: "e1",
      schoolName: "某大学",
      degree: "本科",
      major: "计算机",
      startDate: "2014",
      endDate: "2018",
      campusExperience: "在校",
      thesis: "",
    },
  ];
  doc.certificates = [{ localId: "c1", name: "PMP" }];
  return { ...doc, ...overrides };
}

const POSITIONS: OnlineDicts["positions"] = [
  { code: 100101, name: "前端", parentCode: 1 },
  { code: 100102, name: "前端工程师", parentCode: 1 },
];

function build(
  doc: BossResumeDocument = local(),
  options: OnlineSyncOptions = DEFAULT_ONLINE_SYNC_OPTIONS,
  dicts: OnlineDicts = EMPTY_DICTS,
  raw: Record<string, unknown> = remoteRaw,
) {
  const adapted = OnlineResumeAdapter.adapt(raw, "2026-10-30T00:00:00.000Z");
  if (!adapted.ok) throw new Error("夹具不合法");
  const plan: OnlineSyncPlan = buildOnlineSyncPlan(doc, adapted.resume, options);
  return buildOnlineWritePlan({ resume: doc, remoteRaw: raw, plan, options, dicts });
}

const only = (modules: OnlineSyncOptions["modules"]): OnlineSyncOptions => ({ ...DEFAULT_ONLINE_SYNC_OPTIONS, modules });

describe("buildOnlineWritePlan", () => {
  it("完全一致时不产生任何写操作", () => {
    // 线上多出来的期望与工作经历都会被判成删除，所以先只勾一致的部分。
    const result = build(local(), only(["advantage", "professionalSkill", "baseInfo", "education", "certificate"]));
    expect(result.operations).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("个人优势：先前置校验 userDesc，再保存 advantage", () => {
    const doc = local({ advantage: "新的优势" });
    const result = build(doc, only(["advantage"]));
    expect(result.operations).toHaveLength(1);
    const [operation] = result.operations;
    expect(operation.path).toBe("/wapi/zpgeek/resume/userdesc/save.json");
    expect(operation.precheck).toEqual({
      method: "POST",
      path: "/wapi/zpgeek/resume/userdesc/precheck.json",
      payload: { userDesc: "新的优势" },
    });
    expect(operation.payload).toMatchObject({ advantage: "新的优势", entrance: 1, riskTipType: 1, xGeekBizSource: "pc_online_resume" });
  });

  it("基本资料：性别不填时沿用线上编码，手机号头像等字段不在请求体里", () => {
    const doc = local();
    doc.profile = { ...doc.profile, name: "张三丰", gender: "unknown" };
    const result = build(doc, only(["baseInfo"]));
    const [operation] = result.operations;
    expect(operation.precheck).toEqual({ method: "GET", path: "/wapi/zpgeek/resume/baseinfo/save/precheck.json", payload: {} });
    expect(operation.payload).toEqual({
      name: "张三丰",
      gender: 1,
      birthday: "1995-06",
      startWorkDate: "2018-07",
      applyStatus: 0,
      freshGraduate: 0,
      nameShowType: 0,
      xGeekBizSource: "pc_online_resume",
    });
  });

  it("长文本保留换行：工作内容、项目描述与个人优势不压成一整段", () => {
    const doc = local({ advantage: "第一行\n第二行\r\n第三行" });
    doc.workExperiences = [{ ...doc.workExperiences[0], responsibilities: "职责一\n\n职责二" }];
    const result = build(doc, only(["advantage", "work"]));

    const advantage = result.operations.find((operation) => operation.module === "advantage")!;
    expect(advantage.payload.advantage).toBe("第一行\n第二行\n第三行");
    expect(advantage.precheck?.payload).toEqual({ userDesc: "第一行\n第二行\n第三行" });

    const work = result.operations.find((operation) => operation.module === "work" && operation.action === "save")!;
    expect(work.payload.workContent).toBe("职责一\n\n职责二");
    expect(work.precheck?.payload).toMatchObject({ responsibility: "职责一\n\n职责二" });
  });

  it("工作经历更新：改正文，编码字段全部透传线上值", () => {
    const doc = local();
    doc.workExperiences = [{ ...doc.workExperiences[0], responsibilities: "负责增长与留存" }];
    const result = build(doc, only(["work"]));

    const save = result.operations.find((operation) => operation.action === "save")!;
    expect(save.payload).toMatchObject({
      id: "w1",
      companyName: "A 公司",
      position: 100101,
      // 没有字典时职位文字写进自定义职位，不猜编码。
      customPositionName: "前端",
      industryCode: 100020,
      industryName: "互联网",
      industrySource: -1,
      isPublic: 0,
      workType: 1,
      startDate: "2020-03",
      endDate: "2022-05",
      workContent: "负责增长与留存",
      xGeekBizSource: "pc_online_resume",
    });
    // 前置校验的字段名与保存不同：responsibility / workId。
    expect(save.precheck?.payload).toEqual({ responsibility: "负责增长与留存", workPerformance: "", workId: "w1" });
    expect(save.precheck?.path).toBe("/wapi/zpgeek/geek/workexp/precheck.json");

    // 线上多出来的第二条要按 id 删。
    const remove = result.operations.find((operation) => operation.action === "delete")!;
    expect(remove.path).toBe("/wapi/zpgeek/resume/workexp/delete.json");
    expect(remove.payload).toEqual({ id: "w2", xGeekBizSource: "pc_online_resume" });
  });

  it("工作经历新增：查到字典就用职位编码，并且不带 id", () => {
    const doc = local();
    doc.workExperiences = [
      ...doc.workExperiences,
      {
        localId: "w9",
        companyName: "C 公司",
        positionName: "前端",
        department: "",
        startDate: "2023-01",
        isCurrent: true,
        responsibilities: "新项目",
        achievements: "",
        skills: ["React", "Vue"],
      },
    ];
    // 线上只有一条工作经历，本地多出来的那条才是「新增」。
    const raw = { ...remoteRaw, workExpList: [remoteRaw.workExpList[0]] };
    const result = build(doc, only(["work"]), { ...EMPTY_DICTS, positions: POSITIONS }, raw);
    const created = result.operations.find((operation) => operation.label.includes("新增"))!;
    expect(created.payload).toMatchObject({ companyName: "C 公司", position: 100101, customPositionName: "", emphasis: "React,Vue", startDate: "2023-01" });
    expect(created.payload).not.toHaveProperty("id");
    // 至今：结束日期留空。
    expect(created.payload.endDate).toBe("");
    expect(created.precheck?.payload).toMatchObject({ workId: "" });
  });

  it("期望：多出来的条目不删只报，更新时透传 positionType 与城市编码", () => {
    const doc = local();
    doc.jobIntent = { ...doc.jobIntent, salary: "30-40K" };
    const result = build(doc, only(["expect"]));

    const save = result.operations.find((operation) => operation.action === "save")!;
    expect(save.payload).toMatchObject({
      id: "e1",
      location: 101020100,
      locationName: "上海",
      position: 100101,
      positionType: 0,
      lowSalary: 30,
      highSalary: 40,
      fullUpdate: "true",
      xGeekBizSource: "pc_online_resume",
    });
    expect(result.operations.some((operation) => operation.action === "delete")).toBe(false);
    expect(result.skipped.some((item) => item.includes("线上多出 1 条"))).toBe(true);
  });

  it("期望新增时城市或职位查不到编码就不写", () => {
    const doc = local();
    doc.jobIntent = { ...doc.jobIntent, cities: ["上海", "杭州"], positions: ["前端工程师"] };
    // 线上只有一条期望，本地展开成两条 → 第二条是新增，需要城市与职位编码。
    const raw = { ...remoteRaw, expectList: [remoteRaw.expectList[0]] };
    const withoutDict = build(doc, only(["expect"]), EMPTY_DICTS, raw);
    expect(withoutDict.operations).toHaveLength(0);
    expect(withoutDict.skipped.some((item) => item.includes("没有匹配到编码"))).toBe(true);

    const withDict = build(doc, only(["expect"]), {
      ...EMPTY_DICTS,
      positions: POSITIONS,
      cities: [{ code: 101210100, name: "杭州", parentCode: 101210000 }],
    }, raw);
    const created = withDict.operations.find((operation) => operation.label.includes("新增"))!;
    expect(created.payload).toMatchObject({ location: 101210100, locationName: "杭州", position: 100102 });
    expect(created.payload).not.toHaveProperty("id");
  });

  it("教育经历：只能改不能增删，写不进去的进 skipped", () => {
    const doc = local();
    doc.educations = [
      { ...doc.educations[0], campusExperience: "在校经历改了" },
      { localId: "e2", schoolName: "另一所大学", degree: "硕士", startDate: "2018", endDate: "2021" },
    ];
    const result = build(doc, only(["education"]));

    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].payload).toMatchObject({
      id: "edu1",
      school: "某大学",
      schoolId: 12345,
      degree: 203,
      eduType: 1,
      startDate: "2014",
      endDate: "2018",
      eduDescription: "在校经历改了",
      course: "",
    });
    // 前置校验体 = 保存体去掉来源标记。
    expect(result.operations[0].precheck?.payload).not.toHaveProperty("xGeekBizSource");
    expect(result.skipped.some((item) => item.includes("新增需要学校编码"))).toBe(true);

    // 线上有、本地没有：没有删除接口。
    const empty = build(local({ educations: [] }), only(["education"]));
    expect(empty.operations).toHaveLength(0);
    expect(empty.skipped.some((item) => item.includes("没有录制到删除接口"))).toBe(true);
  });

  it("期望行业跟着开关走：关着不写，打开后按行业字典转码", () => {
    const doc = local();
    doc.jobIntent = { ...doc.jobIntent, industries: ["互联网"], salary: "30-40K" };

    const off = build(doc, only(["expect"]));
    expect(off.operations[0].payload.industryCodes).toBe("");

    const on = build(
      doc,
      { ...only(["expect"]), syncIndustries: true },
      { ...EMPTY_DICTS, positions: POSITIONS, industries: [{ code: 100020, name: "互联网", parentCode: 0 }] },
    );
    expect(on.operations[0].payload.industryCodes).toBe("100020");
  });

  it("资格证书整模块覆盖：本地几本就在一次请求里交几本", () => {
    const doc = local({ certificates: [{ localId: "c1", name: "PMP" }, { localId: "c2", name: "软考高级" }] });
    const result = build(doc, only(["certificate"]));
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].payload).toEqual({
      certJson: [
        { name: "PMP", type: 0 },
        { name: "软考高级", type: 0 },
      ],
    });

    const cleared = build(local({ certificates: [] }), only(["certificate"]));
    expect(cleared.operations[0].payload).toEqual({ certJson: [] });
    expect(cleared.operations[0].label).toContain("清空");
  });

  it("专业技能直接按整段文本写入，不需要 parserId 之类的凭证", () => {
    const doc = local({ professionalSkills: ["TypeScript", "React", "Node"] });
    const result = build(doc, only(["professionalSkill"]));
    expect(result.skipped).toEqual([]);
    const [operation] = result.operations;
    expect(operation.path).toBe("/wapi/zpgeek/resume/professional/skill/save.json");
    // 录制 13:20 的真实请求体就是 {"skill": "..."}：手工编辑技能这条路没有 parserId、也没有 source。
    expect(operation.payload).toEqual({ skill: "TypeScript\nReact\nNode" });
    expect(operation.precheck).toBeUndefined();
  });

  it("专业技能本地为空时不写（不拿空串覆盖线上）", () => {
    const doc = local({ professionalSkills: [] });
    // 线上有内容、本地清空时才算差异，此时仍然不提交空值。
    const result = build(doc, only(["professionalSkill"]), EMPTY_DICTS, { ...remoteRaw, professionalSkill: "线上的技能" });
    expect(result.operations).toEqual([]);
    expect(result.skipped.join()).toContain("本地没有内容");
  });

  it("没勾选的模块一个动作都不产生", () => {
    const doc = local();
    doc.workExperiences = [{ ...doc.workExperiences[0], companyName: "改了公司名" }];
    doc.advantage = "新的优势";
    const result = build(doc, only(["advantage"]));
    expect(result.operations.every((operation) => operation.module === "advantage")).toBe(true);
  });

  it("项目经历新增不带 id，更新带线上 id", () => {
    const doc = local();
    doc.projects = [
      { localId: "p1", projectName: "新项目", role: "负责人", startDate: "2021-01", endDate: "2022-01", description: "描述", achievements: "", link: "" },
    ];
    const raw = { ...remoteRaw, projectExpList: [{ id: "p9", name: "旧项目", roleName: 343, entrance: 1, startDate: "2020.01", endDate: "2021.01", projectDesc: "旧", performance: "", url: "" }] };
    const result = build(doc, only(["project"]), EMPTY_DICTS, raw);

    // 第一条按顺序对齐 → 更新线上那条，带 id；角色是自由文本，写本地文字而不是透传线上数字。
    const update = result.operations.find((operation) => operation.label.includes("更新"))!;
    expect(update.payload).toMatchObject({ id: "p9", name: "新项目", roleName: "负责人", startDate: "2021-01", endDate: "2022-01" });

    // 本地多一条 → 新增，不带 id。
    const create = result.operations.find((operation) => operation.label.includes("新增"));
    expect(create).toBeUndefined();

    const withMore = local();
    withMore.projects = [
      doc.projects[0],
      { localId: "p2", projectName: "第二个项目", startDate: "2019-01", achievements: "", link: "" },
    ];
    const second = build(withMore, only(["project"]), EMPTY_DICTS, raw);
    const created = second.operations.find((operation) => operation.label.includes("新增"))!;
    expect(created.payload).not.toHaveProperty("id");
    // 本地没填角色、线上也没有 → 交空串，不编一个 0 上去。
    expect(created.payload.roleName).toBe("");
  });

  it("项目角色：自由文本直接写；超长或本地为空时保留线上原值", () => {
    const doc = local();
    doc.projects = [
      { localId: "p1", projectName: "第一个项目", role: "前端开发工程师", startDate: "2021-01", description: "描述", achievements: "", link: "" },
      { localId: "p2", projectName: "第二个项目", role: "负责前端架构与团队管理的高级工程师", startDate: "2019-01", description: "描述改了", achievements: "", link: "" },
    ];
    const raw = {
      ...remoteRaw,
      projectExpList: [
        { id: "p1", name: "第一个项目", roleName: "核心开发", entrance: 1, startDate: "2021.01", endDate: "", projectDesc: "描述", performance: "", url: "" },
        { id: "p2", name: "第二个项目", roleName: "核心开发", entrance: 1, startDate: "2019.01", endDate: "", projectDesc: "描述", performance: "", url: "" },
      ],
    };
    const result = build(doc, only(["project"]), EMPTY_DICTS, raw);
    const payloadOf = (name: string) => result.operations.find((operation) => operation.label.includes(name))!.payload as Record<string, unknown>;
    expect(payloadOf("第一个项目").roleName).toBe("前端开发工程师");
    // 超长的角色不硬写（页面只收 2-12 字），保留线上值，并给出提示。
    expect(payloadOf("第二个项目").roleName).toBe("核心开发");
    expect(result.warnings.join("\n")).toContain("2-12");
  });
});
