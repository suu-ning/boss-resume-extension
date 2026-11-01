import { describe, expect, it } from "vitest";
import { OnlineResumeAdapter } from "../../src/boss/online/adapter";

/** 结构照 2026-10-30 录制的 geek/preview/data.json，值只是占位。 */
const zpData = {
  lastUpdateTime: "2026.10.12 10:00",
  baseInfo: {
    name: "张三",
    gender: 1,
    birthday: "19950601",
    birthdayDesc: "1995-06",
    startWorkDateDesc: "2018-07",
    degree: 203,
    workYears: 8,
  },
  userDesc: "8 年前端经验，做过增长与中台。",
  professionalSkill: "TypeScript\nReact",
  expectList: [
    { id: "e1", locationName: "上海", positionName: "前端工程师", lowSalary: 25, highSalary: 35, industryDesc: "互联网" },
  ],
  workExpList: [
    {
      id: "w1",
      companyName: "A 公司",
      positionName: "前端",
      department: "增长",
      startDateStr: "2020.03",
      endDateStr: "2022.05",
      workContent: "负责增长",
      workPerformance: "",
      emphasis: ["React"],
    },
  ],
  projectExpList: [
    {
      id: "p1",
      name: "增长中台",
      roleName: "负责人",
      startDateStr: "2021.01",
      endDateStr: "",
      projectDesc: "从 0 到 1",
      performance: "",
      url: "",
    },
  ],
  educationExpList: [
    {
      id: "edu1",
      school: "某某大学",
      major: "软件工程",
      degreeName: "本科",
      startYearStr: "2011",
      endYearStr: "2015",
      educationDesc: "",
      thesisTitle: "",
    },
  ],
  certificationList: [{ certName: "CET-6" }],
  socialContactList: [],
};

describe("OnlineResumeAdapter", () => {
  it("按录制到的字段名转换整份在线简历", () => {
    const outcome = OnlineResumeAdapter.adapt(zpData, "2026-10-30T00:00:00.000Z");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const { resume, raw } = outcome;
    expect(raw).toBe(zpData);
    expect(resume.name).toBe("张三");
    expect(resume.gender).toBe("male");
    // birthdayDesc 是 YYYY-MM，优先用它；8 位数字只是兜底。
    expect(resume.birthday).toBe("1995-06");
    expect(resume.workStartDate).toBe("2018-07");
    expect(resume.lastUpdateTime).toBe("2026.10.12 10:00");
    expect(resume.advantage).toContain("8 年前端");
    expect(resume.professionalSkill).toBe("TypeScript\nReact");

    expect(resume.expects).toHaveLength(1);
    expect(resume.expects[0].locationName).toBe("上海");
    expect(resume.expects[0].highSalary).toBe(35);

    // 线上日期是 YYYY.MM，模型统一成 YYYY-MM；空结束时间表示至今。
    expect(resume.works[0].startDate).toBe("2020-03");
    expect(resume.works[0].endDate).toBe("2022-05");
    expect(resume.works[0].emphasis).toEqual(["React"]);

    expect(resume.projects[0].startDate).toBe("2021-01");
    expect(resume.projects[0].endDate).toBeUndefined();

    expect(resume.educations[0].startYear).toBe("2011");
    expect(resume.educations[0].endYear).toBe("2015");
    expect(resume.educations[0].degreeName).toBe("本科");

    expect(resume.certificates).toEqual([{ name: "CET-6" }]);
    expect(resume.unknownModules).toEqual([]);
  });

  it("线上填了本地没有对应字段的模块时只记名字，不猜结构", () => {
    const outcome = OnlineResumeAdapter.adapt({ ...zpData, socialContactList: [{ platform: "GitHub" }], honorList: [{ name: "优秀员工" }] });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.resume.unknownModules).toEqual(["社交主页", "荣誉奖项"]);
  });

  it("缺少 baseInfo 时返回 UNEXPECTED_RESPONSE", () => {
    const outcome = OnlineResumeAdapter.adapt({ userDesc: "x" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("UNEXPECTED_RESPONSE");
  });
});
