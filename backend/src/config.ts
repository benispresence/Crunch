import path from "node:path";
import "dotenv/config";

const DEV_JWT_SECRET = "dev-secret-change-me";
const DEV_ENGINE_TOKEN = "dev-engine-token";

const isDev = (process.env.NODE_ENV ?? "development") !== "production";
const jwtSecret = process.env.JWT_SECRET ?? DEV_JWT_SECRET;
const engineToken = process.env.PYTHON_ENGINE_TOKEN ?? DEV_ENGINE_TOKEN;

// Hard boot-time check: in production the operator MUST set strong values
// for JWT_SECRET and PYTHON_ENGINE_TOKEN. Default values would let anyone
// who reads the source forge admin tokens or call the engine directly.
if (!isDev) {
  const errs: string[] = [];
  if (!process.env.JWT_SECRET || jwtSecret === DEV_JWT_SECRET) {
    errs.push("JWT_SECRET is unset or matches the dev default. Set it to a long random string.");
  }
  if (!process.env.PYTHON_ENGINE_TOKEN || engineToken === DEV_ENGINE_TOKEN) {
    errs.push(
      "PYTHON_ENGINE_TOKEN is unset or matches the dev default. Set it to a long random string and pass the same value to the python-engine process.",
    );
  }
  if (errs.length > 0) {
    console.error("\nRefusing to start: production secrets are not configured.\n");
    for (const e of errs) console.error("  - " + e);
    console.error("\nFor local development, run with NODE_ENV=development.\n");
    process.exit(1);
  }
}

export const config = {
  port: Number(process.env.PORT ?? 3691),
  isDev,
  jwtSecret,
  pythonEngineUrl: process.env.PYTHON_ENGINE_URL ?? "http://127.0.0.1:8765",
  pythonEngineToken: engineToken,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7",
  databaseFile: process.env.DATABASE_FILE ?? "./nicemeta.sqlite",
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  // Browser-facing origin of the deployment, used to build OAuth redirect
  // URIs that must match exactly across registration + authorize + token.
  // Prefer the explicit pin (shared with OIDC/SAML); otherwise fall back to
  // the frontend origin (CORS_ORIGIN) — http://localhost:8080 in the docker
  // stack, http://localhost:5173 in native dev.
  publicBaseUrl: (
    process.env.NICEMETA_PUBLIC_BASE_URL ??
    process.env.CORS_ORIGIN ??
    "http://localhost:5173"
  ).replace(/\/+$/, ""),
  // Local working tree mirrored to git for queries / dashboards / viz.
  // Default to the existing repo-root nicemeta-workspace directory.
  workspaceDir:
    process.env.NICEMETA_WORKSPACE_DIR ??
    path.resolve(process.cwd(), "..", "nicemeta-workspace"),
  // Symmetric key for at-rest secret encryption (connection passwords,
  // anthropic api key). Optional in dev; required in prod (see below).
  dataKey: process.env.DATA_KEY ?? "",
  // Optional containment for File connections. When set, the engine
  // refuses local paths outside this directory. Cloud URIs
  // (s3://, gs://, https://) are unaffected. Strongly recommended
  // for multi-tenant deployments — otherwise a user can point at
  // /etc/passwd or /home/*/.ssh and have it parsed as CSV.
  fileSourceRoot: process.env.NICEMETA_FILE_SOURCE_ROOT ?? "",
};

if (!isDev && !config.dataKey) {
  console.error("\nRefusing to start: DATA_KEY is required in production.\n");
  console.error("  Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
  console.error("  and set it as DATA_KEY in your environment.\n");
  process.exit(1);
}
