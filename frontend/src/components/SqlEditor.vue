<script setup lang="ts">
import * as monaco from "monaco-editor";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useWorkspaceStore } from "@/stores/workspace";

const ws = useWorkspaceStore();
const host = ref<HTMLDivElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;

const showSaveAs = ref(false);
const saveAsName = ref("");
const saving = ref(false);
const saveError = ref("");

const activeQuery = computed(() =>
  ws.activeQueryId == null
    ? null
    : ws.savedQueries.find((q) => q.id === ws.activeQueryId) ?? null,
);

async function save() {
  saveError.value = "";
  if (activeQuery.value) {
    // Updating an existing saved query — no name prompt.
    saving.value = true;
    try {
      await ws.saveCurrentQuery(activeQuery.value.name);
    } catch (e) {
      saveError.value = (e as Error).message;
    } finally {
      saving.value = false;
    }
    return;
  }
  // First save — open the inline name prompt.
  saveAsName.value = "";
  showSaveAs.value = true;
}

async function confirmSaveAs() {
  if (!saveAsName.value.trim()) {
    saveError.value = "Name is required";
    return;
  }
  saving.value = true;
  saveError.value = "";
  try {
    await ws.saveCurrentQuery(saveAsName.value);
    showSaveAs.value = false;
  } catch (e) {
    saveError.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

monaco.editor.defineTheme("nicemeta-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "keyword.sql", foreground: "d59c79", fontStyle: "bold" },
    { token: "string.sql", foreground: "a3c585" },
    { token: "number.sql", foreground: "c8a2d4" },
    { token: "comment.sql", foreground: "6b655e", fontStyle: "italic" },
  ],
  colors: {
    "editor.background": "#1a1815",
    "editor.foreground": "#f5f1ec",
    "editorLineNumber.foreground": "#4a443c",
    "editorLineNumber.activeForeground": "#a8a098",
    "editor.selectionBackground": "#d9775733",
    "editor.lineHighlightBackground": "#211e1a",
    "editorCursor.foreground": "#d97757",
    "editorBracketMatch.background": "#d9775722",
    "editorBracketMatch.border": "#d97757",
  },
});

onMounted(() => {
  if (!host.value) return;
  editor = monaco.editor.create(host.value, {
    value: ws.sql,
    language: "sql",
    theme: "nicemeta-dark",
    fontFamily: "JetBrains Mono, SF Mono, monospace",
    fontSize: 13,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    padding: { top: 12, bottom: 12 },
    renderLineHighlight: "all",
    smoothScrolling: true,
    cursorBlinking: "smooth",
    tabSize: 2,
  });
  editor.onDidChangeModelContent(() => {
    ws.sql = editor!.getValue();
  });
  editor.addAction({
    id: "run-sql",
    label: "Run query",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
    run: () => ws.runSql().catch(() => {}),
  });
});

watch(
  () => ws.sql,
  (value) => {
    if (editor && editor.getValue() !== value) editor.setValue(value);
  },
);

onBeforeUnmount(() => editor?.dispose());

function accept() {
  ws.acceptProposal();
}
function reject() {
  ws.rejectProposal();
}
</script>

<template>
  <div class="editor">
    <div class="editor__bar">
      <div class="editor__title">
        <span class="editor__name">{{ activeQuery ? activeQuery.name : "Untitled query" }}</span>
        <span class="editor__hint">⌘ + Enter to run</span>
      </div>
      <div class="editor__actions">
        <button
          class="btn btn-ghost btn-sm"
          :disabled="saving"
          :title="activeQuery ? 'Save changes to this query' : 'Save as a new query'"
          @click="save"
        >
          {{ saving ? "Saving..." : activeQuery ? "Save" : "Save as..." }}
        </button>
        <button class="btn btn-primary btn-sm" :disabled="ws.running" @click="ws.runSql">
          <svg width="10" height="10" viewBox="0 0 10 10"><polygon points="2,1 9,5 2,9" fill="currentColor" /></svg>
          {{ ws.running ? "Running..." : "Run" }}
        </button>
      </div>
    </div>

    <div v-if="showSaveAs" class="save-as">
      <input
        v-model="saveAsName"
        class="save-as__input"
        placeholder="Query name"
        autofocus
        @keyup.enter="confirmSaveAs"
        @keyup.escape="showSaveAs = false"
      />
      <button class="btn btn-ghost btn-sm" @click="showSaveAs = false">Cancel</button>
      <button class="btn btn-primary btn-sm" :disabled="saving" @click="confirmSaveAs">
        {{ saving ? "Saving..." : "Save" }}
      </button>
    </div>
    <p v-if="saveError" class="save-as__error">{{ saveError }}</p>

    <div ref="host" class="editor__host" />

    <div v-if="ws.pendingProposal" class="proposal">
      <div class="proposal__head">
        <span class="proposal__dot" />
        <span>NiceMeta proposed a SQL change</span>
      </div>
      <pre class="proposal__diff">{{ ws.pendingProposal.sql }}</pre>
      <div class="proposal__actions">
        <button class="btn btn-sm" @click="reject">Reject</button>
        <button class="btn btn-primary btn-sm" @click="accept">Accept &amp; replace</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
}
.editor__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  flex-shrink: 0;
}
.editor__title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--fg-muted);
  min-width: 0;
}
.editor__name {
  color: var(--fg);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 360px;
}
.editor__hint { color: var(--fg-subtle); font-size: 11px; }
.editor__actions { display: flex; gap: 6px; flex-shrink: 0; }
.editor__host { flex: 1; min-height: 0; }
.save-as {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
}
.save-as__input {
  flex: 1;
  font-size: 13px;
  padding: 5px 8px;
}
.save-as__error {
  margin: 0;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--error);
  background: rgba(220, 80, 80, 0.08);
  border-bottom: 1px solid var(--border);
}
.proposal {
  border-top: 1px solid var(--accent-border);
  background: var(--accent-subtle);
  padding: 10px 12px;
  display: grid;
  gap: 8px;
}
.proposal__head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--accent);
}
.proposal__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}
.proposal__diff {
  margin: 0;
  padding: 8px 10px;
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--code-fg);
  max-height: 160px;
  overflow: auto;
  white-space: pre;
}
.proposal__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
