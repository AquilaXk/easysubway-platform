#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SHA256_RE = /^[0-9a-f]{64}$/;
const NUM_RE = /^[0-9]+$/;

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    mode: "PREVIEW",
    backendRunId: null,
    backendArtifactId: null,
    backendArtifactName: null,
    backendArchiveSha256: null,
    dataRunId: null,
    dataArtifactId: null,
    dataArtifactName: null,
    dataArchiveSha256: null,
    backendVersion: null,
    datapackSequence: null,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--mode") {
      options.mode = argv[++i];
    } else if (arg === "--backend-run-id") {
      options.backendRunId = argv[++i];
    } else if (arg === "--backend-artifact-id") {
      options.backendArtifactId = argv[++i];
    } else if (arg === "--backend-artifact-name") {
      options.backendArtifactName = argv[++i];
    } else if (arg === "--backend-archive-sha256") {
      options.backendArchiveSha256 = argv[++i];
    } else if (arg === "--data-run-id") {
      options.dataRunId = argv[++i];
    } else if (arg === "--data-artifact-id") {
      options.dataArtifactId = argv[++i];
    } else if (arg === "--data-artifact-name") {
      options.dataArtifactName = argv[++i];
    } else if (arg === "--data-archive-sha256") {
      options.dataArchiveSha256 = argv[++i];
    } else if (arg === "--backend-version") {
      options.backendVersion = argv[++i];
    } else if (arg === "--datapack-sequence") {
      options.datapackSequence = argv[++i];
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

export function validateDeployPayload(payload) {
  if (!["PREVIEW", "DEPLOY"].includes(payload.mode)) {
    throw new Error(`Invalid mode: ${payload.mode}. Must be PREVIEW or DEPLOY.`);
  }

  const requiredFields = [
    ["backend_run_id", payload.backend_run_id, NUM_RE],
    ["backend_artifact_id", payload.backend_artifact_id, NUM_RE],
    ["data_run_id", payload.data_run_id, NUM_RE],
    ["data_artifact_id", payload.data_artifact_id, NUM_RE],
  ];

  for (const [name, val, regex] of requiredFields) {
    if (!val || (regex && !regex.test(val))) {
      throw new Error(`Field ${name} is invalid or missing: ${val}`);
    }
  }

  if (!payload.backend_artifact_name || typeof payload.backend_artifact_name !== "string") {
    throw new Error("backend_artifact_name must be non-empty string");
  }
  if (!payload.data_artifact_name || typeof payload.data_artifact_name !== "string") {
    throw new Error("data_artifact_name must be non-empty string");
  }

  if (!SHA256_RE.test(payload.backend_archive_sha256)) {
    throw new Error(`backend_archive_sha256 is not a valid 64-hex SHA-256: ${payload.backend_archive_sha256}`);
  }
  if (!SHA256_RE.test(payload.data_archive_sha256)) {
    throw new Error(`data_archive_sha256 is not a valid 64-hex SHA-256: ${payload.data_archive_sha256}`);
  }

  return true;
}

export async function resolveArtifactDetails({ repo, runId, exec = execFileSync }) {
  const stdout = exec(
    "gh",
    ["api", `/repos/${repo}/actions/runs/${runId}/artifacts`],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  );
  const data = JSON.parse(stdout);
  if (!data.artifacts || data.artifacts.length === 0) {
    throw new Error(`No artifacts found for run ${runId} in ${repo}`);
  }
  const artifact = data.artifacts[0];
  return {
    id: String(artifact.id),
    name: artifact.name,
    digest: artifact.digest ? artifact.digest.replace(/^sha256:/, "") : null,
  };
}

export function buildDispatchArgs(payload) {
  validateDeployPayload(payload);
  return [
    "workflow",
    "run",
    "source-free-journey-k3s-deploy.yml",
    "-f", `mode=${payload.mode}`,
    "-f", `backend_run_id=${payload.backend_run_id}`,
    "-f", `backend_artifact_id=${payload.backend_artifact_id}`,
    "-f", `backend_artifact_name=${payload.backend_artifact_name}`,
    "-f", `backend_archive_sha256=${payload.backend_archive_sha256}`,
    "-f", `data_run_id=${payload.data_run_id}`,
    "-f", `data_artifact_id=${payload.data_artifact_id}`,
    "-f", `data_artifact_name=${payload.data_artifact_name}`,
    "-f", `data_archive_sha256=${payload.data_archive_sha256}`,
  ];
}

export async function runCli(argv = process.argv.slice(2), { exec = execFileSync } = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(`
Usage: node tools/ops/trigger-journey-deploy.mjs [options]

Trigger or validate K3s deployment for EasySubway Journey.

Options:
  --mode <PREVIEW|DEPLOY>            Execution mode (default: PREVIEW)
  --backend-run-id <id>              Backend release run ID
  --backend-artifact-id <id>         Backend release artifact ID
  --backend-artifact-name <name>     Backend artifact name
  --backend-archive-sha256 <hash>    Backend archive SHA-256
  --data-run-id <id>                 Data FINAL release run ID
  --data-artifact-id <id>            Data artifact ID
  --data-artifact-name <name>        Data artifact name
  --data-archive-sha256 <hash>       Data archive SHA-256
  --dry-run                          Print dispatch command without executing
  -h, --help                         Show this help message
`);
    return 0;
  }

  const payload = {
    mode: options.mode,
    backend_run_id: options.backendRunId,
    backend_artifact_id: options.backendArtifactId,
    backend_artifact_name: options.backendArtifactName,
    backend_archive_sha256: options.backendArchiveSha256,
    data_run_id: options.dataRunId,
    data_artifact_id: options.dataArtifactId,
    data_artifact_name: options.dataArtifactName,
    data_archive_sha256: options.dataArchiveSha256,
  };

  validateDeployPayload(payload);
  const dispatchArgs = buildDispatchArgs(payload);

  if (options.dryRun) {
    console.log(`gh ${dispatchArgs.join(" ")}`);
    return 0;
  }

  exec("gh", dispatchArgs, { stdio: "inherit" });
  return 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runCli().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
