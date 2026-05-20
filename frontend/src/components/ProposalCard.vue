<script setup lang="ts">
import { computed } from "vue";
import { highlightCode } from "@/composables/markdown";
import { useChatStore } from "@/stores/chat";
import type { ProposalRecord } from "@/stores/chat";

const props = defineProps<{ record: ProposalRecord; turnId: string }>();
const chat = useChatStore();

type DiffLine = { type: "common" | "add" | "remove"; text: string };

function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const m = a.length;
  const n = b.length;
  // LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i]![j] = dp[i + 1]![j + 1]! + 1;
      else dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ type: "common", text: a[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push({ type: "remove", text: a[i]! }); i++; }
    else { out.push({ type: "add", text: b[j]! }); j++; }
  }
  while (i < m) out.push({ type: "remove", text: a[i++]! });
  while (j < n) out.push({ type: "add", text: b[j++]! });
  return out;
}

const p = computed(() => props.record.proposal);

const title = computed(() => {
  const x = p.value;
  switch (x.kind) {
    case "query_edit": return `Edit query #${x.query_id}`;
    case "chart_change": return `Edit chart on "${x.query_name}"`;
    case "new_query": return `New query: "${x.query.name}"`;
    case "delete_query": return `Delete query "${x.target.name}"`;
    case "new_dashboard": return `New dashboard: "${x.dashboard.name}"`;
    case "add_widget": return `Add chart to "${x.dashboard_name}"`;
    case "remove_widget": return `Remove "${x.widget_name}" from "${x.dashboard_name}"`;
    case "dashboard_filter_change": return `Edit filters on "${x.dashboard_name}"`;
    case "widget_mapping": return `Rewire filters → "${x.widget_name}"`;
    case "navigate":
      return x.to === "workspace"
        ? (x.query_id != null ? `Open query #${x.query_id} in workspace` : "Switch to workspace")
        : `Open dashboard #${x.dashboard_id ?? "?"}`;
  }
});

const sqlDiff = computed<DiffLine[] | null>(() => {
  const x = p.value;
  if (x.kind === "query_edit") return diffLines(x.before.sql, x.after.sql);
  return null;
});

const nameDiff = computed<{ before: string; after: string } | null>(() => {
  const x = p.value;
  if (x.kind === "query_edit" && x.before.name !== x.after.name) {
    return { before: x.before.name, after: x.after.name };
  }
  return null;
});

const chartDelta = computed(() => {
  const x = p.value;
  if (x.kind !== "chart_change") return null;
  const lines: Array<{ field: string; before: string; after: string }> = [];
  const cmp = (k: keyof typeof x.before, b: unknown, a: unknown) => {
    const bs = typeof b === "object" ? JSON.stringify(b, null, 2) : String(b ?? "");
    const as = typeof a === "object" ? JSON.stringify(a, null, 2) : String(a ?? "");
    if (bs !== as) lines.push({ field: String(k), before: bs, after: as });
  };
  cmp("chart_type", x.before.chart_type, x.after.chart_type);
  cmp("chart_mode", x.before.chart_mode, x.after.chart_mode);
  cmp("chart_config", x.before.chart_config, x.after.chart_config);
  cmp("chart_python_code", x.before.chart_python_code, x.after.chart_python_code);
  return lines;
});

async function accept() { await chat.acceptProposal(props.turnId, props.record.id); }
function reject() { chat.rejectProposal(props.turnId, props.record.id); }
</script>

<template>
  <div class="prop" :class="`prop--${record.status}`">
    <header class="prop__head">
      <span class="prop__kind">{{ p.kind }}</span>
      <span class="prop__title">{{ title }}</span>
      <span class="prop__status">{{ record.status }}</span>
    </header>

    <p v-if="p.rationale" class="prop__rationale">{{ p.rationale }}</p>

    <!-- query_edit: name + SQL diff -->
    <template v-if="p.kind === 'query_edit'">
      <div v-if="nameDiff" class="prop__namechange">
        <span class="prop__field">name</span>
        <code class="prop__name--del">{{ nameDiff.before }}</code>
        <span class="prop__arrow">→</span>
        <code class="prop__name--add">{{ nameDiff.after }}</code>
      </div>
      <div v-if="sqlDiff && sqlDiff.length > 0" class="prop__diff hljs">
        <div
          v-for="(line, i) in sqlDiff"
          :key="i"
          class="prop__line"
          :class="`prop__line--${line.type}`"
        >
          <span class="prop__marker">{{ line.type === "add" ? "+" : line.type === "remove" ? "-" : " " }}</span>
          <span class="prop__text" v-html="highlightCode(line.text || ' ', 'sql')" />
        </div>
      </div>
    </template>

    <!-- chart_change: field-by-field deltas -->
    <template v-if="p.kind === 'chart_change'">
      <div v-if="chartDelta && chartDelta.length > 0" class="prop__chart">
        <div v-for="d in chartDelta" :key="d.field" class="prop__chart-field">
          <div class="prop__chart-name">{{ d.field }}</div>
          <pre class="prop__chart-side prop__chart-side--del">{{ d.before }}</pre>
          <pre class="prop__chart-side prop__chart-side--add">{{ d.after }}</pre>
        </div>
      </div>
      <p v-else class="prop__nochange">No effective change.</p>
    </template>

    <!-- new_query: preview -->
    <template v-if="p.kind === 'new_query'">
      <div class="prop__newq">
        <div class="prop__newq-row"><strong>name</strong> {{ p.query.name }}</div>
        <div class="prop__newq-row"><strong>connection</strong> #{{ p.query.connection_id }}</div>
        <div class="prop__newq-row"><strong>chart</strong> {{ p.query.chart_mode }} · {{ p.query.chart_type }}</div>
        <pre class="prop__newq-sql hljs"><code v-html="highlightCode(p.query.sql, 'sql')" /></pre>
      </div>
    </template>

    <!-- delete_query -->
    <template v-if="p.kind === 'delete_query'">
      <div class="prop__delete">
        <p>Will delete query <strong>"{{ p.target.name }}"</strong> (#{{ p.query_id }}).</p>
        <pre class="prop__delete-sql hljs"><code v-html="highlightCode(p.target.sql, 'sql')" /></pre>
      </div>
    </template>

    <!-- new_dashboard -->
    <template v-if="p.kind === 'new_dashboard'">
      <div class="prop__newq">
        <div class="prop__newq-row"><strong>name</strong> {{ p.dashboard.name }}</div>
        <div v-if="p.dashboard.description" class="prop__newq-row">
          <strong>description</strong> {{ p.dashboard.description }}
        </div>
        <div class="prop__newq-row">
          <strong>filters</strong>
          {{ p.dashboard.filters.length === 0 ? "none" : p.dashboard.filters.map((f) => `${f.name} (${f.type})`).join(", ") }}
        </div>
        <div class="prop__newq-row">
          <strong>widgets</strong>
          {{ p.dashboard.widgets.length }} chart(s)
        </div>
      </div>
    </template>

    <!-- add_widget -->
    <template v-if="p.kind === 'add_widget'">
      <div class="prop__newq">
        <div class="prop__newq-row"><strong>dashboard</strong> {{ p.dashboard_name }}</div>
        <div class="prop__newq-row"><strong>chart</strong> {{ p.widget.query_name }} (query #{{ p.widget.query_id }})</div>
        <div class="prop__newq-row">
          <strong>position</strong>
          col {{ p.widget.position_x }} · row {{ p.widget.position_y }} · {{ p.widget.width }}×{{ p.widget.height }}
        </div>
        <div v-if="Object.keys(p.widget.parameter_mappings).length > 0" class="prop__newq-row">
          <strong>mappings</strong>
          <span v-for="(v, k) in p.widget.parameter_mappings" :key="k" class="prop__chip">
            {{ k }} → {{ v }}
          </span>
        </div>
      </div>
    </template>

    <!-- remove_widget -->
    <template v-if="p.kind === 'remove_widget'">
      <div class="prop__delete">
        <p>Will remove chart <strong>"{{ p.widget_name }}"</strong> from <strong>{{ p.dashboard_name }}</strong>. The underlying saved query is left alone.</p>
      </div>
    </template>

    <!-- dashboard_filter_change -->
    <template v-if="p.kind === 'dashboard_filter_change'">
      <div class="prop__chart">
        <div class="prop__chart-field">
          <div class="prop__chart-name">filters</div>
          <pre class="prop__chart-side prop__chart-side--del">{{ JSON.stringify(p.before, null, 2) }}</pre>
          <pre class="prop__chart-side prop__chart-side--add">{{ JSON.stringify(p.after, null, 2) }}</pre>
        </div>
      </div>
    </template>

    <!-- widget_mapping -->
    <template v-if="p.kind === 'widget_mapping'">
      <div class="prop__chart">
        <div class="prop__chart-field">
          <div class="prop__chart-name">mapping</div>
          <pre class="prop__chart-side prop__chart-side--del">{{ JSON.stringify(p.before, null, 2) }}</pre>
          <pre class="prop__chart-side prop__chart-side--add">{{ JSON.stringify(p.after, null, 2) }}</pre>
        </div>
      </div>
    </template>

    <!-- navigate -->
    <template v-if="p.kind === 'navigate'">
      <div class="prop__newq">
        <div class="prop__newq-row">
          <strong>destination</strong>
          {{ p.to === "workspace"
            ? (p.query_id != null ? `Workspace — open query #${p.query_id}` : "Workspace")
            : `Dashboard #${p.dashboard_id ?? "?"}` }}
        </div>
      </div>
    </template>

    <p v-if="record.error" class="prop__err">⚠ {{ record.error }}</p>

    <footer v-if="record.status === 'pending'" class="prop__actions">
      <button class="btn btn-sm prop__reject" @click="reject">
        {{ p.kind === "navigate" ? "Stay here" : "Reject" }}
      </button>
      <button
        class="btn btn-primary btn-sm"
        :class="{ 'prop__danger': p.kind === 'delete_query' || p.kind === 'remove_widget' }"
        @click="accept"
      >
        {{
          p.kind === "delete_query" || p.kind === "remove_widget"
            ? "Confirm"
            : p.kind === "navigate"
              ? "Open"
              : "Accept"
        }}
      </button>
    </footer>
    <footer v-else-if="record.status === 'accepted' || record.status === 'auto-accepted'" class="prop__done">
      ✓ Applied{{ record.status === "auto-accepted" ? " (auto)" : "" }}
    </footer>
    <footer v-else-if="record.status === 'rejected'" class="prop__done prop__done--rejected">
      ✗ Rejected
    </footer>
  </div>
</template>

<style scoped>
.prop {
  border: 1px solid var(--accent-border);
  border-radius: var(--radius);
  background: var(--bg-elev);
  padding: 10px 12px;
  display: grid;
  gap: 8px;
  margin: 8px 0;
}
.prop--accepted, .prop--auto-accepted { border-color: rgba(127, 176, 105, 0.4); }
.prop--rejected { border-color: var(--border); opacity: 0.7; }
.prop--error { border-color: rgba(224, 122, 95, 0.45); }
.prop__head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.prop__kind {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  background: var(--accent-subtle);
  color: var(--accent);
  padding: 1px 6px;
  border-radius: 999px;
}
.prop__title { flex: 1; font-weight: 600; color: var(--fg); }
.prop__status {
  font-size: 10px;
  text-transform: uppercase;
  color: var(--fg-subtle);
}
.prop__rationale {
  margin: 0;
  font-size: 12px;
  color: var(--fg-muted);
  font-style: italic;
}
.prop__namechange {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 11px;
  font-family: var(--font-mono);
}
.prop__field {
  font-size: 10px;
  text-transform: uppercase;
  color: var(--fg-subtle);
}
.prop__arrow { color: var(--fg-subtle); }
.prop__name--del {
  background: rgba(224, 122, 95, 0.12);
  color: var(--error);
  padding: 1px 5px;
  border-radius: 3px;
}
.prop__name--add {
  background: rgba(127, 176, 105, 0.14);
  color: var(--success);
  padding: 1px 5px;
  border-radius: 3px;
}
.prop__diff {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  border-radius: var(--radius-sm);
  padding: 6px 0;
  max-height: 320px;
  overflow: auto;
}
.prop__line { display: grid; grid-template-columns: 18px 1fr; padding: 0 8px; }
.prop__marker { color: var(--fg-subtle); user-select: none; }
.prop__text { white-space: pre; }
.prop__line--add { background: rgba(127, 176, 105, 0.12); }
.prop__line--add .prop__marker { color: var(--success); }
.prop__line--remove { background: rgba(224, 122, 95, 0.12); }
.prop__line--remove .prop__marker { color: var(--error); }
.prop__line .prop__text :deep(span) { background: transparent; }
.prop__chart { display: grid; gap: 6px; }
.prop__chart-field {
  display: grid;
  grid-template-columns: 110px 1fr 1fr;
  gap: 6px;
  align-items: start;
}
.prop__chart-name {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--fg-muted);
  padding-top: 4px;
}
.prop__chart-side {
  margin: 0;
  padding: 4px 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 100px;
  overflow: auto;
}
.prop__chart-side--del { background: rgba(224, 122, 95, 0.1); color: #e89b85; }
.prop__chart-side--add { background: rgba(127, 176, 105, 0.1); color: #a4d18a; }
.prop__nochange { font-size: 12px; color: var(--fg-subtle); margin: 0; }
.prop__newq { display: grid; gap: 4px; }
.prop__newq-row { font-size: 12px; color: var(--fg-muted); }
.prop__newq-row strong {
  display: inline-block;
  width: 100px;
  font-size: 10px;
  text-transform: uppercase;
  color: var(--fg-subtle);
  font-weight: 600;
}
.prop__newq-sql, .prop__delete-sql {
  margin: 4px 0 0;
  padding: 8px 10px;
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 11.5px;
  white-space: pre-wrap;
  max-height: 200px;
  overflow: auto;
}
.prop__delete { font-size: 12px; color: var(--fg-muted); }
.prop__chip {
  display: inline-block;
  margin: 0 4px 2px 0;
  padding: 1px 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--fg-muted);
}
.prop__err {
  margin: 0;
  font-size: 11px;
  color: var(--error);
}
.prop__actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}
.prop__reject { color: var(--fg-muted); }
.prop__danger { background: var(--error); border-color: var(--error); color: #fff; }
.prop__done {
  font-size: 11px;
  color: var(--success);
  text-align: right;
}
.prop__done--rejected { color: var(--fg-subtle); }
</style>
