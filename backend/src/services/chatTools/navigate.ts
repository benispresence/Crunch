/**
 * Cross-surface navigation proposal. Distinct from the mutation
 * proposals: accept = router.push, never a DB write.
 */

import type { ToolHandler, ToolModule } from "./types.js";

const propose_navigate: ToolHandler = (_ctx, input) => ({
  success: true,
  proposal: {
    kind: "navigate",
    to: input.to as string,
    query_id: input.query_id as number | undefined,
    dashboard_id: input.dashboard_id as number | undefined,
    pipeline_id: input.pipeline_id as number | undefined,
    rationale: input.rationale as string | undefined,
  },
});

export const navigateTools: ToolModule = {
  tools: [
    {
      name: "propose_navigate",
      description:
        "Propose moving the user's UI to either the workspace (optionally opening a specific saved query), a dashboard detail page, or a pipeline detail page. Use this when the natural next step is to look at something in a different surface. With auto-accept on, navigation happens immediately.",
      input_schema: {
        type: "object",
        properties: {
          to: { type: "string", description: "'workspace' | 'dashboard' | 'pipeline' | 'pipelines'" },
          query_id: { type: "number", description: "If to=workspace, the saved query to open" },
          dashboard_id: { type: "number", description: "If to=dashboard, the dashboard to open" },
          pipeline_id: { type: "number", description: "If to=pipeline, the pipeline to open" },
          rationale: { type: "string" },
        },
        required: ["to"],
      },
    },
  ],
  handlers: { propose_navigate },
};
