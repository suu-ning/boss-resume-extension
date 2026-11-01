<script setup lang="ts">
import { ref } from "vue";
import type { BossCustomModule } from "../domain/types";

const props = defineProps<{ modules: BossCustomModule[] }>();
const pendingRemoval = ref<number>();

function valueText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(valueText).filter(Boolean).join("、");
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => {
        const text = valueText(item);
        return text ? `${key}：${text}` : "";
      })
      .filter(Boolean)
      .join("；");
  }
  return "";
}

function content(module: BossCustomModule): string {
  return module.items.map(valueText).filter(Boolean).join("\n");
}

function updateContent(module: BossCustomModule, value: string): void {
  module.items = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function add(): void {
  props.modules.push({ key: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, title: "自定义模块", items: [] });
}

function confirmRemove(): void {
  const index = pendingRemoval.value;
  pendingRemoval.value = undefined;
  if (index !== undefined) props.modules.splice(index, 1);
}
</script>

<template>
  <div class="section-heading section-heading--action">
    <div><p class="eyebrow">CUSTOM MODULES</p><h2>自定义模块</h2><p>补充证书、荣誉、语言能力等简历中没有固定编辑器的内容。</p></div>
    <button class="button button--outline" type="button" @click="add">添加模块</button>
  </div>
  <div v-if="!modules.length" class="section-empty">还没有自定义模块，点击右上角添加。</div>
  <div v-else class="custom-module-list">
    <article v-for="(module, index) in modules" :key="module.key" class="custom-module-card">
      <div class="custom-module-card__head">
        <label class="field"><span>模块名称</span><input v-model="module.title" maxlength="40" placeholder="例如：荣誉奖项" /></label>
        <button class="text-button text-button--danger" type="button" @click="pendingRemoval = index">删除</button>
      </div>
      <label class="field field--wide"><span>模块内容</span><textarea :value="content(module)" rows="5" maxlength="4000" placeholder="每行填写一条内容" @input="updateContent(module, ($event.target as HTMLTextAreaElement).value)" /></label>
      <p class="field-hint">每行会在预览中单独显示。</p>
    </article>
  </div>
  <div v-if="pendingRemoval !== undefined" class="dialog-backdrop" @click.self="pendingRemoval = undefined">
    <section class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="custom-module-remove-title">
      <h2 id="custom-module-remove-title">删除自定义模块</h2>
      <p>删除「{{ modules[pendingRemoval]?.title || '未命名模块' }}」？删除后不可恢复。</p>
      <div class="dialog-actions">
        <button class="button button--quiet" type="button" @click="pendingRemoval = undefined">取消</button>
        <button class="button button--danger-solid" type="button" @click="confirmRemove">确认删除</button>
      </div>
    </section>
  </div>
</template>
