#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";

try {
  const options = parseArguments(process.argv.slice(2));
  for (const key of ["contract", "manifest", "evidence"]) assertFile(options[key], key);
  const contract = readJson(options.contract);
  const manifest = readJson(options.manifest);
  const runId = Number(options.runId);
  const gitSha = manifest.gitSha;
  const digest = manifest?.artifactIdentity?.imageDigest;
  const evidenceSha256 = createHash("sha256").update(readFileSync(options.evidence)).digest("hex");
  const matches = (pattern, value) => typeof value === "string" && new RegExp(pattern).test(value);

  if (contract.schemaVersion !== 1 || contract.artifactKind !== "platform-deployment-contract" || contract.contractVersion !== "platform-v1") throw new Error("invalid deployment contract");
  if (!contract.allowedProducerRepositories.includes(options.producerRepository) || manifest.repository !== options.producerRepository) throw new Error("producer repository mismatch");
  if (!Number.isSafeInteger(runId) || runId < 1) throw new Error("invalid run id");
  if (!matches(contract.gitShaPattern, gitSha) || !matches(contract.artifactNamePattern, options.artifactName) || !options.artifactName.endsWith(gitSha)) throw new Error("artifact identity mismatch");
  if (!matches(contract.sha256Pattern, options.artifactSha256)) throw new Error("invalid artifact sha256");
  if (manifest.schemaVersion !== 1 || manifest.component !== "backend" || manifest.contractVersion !== manifest?.artifactIdentity?.apiContractVersion) throw new Error("invalid backend manifest");
  if (!matches(contract.imageDigestPattern, digest) || manifest.evidenceSha256 !== evidenceSha256) throw new Error("invalid backend evidence");
  if (!Array.isArray(manifest.issueRefs) || manifest.issueRefs.length === 0 || manifest.issueRefs.some((value) => !matches(contract.issueRefPattern, value))) throw new Error("invalid issue refs");

  process.stdout.write(`${JSON.stringify({
    repository: options.producerRepository,
    runId,
    artifactName: options.artifactName,
    artifactSha256: options.artifactSha256,
    backendGitSha: gitSha,
    image: `${contract.imageRepository}@${digest}`,
    imageDigest: digest,
    evidenceSha256,
  })}\n`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

function parseArguments(arguments_) {
  const names = ["contract", "manifest", "evidence", "producer-repository", "run-id", "artifact-name", "artifact-sha256"];
  const allowed = new Set(names.map((name) => `--${name}`));
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!allowed.has(key)) throw new Error(`unknown option: ${key}`);
    if (!value || value.startsWith("--")) throw new Error(`missing value: ${key}`);
    if (values.has(key)) throw new Error(`duplicate option: ${key}`);
    values.set(key, value);
  }
  if (values.size !== names.length) throw new Error("all deployment inputs are required");
  return Object.fromEntries(names.map((name) => [name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), values.get(`--${name}`)]));
}

function assertFile(path, label) {
  if (!lstatSync(path).isFile()) throw new Error(`${label} must be a regular file`);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path)); } catch { throw new Error(`invalid JSON: ${path}`); }
}
