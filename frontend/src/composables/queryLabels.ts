import { ref, watch } from "vue";

/** Shared preference: show connection/chart meta under each query name. */
const KEY = "nm_query_show_labels";

function read(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    // Default on so labels are visible until the user hides them.
    if (v === null) return true;
    return v === "1";
  } catch {
    return true;
  }
}

const showQueryLabels = ref(read());

watch(showQueryLabels, (v) => {
  try {
    localStorage.setItem(KEY, v ? "1" : "0");
  } catch {
    /* ignore */
  }
});

export function useQueryLabels() {
  function toggleQueryLabels() {
    showQueryLabels.value = !showQueryLabels.value;
  }
  return { showQueryLabels, toggleQueryLabels };
}
