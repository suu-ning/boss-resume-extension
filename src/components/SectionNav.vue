<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import Sortable from "sortablejs";
import { SECTION_LABEL, type SectionId } from "../editor/sections";

/**
 * 编辑页左侧菜单。所有模块按住拖动排序。
 * order 直接改写传入数组，自动保存由编辑器的 deep watch 负责。
 */
const props = defineProps<{
  order: SectionId[];
  active: SectionId;
  issues: Partial<Record<SectionId, string[]>>;
}>();
const emit = defineEmits<{ select: [section: SectionId] }>();

const DRAG_DISTANCE_PX = 10;
const listEl = ref<HTMLElement>();
/** 拖完松手也会触发 click，短时间内忽略，避免误切换模块。 */
let suppressClick = false;
let sortable: Sortable | undefined;

function select(section: SectionId): void {
  if (!suppressClick) emit("select", section);
}

/** sortablejs 已搬动 DOM：先还原节点，再改数组交给 Vue 重排。 */
function onSortEnd(event: Sortable.SortableEvent): void {
  window.setTimeout(() => (suppressClick = false), 120);
  const { oldIndex, newIndex, item, from } = event;
  if (oldIndex === undefined || newIndex === undefined || oldIndex === newIndex) return;
  from.removeChild(item);
  from.insertBefore(item, from.children[oldIndex] ?? null);
  const [moved] = props.order.splice(oldIndex, 1);
  props.order.splice(newIndex, 0, moved);
}

watch(listEl, (el) => {
  sortable?.destroy();
  sortable = el
    ? Sortable.create(el, {
        animation: 200,
        ghostClass: "item-ghost",
        fallbackClass: "nav-fallback",
        forceFallback: true,
        fallbackOnBody: true,
        fallbackTolerance: DRAG_DISTANCE_PX,
        onStart: () => (suppressClick = true),
        onEnd: onSortEnd,
      })
    : undefined;
});

onBeforeUnmount(() => sortable?.destroy());
</script>

<template>
  <nav>
    <div ref="listEl" class="nav-sortable">
      <button
        v-for="(section, index) in order"
        :key="section"
        type="button"
        class="nav-movable"
        :class="{ active: active === section, invalid: issues[section] }"
        :title="issues[section]?.join('\n') || '按住拖动可调整顺序'"
        @click="select(section)"
      >
        <span>{{ String(index + 1).padStart(2, '0') }}</span>{{ SECTION_LABEL[section] }}<em v-if="issues[section]" class="nav-issue">{{ issues[section]!.length }}</em><i class="item-grip nav-grip" aria-hidden="true"></i>
      </button>
    </div>
  </nav>
</template>
