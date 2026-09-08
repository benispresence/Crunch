<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { FILTERS_DOCS_PATH, isFilterError } from "@/utils/filterErrors";

const props = defineProps<{ message?: string | null; always?: boolean }>();

const show = computed(() => props.always || isFilterError(props.message));
const filterish = computed(() => isFilterError(props.message));
</script>

<template>
  <p v-if="show" class="filter-docs">
    <template v-if="filterish">This looks like a filter / template problem. </template>
    <template v-else>Using <code v-pre>{{variables}}</code> or field filters? </template>
    <RouterLink :to="FILTERS_DOCS_PATH">Read how query filters work</RouterLink>
    — variables, optional clauses, and field filters.
  </p>
</template>

<style scoped>
.filter-docs {
  margin: 10px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--fg-muted);
}
.filter-docs a {
  color: var(--accent);
  text-decoration: none;
  font-weight: 500;
}
.filter-docs a:hover { text-decoration: underline; }
.filter-docs code {
  font-family: var(--font-mono);
  font-size: 12px;
}
</style>
