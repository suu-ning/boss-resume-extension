<script setup lang="ts">
import { computed } from "vue";
import type { BossResumeDocument } from "../domain/types";
import { normalizeSectionOrder, type SectionId } from "../editor/sections";

const props = defineProps<{ resume: BossResumeDocument }>();
const emit = defineEmits<{ edit: [section: SectionId] }>();

/** 个人优势 / 工作经历 / 项目经历 / 教育经历按左侧菜单的顺序显示。 */
const order = computed(() => normalizeSectionOrder(props.resume.sectionOrder));

const GENDER: Record<string, string> = { male: "男", female: "女" };

/** YYYY-MM(-DD) → YYYY.MM */
function month(value?: string): string {
  return value ? value.slice(0, 7).replace("-", ".") : "";
}

function range(start?: string, end?: string, current?: boolean): string {
  const from = month(start);
  const to = current ? "至今" : month(end);
  if (!from && !to) return "";
  return `${from || "—"} – ${to || "—"}`;
}

/** 距今整年数；日期无效返回 undefined。 */
function yearsSince(value?: string): number | undefined {
  const [year, mon] = (value ?? "").split("-").map(Number);
  if (!year) return undefined;
  const now = new Date();
  const months = (now.getFullYear() - year) * 12 + (now.getMonth() + 1 - (mon || 1));
  return months >= 0 ? Math.floor(months / 12) : undefined;
}

function filled(...values: Array<string | undefined>): string[] {
  return values.map((value) => value?.trim() ?? "").filter(Boolean);
}

const initial = computed(() => props.resume.profile.name.trim().slice(0, 1) || "?");

const meta = computed(() => {
  const { profile } = props.resume;
  const workYears = yearsSince(profile.workStartDate);
  const age = yearsSince(profile.birthDate);
  return filled(
    profile.gender ? GENDER[profile.gender] : undefined,
    age !== undefined ? `${age} 岁` : undefined,
    workYears !== undefined ? (workYears >= 1 ? `${workYears} 年工作经验` : "1 年以内工作经验") : undefined,
    profile.jobIdentity,
  );
});

const intent = computed(() => {
  const { jobIntent } = props.resume;
  return filled(
    jobIntent.positions.join("、"),
    jobIntent.cities.join("、"),
    jobIntent.salary,
    jobIntent.jobType,
    jobIntent.industries.join("、"),
  );
});

const status = computed(() => {
  const { jobSearchStatus: s } = props.resume;
  return filled(s.status, s.availableDate && `可到岗：${s.availableDate}`, s.preferredContactTime && `联系时间：${s.preferredContactTime}`);
});

function rawText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(rawText).filter(Boolean).join("、");
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => {
        const text = rawText(item);
        return text ? `${key}：${text}` : "";
      })
      .filter(Boolean)
      .join("；");
  }
  return "";
}

const isEmpty = computed(() => {
  const r = props.resume;
  return !r.advantage.trim() && !r.workExperiences.length && !r.projects.length && !r.educations.length
    && !(r.professionalSkills ?? []).length && !(r.customModules ?? []).length
    && !r.certificates.length && !r.socialProfiles.length && !r.volunteerExperiences.length;
});
</script>

<template>
  <article class="rp-page" aria-label="简历预览">
    <template v-for="section in order" :key="section">
    <header v-if="section === 'profile'" class="rp-header">
      <img v-if="resume.profile.avatar" class="rp-avatar" :src="resume.profile.avatar" alt="" />
      <div v-else class="rp-avatar rp-avatar--empty" aria-hidden="true">{{ initial }}</div>
      <div class="rp-identity">
        <h1>{{ resume.profile.name || "未填写姓名" }}</h1>
        <p v-if="meta.length" class="rp-meta"><span v-for="item in meta" :key="item">{{ item }}</span></p>
        <p v-if="intent.length" class="rp-intent"><strong>求职意向</strong><span v-for="item in intent" :key="item">{{ item }}</span></p>
      </div>
      <button class="rp-edit" type="button" @click="emit('edit', 'profile')">编辑</button>
    </header>

    <section v-if="section === 'advantage' && resume.advantage.trim()" class="rp-section">
      <h2>个人优势<button class="rp-edit" type="button" @click="emit('edit', 'advantage')">编辑</button></h2>
      <p class="rp-text">{{ resume.advantage }}</p>
    </section>

    <section v-else-if="section === 'work' && resume.workExperiences.length" class="rp-section">
      <h2>工作经历<button class="rp-edit" type="button" @click="emit('edit', 'work')">编辑</button></h2>
      <div v-for="item in resume.workExperiences" :key="item.localId" class="rp-item">
        <div class="rp-item__head"><strong>{{ item.companyName || "未填写公司" }}</strong><time>{{ range(item.startDate, item.endDate, item.isCurrent) }}</time></div>
        <p v-if="filled(item.positionName, item.department, item.industry).length" class="rp-item__sub">{{ filled(item.positionName, item.department, item.industry).join(" · ") }}</p>
        <p v-if="item.responsibilities" class="rp-text">{{ item.responsibilities }}</p>
        <p v-if="item.achievements" class="rp-text"><b class="rp-label">工作成果</b>{{ item.achievements }}</p>
        <p v-if="item.skills.length" class="rp-tags"><span v-for="skill in item.skills" :key="skill">{{ skill }}</span></p>
      </div>
    </section>

    <section v-else-if="section === 'projects' && resume.projects.length" class="rp-section">
      <h2>项目经历<button class="rp-edit" type="button" @click="emit('edit', 'projects')">编辑</button></h2>
      <div v-for="item in resume.projects" :key="item.localId" class="rp-item">
        <div class="rp-item__head"><strong>{{ item.projectName || "未填写项目" }}</strong><time>{{ range(item.startDate, item.endDate, item.isCurrent) }}</time></div>
        <p v-if="item.role || item.link" class="rp-item__sub">{{ item.role }}<a v-if="item.link" :href="item.link" target="_blank" rel="noopener noreferrer">{{ item.link }}</a></p>
        <p v-if="item.description" class="rp-text">{{ item.description }}</p>
        <p v-if="item.achievements" class="rp-text"><b class="rp-label">项目成果</b>{{ item.achievements }}</p>
      </div>
    </section>

    <section v-else-if="section === 'education' && resume.educations.length" class="rp-section">
      <h2>教育经历<button class="rp-edit" type="button" @click="emit('edit', 'education')">编辑</button></h2>
      <div v-for="item in resume.educations" :key="item.localId" class="rp-item">
        <div class="rp-item__head"><strong>{{ item.schoolName || "未填写学校" }}</strong><time>{{ range(item.startDate, item.endDate, item.isCurrent) }}</time></div>
        <p v-if="filled(item.major, item.degree).length" class="rp-item__sub">{{ filled(item.major, item.degree).join(" · ") }}</p>
        <p v-if="item.campusExperience" class="rp-text">{{ item.campusExperience }}</p>
        <p v-if="item.thesis" class="rp-text"><b class="rp-label">论文 / 研究课题</b>{{ item.thesis }}</p>
      </div>
    </section>

    <section v-else-if="section === 'professionalSkills' && resume.professionalSkills?.length" class="rp-section">
      <h2>专业技能<button class="rp-edit" type="button" @click="emit('edit', 'professionalSkills')">编辑</button></h2>
      <ul class="rp-skill-list"><li v-for="(skill, index) in resume.professionalSkills" :key="index">{{ skill }}</li></ul>
    </section>

    <section v-else-if="section === 'customModules' && resume.customModules?.length" class="rp-custom-group">
      <section v-for="module in resume.customModules" :key="module.key" class="rp-section">
        <h2>{{ module.title }}<button class="rp-edit" type="button" @click="emit('edit', 'customModules')">编辑</button></h2>
        <p v-for="(item, index) in module.items" :key="index" class="rp-text">{{ rawText(item) }}</p>
      </section>
    </section>
    </template>


    <section v-if="resume.certificates.length" class="rp-section">
      <h2>资格证书</h2>
      <div v-for="item in resume.certificates" :key="item.localId" class="rp-item">
        <div class="rp-item__head"><strong>{{ item.name || "未填写证书" }}</strong><time>{{ range(item.issueDate, item.expiryDate) }}</time></div>
        <p v-if="filled(item.issuer, item.credentialId).length" class="rp-item__sub">{{ filled(item.issuer, item.credentialId).join(" · ") }}</p>
        <p v-if="item.description" class="rp-text">{{ item.description }}</p>
      </div>
    </section>

    <section v-if="resume.socialProfiles.length" class="rp-section">
      <h2>社交主页</h2>
      <ul class="rp-links">
        <li v-for="item in resume.socialProfiles" :key="item.localId"><b>{{ item.label || item.platform }}</b><a :href="item.url" target="_blank" rel="noopener noreferrer">{{ item.url }}</a></li>
      </ul>
    </section>

    <section v-if="resume.volunteerExperiences.length" class="rp-section">
      <h2>志愿者服务</h2>
      <div v-for="item in resume.volunteerExperiences" :key="item.localId" class="rp-item">
        <div class="rp-item__head"><strong>{{ item.organizationName || "未填写组织" }}</strong><time>{{ range(item.startDate, item.endDate) }}</time></div>
        <p v-if="item.role" class="rp-item__sub">{{ item.role }}</p>
        <p v-if="item.description" class="rp-text">{{ item.description }}</p>
      </div>
    </section>

    <section v-if="status.length" class="rp-section">
      <h2>求职状态</h2>
      <p class="rp-item__sub">{{ status.join(" · ") }}</p>
    </section>

    <p v-if="isEmpty" class="rp-empty">还没有可预览的经历内容，切回编辑补充后再看。</p>
  </article>
</template>
