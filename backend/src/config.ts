import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3691),
  jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me",
  pythonEngineUrl: process.env.PYTHON_ENGINE_URL ?? "http://127.0.0.1:8765",
  pythonEngineToken: process.env.PYTHON_ENGINE_TOKEN ?? "dev-engine-token",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7",
  databaseFile: process.env.DATABASE_FILE ?? "./nicemeta.sqlite",
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
};
