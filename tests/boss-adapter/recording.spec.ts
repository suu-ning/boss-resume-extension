import { describe, expect, it } from "vitest";
import { isRawRequestRecord, maskPath, parseRequestBody, sanitizeRecord, type RawRequestRecord } from "../../src/boss/recording";
import { buildStructureSample } from "../../src/boss/structureSample";

const STARTED = Date.parse("2026-10-28T02:00:00.000Z");

const raw = (overrides: Partial<RawRequestRecord> = {}): RawRequestRecord => ({
  method: "post",
  url: "https://cv.zhipin.com/wapi/zpcvresume/myresume/save.json?resumeId=12345678901&_=1730000000000",
  headerNames: ["Content-Type", "zp_token", "X-Requested-With"],
  contentType: "application/json;charset=UTF-8",
  requestBody: { kind: "text", text: JSON.stringify({ name: "张三", phone: "13800000000", gender: 1, birthday: "1995.06", works: [{ company: "示例公司" }] }) },
  status: 200,
  responseText: JSON.stringify({ code: 0, message: "Success", zpData: { resumeId: 98765432101, title: "我的简历" } }),
  at: STARTED + 1500,
  ...overrides,
});

describe("buildStructureSample 字符串格式", () => {
  it("短数字保留枚举值，日期与手机号只留格式，其余只留长度", () => {
    expect(buildStructureSample({ g: "1", d: "2020.03", p: "13800000000", n: "张三", b: true })).toEqual({
      g: "<digits:1>",
      d: "<format:9999.99>",
      p: "<format:99999999999>",
      n: "<string:2>",
      b: "<boolean:true>",
    });
  });
});

describe("maskPath", () => {
  it("路径中的长数字与长随机串替换为 {id}，查询串单独返回", () => {
    const masked = maskPath("https://cv.zhipin.com/wapi/resume/123456789/detail/AbCdEfGhIjKlMnOpQrStUvWx.json?a=1");
    expect(masked?.path).toBe("https://cv.zhipin.com/wapi/resume/{id}/detail/{id}.json");
    expect(masked?.query).toEqual({ a: "1" });
  });
});

describe("parseRequestBody", () => {
  it("urlencoded 表单按字段拆开，值为 JSON 的展开，同名键合并为数组", () => {
    const parsed = parseRequestBody({ kind: "text", text: "data=%7B%22name%22%3A%22x%22%7D&tag=a&tag=b" }, "application/x-www-form-urlencoded");
    expect(parsed).toEqual({ kind: "form", value: { data: { name: "x" }, tag: ["a", "b"] } });
  });

  it("FormData 条目与 JSON 文本", () => {
    expect(parseRequestBody({ kind: "entries", entries: [["k", "v"]] })).toEqual({ kind: "form", value: { k: "v" } });
    expect(parseRequestBody({ kind: "text", text: "[1,2]" })).toEqual({ kind: "json", value: [1, 2] });
    expect(parseRequestBody({ kind: "binary" })).toEqual({ kind: "binary", value: null });
  });
});

describe("sanitizeRecord", () => {
  it("只保留结构：不含姓名、手机号、ID 与令牌值", () => {
    const record = sanitizeRecord(raw(), STARTED);
    expect(record).toBeDefined();
    const text = JSON.stringify(record);
    for (const secret of ["张三", "13800000000", "示例公司", "12345678901", "98765432101", "我的简历"]) expect(text).not.toContain(secret);

    expect(record).toMatchObject({
      offsetMs: 1500,
      method: "POST",
      path: "https://cv.zhipin.com/wapi/zpcvresume/myresume/save.json",
      query: { resumeId: "<format:99999999999>", _: "<format:9999999999999>" },
      headerNames: ["content-type", "x-requested-with", "zp_token"],
      bodyKind: "json",
      requestBody: { name: "<string:2>", gender: "<integer:1>", birthday: "<format:9999.99>", works: ["<array:1>", { company: "<string:4>" }] },
      responseCode: 0,
      responseMessage: "<string:7>",
      responseBody: { code: "<integer:0>", message: "<string:7>", zpData: { resumeId: "<integer>", title: "<string:4>" } },
    });
  });

  it("保留错误码与提示，用于识别份数已满等失败", () => {
    const record = sanitizeRecord(raw({ responseText: JSON.stringify({ code: 1001, message: "简历数量已达上限" }) }), STARTED);
    expect(record).toMatchObject({ responseCode: 1001, responseMessage: "<string:8>" });
    expect(JSON.stringify(record)).not.toContain("简历数量已达上限");
  });

  it("非 zhipin.com 的请求与非法 URL 丢弃，非 JSON 响应只留长度", () => {
    expect(sanitizeRecord(raw({ url: "https://evil.example.com/wapi/x" }), STARTED)).toBeUndefined();
    expect(sanitizeRecord(raw({ url: "not a url" }), STARTED)).toBeUndefined();
    expect(sanitizeRecord(raw({ responseText: "<html>" }), STARTED)?.responseBody).toBe("<non-json:6>");
  });
});

describe("isRawRequestRecord", () => {
  it("拒绝来自网页的畸形消息", () => {
    expect(isRawRequestRecord(raw())).toBe(true);
    expect(isRawRequestRecord({ ...raw(), headerNames: [1] })).toBe(false);
    expect(isRawRequestRecord({ ...raw(), requestBody: { kind: "entries", entries: [["a"]] } })).toBe(false);
    expect(isRawRequestRecord(null)).toBe(false);
  });
});
