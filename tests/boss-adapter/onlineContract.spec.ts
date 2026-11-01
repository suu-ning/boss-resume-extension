import { describe, expect, it } from "vitest";
import {
  CARRY_OVER,
  GEEK_BIZ_SOURCE,
  GEEK_ENDPOINTS,
  STATIC_FIELDS,
  buildBaseInfoPayload,
  buildCertificationPayload,
  buildExpectDeletePayload,
  buildExperienceDeletePayload,
  buildUserDescPayload,
  buildUserDescPrecheck,
} from "../../src/boss/online/contract";

/**
 * 这些字段名不是抄来的，是 2026-10-30 录制样本里真实出现的键。
 * 抄错一个字母，线上接口会当没传，写入「成功」但什么都没改 —— 所以在这里钉死。
 */
const RECORDED_KEYS = {
  userdescSave: ["advantage", "entrance", "riskTipType", "xGeekBizSource"],
  userdescPrecheck: ["userDesc"],
  baseinfoSave: ["applyStatus", "birthday", "freshGraduate", "gender", "name", "nameShowType", "startWorkDate", "xGeekBizSource"],
  certificationSave: ["certJson"],
  workSave: [
    "companyName",
    "customPositionName",
    "department",
    "emphasis",
    "endDate",
    "entrance",
    "id",
    "industryCode",
    "industryName",
    "industrySource",
    "isPublic",
    "position",
    "riskTipType",
    "startDate",
    "workContent",
    "workPerformance",
    "workType",
    "xGeekBizSource",
  ],
  projectSave: ["description", "endDate", "entrance", "name", "performance", "riskTipType", "roleName", "startDate", "url", "xGeekBizSource"],
  eduexpSave: [
    "course",
    "degree",
    "eduDescription",
    "eduType",
    "endDate",
    "entrance",
    "id",
    "major",
    "majorRanking",
    "riskTipType",
    "school",
    "schoolId",
    "startDate",
    "thesisDesc",
    "thesisTitle",
    "xGeekBizSource",
  ],
  expectSave: [
    "freshGraduate",
    "fullUpdate",
    "highSalary",
    "id",
    "industryCodes",
    "location",
    "locationName",
    "lowSalary",
    "multiExpectInfos",
    "otherLocationCodeStr",
    "position",
    "positionType",
    "subLocation",
    "xGeekBizSource",
  ],
} as const;

const keysOf = (value: object): string[] => Object.keys(value).sort();

describe("接口路径", () => {
  it("与录制样本里的路径逐字一致", () => {
    expect(GEEK_ENDPOINTS.userDescSave.path).toBe("/wapi/zpgeek/resume/userdesc/save.json");
    expect(GEEK_ENDPOINTS.baseInfoPrecheck.path).toBe("/wapi/zpgeek/resume/baseinfo/save/precheck.json");
    expect(GEEK_ENDPOINTS.workSave.path).toBe("/wapi/zpgeek/resume/workexp/save.json");
    expect(GEEK_ENDPOINTS.workPrecheck.path).toBe("/wapi/zpgeek/geek/workexp/precheck.json");
    expect(GEEK_ENDPOINTS.projectDelete.path).toBe("/wapi/zpgeek/resume/projectexp/delete.json");
    expect(GEEK_ENDPOINTS.educationPrecheck.path).toBe("/wapi/zpgeek/geek/eduexp/precheck.json");
    expect(GEEK_ENDPOINTS.expectSave.path).toBe("/wapi/zpgeek/resume/expect/save.json");
    expect(GEEK_ENDPOINTS.certificationSave.path).toBe("/wapi/zpgeek/resume/certification/save.json");
  });

  it("基本资料的 precheck 是 GET，其余写接口都是 POST", () => {
    expect(GEEK_ENDPOINTS.baseInfoPrecheck.method).toBe("GET");
    for (const [name, endpoint] of Object.entries(GEEK_ENDPOINTS)) {
      if (name === "baseInfoPrecheck") continue;
      expect(endpoint.method, name).toBe("POST");
    }
  });
});

describe("个人优势", () => {
  it("保存体的字段名与录制一致，并带上来来源标记", () => {
    const payload = buildUserDescPayload("十年一线开发");
    expect(keysOf(payload)).toEqual([...RECORDED_KEYS.userdescSave].sort());
    expect(payload.advantage).toBe("十年一线开发");
    expect(payload.xGeekBizSource).toBe(GEEK_BIZ_SOURCE);
  });

  it("前置校验用的是 userDesc 而不是 advantage", () => {
    const payload = buildUserDescPrecheck("十年一线开发");
    expect(keysOf(payload)).toEqual([...RECORDED_KEYS.userdescPrecheck].sort());
    expect(payload.userDesc).toBe("十年一线开发");
  });

  it("清空个人优势时传空串，而不是省略字段", () => {
    const payload = buildUserDescPayload("");
    expect(payload.advantage).toBe("");
    expect("advantage" in payload).toBe(true);
  });
});

describe("资格证书", () => {
  it("只有 certJson 一个字段，不带来源标记", () => {
    expect(keysOf(buildCertificationPayload(["系统架构师"]))).toEqual([...RECORDED_KEYS.certificationSave].sort());
  });

  it("整模块覆盖：按传入顺序生成完整数组", () => {
    const payload = buildCertificationPayload(["A", "B", "C"]);
    expect(payload.certJson).toEqual([
      { name: "A", type: 0 },
      { name: "B", type: 0 },
      { name: "C", type: 0 },
    ]);
  });

  it("过滤空白项：空名字不是合法证书", () => {
    expect(buildCertificationPayload(["A", "  ", "", "B "]).certJson).toEqual([
      { name: "A", type: 0 },
      { name: "B", type: 0 },
    ]);
  });

  it("传空数组就是清空整个模块，不做兜底保留", () => {
    expect(buildCertificationPayload([]).certJson).toEqual([]);
  });
});

describe("基本资料", () => {
  it("字段名与录制一致，nameShowType 默认 0", () => {
    const payload = buildBaseInfoPayload({
      name: "张三",
      gender: 1,
      birthday: "1995-08",
      startWorkDate: "2018-07",
      applyStatus: 0,
      freshGraduate: 0,
    });
    expect(keysOf(payload)).toEqual([...RECORDED_KEYS.baseinfoSave].sort());
    expect(payload.nameShowType).toBe(0);
    expect(payload.xGeekBizSource).toBe(GEEK_BIZ_SOURCE);
  });

  it("求职状态与应届标记必须由调用方从线上原值带入，不给默认值", () => {
    const payload = buildBaseInfoPayload({
      name: "张三",
      gender: 1,
      birthday: "1995-08",
      startWorkDate: "2018-07",
      applyStatus: 3,
      freshGraduate: 1,
    });
    expect(payload.applyStatus).toBe(3);
    expect(payload.freshGraduate).toBe(1);
  });
});

describe("删除", () => {
  it("工作与项目经历的删除体只有 id 和来源标记", () => {
    const payload = buildExperienceDeletePayload("abc123");
    expect(keysOf(payload)).toEqual(["id", "xGeekBizSource"].sort());
    expect(payload.id).toBe("abc123");
    expect(payload.xGeekBizSource).toBe(GEEK_BIZ_SOURCE);
  });

  it("期望删除传的是 positionType，不是 id", () => {
    const payload = buildExpectDeletePayload(1);
    expect(keysOf(payload)).toEqual(["type", "xGeekBizSource"].sort());
    expect(payload.type).toBe(1);
    // 一旦混进 id，语义就从「删整组」变成别的东西，必须没有。
    expect("id" in payload).toBe(false);
  });

  it("删除接口路径与录制一致", () => {
    expect(GEEK_ENDPOINTS.workDelete.path).toBe("/wapi/zpgeek/resume/workexp/delete.json");
    expect(GEEK_ENDPOINTS.projectDelete.path).toBe("/wapi/zpgeek/resume/projectexp/delete.json");
    expect(GEEK_ENDPOINTS.expectDelete.path).toBe("/wapi/zpgeek/resume/expect/delete.json");
  });
});

describe("线上回传字段", () => {
  it("列出的字段都在该模块的录制字段里，没有拼错", () => {
    const recordedByModule: Record<string, readonly string[]> = {
      workexp: RECORDED_KEYS.workSave,
      projectexp: RECORDED_KEYS.projectSave,
      eduexp: RECORDED_KEYS.eduexpSave,
      expect: RECORDED_KEYS.expectSave,
    };
    for (const [module, fields] of Object.entries(CARRY_OVER)) {
      const recorded = recordedByModule[module];
      expect(recorded, `未登记的模块 ${module}`).toBeDefined();
      for (const field of fields) {
        expect(recorded, `${module}.${field} 不在录制字段里`).toContain(field);
      }
    }
  });

  it("行业来源这类编码必须回传，不能硬编码", () => {
    // 两次录制里 industrySource 分别是负数与两位数，硬编码任何一个都会写错。
    expect(CARRY_OVER.workexp).toContain("industrySource");
    expect(STATIC_FIELDS).not.toHaveProperty("industrySource");
  });
});
