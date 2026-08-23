#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import path from "node:path";

export const HUB_REVISION = "e14964e588ef79b1cff6e01e18d8b943d7724420";
export const BUNDLE_SHA256 = "ffbfed08c46916a6a9f7e1bf3d3de46989fe4f2517ed341bd2e2f89e02b7ce58";
export const BUNDLE_URL = `https://raw.githubusercontent.com/AquilaXk/easysubway/${HUB_REVISION}/contracts/bundles/platform-contracts-v1.1.0.json`;
export const RESOURCE_IDENTITIES = Object.freeze([
  ["platform/deployment-contract.json", "e5fba2310dcda64ca1a25ada3d933a22058857c66bb4772c2cb7e44af8a59ad8"],
  ["platform/k3s-activation-contract.json", "5e5cc0aec2423e5568acc25d92ca47fb81ab314b390372d5b068d8178c4b54e2"],
  ["platform/k3s-runtime-contract.json", "ce226499224b3a3279d6bf1e41a181fc2a47afe100d9230411e3d782de36220b"],
  ["platform/k3s-runtime-contract.schema.json", "9b7a6d208d826a7046a80bab99d2c6856f4e59f15b923f9081926c95a8c88bdd"],
  ["platform/k3s-activation-receipt.schema.json", "bb4d9e3e57e52186f29a651cd514c095790cb10b36ddb60dfa490e80c16fe8b4"],
]);

export class PlatformContractBundleError extends Error {
  constructor(code) { super(code); this.name = "PlatformContractBundleError"; this.code = code; }
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function inspectPlatformContractBundle(bytes) {
  if (!Buffer.isBuffer(bytes) || sha256(bytes) !== BUNDLE_SHA256) throw new PlatformContractBundleError("HUB_BUNDLE_DIGEST_DRIFT");
  let bundle;
  try { bundle = JSON.parse(bytes.toString("utf8")); } catch { throw new PlatformContractBundleError("HUB_BUNDLE_MALFORMED"); }
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle) ||
    Object.keys(bundle).length !== 5 || bundle.schemaVersion !== 1 || bundle.bundleVersion !== "1.1.0" ||
    !/^[a-f0-9]{64}$/.test(bundle.componentManifestSchemaSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(bundle.issueRefSchemaSha256 ?? "") ||
    !bundle.resources || typeof bundle.resources !== "object" || Array.isArray(bundle.resources)) {
    throw new PlatformContractBundleError("HUB_BUNDLE_MALFORMED");
  }
  const keys = Object.keys(bundle.resources);
  if (keys.length !== RESOURCE_IDENTITIES.length || !keys.every((key, index) => key === RESOURCE_IDENTITIES[index][0])) {
    throw new PlatformContractBundleError("HUB_BUNDLE_RESOURCE_SET_DRIFT");
  }
  const resources = RESOURCE_IDENTITIES.map(([resourcePath, expectedSha256]) => {
    const value = bundle.resources[resourcePath];
    if (typeof value !== "string" || value.length === 0 || sha256(Buffer.from(value, "utf8")) !== expectedSha256) {
      throw new PlatformContractBundleError("HUB_BUNDLE_RESOURCE_DIGEST_DRIFT");
    }
    return { resourcePath, sha256: expectedSha256, bytes: Buffer.from(value, "utf8") };
  });
  const resourceSetSha256 = sha256(Buffer.from(resources.map(({ resourcePath, sha256: digest }) => `${resourcePath}\n${digest}\n`).join(""), "utf8"));
  return { resources, resourceSetSha256 };
}

export async function inspectStagedPlatformContractBundle({ runtimeContractPath, readStableFile }) {
  if (typeof runtimeContractPath !== "string" || !path.isAbsolute(runtimeContractPath) || typeof readStableFile !== "function") {
    throw new PlatformContractBundleError("HUB_BUNDLE_USAGE");
  }
  const bundleRoot = path.resolve(path.dirname(runtimeContractPath), "../..");
  const expectedRuntimePath = path.join(bundleRoot, "resources", "platform", "k3s-runtime-contract.json");
  if (runtimeContractPath !== expectedRuntimePath) throw new PlatformContractBundleError("HUB_BUNDLE_STAGING_DRIFT");
  const resources = await Promise.all(RESOURCE_IDENTITIES.map(async ([resourcePath, expectedSha256]) => {
    const bytes = await readStableFile(path.join(bundleRoot, "resources", resourcePath));
    if (sha256(bytes) !== expectedSha256) throw new PlatformContractBundleError("HUB_BUNDLE_STAGING_DRIFT");
    return { resourcePath, sha256: `sha256:${expectedSha256}` };
  }));
  const evidenceBytes = await readStableFile(path.join(bundleRoot, "evidence.json"));
  let evidence;
  try { evidence = JSON.parse(evidenceBytes.toString("utf8")); } catch { throw new PlatformContractBundleError("HUB_BUNDLE_STAGING_DRIFT"); }
  const resourceSetSha256 = `sha256:${sha256(Buffer.from(resources.map((entry) => `${entry.resourcePath}\n${entry.sha256.slice(7)}\n`).join(""), "utf8"))}`;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) ||
    Object.keys(evidence).length !== 6 || evidence.schemaVersion !== "PLATFORM_HUB_BUNDLE_ACQUISITION_EVIDENCE_V1" ||
    evidence.artifactKind !== "platform-hub-bundle-acquisition-evidence" || evidence.hubRevision !== HUB_REVISION ||
    evidence.bundleSha256 !== `sha256:${BUNDLE_SHA256}` || evidence.resourceSetSha256 !== resourceSetSha256 ||
    JSON.stringify(evidence.resources) !== JSON.stringify(resources)) throw new PlatformContractBundleError("HUB_BUNDLE_STAGING_DRIFT");
  return {
    hubRevision: HUB_REVISION,
    bundleSha256: `sha256:${BUNDLE_SHA256}`,
    resourceSetSha256,
    acquisitionEvidenceDigest: `sha256:${sha256(evidenceBytes)}`,
    runtimeContractPath,
  };
}

export async function acquirePlatformContractBundle({ outputRoot, fetchImpl = fetch }) {
  if (typeof outputRoot !== "string" || !path.isAbsolute(outputRoot) || typeof fetchImpl !== "function") throw new PlatformContractBundleError("HUB_BUNDLE_USAGE");
  let stage;
  try {
    const response = await fetchImpl(BUNDLE_URL, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response || response.status !== 200 || response.redirected) throw new PlatformContractBundleError("HUB_BUNDLE_UNAVAILABLE");
    const bytes = Buffer.from(await response.arrayBuffer());
    const inspected = inspectPlatformContractBundle(bytes);
    stage = await mkdtemp(path.join(path.dirname(outputRoot), ".platform-contract-bundle-"));
    for (const resource of inspected.resources) await writeCreateOnly(path.join(stage, "resources", resource.resourcePath), resource.bytes);
    const evidence = {
      schemaVersion: "PLATFORM_HUB_BUNDLE_ACQUISITION_EVIDENCE_V1", artifactKind: "platform-hub-bundle-acquisition-evidence",
      hubRevision: HUB_REVISION, bundleSha256: `sha256:${BUNDLE_SHA256}`, resourceSetSha256: `sha256:${inspected.resourceSetSha256}`,
      resources: inspected.resources.map(({ resourcePath, sha256: digest }) => ({ resourcePath, sha256: `sha256:${digest}` })),
    };
    const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    await writeCreateOnly(path.join(stage, "evidence.json"), evidenceBytes);
    await lstat(outputRoot).then(() => { throw new PlatformContractBundleError("HUB_BUNDLE_OUTPUT_EXISTS"); }, (error) => { if (error?.code !== "ENOENT") throw error; });
    await rename(stage, outputRoot);
    stage = undefined;
    return { ...evidence, evidenceSha256: `sha256:${sha256(evidenceBytes)}`, outputRoot };
  } catch (error) {
    if (stage) await rm(stage, { recursive: true, force: true });
    if (error instanceof PlatformContractBundleError) throw error;
    throw new PlatformContractBundleError("HUB_BUNDLE_UNAVAILABLE");
  }
}

async function writeCreateOnly(target, bytes) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle?.close(); }
}

function parseCli(args) {
  if (args.length !== 2 || args[0] !== "--output-root") throw new PlatformContractBundleError("HUB_BUNDLE_USAGE");
  return { outputRoot: args[1] };
}
async function main() {
  try {
    const result = await acquirePlatformContractBundle(parseCli(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code ?? "HUB_BUNDLE_UNAVAILABLE"}\n`);
    process.exitCode = 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main();
}
