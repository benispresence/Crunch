import { request } from "undici";
import { config } from "../config.js";

interface EngineRequest {
  path: string;
  body: Record<string, unknown>;
}

async function call<T>({ path, body }: EngineRequest): Promise<T> {
  const { statusCode, body: resBody } = await request(`${config.pythonEngineUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, token: config.pythonEngineToken }),
  });
  const text = await resBody.text();
  if (statusCode >= 400) {
    throw new Error(`python engine ${path} failed (${statusCode}): ${text}`);
  }
  return JSON.parse(text) as T;
}

export interface SqlResult {
  success: boolean;
  columns: string[];
  rows: unknown[][];
  row_count: number;
  execution_time_ms: number;
  error?: string;
}

export interface ChartResult {
  success: boolean;
  spec?: Record<string, unknown>;
  html?: string;
  error?: string;
}

export interface PythonResult {
  success: boolean;
  spec?: Record<string, unknown>;
  stdout: string;
  error?: string;
}

export const pythonEngine = {
  validateSql: (sql: string) =>
    call<{ valid: boolean; error?: string }>({ path: "/sql/validate", body: { sql } }),

  executeSql: (params: { connection: Record<string, unknown>; sql: string; limit?: number }) =>
    call<SqlResult>({ path: "/sql/execute", body: params }),

  renderChart: (params: {
    chart_type: string;
    renderer?: string;
    data: Record<string, unknown[]>;
    config?: Record<string, unknown>;
  }) => call<ChartResult>({ path: "/viz/render", body: params }),

  executePython: (params: {
    code: string;
    data?: Record<string, unknown[]>;
    allowed_packages?: string[];
    timeout_seconds?: number;
  }) => call<PythonResult>({ path: "/python/execute", body: params }),

  installPackage: (name: string, versionSpec?: string) =>
    call<{ success: boolean; version?: string; error?: string }>({
      path: "/packages/install",
      body: { package_name: name, version_spec: versionSpec },
    }),

  uninstallPackage: (name: string) =>
    call<{ success: boolean; error?: string }>({
      path: "/packages/uninstall",
      body: { package_name: name },
    }),

  health: async () => {
    const { statusCode, body } = await request(`${config.pythonEngineUrl}/health`);
    return { ok: statusCode === 200, body: await body.text() };
  },
};
