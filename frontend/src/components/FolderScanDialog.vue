<script setup lang="ts">
import { computed, ref } from "vue";
import { api } from "@/api/client";

/**
 * Folder-scan picker. The user pastes a local folder path, hits Scan,
 * and gets back a per-file checklist with format chips and (for
 * Excel) per-sheet rows. "Add selected" hands the chosen entries
 * back to the parent component as a list of URIs that the FileAdapter
 * recognises — bare paths for CSV/Parquet/JSON/Arrow, and
 * ``path.xlsx#SheetName`` fragments for individual Excel sheets.
 */

interface ScannedFile {
  uri: string;
  name: string;
  format: string;
  size_bytes: number;
  relative_path: string;
  sheet: string | null;
}

interface ScanResult {
  root: string;
  files: ScannedFile[];
  skipped: number;
  error?: string;
}

defineProps<{ initialPath?: string }>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "select", uris: string[]): void;
}>();

const path = ref<string>("");
const recursive = ref(true);
const scanning = ref(false);
const result = ref<ScanResult | null>(null);
const error = ref<string | null>(null);
// uri → selected flag. We key on uri (including the #SheetName
// fragment) so per-sheet selection works naturally.
const selected = ref<Record<string, boolean>>({});
const filter = ref("");

async function runScan() {
  if (!path.value.trim()) {
    error.value = "Please paste a folder path";
    return;
  }
  scanning.value = true;
  error.value = null;
  selected.value = {};
  try {
    const r = await api.post<ScanResult>("/connections/scan-folder", {
      path: path.value.trim(),
      recursive: recursive.value,
    });
    if (r.error) {
      error.value = r.error;
      result.value = null;
    } else {
      result.value = r;
      // Default-select everything so "Scan + Add selected" is one click
      // for the common case of "take everything in this folder".
      for (const f of r.files) selected.value[f.uri] = true;
    }
  } catch (e) {
    error.value = (e as Error).message;
    result.value = null;
  } finally {
    scanning.value = false;
  }
}

const filtered = computed<ScannedFile[]>(() => {
  const files = result.value?.files ?? [];
  const q = filter.value.trim().toLowerCase();
  if (!q) return files;
  return files.filter(
    (f) =>
      f.name.toLowerCase().includes(q)
      || f.relative_path.toLowerCase().includes(q)
      || f.format.includes(q),
  );
});

const counts = computed(() => {
  const total = filtered.value.length;
  const picked = filtered.value.filter((f) => selected.value[f.uri]).length;
  return { picked, total };
});

function selectAll() {
  for (const f of filtered.value) selected.value[f.uri] = true;
}
function selectNone() {
  for (const f of filtered.value) selected.value[f.uri] = false;
}
function toggleByFormat(fmt: string, on: boolean) {
  for (const f of filtered.value) if (f.format === fmt) selected.value[f.uri] = on;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function addSelected() {
  const uris = (result.value?.files ?? [])
    .filter((f) => selected.value[f.uri])
    .map((f) => f.uri);
  emit("select", uris);
  emit("close");
}

const formatColors: Record<string, string> = {
  csv: "color-csv",
  parquet: "color-parquet",
  json: "color-json",
  excel: "color-excel",
  arrow: "color-arrow",
};
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog">
      <header class="dialog__head">
        <div>
          <h3>Browse a folder</h3>
          <p class="dialog__sub">
            Paste a local folder path. Crunch walks it, detects each file's format, and lists
            every Excel sheet as its own row.
          </p>
        </div>
        <button class="btn btn-ghost btn-icon" @click="emit('close')">×</button>
      </header>

      <div class="dialog__form">
        <label class="dialog__field">
          <span>Folder path</span>
          <input
            v-model="path"
            placeholder="/home/me/data"
            autofocus
            @keyup.enter="runScan"
          />
        </label>
        <label class="dialog__checkbox">
          <input v-model="recursive" type="checkbox" />
          <span>Walk subfolders recursively</span>
        </label>
        <button class="btn btn-primary btn-sm" :disabled="scanning" @click="runScan">
          {{ scanning ? "Scanning…" : "Scan" }}
        </button>
      </div>

      <p v-if="error" class="dialog__error">{{ error }}</p>

      <div v-if="result && !error" class="dialog__results">
        <div class="dialog__toolbar">
          <input
            v-model="filter"
            class="dialog__filter"
            placeholder="Filter by name or format…"
          />
          <span class="dialog__count">
            {{ counts.picked }} of {{ counts.total }} selected
            <template v-if="result.skipped > 0">
              · {{ result.skipped }} skipped (unknown format)
            </template>
          </span>
          <div class="dialog__bulk">
            <button class="btn btn-ghost btn-sm" @click="selectAll">All</button>
            <button class="btn btn-ghost btn-sm" @click="selectNone">None</button>
            <div class="dialog__by-format">
              <span class="dialog__by-label">By format:</span>
              <button
                v-for="fmt in [...new Set(filtered.map((f) => f.format))]"
                :key="fmt"
                class="btn btn-ghost btn-sm dialog__by-chip"
                @click="toggleByFormat(fmt, true)"
              >
                +{{ fmt }}
              </button>
            </div>
          </div>
        </div>

        <ul v-if="filtered.length > 0" class="dialog__list">
          <li v-for="f in filtered" :key="f.uri" class="dialog__row">
            <label class="dialog__row-label">
              <input v-model="selected[f.uri]" type="checkbox" />
              <span class="dialog__fmt" :class="formatColors[f.format] ?? 'color-misc'">
                {{ f.format }}
              </span>
              <span class="dialog__name">
                {{ f.name }}
                <span v-if="f.sheet" class="dialog__sheet">sheet</span>
              </span>
              <span class="dialog__path">{{ f.relative_path }}</span>
              <span class="dialog__size">{{ humanSize(f.size_bytes) }}</span>
            </label>
          </li>
        </ul>
        <div v-else class="dialog__empty">
          <template v-if="result.files.length === 0">
            No supported files found under <code>{{ result.root }}</code>.
          </template>
          <template v-else>
            No matches for "{{ filter }}".
          </template>
        </div>
      </div>

      <footer class="dialog__foot">
        <button class="btn btn-sm" @click="emit('close')">Cancel</button>
        <button
          class="btn btn-primary btn-sm"
          :disabled="counts.picked === 0"
          @click="addSelected"
        >
          Add {{ counts.picked }} item{{ counts.picked === 1 ? '' : 's' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(10, 8, 6, 0.6);
  display: grid;
  place-items: center;
  z-index: 200;
}
.dialog {
  width: 720px;
  max-width: 96vw;
  max-height: 85vh;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.dialog__head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}
.dialog__head h3 {
  margin: 0 0 2px;
  font-family: var(--font-serif);
  font-weight: 500;
  font-size: 15px;
}
.dialog__sub { margin: 0; font-size: 12px; color: var(--fg-subtle); line-height: 1.4; }
.dialog__form {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 10px;
  align-items: end;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.dialog__field { display: grid; gap: 4px; font-size: 11px; color: var(--fg-muted); }
.dialog__field input {
  font-size: 13px;
  padding: 6px 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg);
  font-family: var(--font-mono);
}
.dialog__checkbox {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--fg-muted);
  padding: 6px 0;
}
.dialog__error {
  margin: 0;
  padding: 10px 16px;
  background: rgba(220, 80, 80, 0.08);
  color: var(--error);
  font-size: 12px;
  border-bottom: 1px solid var(--border);
}
.dialog__results {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.dialog__toolbar {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 10px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  align-items: center;
}
.dialog__filter {
  font-size: 12px;
  padding: 5px 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg);
}
.dialog__count { font-size: 11px; color: var(--fg-subtle); white-space: nowrap; }
.dialog__bulk { display: flex; gap: 6px; align-items: center; }
.dialog__by-format {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 8px;
  padding-left: 8px;
  border-left: 1px solid var(--border);
}
.dialog__by-label { font-size: 11px; color: var(--fg-subtle); }
.dialog__by-chip { padding: 2px 8px; font-size: 11px; }
.dialog__list {
  list-style: none;
  margin: 0;
  padding: 6px 0;
  overflow-y: auto;
  flex: 1;
}
.dialog__row { padding: 0 12px; }
.dialog__row:hover { background: var(--bg-hover); }
.dialog__row-label {
  display: grid;
  grid-template-columns: 18px 56px 1fr 1.2fr 70px;
  gap: 8px;
  align-items: center;
  padding: 4px 4px;
  font-size: 12.5px;
  cursor: pointer;
}
.dialog__fmt {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px 6px;
  border-radius: 3px;
  text-align: center;
}
.color-csv     { background: rgba(127, 176, 105, 0.16); color: #7fb069; }
.color-parquet { background: rgba(122, 162, 200, 0.16); color: #7aa2c8; }
.color-json    { background: rgba(232, 176, 76, 0.16); color: #e8b04c; }
.color-excel   { background: rgba(127, 176, 105, 0.20); color: #6e9c5a; }
.color-arrow   { background: rgba(200, 162, 212, 0.20); color: #c8a2d4; }
.color-misc    { background: var(--bg); color: var(--fg-subtle); }
.dialog__name {
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.dialog__sheet {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg-subtle);
  background: var(--bg);
  padding: 1px 5px;
  border-radius: 999px;
  border: 1px solid var(--border);
}
.dialog__path {
  color: var(--fg-subtle);
  font-family: var(--font-mono);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dialog__size {
  color: var(--fg-subtle);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  text-align: right;
}
.dialog__empty {
  padding: 28px 18px;
  text-align: center;
  font-size: 13px;
  color: var(--fg-muted);
}
.dialog__empty code {
  font-family: var(--font-mono);
  background: var(--bg);
  padding: 1px 5px;
  border-radius: 3px;
}
.dialog__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}
</style>
