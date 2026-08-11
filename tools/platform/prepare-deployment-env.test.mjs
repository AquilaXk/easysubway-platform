import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../..", import.meta.url);
const script = new URL("tools/deploy/prepare-deployment-env.sh", root);
const composeAllowlist = new URL("tools/deploy/compose-server-env.allowlist", root);
const backendAllowlist = new URL("tools/deploy/backend-app-env.allowlist", root);
const ciWorkflow = new URL(".github/workflows/ci.yml", root);

const receiptKey = "EASYSUBWAY_REPORT_RECEIPT_PEPPER";
const legacyReceiptKey = "EASYSUBWAY_REPORT_RECEIPT_TOKEN_PEPPER";
const intentKey = "EASYSUBWAY_REPORT_UPLOAD_INTENT_SIGNING_KEY";
const strongReceipt = "canonical-receipt-pepper-32-bytes-minimum";
const strongIntent = "canonical-upload-intent-key-32-bytes-minimum";
const sharedSecret = "shared-report-secret-value-with-enough-entropy";
const legacySecret = "sensitive-legacy-receipt-pepper-with-enough-entropy";

test("required Platform CI owns the canonical report-secret preparation contract", () => {
  const allowlist = readFileSync(backendAllowlist, "utf8").split("\n").filter(Boolean);
  assert.equal(allowlist.filter((key) => key === receiptKey).length, 1);
  assert.equal(allowlist.filter((key) => key === intentKey).length, 1);
  assert.equal(allowlist.includes(legacyReceiptKey), false);

  const ci = readFileSync(ciWorkflow, "utf8");
  assert.equal(
    ci.split("node --test tools/platform/prepare-deployment-env.test.mjs").length - 1,
    1,
  );
});

test("two distinct canonical report secrets are preserved without the legacy alias", () => {
  const fixture = makeFixture();
  try {
    const result = run(fixture);
    assert.equal(result.status, 0, result.stderr);
    const backendEnv = readFileSync(join(fixture.outputDirectory, "backend.env"), "utf8");
    assert.match(backendEnv, new RegExp(`^${receiptKey}=${strongReceipt}$`, "m"));
    assert.match(backendEnv, new RegExp(`^${intentKey}=${strongIntent}$`, "m"));
    assert.doesNotMatch(backendEnv, new RegExp(`^${legacyReceiptKey}=`, "m"));
  } finally {
    fixture.cleanup();
  }
});

test("break-glass credentials and reason are excluded from backend deployment env", () => {
  const breakGlassValues = {
    EASYSUBWAY_ADMIN_BREAK_GLASS_USERNAME: "synthetic-break-glass-username",
    EASYSUBWAY_ADMIN_BREAK_GLASS_PASSWORD: "synthetic-break-glass-password",
    EASYSUBWAY_ADMIN_BREAK_GLASS_REASON: "synthetic-break-glass-reason",
  };
  const bootstrapKey = "EASYSUBWAY_ADMIN_PLATFORM_FLAGS_BREAK_GLASS_BOOTSTRAP";
  const bootstrapValue = "synthetic-break-glass-bootstrap";
  const cases = [
    { EASYSUBWAY_ADMIN_BREAK_GLASS_USERNAME: breakGlassValues.EASYSUBWAY_ADMIN_BREAK_GLASS_USERNAME },
    { EASYSUBWAY_ADMIN_BREAK_GLASS_PASSWORD: breakGlassValues.EASYSUBWAY_ADMIN_BREAK_GLASS_PASSWORD },
    { EASYSUBWAY_ADMIN_BREAK_GLASS_REASON: breakGlassValues.EASYSUBWAY_ADMIN_BREAK_GLASS_REASON },
    breakGlassValues,
  ];

  for (const breakGlassCase of cases) {
    const fixture = makeFixture({ [bootstrapKey]: bootstrapValue, ...breakGlassCase });
    try {
      const result = run(fixture);
      assert.equal(result.status, 0, result.stderr);

      const backendEnv = readFileSync(join(fixture.outputDirectory, "backend.env"), "utf8");
      for (const [key, value] of Object.entries(breakGlassCase)) {
        assert.doesNotMatch(backendEnv, new RegExp(`^${key}=`, "m"));
        assert.equal(backendEnv.includes(value), false);
      }
      assert.match(backendEnv, /^EASYSUBWAY_ADMIN_USERNAME=admin$/m);
      assert.match(backendEnv, /^EASYSUBWAY_ADMIN_PASSWORD=synthetic-admin-password$/m);
      assert.match(backendEnv, new RegExp(`^${bootstrapKey}=${bootstrapValue}$`, "m"));
    } finally {
      fixture.cleanup();
    }
  }

  const allowlist = readFileSync(backendAllowlist, "utf8").split("\n").filter(Boolean);
  for (const key of Object.keys(breakGlassValues)) {
    assert.equal(allowlist.includes(key), false);
  }
  assert.equal(allowlist.includes(bootstrapKey), true);
});

test("missing weak legacy or equal report secrets fail before output publication", () => {
  const cases = [
    [{ [receiptKey]: undefined }, receiptKey],
    [{ [intentKey]: undefined }, intentKey],
    [{ [receiptKey]: "" }, receiptKey],
    [{ [intentKey]: "" }, intentKey],
    [{ [receiptKey]: "too-short" }, receiptKey],
    [{ [intentKey]: "too-short" }, intentKey],
    [{ [receiptKey]: "local-dev-report-receipt-pepper" }, receiptKey],
    [{ [intentKey]: "local-dev-report-upload-intent-signing-key" }, intentKey],
    [{ [receiptKey]: undefined, [intentKey]: undefined, [legacyReceiptKey]: legacySecret }, legacyReceiptKey],
    [{ [legacyReceiptKey]: legacySecret }, legacyReceiptKey],
    [{ [legacyReceiptKey]: "" }, legacyReceiptKey],
    [{ [receiptKey]: sharedSecret, [intentKey]: `  ${sharedSecret}  ` }, "서로 달라야"],
  ];

  for (const [overrides, expectedIdentity] of cases) {
    const fixture = makeFixture(overrides);
    try {
      const result = run(fixture);
      assert.equal(result.status, 1, JSON.stringify({ overrides: Object.keys(overrides), result }));
      assert.match(result.stderr, new RegExp(expectedIdentity));
      for (const secret of [strongReceipt, strongIntent, sharedSecret, legacySecret]) {
        assert.equal(result.stderr.includes(secret), false);
      }
      assert.deepEqual(
        existsSync(fixture.outputDirectory) ? readdirSync(fixture.outputDirectory) : [],
        [],
      );
    } finally {
      fixture.cleanup();
    }
  }
});

function makeFixture(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "platform-report-env-"));
  const sourceEnv = join(directory, "source.env");
  const outputDirectory = join(directory, "output");
  const values = new Map([
    ["EASYSUBWAY_ADMIN_USERNAME", "admin"],
    ["EASYSUBWAY_ADMIN_PASSWORD", "synthetic-admin-password"],
    ["EASYSUBWAY_POSTGRES_USER", "easysubway"],
    ["EASYSUBWAY_POSTGRES_PASSWORD", "synthetic-postgres-password"],
    ["EASYSUBWAY_DATASOURCE_URL", "jdbc:postgresql://postgres:5432/easysubway"],
    ["EASYSUBWAY_DATASOURCE_USERNAME", "easysubway"],
    ["EASYSUBWAY_DATASOURCE_PASSWORD", "synthetic-postgres-password"],
    ["EASYSUBWAY_REPORT_UPLOAD_BUCKET", "report-uploads"],
    ["EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY", "synthetic-access-key"],
    ["EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY", "synthetic-secret-key"],
    ["EASYSUBWAY_ADS_ASSET_ORIGIN", "https://assets.aquilaxk.site"],
    ["EASYSUBWAY_TAGO_TRAIN_SERVICE_KEY", "synthetic-tago-key"],
    ["EASYSUBWAY_ADS_EVENT_DAILY_CAP", "1"],
    ["EASYSUBWAY_ROUTE_V2_ORIGIN_SECRET", "a".repeat(43)],
    ["EASYSUBWAY_ROUTE_V2_PLAY_INTEGRITY_CERTIFICATE_SHA256", "b".repeat(43)],
    ["EASYSUBWAY_PLAY_INTEGRITY_CREDENTIALS_BASE64", "synthetic-play-integrity"],
    ["EASYSUBWAY_ROUTE_V2_TRUSTED_PROXY_CIDR", "172.16.0.0/12"],
    ["EASYSUBWAY_ROUTE_V2_SESSION_RATE_PER_MINUTE", "5"],
    ["EASYSUBWAY_ROUTE_V2_SESSION_BURST", "2"],
    ["EASYSUBWAY_ROUTE_V2_SEARCH_RATE_PER_MINUTE", "10"],
    ["EASYSUBWAY_ROUTE_V2_SEARCH_BURST", "3"],
    ["EASYSUBWAY_ROUTE_V2_SESSION_MAX_REQUESTS", "50"],
    ["EASYSUBWAY_BACKEND_BIND", "127.0.0.1"],
    ["EASYSUBWAY_REPORT_OBJECT_STORAGE_INTERNAL_ENDPOINT", "http://object-storage:9000"],
    ["EASYSUBWAY_REPORT_UPLOAD_PUBLIC_BASE_URL", "https://uploads.aquilaxk.site"],
    ["EASYSUBWAY_TRUSTED_PROXY_CIDRS", "172.16.0.0/12"],
    [receiptKey, strongReceipt],
    [intentKey, strongIntent],
  ]);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) values.delete(key);
    else values.set(key, value);
  }
  writeFileSync(sourceEnv, `${[...values].map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
  return {
    directory,
    sourceEnv,
    outputDirectory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function run(fixture) {
  return spawnSync("bash", [
    script.pathname,
    fixture.sourceEnv,
    composeAllowlist.pathname,
    backendAllowlist.pathname,
    fixture.outputDirectory,
  ], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
  });
}
