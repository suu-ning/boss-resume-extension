<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { readOnlineDicts, readOnlineResume, writeOnlineResume } from "../boss/client";
import { buildOnlineWritePlan } from "../boss/online/execute";
import { buildOnlineSyncPlan } from "../boss/online/plan";
import {
  ALL_ONLINE_MODULES,
  DEFAULT_ONLINE_SYNC_OPTIONS,
  resolveOnlineSyncOptions,
  type OnlineModuleId,
  type OnlineOperation,
  type OnlineResume,
  type OnlineSyncPlan,
  type OnlineWriteResult,
} from "../boss/online/types";
import type { BossFetchError } from "../boss/types";
import type { BossResumeDocument, OnlineSyncOptions } from "../domain/types";

const props = defineProps<{ resume: BossResumeDocument }>();
const emit = defineEmits<{
  close: [];
  snapshot: [payload: { fetchedAt: string; raw: Record<string, unknown>; options: OnlineSyncOptions }];
}>();

const loading = ref(false);
const error = ref<BossFetchError>();
const remote = ref<OnlineResume>();
const raw = ref<Record<string, unknown>>();
const options = ref<OnlineSyncOptions>(resolveOnlineSyncOptions(props.resume.onlineSyncOptions ?? DEFAULT_ONLINE_SYNC_OPTIONS));

/** 计划是纯函数算出来的，开关一变就重算，不用重新读线上。 */
const plan = computed<OnlineSyncPlan | undefined>(() => {
  if (!remote.value) return undefined;
  // 传进去的必须是普通对象：Vue 的响应式代理在 structuredClone/展开时会出问题。
  return buildOnlineSyncPlan(JSON.parse(JSON.stringify(props.resume)) as BossResumeDocument, remote.value, options.value);
});

const pickedIds = computed<OnlineModuleId[]>(() => options.value.modules ?? [...ALL_ONLINE_MODULES]);
const pickedCount = computed(() => pickedIds.value.length);
const allPicked = computed(() => pickedCount.value === ALL_ONLINE_MODULES.length);

const hasChanges = (module: OnlineSyncPlan["modules"][number]): boolean =>
  module.counts.create + module.counts.update + module.counts.delete > 0 || module.fields.some((field) => field.changed);

const changedFields = (fields: OnlineSyncPlan["modules"][number]["fields"]) => fields.filter((field) => field.changed);

/** 选项一变就重算计划。落盘放到关闭弹窗时做，避免连点勾选产生一串并发写入。 */
function applyOptions(next: OnlineSyncOptions): void {
  options.value = next;
}

/** 关闭前把勾选结果和快照存回档案，下次打开沿用上次的选择。 */
function closeDialog(): void {
  if (remote.value && raw.value) {
    emit("snapshot", { fetchedAt: remote.value.fetchedAt, raw: raw.value, options: options.value });
  }
  emit("close");
}

function toggle(key: "syncIndustries", value: boolean): void {
  applyOptions({ ...options.value, [key]: value });
}

function toggleModule(id: OnlineModuleId, checked: boolean): void {
  const current = new Set(pickedIds.value);
  if (checked) current.add(id);
  else current.delete(id);
  applyOptions({ ...options.value, modules: ALL_ONLINE_MODULES.filter((entry) => current.has(entry)) });
}

function pickAll(): void {
  applyOptions({ ...options.value, modules: [...ALL_ONLINE_MODULES] });
}

function pickNone(): void {
  applyOptions({ ...options.value, modules: [] });
}

/** 只勾选当前存在差异的模块——这是最常用的一次操作。 */
function pickChanged(): void {
  const changed = plan.value?.modules.filter((module) => module.kind !== "unchanged").map((module) => module.id) ?? [];
  applyOptions({ ...options.value, modules: ALL_ONLINE_MODULES.filter((id) => changed.includes(id)) });
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = undefined;
  try {
    const outcome = await readOnlineResume();
    if (!outcome.ok) {
      error.value = outcome.error;
      return;
    }
    remote.value = outcome.resume;
    raw.value = outcome.raw;
    // 读到就落盘一份快照：既是下次对比的基线，也是以后写坏了的回滚依据。
    emit("snapshot", { fetchedAt: outcome.resume.fetchedAt, raw: outcome.raw, options: options.value });
  } catch (caught) {
    error.value = { code: "UNEXPECTED_RESPONSE", message: caught instanceof Error ? caught.message : String(caught) };
  } finally {
    loading.value = false;
  }
}

// ---------- 写入 ----------

const writing = ref(false);
/** 待确认的动作清单：点「同步写入」先把要做的事摊开，确认后才真的写。 */
const pending = ref<OnlineOperation[]>();
const pendingSkipped = ref<string[]>([]);
const pendingWarnings = ref<string[]>([]);
const writeError = ref<BossFetchError>();
const writeResult = ref<OnlineWriteResult>();
/** 写入后是否已经回读过：回读后 plan 会重算，剩下的差异就是残差。 */
const verified = ref(false);

const deletes = computed(() => (pending.value ?? []).filter((operation) => operation.action === "delete"));

/** 勾选模块里是否还有可执行的动作；为 0 时没必要写。 */
const actionable = computed(() => (plan.value ? plan.value.counts.create + plan.value.counts.update + plan.value.counts.delete : 0));
const canWrite = computed(
  () => Boolean(plan.value) && !loading.value && !writing.value && pickedCount.value > 0 && !plan.value?.blockers.length && actionable.value > 0,
);
const writeHint = computed(() => {
  if (!pickedCount.value) return "还没有勾选要同步的模块";
  if (plan.value?.blockers.length) return plan.value.blockers[0];
  if (!actionable.value) return "勾选的模块已经和线上一致，没有要写的内容";
  return "写入前会先列一遍要做的事，确认后才真正写入";
});

const residual = computed(() => (plan.value ? plan.value.counts.create + plan.value.counts.update + plan.value.counts.delete : 0));

/** 第一步：读字典 + 生成动作清单，摊开来让用户确认。 */
async function prepare(): Promise<void> {
  if (!plan.value || !raw.value) return;
  writing.value = true;
  writeError.value = undefined;
  writeResult.value = undefined;
  verified.value = false;
  try {
    const dicts = await readOnlineDicts();
    const built = buildOnlineWritePlan({
      resume: JSON.parse(JSON.stringify(props.resume)) as BossResumeDocument,
      remoteRaw: raw.value,
      plan: plan.value,
      options: options.value,
      dicts,
    });
    pending.value = built.operations;
    pendingSkipped.value = built.skipped;
    pendingWarnings.value = built.warnings;
    if (!built.operations.length) writeError.value = { code: "API_ERROR", message: "没有可以执行的写入动作" };
  } catch (caught) {
    writeError.value = { code: "UNEXPECTED_RESPONSE", message: caught instanceof Error ? caught.message : String(caught) };
  } finally {
    writing.value = false;
  }
}

/** 第二步：确认后逐条写入，写完立刻回读整份在线简历做残差校验。 */
async function commit(): Promise<void> {
  const operations = pending.value;
  if (!operations?.length) return;
  writing.value = true;
  pending.value = undefined;
  try {
    writeResult.value = await writeOnlineResume(operations);
    await verify();
  } catch (caught) {
    writeError.value = { code: "UNEXPECTED_RESPONSE", message: caught instanceof Error ? caught.message : String(caught) };
  } finally {
    writing.value = false;
  }
}

/** 回读：写入之后必须再读一遍，剩下多少差异就是这次没做到的部分，不能只凭接口返回就报成功。 */
async function verify(): Promise<void> {
  try {
    const outcome = await readOnlineResume();
    if (!outcome.ok) {
      writeError.value = outcome.error;
      return;
    }
    remote.value = outcome.resume;
    raw.value = outcome.raw;
    verified.value = true;
    emit("snapshot", { fetchedAt: outcome.resume.fetchedAt, raw: outcome.raw, options: options.value });
  } catch (caught) {
    writeError.value = { code: "UNEXPECTED_RESPONSE", message: caught instanceof Error ? caught.message : String(caught) };
  }
}

function dismissResult(): void {
  writeResult.value = undefined;
  writeError.value = undefined;
  pendingSkipped.value = [];
  pendingWarnings.value = [];
  verified.value = false;
}

onMounted(load);
</script>

<template>
  <div class="dialog-backdrop" @click.self="closeDialog">
    <section class="dialog sync-dialog" role="dialog" aria-modal="true" aria-labelledby="sync-title">
      <button class="dialog-close" type="button" aria-label="关闭" @click="closeDialog">×</button>
      <p class="eyebrow">ONLINE RESUME DIFF</p>
      <h2 id="sync-title">同步到在线简历</h2>
      <p class="sync-intro">
        以当前档案为源，把 BOSS 在线简历写成和它一致：线上多出来的条目会被删除，线上有值而本地为空的字段会被清空。
        只会写入下面勾选的模块，没勾的模块线上原样保留；手机号、邮箱、头像这些本地没有的字段始终保留线上原值。
      </p>

      <p v-if="loading" class="sync-state">正在读取在线简历…</p>
      <p v-else-if="error" class="sync-error" role="alert">
        读取失败：{{ error.message }}
        <span v-if="error.code === 'NOT_LOGGED_IN'">请先在浏览器里登录 BOSS 求职者账号。</span>
        <span v-else-if="error.code === 'NO_TAB'">可以手动打开 www.zhipin.com/web/geek/resume 再重试。</span>
        <span v-else-if="error.code === 'SECURITY_BLOCKED'">先在 BOSS 页面完成安全校验再重试。</span>
      </p>

      <template v-else-if="plan && remote">
        <div class="sync-summary">
          <span class="sync-chip sync-chip--pick">本次同步 {{ pickedCount }}/{{ plan.modules.length }} 个模块</span>
          <span v-if="plan.counts.create" class="sync-chip sync-chip--create">新增 {{ plan.counts.create }}</span>
          <span v-if="plan.counts.update" class="sync-chip sync-chip--update">更新 {{ plan.counts.update }}</span>
          <span v-if="plan.counts.delete" class="sync-chip sync-chip--delete">删除 {{ plan.counts.delete }}</span>
          <span v-if="plan.counts.clear" class="sync-chip sync-chip--clear">清空 {{ plan.counts.clear }} 项</span>
          <span v-if="!pickedCount" class="sync-chip sync-chip--same">未勾选任何模块</span>
          <span v-else-if="!plan.changedModules" class="sync-chip sync-chip--same">勾选部分已与线上一致</span>
          <span class="sync-meta">线上最近更新：{{ remote.lastUpdateTime || "未知" }}</span>
        </div>

        <div class="sync-picker">
          <span class="sync-picker__label">勾选要同步的模块（可多选，不勾的模块线上原样保留）</span>
          <div class="sync-picker__actions">
            <button class="text-button sync-picker__action" type="button" :disabled="allPicked" @click="pickAll">全选</button>
            <button class="text-button sync-picker__action" type="button" :disabled="!pickedCount" @click="pickNone">全不选</button>
            <button class="text-button sync-picker__action" type="button" @click="pickChanged">只选有差异的</button>
          </div>
        </div>

        <ul v-if="plan.blockers.length" class="sync-blockers">
          <li v-for="blocker in plan.blockers" :key="blocker">{{ blocker }}</li>
        </ul>

        <div class="sync-body">
          <details
            v-for="module in plan.modules"
            :key="module.id"
            class="sync-module"
            :class="{ 'is-skipped': !module.selected }"
            :open="module.selected && hasChanges(module)"
          >
            <summary class="sync-module__head">
              <input
                class="sync-module__pick"
                type="checkbox"
                :checked="module.selected"
                :aria-label="`同步${module.label}`"
                :title="`同步${module.label}`"
                @click.stop
                @change="toggleModule(module.id, ($event.target as HTMLInputElement).checked)"
              />
              <span class="sync-module__name">{{ module.label }}</span>
              <span class="sync-module__tags">
                <span v-if="module.hint" class="tag tag--hint">{{ module.hint }}</span>
                <span v-if="!module.selected" class="tag tag--skip">跳过</span>
                <span v-if="module.counts.create" class="tag tag--create">新增 {{ module.counts.create }}</span>
                <span v-if="module.counts.update" class="tag tag--update">更新 {{ module.counts.update }}</span>
                <span v-if="module.counts.delete" class="tag tag--delete">删除 {{ module.counts.delete }}</span>
                <span v-if="!hasChanges(module)" class="tag tag--same">一致</span>
              </span>
            </summary>

            <p v-if="module.note" class="sync-module__note">{{ module.note }}</p>

            <ul v-if="changedFields(module.fields).length" class="field-list">
              <li v-for="field in changedFields(module.fields)" :key="field.label">
                <span class="field-label">{{ field.label }}</span>
                <span class="field-before">{{ field.before }}</span>
                <span class="field-arrow" aria-hidden="true">→</span>
                <span class="field-after">{{ field.after }}</span>
              </li>
            </ul>

            <div v-for="item in module.items.filter((entry) => entry.kind !== 'unchanged')" :key="item.index" class="item-block">
              <p class="item-head">
                <span class="item-kind" :class="`item-kind--${item.kind}`">{{ item.kind === "delete" ? "删除" : item.kind === "create" ? "新增" : "更新" }}</span>
                <strong>{{ item.index }}. {{ item.title }}</strong>
              </p>
              <p v-if="item.kind === 'delete'" class="item-hint">整条从线上删除</p>
              <ul v-else class="field-list">
                <li v-for="field in changedFields(item.fields)" :key="field.label">
                  <span class="field-label">{{ field.label }}</span>
                  <span class="field-before">{{ field.before }}</span>
                  <span class="field-arrow" aria-hidden="true">→</span>
                  <span class="field-after">{{ field.after }}</span>
                </li>
              </ul>
            </div>
          </details>
        </div>

        <fieldset class="sync-options">
          <legend>取舍开关</legend>
          <label>
            <input
              type="checkbox"
              :checked="options.syncIndustries"
              @change="toggle('syncIndustries', ($event.target as HTMLInputElement).checked)"
            />
            期望行业按本地覆盖（默认保留线上值）
          </label>
          <p class="sync-options__note">
            求职状态没有开关：它在接口里是 applyStatus 数字编码，本地只有文字，转不了码，始终保留线上原值。
          </p>
        </fieldset>

        <details v-if="plan.warnings.length || plan.preserved.length || plan.notCompared.length" class="sync-extra">
          <summary>取舍说明（{{ plan.warnings.length + plan.preserved.length + plan.notCompared.length }} 条）</summary>
          <ul v-if="plan.warnings.length" class="sync-list sync-list--warn">
            <li v-for="warning in plan.warnings" :key="warning">{{ warning }}</li>
          </ul>
          <ul class="sync-list">
            <li v-for="item in plan.preserved" :key="item">保留：{{ item }}</li>
          </ul>
          <ul class="sync-list">
            <li v-for="item in plan.notCompared" :key="item">不比对：{{ item }}</li>
          </ul>
        </details>

        <p v-if="!pending && !writeResult && !writeError" class="sync-gate">
          点「同步写入」会先读一次 BOSS 的职位 / 行业 / 城市字典，把本地文字转成接口要的编码，再把要做的事逐条列出来。
          确认之后才真正写入，写完立刻回读整份在线简历做残差校验。勾选结果会随档案保存，下次打开沿用。
        </p>

        <section v-if="pending" class="sync-confirm" aria-live="polite">
          <p class="sync-confirm__title">将执行 {{ pending.length }} 个动作，确认后写入</p>
          <ul class="sync-list sync-list--ops">
            <li v-for="operation in pending" :key="operation.key">
              <span class="op-kind" :class="operation.action === 'delete' ? 'op-kind--delete' : 'op-kind--save'">
                {{ operation.action === "delete" ? "删除" : "保存" }}
              </span>
              <span class="op-label">{{ operation.label }}</span>
              <span v-if="operation.note" class="op-note">{{ operation.note }}</span>
            </li>
          </ul>
          <ul v-if="pendingWarnings.length" class="sync-list sync-list--warn">
            <li v-for="item in pendingWarnings" :key="item">{{ item }}</li>
          </ul>
          <ul v-if="pendingSkipped.length" class="sync-list sync-list--warn">
            <li v-for="item in pendingSkipped" :key="item">不做：{{ item }}</li>
          </ul>
          <p v-if="deletes.length" class="sync-confirm__danger">
            注意：这次会从线上删除 {{ deletes.length }} 条内容，扩展无法撤销，删完只能手工补回。
          </p>
          <div class="sync-confirm__actions">
            <button class="button button--quiet" type="button" :disabled="writing" @click="pending = undefined">取消</button>
            <button class="button button--accent" type="button" :disabled="writing" @click="commit">
              {{ writing ? "正在写入…" : `确认写入 ${pending.length} 项` }}
            </button>
          </div>
        </section>

        <section v-if="writeResult || writeError" class="sync-result">
          <p class="sync-result__title">
            {{ writeResult?.ok ? "写入完成" : "写入未全部完成" }}
            <span v-if="verified" class="sync-result__residual" :class="{ 'is-bad': residual > 0 }">
              {{ residual ? `回读校验：仍有 ${residual} 处差异` : "回读校验：已与档案一致" }}
            </span>
          </p>
          <p v-if="writeError" class="sync-result__line is-bad">{{ writeError.message }}</p>
          <p v-if="writeResult?.error" class="sync-result__line is-bad">
            中途停下：{{ writeResult.error.message }}<span v-if="writeResult.error.detail">（{{ writeResult.error.detail }}）</span>
          </p>
          <p v-if="writeResult" class="sync-result__line">
            成功 {{ writeResult.done.length }} 项<template v-if="writeResult.failed.length">，失败 {{ writeResult.failed.length }} 项</template><template v-if="writeResult.skipped.length">，未执行 {{ writeResult.skipped.length }} 项</template>
          </p>
          <ul v-if="writeResult?.failed.length" class="sync-list sync-list--warn">
            <li v-for="item in writeResult.failed" :key="item.key">{{ item.label }}：{{ item.message }}</li>
          </ul>
          <ul v-if="writeResult?.skipped.length" class="sync-list sync-list--warn">
            <li v-for="item in writeResult.skipped" :key="item">未执行：{{ item }}</li>
          </ul>
          <ul v-if="pendingSkipped.length" class="sync-list">
            <li v-for="item in pendingSkipped" :key="item">不做：{{ item }}</li>
          </ul>
          <p v-if="verified && residual" class="sync-result__line is-warn">
            下面的差异就是回读后仍然存在的部分：可能写不进去或本来就写不了，可以再点一次「同步写入」重试，或到 BOSS 页面上手动处理。
          </p>
          <button class="text-button sync-result__close" type="button" @click="dismissResult">收起</button>
        </section>
      </template>

      <div class="dialog-actions">
        <button class="button button--quiet" type="button" @click="closeDialog">关闭</button>
        <button class="button button--outline" type="button" :disabled="loading || writing" @click="load">
          {{ loading ? "正在读取…" : "重新读取" }}
        </button>
        <button class="button button--accent" type="button" :disabled="!canWrite" :title="writeHint" @click="prepare">
          {{ writing ? "正在准备…" : "同步写入" }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.sync-dialog { width: min(720px, calc(100vw - 32px)); max-height: min(86vh, 820px); overflow: auto; }
.sync-dialog .sync-intro { margin: 0 0 14px; color: var(--text-2); font-size: 13px; line-height: 1.65; }
.sync-dialog .sync-state { margin: 18px 0; color: var(--muted); font-size: 13px; }
.sync-dialog .sync-error { margin: 14px 0; padding: 10px 12px; border: 1px solid #f1c4c0; border-radius: var(--radius-sm); color: #a82e28; background: var(--danger-soft); font-size: 13px; line-height: 1.5; }
.sync-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
.sync-chip { padding: 3px 9px; border-radius: 999px; font-size: 12px; font-weight: 500; }
.sync-chip--create { color: var(--accent-text); background: var(--accent-soft); }
.sync-chip--update { color: #8a5a00; background: var(--warn-soft); }
.sync-chip--delete { color: var(--danger); background: var(--danger-soft); }
.sync-chip--clear { color: var(--warn); background: var(--warn-soft); }
.sync-chip--same { color: var(--ok); background: var(--ok-soft); }
.sync-chip--pick { color: var(--text-2); background: var(--surface-soft); }
.sync-picker { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 10px; padding: 8px 12px; border: 1px dashed var(--line); border-radius: var(--radius-sm); }
.sync-picker__label { color: var(--text-2); font-size: 12px; }
.sync-picker__actions { margin-left: auto; display: flex; gap: 4px; }
.sync-picker__action { padding: 2px 5px; font-size: 12px; }
.sync-picker__action:disabled { color: var(--muted); opacity: .55; }
.sync-module__pick { flex: none; width: 15px; height: 15px; margin: 0; accent-color: var(--accent); cursor: pointer; }
.sync-module.is-skipped { background: var(--surface-soft); }
.sync-module.is-skipped .sync-module__name, .sync-module.is-skipped .sync-module__tags { opacity: .6; }
.tag--skip { color: var(--muted); background: var(--surface-soft); border: 1px solid var(--line); }
.sync-meta { margin-left: auto; color: var(--muted); font-size: 12px; }
.sync-blockers { margin: 0 0 12px; padding: 10px 12px 10px 30px; border-radius: var(--radius-sm); color: #a82e28; background: var(--danger-soft); font-size: 13px; line-height: 1.55; }
.sync-body { display: grid; gap: 8px; }
.sync-module { border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface); }
.sync-module__head { display: flex; align-items: center; gap: 10px; padding: 10px 12px; cursor: pointer; font-size: 13px; }
.sync-module__name { font-weight: 500; }
.sync-module__tags { display: flex; gap: 6px; margin-left: auto; }
.tag { padding: 2px 7px; border-radius: 999px; font-size: 11px; }
.tag--create { color: var(--accent-text); background: var(--accent-soft); }
.tag--update { color: #8a5a00; background: var(--warn-soft); }
.tag--delete { color: var(--danger); background: var(--danger-soft); }
.tag--same { color: var(--muted); background: var(--surface-soft); }
.tag--hint { color: #8a5a00; background: var(--warn-soft); }
.sync-dialog .sync-module__note { margin: 0; padding: 0 12px 8px; color: var(--muted); font-size: 12px; line-height: 1.5; }
.field-list { margin: 0; padding: 0 12px 10px; list-style: none; display: grid; gap: 5px; }
.field-list li { display: grid; grid-template-columns: 84px minmax(0, 1fr) 16px minmax(0, 1fr); align-items: baseline; gap: 6px; font-size: 12px; line-height: 1.5; }
.field-label { color: var(--muted); }
.field-before { color: var(--danger); text-decoration: line-through solid rgba(217, 68, 58, .35); }
.field-arrow { color: var(--muted); text-align: center; }
.field-after { color: var(--ok); }
.item-block { padding: 8px 0 0; border-top: 1px dashed var(--line); }
.sync-dialog .item-head { display: flex; align-items: center; gap: 8px; margin: 0; padding: 0 12px 6px; font-size: 13px; }
.sync-dialog .item-hint { margin: 0; padding: 0 12px 10px; color: var(--danger); font-size: 12px; }
.item-kind { padding: 1px 6px; border-radius: 4px; font-size: 11px; }
.item-kind--delete { color: var(--danger); background: var(--danger-soft); }
.item-kind--create { color: var(--accent-text); background: var(--accent-soft); }
.item-kind--update { color: #8a5a00; background: var(--warn-soft); }
.sync-options { margin: 14px 0 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); display: grid; gap: 8px; }
.sync-options legend { padding: 0 6px; color: var(--muted); font-size: 12px; }
.sync-options label { display: flex; align-items: center; gap: 8px; color: var(--text-2); font-size: 13px; }
.sync-options__note { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.sync-extra { margin-top: 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 10px 12px; font-size: 12px; color: var(--text-2); }
.sync-extra summary { cursor: pointer; color: var(--text-2); }
.sync-list { margin: 8px 0 0; padding-left: 18px; display: grid; gap: 4px; line-height: 1.55; }
.sync-list--warn { color: #8a5a00; }
.sync-dialog .sync-gate { margin: 14px 0 0; padding: 10px 12px; border-radius: var(--radius-sm); color: var(--muted); background: var(--surface-soft); font-size: 12px; line-height: 1.6; }
.sync-confirm { margin: 14px 0 0; padding: 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface-soft); }
.sync-confirm__title { margin: 0 0 8px; font-size: 13px; font-weight: 500; }
.sync-list--ops { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }
.sync-list--ops li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; font-size: 12px; line-height: 1.5; }
.op-kind { flex: none; padding: 1px 6px; border-radius: 4px; font-size: 11px; }
.op-kind--save { color: var(--accent-text); background: var(--accent-soft); }
.op-kind--delete { color: var(--danger); background: var(--danger-soft); }
.op-note { width: 100%; padding-left: 42px; color: var(--muted); }
.sync-confirm__danger { margin: 8px 0 0; padding: 8px 10px; border-radius: var(--radius-sm); color: #a82e28; background: var(--danger-soft); font-size: 12px; line-height: 1.55; }
.sync-confirm__actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
.sync-result { margin: 14px 0 0; padding: 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface); }
.sync-result__title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 6px; font-size: 13px; font-weight: 500; }
.sync-result__residual { padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 400; color: var(--ok); background: var(--ok-soft); }
.sync-result__residual.is-bad { color: #8a5a00; background: var(--warn-soft); }
.sync-result__line { margin: 4px 0; color: var(--text-2); font-size: 12px; line-height: 1.55; }
.sync-result__line.is-bad { color: #a82e28; }
.sync-result__line.is-warn { color: #8a5a00; }
.sync-result__close { margin-top: 6px; padding: 2px 0; font-size: 12px; }
</style>
