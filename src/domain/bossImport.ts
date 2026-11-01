import { createBlankResume, type ResumeFactoryOptions } from "./factories";
import type { BossRemoteSnapshot, BossResumeDocument } from "./types";

/** 简历中可由 BOSS 数据填充的业务字段，不含本地元数据。 */
export type BossResumeContent = Pick<
  BossResumeDocument,
  | "profile"
  | "advantage"
  | "jobIntent"
  | "workExperiences"
  | "projects"
  | "educations"
  | "professionalSkills"
  | "customModules"
  | "certificates"
  | "socialProfiles"
  | "volunteerExperiences"
  | "jobSearchStatus"
  | "sectionOrder"
>;

export interface BossImportGroupSummary {
  label: string;
  count: number;
}

export interface BossImportReport {
  fetchedAt: string;
  readGroups: BossImportGroupSummary[];
  missingGroups: string[];
  warnings: string[];
}

export interface BossImportResult {
  /** 直聘简历里的简历名称，新建本地简历时用作标题。 */
  cvName: string;
  /** 直聘简历的样式模板 ID。 */
  templateId?: string;
  content: BossResumeContent;
  unmappedFields?: Record<string, unknown>;
  remoteSnapshot: BossRemoteSnapshot;
  report: BossImportReport;
}

/** 用一次直聘简历读取结果新建本地简历。 */
export function createResumeFromBossImport(
  result: BossImportResult,
  options: ResumeFactoryOptions = {},
): BossResumeDocument {
  const base = createBlankResume({ now: result.report.fetchedAt, ...options });
  return {
    ...base,
    ...structuredClone(result.content),
    title: result.cvName,
    source: "boss-import",
    lastBossFetchedAt: result.report.fetchedAt,
    syncState: "synced",
    bossCvId: result.remoteSnapshot.cvId,
    bossTemplateId: result.templateId,
    remoteSnapshot: structuredClone(result.remoteSnapshot),
    unmappedFields: result.unmappedFields ? structuredClone(result.unmappedFields) : undefined,
  };
}

/** 用直聘简历数据刷新已绑定简历的业务字段（只改本地），保留本地 ID、名称、来源和上传记录。 */
export function refreshResumeFromBossImport(
  target: BossResumeDocument,
  result: BossImportResult,
  now: Date | string = new Date(),
): BossResumeDocument {
  return {
    ...structuredClone(target),
    ...structuredClone(result.content),
    updatedAt: typeof now === "string" ? now : now.toISOString(),
    lastBossFetchedAt: result.report.fetchedAt,
    syncState: "synced",
    bossCvId: result.remoteSnapshot.cvId,
    bossTemplateId: result.templateId ?? target.bossTemplateId,
    remoteSnapshot: structuredClone(result.remoteSnapshot),
    unmappedFields: result.unmappedFields ? structuredClone(result.unmappedFields) : undefined,
  };
}
