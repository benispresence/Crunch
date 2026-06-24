import { z } from "zod";

/**
 * Per-query parameter declaration. Mirrors the Metabase model: each
 * variable picked up from `{{var}}` in the SQL gets a row with a
 * type, optional default, and a UI widget hint. The python engine
 * uses the same `name/type/default/required` fields for substitution.
 */
export const parameterTypeSchema = z.enum(["text", "number", "date", "boolean"]);
export type ParameterType = z.infer<typeof parameterTypeSchema>;

export const parameterWidgetSchema = z.enum([
  "input",
  "dropdown",
  "date",
  "toggle",
]);

export const parameterSpecSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be alphanumeric/underscore"),
  display_name: z.string().optional(),
  type: parameterTypeSchema.default("text"),
  default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  required: z.boolean().default(false),
  widget: parameterWidgetSchema.optional(),
  // For dropdown widgets — a static list of options. Empty for free input.
  options: z.array(z.string()).optional(),
});
export type ParameterSpec = z.infer<typeof parameterSpecSchema>;

export const parameterSpecArraySchema = z.array(parameterSpecSchema);

/** Dashboard-level filter (the chip the user toggles in the bar). */
export const dashboardFilterSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: parameterTypeSchema.default("text"),
  default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  widget: parameterWidgetSchema.optional(),
  options: z.array(z.string()).optional(),
});
export type DashboardFilter = z.infer<typeof dashboardFilterSchema>;

export const dashboardFiltersSchema = z.array(dashboardFilterSchema);

/** Map dashboard filter id → param name on the widget's query. */
export const widgetParameterMappingSchema = z.record(z.string(), z.string());
export type WidgetParameterMapping = z.infer<typeof widgetParameterMappingSchema>;

/** Per-run user-supplied values (whatever the input widgets emit). */
export const parameterValuesSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
export type ParameterValues = z.infer<typeof parameterValuesSchema>;

export function safeParseSpecs(raw: string): ParameterSpec[] {
  try {
    const parsed = parameterSpecArraySchema.safeParse(JSON.parse(raw || "[]"));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function safeParseFilters(raw: string): DashboardFilter[] {
  try {
    const parsed = dashboardFiltersSchema.safeParse(JSON.parse(raw || "[]"));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function safeParseMapping(raw: string): WidgetParameterMapping {
  try {
    const parsed = widgetParameterMappingSchema.safeParse(JSON.parse(raw || "{}"));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/**
 * Resolve the parameter values that get sent to the python engine
 * for a single widget. Dashboard filter values are translated through
 * the widget's mapping table; any explicit `widgetOverrides` (e.g.
 * preview pane on the dashboard editor) win.
 */
export function resolveWidgetParameterValues(opts: {
  filters: DashboardFilter[];
  filterValues: ParameterValues;
  mapping: WidgetParameterMapping;
  widgetOverrides?: ParameterValues;
}): ParameterValues {
  const out: ParameterValues = {};
  for (const f of opts.filters) {
    const paramName = opts.mapping[f.id];
    if (!paramName) continue;
    const v = opts.filterValues[f.id];
    if (v !== undefined && v !== null && v !== "") {
      out[paramName] = v;
    } else if (f.default !== undefined && f.default !== null && f.default !== "") {
      out[paramName] = f.default;
    }
  }
  return { ...out, ...(opts.widgetOverrides ?? {}) };
}
