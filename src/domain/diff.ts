import type { BossResumeDocument } from "./types";

export type ResumeDiffKind = "added" | "removed" | "changed";

export interface ResumeFieldDiff {
  path: string;
  kind: ResumeDiffKind;
  before?: unknown;
  after?: unknown;
}

type ComparableDocument = Pick<
  BossResumeDocument,
  | "title"
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
  | "unmappedFields"
>;

const DIFF_FIELDS: Array<keyof ComparableDocument> = [
  "title",
  "profile",
  "advantage",
  "jobIntent",
  "workExperiences",
  "projects",
  "educations",
  "professionalSkills",
  "customModules",
  "certificates",
  "socialProfiles",
  "volunteerExperiences",
  "jobSearchStatus",
  "unmappedFields",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return Object.is(left, right);
}

function diffValue(
  before: unknown,
  after: unknown,
  path: string,
  differences: ResumeFieldDiff[],
): void {
  if (sameValue(before, after)) {
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    diffArray(before, after, path, differences);
    return;
  }

  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      const childPath = path ? `${path}.${key}` : key;
      diffValue(before[key], after[key], childPath, differences);
    }
    return;
  }

  if (before === undefined) {
    differences.push({ path, kind: "added", after });
    return;
  }

  if (after === undefined) {
    differences.push({ path, kind: "removed", before });
    return;
  }

  differences.push({ path, kind: "changed", before, after });
}

function diffArray(
  before: unknown[],
  after: unknown[],
  path: string,
  differences: ResumeFieldDiff[],
): void {
  const canMatchById = [...before, ...after].every(
    (item) => isRecord(item) && typeof item.localId === "string",
  );

  if (!canMatchById) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      diffValue(before[index], after[index], `${path}[${index}]`, differences);
    }
    return;
  }

  const beforeById = new Map(before.map((item) => [(item as { localId: string }).localId, item]));
  const afterById = new Map(after.map((item) => [(item as { localId: string }).localId, item]));
  const ids = new Set([...beforeById.keys(), ...afterById.keys()]);

  for (const localId of [...ids].sort()) {
    diffValue(beforeById.get(localId), afterById.get(localId), `${path}[${localId}]`, differences);
  }
}

/** 仅比较可编辑内容和本地保留字段，忽略 ID、时间戳、同步状态及远程快照。 */
export function diffResumes(
  before: BossResumeDocument,
  after: BossResumeDocument,
): ResumeFieldDiff[] {
  const differences: ResumeFieldDiff[] = [];

  for (const field of DIFF_FIELDS) {
    diffValue(before[field], after[field], field, differences);
  }

  return differences;
}
