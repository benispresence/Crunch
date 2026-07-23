import { useWorkspaceStore } from "@/stores/workspace";
import { useDashboardsStore } from "@/stores/dashboards";
import { usePipelinesStore } from "@/stores/pipelines";

/**
 * Resolve numeric entity ids to human labels for chat / proposals / tools.
 * Falls back to a short "#id" only when the entity isn't loaded yet.
 */
export function useEntityLabels() {
  const ws = useWorkspaceStore();
  const dashboards = useDashboardsStore();
  const pipelines = usePipelinesStore();

  function queryName(id: number | null | undefined): string | null {
    if (id == null) return null;
    return ws.savedQueries.find((q) => q.id === id)?.name ?? null;
  }

  function queryLabel(id: number | null | undefined): string {
    if (id == null) return "—";
    return queryName(id) ?? `Query #${id}`;
  }

  function connectionName(id: number | null | undefined): string | null {
    if (id == null) return null;
    return ws.connections.find((c) => c.id === id)?.name ?? null;
  }

  function connectionLabel(id: number | null | undefined): string {
    if (id == null) return "(unbound)";
    const c = ws.connections.find((x) => x.id === id);
    if (!c) return `Connection #${id}`;
    return c.type ? `${c.name} · ${c.type}` : c.name;
  }

  function dashboardName(id: number | null | undefined): string | null {
    if (id == null) return null;
    if (dashboards.current?.id === id) return dashboards.current.name;
    return dashboards.list.find((d) => d.id === id)?.name ?? null;
  }

  function dashboardLabel(id: number | null | undefined): string {
    if (id == null) return "—";
    return dashboardName(id) ?? `Dashboard #${id}`;
  }

  function pipelineName(id: number | null | undefined): string | null {
    if (id == null) return null;
    if (pipelines.current?.id === id) return pipelines.current.name;
    return pipelines.list.find((p) => p.id === id)?.name ?? null;
  }

  function pipelineLabel(id: number | null | undefined): string {
    if (id == null) return "—";
    return pipelineName(id) ?? `Pipeline #${id}`;
  }

  return {
    queryName,
    queryLabel,
    connectionName,
    connectionLabel,
    dashboardName,
    dashboardLabel,
    pipelineName,
    pipelineLabel,
  };
}

/** Friendly tool names for the agent tool strip. */
export const TOOL_DISPLAY_NAMES: Record<string, string> = {
  list_connections: "List connections",
  list_tables: "List tables",
  describe_table: "Describe table",
  run_sql: "Run SQL",
  list_queries: "List queries",
  get_query: "Get query",
  propose_query_edit: "Propose query edit",
  propose_bulk_query_edit: "Propose bulk query edit",
  propose_new_query: "Propose new query",
  propose_delete_query: "Propose delete query",
  propose_chart_change: "Propose chart change",
  list_dashboards: "List dashboards",
  get_dashboard: "Get dashboard",
  propose_new_dashboard: "Propose new dashboard",
  propose_add_widget: "Propose add chart",
  propose_remove_widget: "Propose remove chart",
  propose_dashboard_filter_change: "Propose filter change",
  propose_widget_mapping: "Propose filter mapping",
  propose_navigate: "Propose navigation",
  list_pipelines: "List pipelines",
  get_pipeline: "Get pipeline",
  propose_new_pipeline: "Propose new pipeline",
  propose_pipeline_edit: "Propose pipeline edit",
  propose_run_pipeline: "Propose run pipeline",
  propose_delete_pipeline: "Propose delete pipeline",
};

export function toolDisplayName(name: string): string {
  if (TOOL_DISPLAY_NAMES[name]) return TOOL_DISPLAY_NAMES[name]!;
  return name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Friendly proposal kind labels. */
export const PROPOSAL_KIND_LABELS: Record<string, string> = {
  query_edit: "Edit query",
  bulk_query_edit: "Bulk edit",
  chart_change: "Chart change",
  new_query: "New query",
  delete_query: "Delete query",
  new_dashboard: "New dashboard",
  add_widget: "Add chart",
  remove_widget: "Remove chart",
  dashboard_filter_change: "Dashboard filters",
  widget_mapping: "Filter mapping",
  navigate: "Navigate",
  new_pipeline: "New pipeline",
  pipeline_edit: "Edit pipeline",
  run_pipeline: "Run pipeline",
  delete_pipeline: "Delete pipeline",
};

export function proposalKindLabel(kind: string): string {
  return PROPOSAL_KIND_LABELS[kind] ?? kind.replace(/_/g, " ");
}
