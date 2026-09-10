import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isPipelineDefault,
  isStdlibRow,
  isVizBlockedImport,
  PIPELINE_DEFAULT_PACKAGES,
  VIZ_BLOCKED_PYPI,
} from "../src/services/packages.ts";

describe("package policy", () => {
  it("keeps requests installable for pipelines while viz-blocked", () => {
    assert.equal(isVizBlockedImport("requests"), true);
    assert.equal(isVizBlockedImport("pandas"), false);
    assert.ok(VIZ_BLOCKED_PYPI.has("requests"));
    assert.ok(PIPELINE_DEFAULT_PACKAGES.some((p) => p.package_name === "requests"));
    assert.equal(isPipelineDefault("requests"), true);
    assert.equal(isPipelineDefault("plotly"), false);
  });

  it("recognizes stdlib rows", () => {
    assert.equal(isStdlibRow("stdlib"), true);
    assert.equal(isStdlibRow("2.32.3"), false);
  });
});
