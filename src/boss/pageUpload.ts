import type { CvApi, CvApiError } from "./cvPageApi";
import type { BossUploadErrorCode, BossUploadResult, UploadMonth, UploadPlan, UploadText } from "./uploadPlan";

/**
 * 在 cv.zhipin.com 页面主世界中执行（chrome.scripting.executeScript, world: "MAIN"），按计划填写一份直聘简历：
 * plan.cvId 对应的简历还在就覆盖它，否则新建一份。
 *
 * - 函数会被序列化后注入页面，不能引用模块作用域内的任何变量或导入（类型除外）。
 * - 须先注入 cvPageApi.installCvApiInPage，请求格式与请求头都在那里。
 * - 依据：querylist / query / updatecvname /
 *   profile、advantage、workexp、projectexp、eduexp 的 save 均来自 2026-10-28 的真实录制；
 *   新建用 syncfrombosszp（参数 templateId，直聘前端「按样式模板新建」的同一接口）、
 *   新增条目（id 为空）与各模块的 delete.json 来自直聘简历前端包，未经录制，最后用 query.json 回读核对。
 * - 不重试；任何一步失败立即停止并返回已新建的 cvId，方便用户去直聘简历里处理。
 */
export async function uploadResumeInPage(plan: UploadPlan): Promise<BossUploadResult> {
  type Raw = Record<string, unknown>;
  interface StepError {
    uploadError: true;
    code: BossUploadErrorCode;
    message: string;
    detail?: string;
  }

  const DEFAULT_TEMPLATE_ID = "7d133318365793281g~~";
  const WRITE_GAP_MS = 300;
  const warnings: string[] = [];
  warnings.push(...plan.notes, ...plan.notUploaded.map((item) => `未自动上传：${item}`));
  let cvId: string | undefined;
  let created = false;
  let templateId = DEFAULT_TEMPLATE_ID;
  let step = "";

  const editUrlOf = (id: string) =>
    `${location.origin}/edit-resume?cvId=${encodeURIComponent(id)}&templateId=${encodeURIComponent(templateId)}`;
  const stepError = (code: BossUploadErrorCode, message: string, detail?: string): StepError => ({ uploadError: true, code, message, detail });
  const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // 请求工具由 cvPageApi.installCvApiInPage 先装到页面上（读取与上传共用）。
  const api = (window as unknown as Raw)["__bossResumeCvApi__"] as CvApi | undefined;
  const call: CvApi["call"] = async (method, path, params) => {
    if (!api) throw stepError("UNEXPECTED_RESPONSE", "直聘简历页没有装上请求工具，请重新加载扩展后重试");
    try {
      return await api.call(method, path, params);
    } catch (error) {
      if (isRecord(error) && error.cvApiError === true) {
        const known = error as unknown as CvApiError;
        throw stepError(known.code, known.message, known.detail);
      }
      throw error;
    }
  };

  /**
   * 直聘简历原有的模块顺序 + 本地的个人优势 / 工作经历 / 项目经历 / 教育经历顺序 → profile/save.json 的 sort。
   * 只在这几个模块原来所占的位置之间换序，基本信息等其他模块留在原位；原来没有的补在末尾。
   */
  const sortOf = (raw: unknown): string => {
    const codes = plan.sectionCodes;
    const base = Array.isArray(raw) ? raw.map(Number).filter((code) => code > 0) : [];
    const unique = base.filter((code, index) => base.indexOf(code) === index);
    if (!unique.length) unique.push(1001);
    for (const code of codes) if (!unique.includes(code)) unique.push(code);
    let next = 0;
    return unique.map((code) => (codes.includes(code) ? codes[next++] : code)).join(",");
  };

  const write = async (path: string, params: Raw): Promise<unknown> => {
    const data = await call("POST", path, { cvId, templateId, ...params });
    await sleep(WRITE_GAP_MS);
    return data;
  };

  // ---------- 字典：名称 → 编码 ----------

  interface DictEntry {
    code: number;
    name: string;
    parentCode: number;
  }
  const flatten = (nodes: unknown, parentCode = 0, out: DictEntry[] = [], leavesOnly = false): DictEntry[] => {
    if (!Array.isArray(nodes)) return out;
    for (const node of nodes) {
      if (!isRecord(node) || typeof node.code !== "number" || typeof node.name !== "string") continue;
      const children = node.subLevelModelList;
      const isLeaf = !Array.isArray(children) || children.length === 0;
      if (!leavesOnly || isLeaf) out.push({ code: node.code, name: node.name, parentCode });
      flatten(children, node.code, out, leavesOnly);
    }
    return out;
  };
  const normalizeName = (name: string) => name.replace(/\s+/g, "").replace(/(市|省|自治区|特别行政区)$/, "").toLowerCase();
  const lookup = (entries: DictEntry[], name: string): DictEntry | undefined => {
    const target = normalizeName(name);
    return entries.find((entry) => entry.name === name) ?? entries.find((entry) => normalizeName(entry.name) === target);
  };

  let positions: DictEntry[] | undefined;
  const positionOf = async (name: string): Promise<DictEntry | undefined> => {
    if (!positions) {
      try {
        positions = flatten(await call("GET", "/wapi/zpCommon/data/position.json"), 0, [], true);
      } catch {
        positions = [];
        warnings.push("职位字典读取失败，职位只按文字上传");
      }
    }
    return lookup(positions, name);
  };

  // ---------- 字段转换 ----------

  const text = (value: UploadText, key: string): Raw => ({ [key]: value.text, [`${key}RichText`]: value.html });
  const monthFields = (start: UploadMonth | undefined, end: UploadMonth | undefined, current: boolean): Raw => ({
    startDate: start ? start.compact : -1,
    startDateStr: start ? start.dot : "",
    endDate: current ? 0 : end ? end.compact : -1,
    endDateStr: current ? "至今" : end ? end.dash : "",
    isToday: current,
  });
  const yearsSince = (month: UploadMonth | undefined): number | undefined => {
    if (!month) return undefined;
    const now = new Date();
    const [year, mon] = [Number(month.compact.slice(0, 4)), Number(month.compact.slice(4))];
    return now.getFullYear() - year - (now.getMonth() + 1 < mon ? 1 : 0);
  };

  /** 用模板自带条目的 id 覆盖前几条，不够的新增（id 为空），多出的删除。 */
  const syncList = async (
    label: string,
    existing: unknown,
    savePath: string,
    deletePath: string,
    items: Raw[],
  ): Promise<void> => {
    const ids = (Array.isArray(existing) ? existing : []).map((item) => (isRecord(item) && typeof item.id === "string" ? item.id : "")).filter(Boolean);
    for (let index = 0; index < items.length; index += 1) {
      step = `保存${label} ${index + 1}/${items.length}`;
      await write(savePath, { ...items[index], id: ids[index] ?? "", expanded: true, newExpanded: true });
    }
    for (let index = items.length; index < ids.length; index += 1) {
      step = `删除多余的${label}`;
      await write(deletePath, { id: ids[index] });
    }
  };

  try {
    step = "读取直聘简历列表";
    const list = await call("GET", "/wapi/zpcvresume/myresume/querylist.json");
    const existing = isRecord(list) && Array.isArray(list.myresumelist) ? list.myresumelist.filter(isRecord) : [];
    const boundId = plan.cvId;
    const bound = boundId ? existing.find((item) => item.id === boundId) : undefined;
    if (plan.cvId && !bound) warnings.push("直聘简历里已经找不到原来那份简历，改为新建一份");

    if (bound) {
      // 覆盖已有简历：沿用它的样式模板，下面各模块逐个覆盖、多出的条目删除。
      cvId = boundId as string;
      if (typeof bound.templateId === "string" && bound.templateId) templateId = bound.templateId;
    } else {
      const count = isRecord(list) && Array.isArray(list.myresumelist) ? list.myresumelist.length : 0;
      if (isRecord(list) && typeof list.maxCount === "number" && count >= list.maxCount) {
        throw stepError("RESUME_FULL", `直聘简历已有 ${count} 份，达到上限 ${list.maxCount} 份。请先在直聘简历里删除一份再上传。`);
      }

      // 样式模板优先沿用本地简历记下的（从直聘简历拉取时的那份），其次最近编辑过的直聘简历，最后直聘默认模板。
      step = "选择样式模板";
      const latest = existing
        .filter((item) => typeof item.templateId === "string" && item.templateId)
        .sort((a, b) => (Number(b.updateTime) || 0) - (Number(a.updateTime) || 0))[0];
      if (plan.templateId) templateId = plan.templateId;
      else if (latest) templateId = latest.templateId as string;

      step = "新建简历";
      // 直聘前端「按样式模板新建」走的就是这个接口：内容取自 BOSS 在线简历，下面各模块再逐个覆盖。
      const made = await call("POST", "/wapi/zpcvresume/myresume/syncfrombosszp.json", { templateId });
      if (!isRecord(made) || typeof made.cvId !== "string" || !made.cvId) throw stepError("UNEXPECTED_RESPONSE", "新建简历没有返回 cvId");
      cvId = made.cvId;
      created = true;
      await sleep(WRITE_GAP_MS);
    }

    step = "读取简历";
    const detail = await call("POST", "/wapi/zpcvresume/myresume/query.json", { cvId });
    if (!isRecord(detail) || !isRecord(detail.profileVO)) throw stepError("UNEXPECTED_RESPONSE", "读取简历失败：缺少 profileVO");
    const vo = detail.profileVO;
    if (typeof vo.templateId === "string" && vo.templateId) templateId = vo.templateId;

    step = "修改简历名称";
    await write("/wapi/zpcvresume/myresume/updatecvname.json", { cvName: plan.cvName });

    step = "保存基本信息";
    const profile = plan.profile;
    let place = { code: vo.location, parentCode: vo.locationLv1, name: vo.locationName };
    if (profile.cityName) {
      try {
        const cityData = await call("GET", "/wapi/zpcvresume/common/config/city.json");
        // 只在市级（叶子）里找：直辖市的省级和市级同名，省级码不是有效的期望城市。
        const city = lookup(flatten(isRecord(cityData) ? cityData.cityList : undefined, 0, [], true), profile.cityName);
        if (city) place = { code: city.code, parentCode: city.parentCode || city.code, name: city.name };
        else warnings.push(`城市“${profile.cityName}”不在直聘简历的城市列表里，保留了 BOSS 默认城市“${String(vo.locationName ?? "")}”`);
      } catch {
        warnings.push("城市字典读取失败，保留了 BOSS 默认城市");
      }
    }
    let position = { code: 0, name: "" };
    if (profile.positionName) {
      const hit = await positionOf(profile.positionName);
      if (hit) position = { code: hit.code, name: hit.name };
      else warnings.push(`期望职位“${profile.positionName}”不在直聘简历的职位列表里，没有上传`);
    }
    const age = yearsSince(profile.birthday);
    const workYears = yearsSince(profile.workDate);
    await write("/wapi/zpcvresume/profile/save.json", {
      name: profile.name,
      gender: profile.gender,
      birthday: profile.birthday?.compact ?? "",
      newBirthday: profile.birthday?.dash ?? "",
      age: age !== undefined ? `${age}岁` : vo.age,
      workDate: profile.workDate?.compact ?? "",
      workDateDesc: workYears !== undefined && workYears >= 1 ? `${workYears}年` : vo.workDateDesc,
      location: place.code,
      locationLv1: place.parentCode,
      locationName: place.name,
      position: position.code,
      positionName: position.name,
      lowSalary: profile.lowSalary,
      highSalary: profile.highSalary,
      // 本地档案没有以下字段，沿用 BOSS 新建时填好的值。
      phone: vo.phone,
      email: vo.email,
      wechat: vo.wechat,
      avatar: vo.avatar,
      baseAvatar: vo.baseAvatar,
      applyStatus: vo.applyStatus,
      templateAvatarStyle: vo.templateAvatarStyle,
      nativePlace: vo.nativePlace ?? 0,
      nativePlaceName: vo.nativePlaceName ?? "",
      politicalStatus: vo.politicalStatus || "",
      politicalStatusName: vo.politicalStatusName ?? "",
      sort: sortOf(vo.sort),
      usedItemTypes: Array.isArray(vo.usedItemTypes) ? vo.usedItemTypes : [],
    });

    step = "保存个人优势";
    await write("/wapi/zpcvresume/advantage/save.json", { content: plan.advantage.text, contentRichText: plan.advantage.html });

    step = "保存专业技能";
    await write("/wapi/zpcvresume/skills/save.json", { content: plan.professionalSkills.text, contentRichText: plan.professionalSkills.html });

    const works: Raw[] = [];
    for (const work of plan.works) {
      const hit = work.positionName ? await positionOf(work.positionName) : undefined;
      if (work.positionName && !hit) warnings.push(`工作经历“${work.company}”的职位“${work.positionName}”不在职位列表里，只按文字上传`);
      works.push({
        company: work.company,
        position: hit?.code ?? 0,
        positionName: hit?.name ?? work.positionName,
        ...monthFields(work.start, work.end, work.current),
        ...text(work.responsibility, "responsibility"),
        ...text(work.performance, "workPerformance"),
      });
    }
    await syncList("工作经历", detail.workExpVOList, "/wapi/zpcvresume/workexp/save.json", "/wapi/zpcvresume/workexp/delete.json", works);

    await syncList(
      "项目经历",
      detail.projectExpVOList,
      "/wapi/zpcvresume/projectexp/save.json",
      "/wapi/zpcvresume/projectexp/delete.json",
      plan.projects.map((project) => ({
        name: project.name,
        roleName: project.roleName,
        ...monthFields(project.start, project.end, project.current),
        ...text(project.description, "description"),
        ...text(project.performance, "performance"),
      })),
    );

    await syncList(
      "教育经历",
      detail.eduExpVOList,
      "/wapi/zpcvresume/eduexp/save.json",
      "/wapi/zpcvresume/eduexp/delete.json",
      plan.educations.map((education) => ({
        school: education.school,
        major: education.major,
        degree: education.degree,
        majorRanking: 0,
        courseList: "",
        isToday: education.current,
        startYear: education.startYear ?? -1,
        startYearStr: education.startYear ? String(education.startYear) : "",
        endYear: education.endYear ?? -1,
        endYearStr: education.endYear ? String(education.endYear) : "",
        yearScope: education.startYear && education.endYear ? [education.startYear, education.endYear] : [],
        ...text(education.description, "description"),
      })),
    );

    step = "回读核对";
    const final = await call("POST", "/wapi/zpcvresume/myresume/query.json", { cvId });
    const length = (value: unknown) => (Array.isArray(value) ? value.length : 0);
    if (isRecord(final)) {
      const checks: Array<[string, unknown, number]> = [
        ["工作经历", final.workExpVOList, plan.works.length],
        ["项目经历", final.projectExpVOList, plan.projects.length],
        ["教育经历", final.eduExpVOList, plan.educations.length],
      ];
      for (const [label, actual, expected] of checks) {
        if (length(actual) !== expected) warnings.push(`${label}：本地 ${expected} 条，BOSS 上是 ${length(actual)} 条，请到直聘简历里核对`);
      }
      const plain = (value: unknown) => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
      if (plain(final.skills) !== plain(plan.professionalSkills.text)) warnings.push("专业技能：BOSS 回读内容与本地不一致，请到直聘简历里核对");
      if (isRecord(final.profileVO) && final.profileVO.name !== plan.profile.name) warnings.push("BOSS 上的姓名与本地不一致，请到直聘简历里核对");
    }

    return { ok: true, cvId, editUrl: editUrlOf(cvId), created, warnings };
  } catch (error) {
    const known = isRecord(error) && (error as { uploadError?: unknown }).uploadError === true ? (error as unknown as StepError) : undefined;
    return {
      ok: false,
      error: {
        code: known?.code ?? "UNEXPECTED_RESPONSE",
        message: known?.message ?? "上传过程中出现意外错误",
        step,
        detail: known?.detail ?? (error instanceof Error ? error.message : String(error)),
      },
      cvId,
      editUrl: cvId ? editUrlOf(cvId) : undefined,
      created,
      warnings,
    };
  }
}
