import type { BossResumeDocument } from "./types";

export interface ResumeFactoryOptions {
  now?: Date | string;
  createId?: () => string;
}

function toIsoString(now: Date | string | undefined): string {
  if (now === undefined) {
    return new Date().toISOString();
  }

  return typeof now === "string" ? now : now.toISOString();
}

function createLocalId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `resume-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function deepClone<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

/** 创建一份未绑定 BOSS 的完整空白简历。 */
export function createBlankResume(options: ResumeFactoryOptions = {}): BossResumeDocument {
  const now = toIsoString(options.now);
  const localId = (options.createId ?? createLocalId)();

  return {
    localId,
    title: "未命名简历",
    source: "manual",
    createdAt: now,
    updatedAt: now,
    syncState: "unbound",
    profile: { name: "" },
    advantage: "",
    jobIntent: { cities: [], positions: [], industries: [] },
    workExperiences: [],
    projects: [],
    educations: [],
    professionalSkills: [],
    customModules: [],
    certificates: [],
    socialProfiles: [],
    volunteerExperiences: [],
    jobSearchStatus: {},
  };
}

/** 深拷贝简历，并清除所有 BOSS 绑定与远程版本信息。 */
export function copyResume(
  source: BossResumeDocument,
  options: ResumeFactoryOptions = {},
): BossResumeDocument {
  const copy = deepClone(source);
  const now = toIsoString(options.now);

  copy.localId = (options.createId ?? createLocalId)();
  copy.title = `${source.title}副本`;
  copy.source = "copy";
  copy.createdAt = now;
  copy.updatedAt = now;
  delete copy.lastBossFetchedAt;
  delete copy.lastBossUploadedAt;
  // 副本不再绑定原直聘简历，但沿用它的样式模板。
  delete copy.bossCvId;
  copy.syncState = "unbound";
  delete copy.remoteSnapshot;

  return copy;
}
