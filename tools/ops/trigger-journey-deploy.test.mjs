import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, validateDeployPayload, buildDispatchArgs } from "./trigger-journey-deploy.mjs";

test("parseArgs parses valid arguments correctly", () => {
  const argv = [
    "--mode", "DEPLOY",
    "--backend-run-id", "12345",
    "--backend-artifact-id", "67890",
    "--backend-artifact-name", "backend-artifact",
    "--backend-archive-sha256", "a".repeat(64),
    "--data-run-id", "11111",
    "--data-artifact-id", "22222",
    "--data-artifact-name", "data-artifact",
    "--data-archive-sha256", "b".repeat(64),
    "--dry-run",
  ];
  const opts = parseArgs(argv);
  assert.equal(opts.mode, "DEPLOY");
  assert.equal(opts.backendRunId, "12345");
  assert.equal(opts.backendArtifactId, "67890");
  assert.equal(opts.backendArtifactName, "backend-artifact");
  assert.equal(opts.backendArchiveSha256, "a".repeat(64));
  assert.equal(opts.dataRunId, "11111");
  assert.equal(opts.dataArtifactId, "22222");
  assert.equal(opts.dataArtifactName, "data-artifact");
  assert.equal(opts.dataArchiveSha256, "b".repeat(64));
  assert.equal(opts.dryRun, true);
});

test("validateDeployPayload rejects invalid mode and non-hex SHA256", () => {
  const valid = {
    mode: "PREVIEW",
    backend_run_id: "100",
    backend_artifact_id: "200",
    backend_artifact_name: "backend",
    backend_archive_sha256: "0".repeat(64),
    data_run_id: "300",
    data_artifact_id: "400",
    data_artifact_name: "data",
    data_archive_sha256: "f".repeat(64),
  };
  assert.equal(validateDeployPayload(valid), true);

  assert.throws(() => validateDeployPayload({ ...valid, mode: "INVALID" }), /Invalid mode/);
  assert.throws(() => validateDeployPayload({ ...valid, backend_archive_sha256: "not-a-sha" }), /not a valid 64-hex/);
  assert.throws(() => validateDeployPayload({ ...valid, backend_run_id: "abc" }), /invalid or missing/);
});

test("buildDispatchArgs formats correct gh workflow run invocation", () => {
  const payload = {
    mode: "DEPLOY",
    backend_run_id: "123",
    backend_artifact_id: "456",
    backend_artifact_name: "backend-zip",
    backend_archive_sha256: "c".repeat(64),
    data_run_id: "789",
    data_artifact_id: "101",
    data_artifact_name: "data-zip",
    data_archive_sha256: "d".repeat(64),
  };
  const args = buildDispatchArgs(payload);
  assert.deepEqual(args, [
    "workflow",
    "run",
    "source-free-journey-k3s-deploy.yml",
    "-f", "mode=DEPLOY",
    "-f", "backend_run_id=123",
    "-f", "backend_artifact_id=456",
    "-f", "backend_artifact_name=backend-zip",
    "-f", `backend_archive_sha256=${"c".repeat(64)}`,
    "-f", "data_run_id=789",
    "-f", "data_artifact_id=101",
    "-f", "data_artifact_name=data-zip",
    "-f", `data_archive_sha256=${"d".repeat(64)}`,
  ]);
});
