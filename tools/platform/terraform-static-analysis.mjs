import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const inventoryRelativePath = "tools/platform/terraform-root-inventory.json";
const policyRelativePath = "tools/platform/terraform-static-analysis-policy.json";
const tflintConfigRelativePath = ".tflint.hcl";
const tflintInfoUri = "https://github.com/terraform-linters/tflint";
const scannerNames = new Set(["TFLINT", "CHECKOV"]);
const requiredPolicyKeys = ["schemaVersion", "artifactKind", "inventoryPath", "toolchain", "execution", "report", "suppressions"];
const requiredSuppressionKeys = ["scanner", "ruleId", "rootId", "path", "resourceAddress", "resourceIdentitySource", "disposition", "reason", "impact", "ownerIssueUrl", "ownerIssueTitle", "ownerIssueState", "removalCondition", "expiresAt"];
const resultKeys = ["schemaVersion", "artifactKind", "sourceSha", "inventory", "policy", "configuration", "tools", "roots", "reports", "findings", "summary", "outcome"];
const findingKeys = ["scanner", "ruleId", "rootId", "path", "resourceAddress", "resourceIdentitySource", "disposition"];
const scanKeys = ["scanner", "rootId", "rootPath", "exit", "rawSarifPath", "rawSarifSha256", "structuredJsonPath", "structuredJsonSha256"];
const fixtureKeys = ["scanner", "fixturePath", "sourceSha256", "expectedRuleId", "exit", "rawSarifPath", "rawSarifSha256", "structuredJsonPath", "structuredJsonSha256"];
const toolCheckKeys = ["scanner", "version", "ruleset", "stdoutSha256"];
const rawToolCheckKeys = ["scanner", "version", "ruleset", "exit", "stdoutPath", "stdoutSha256", "stderrPath", "stderrSha256"];
const cleanCheckovSummaryKeys = ["passed", "failed", "skipped", "parsing_errors", "resource_count", "checkov_version"];

function fail(message) { throw new Error(`terraform static analysis: ${message}`); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function compareCodepoint(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value)) !== JSON.stringify(keys)) fail(`${label} keys must be exact`);
}
function safeRelativePath(path) {
  return typeof path === "string" && path.length > 0 && !/[\u0000-\u001f\u007f]/.test(path) && !isAbsolute(path) && !/^[a-zA-Z]:[\\/]/.test(path) && !path.startsWith("\\\\") && !path.startsWith("//") && !path.startsWith("./") && !path.split("/").includes("..") && !path.split("/").includes(".") && !path.split("/").includes("");
}
function readCanonicalJson(path) {
  const bytes = readFileSync(path, "utf8");
  if (bytes.includes("\r") || bytes !== `${bytes.trimEnd()}\n`) fail(`${path} must be LF-terminated canonical JSON`);
  try { return { bytes, value: JSON.parse(bytes) }; } catch { fail(`${path} is malformed JSON`); }
}
function readJson(path) {
  const bytes = readFileSync(path, "utf8");
  try { return { bytes, value: JSON.parse(bytes) }; } catch { fail(`${path} is malformed JSON`); }
}
function readRepositoryJson(relativePath) { return readCanonicalJson(resolve(repository, relativePath)); }
function within(parent, candidate) { return candidate === parent || candidate.startsWith(`${parent}/`); }
function canonicalTemporaryRoot(root, label) {
  if (typeof root !== "string" || root.length === 0 || !isAbsolute(root) || root !== resolve(root)) fail(`${label} is invalid`);
  const metadata = lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(`${label} must be a real directory`);
  return realpathSync(root);
}
function runDirectory(reportDirectory, approvedRoot) {
  if (typeof reportDirectory !== "string" || !isAbsolute(reportDirectory) || reportDirectory !== resolve(reportDirectory)) fail("report directory identity is invalid");
  const metadata = lstatSync(reportDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("report directory must be a real directory");
  const canonicalDirectory = realpathSync(reportDirectory);
  if (!within(approvedRoot, canonicalDirectory)) fail("report directory escapes the task-owned temp root");
  return canonicalDirectory;
}
function productionReportDirectory() {
  const runnerTemp = process.env.RUNNER_TEMP;
  const canonicalRunnerTemp = canonicalTemporaryRoot(runnerTemp, "RUNNER_TEMP");
  return runDirectory(resolve(canonicalRunnerTemp, "terraform-static-analysis"), canonicalRunnerTemp);
}
function testReportDirectory(reportDirectory) {
  return runDirectory(reportDirectory, canonicalTemporaryRoot(process.env.RUNNER_TEMP ?? tmpdir(), "test report root"));
}
function resolvedRunDirectory({ reportDirectory, approvedRoot }) {
  return approvedRoot === undefined ? testReportDirectory(reportDirectory) : runDirectory(reportDirectory, approvedRoot);
}
function productionInput() {
  const reportDirectory = productionReportDirectory();
  return { reportDirectory, approvedRoot: reportDirectory };
}
function internalPath(directory, path) {
  if (!safeRelativePath(path)) fail("internal report path is unsafe");
  if (typeof directory !== "string" || !isAbsolute(directory) || directory !== resolve(directory)) fail("current run directory identity is invalid");
  const directoryMetadata = lstatSync(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) fail("current run directory must be a real directory");
  const canonicalDirectory = realpathSync(directory);
  const absolute = resolve(canonicalDirectory, path);
  if (!within(canonicalDirectory, absolute)) fail("internal report path escapes the current run");
  const parent = realpathSync(dirname(absolute));
  if (!within(canonicalDirectory, parent)) fail("internal report parent escapes the current run");
  if (existsSync(absolute)) {
    const metadata = lstatSync(absolute);
    if (metadata.isSymbolicLink() || !within(canonicalDirectory, realpathSync(absolute))) fail("internal report path escapes the current run");
  }
  return absolute;
}
function normalizeSarifPath(uri) {
  if (typeof uri !== "string" || !uri) fail("SARIF location is missing");
  let decoded;
  try { decoded = decodeURIComponent(uri); } catch { fail("SARIF URI cannot be decoded exactly once"); }
  const normalized = decoded.replaceAll("\\", "/");
  if (!safeRelativePath(normalized)) fail("SARIF location is unsafe");
  return normalized;
}
function normalizeCheckovJsonPath(path) {
  if (typeof path !== "string" || !path) fail("Checkov JSON path is missing");
  const normalized = path.replaceAll("\\", "/").replace(/^\//, "");
  if (!safeRelativePath(normalized)) fail("Checkov JSON path is unsafe");
  return normalized;
}
function prefixedRootPath(rootPath, relativePath) {
  if (!safeRelativePath(rootPath) || !safeRelativePath(relativePath)) fail("root-relative path is unsafe");
  return `${rootPath}/${relativePath}`;
}
function canonical(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function writeJson(path, value) { writeFileSync(path, canonical(value)); }
function rawRecordsPath(directory) { return internalPath(directory, ".scanner-exits.json"); }
function fixtureRecordsPath(directory) { return internalPath(directory, ".fixture-checks.json"); }
function toolRecordsPath(directory) { return internalPath(directory, ".tool-checks.json"); }
function markerPath(directory) { return internalPath(directory, ".enforced-success.json"); }
function readRecords(path) { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : []; }
const fixtureRegistry = [
  { scanner: "CHECKOV", id: "checkov-oci-public-bucket", fixturePath: "tools/platform/fixtures/terraform-static-analysis/checkov-oci-public-bucket.tf.fixture", expectedRuleId: "CKV_OCI_10" },
  { scanner: "CHECKOV", id: "checkov-oci-unrestricted-ssh", fixturePath: "tools/platform/fixtures/terraform-static-analysis/checkov-oci-unrestricted-ssh.tf.fixture", expectedRuleId: "CKV_OCI_19" },
  { scanner: "TFLINT", id: "tflint-required-version", fixturePath: "tools/platform/fixtures/terraform-static-analysis/tflint-required-version.tf.fixture", expectedRuleId: "terraform_required_version" },
];
const toolReportPaths = {
  TFLINT: { stdoutPath: "tflint-version.stdout", stderrPath: "tflint-version.stderr" },
  CHECKOV: { stdoutPath: "checkov-version.stdout", stderrPath: "checkov-version.stderr" },
};
function expectedRoots(inventory) { return inventory.roots.flatMap(({ id, path }) => [["CHECKOV", id, path], ["TFLINT", id, path]]).sort((a, b) => compareCodepoint(JSON.stringify(a), JSON.stringify(b))); }
function expectedFixtures() { return fixtureRegistry.map(({ scanner, fixturePath, expectedRuleId }) => [scanner, fixturePath, expectedRuleId]); }
function scanReportPaths(scanner, rootId) {
  if (!scannerNames.has(scanner) || typeof rootId !== "string" || !rootId) fail("scan identity is invalid");
  const prefix = `${scanner.toLowerCase()}-${rootId}`;
  return { rawSarifPath: `${prefix}.sarif`, structuredJsonPath: scanner === "TFLINT" ? null : `${prefix}.json` };
}
function fixtureDefinition(scanner, fixtureId) {
  const fixture = fixtureRegistry.find((item) => item.scanner === scanner && item.id === fixtureId);
  if (!fixture) fail("fixture identity is invalid");
  return fixture;
}
function fixtureReportPaths(scanner, fixtureId) {
  fixtureDefinition(scanner, fixtureId);
  const prefix = `fixture-${fixtureId}`;
  return { rawSarifPath: `${prefix}.sarif`, structuredJsonPath: scanner === "TFLINT" ? null : `${prefix}.json` };
}
function inventoryRoot(rootId) {
  const root = loadInventory().inventory.roots.find((item) => item.id === rootId);
  if (!root) fail("inventory root identity is invalid");
  return root;
}
const approvedSuppressionRows = [
  ["CKV_OCI_10", "datapack_object_storage.tf", "oci_objectstorage_bucket.datapack", "ACCEPTED_BOUNDED_RISK", "ObjectReadWithoutList로 known immutable datapack object GET만 허용하고 bucket list는 금지하는 현재 제품 전달 계약", "object URL을 아는 비인증 사용자가 해당 datapack object를 읽고 재전달할 수 있음", "40", "[Security][Platform][P1] public datapack private delivery로 CKV_OCI_10 bounded risk 제거", "지원 consumer의 private delivery 전환, public URL 의존 0, NoPublicAccess 적용·anonymous GET/list 실패, CKV_OCI_10 0, policy decision 삭제"],
  ["CKV_OCI_7", "datapack_object_storage.tf", "oci_objectstorage_bucket.datapack", "NOT_APPLICABLE_WITH_REASON", "현재 승인된 datapack delivery에는 object event를 소비하는 운영 계약이 없고 event emission만으로 보안·감사 결과가 생성되지 않음", "향후 object mutation audit·SIEM·event-driven lifecycle 요구가 생기면 현재 decision이 그 요구를 충족하지 못함", "46", "[Security][Platform][P2] datapack bucket object-event 필요성 판정 및 CKV_OCI_7 decision", "승인된 object-event consumer·retention·alert/audit owner·failure handling 확정, CKV_OCI_7 0, policy decision 삭제"],
  ["CKV_OCI_9", "datapack_object_storage.tf", "oci_objectstorage_bucket.datapack", "ACCEPTED_BOUNDED_RISK", "현재 OCI provider-managed encryption에 의존하며 승인된 Vault/key/IAM/rotation/recovery architecture가 없음", "customer-controlled key rotation·revocation·access audit 경계가 없어 object data key risk를 독립 통제하지 못함", "47", "[Security][Platform][P1] OCI CMK strategy로 datapack bucket·data volume CKV_OCI_9/3 해소", "approved regional Vault/key·least-privilege IAM·rotation·key-loss recovery, bucket kms_key_id plan evidence, CKV_OCI_9 0, policy decision 삭제"],
  ["CKV_OCI_2", "storage.tf", "oci_core_volume.data[0]", "ACCEPTED_BOUNDED_RISK", "현재 approved backup/restore architecture와 retention·cost·monitoring contract가 없음", "volume loss/corruption 시 재구성 불가능한 Docker data가 RPO/RTO 보장 없이 손실될 수 있음", "48", "[Resilience][Platform][P1] OCI data volume backup·restore contract로 CKV_OCI_2 해소", "approved backup policy·RPO/RTO·retention/cost·monitoring/alert owner·restore rehearsal, CKV_OCI_2 0, policy decision 삭제"],
  ["CKV_OCI_3", "storage.tf", "oci_core_volume.data[0]", "ACCEPTED_BOUNDED_RISK", "현재 OCI provider-managed encryption에 의존하며 승인된 Vault/key/IAM/rotation/recovery architecture가 없음", "customer-controlled key rotation·revocation·access audit 경계가 없어 block-volume data key risk를 독립 통제하지 못함", "47", "[Security][Platform][P1] OCI CMK strategy로 datapack bucket·data volume CKV_OCI_9/3 해소", "approved regional Vault/key·least-privilege IAM·rotation·key-loss recovery, volume kms_key_id plan evidence, CKV_OCI_3 0, policy decision 삭제"],
];
const approvedSuppressions = approvedSuppressionRows.map(([ruleId, file, resourceAddress, disposition, reason, impact, issue, ownerIssueTitle, removalCondition]) => ({
  scanner: "CHECKOV", ruleId, rootId: "oci-always-free-a1-flex", path: `infra/terraform/oci/always-free-a1-flex/${file}`, resourceAddress, resourceIdentitySource: "RESOURCE", disposition, reason, impact,
  ownerIssueUrl: `https://github.com/AquilaXk/easysubway-platform/issues/${issue}`, ownerIssueTitle, ownerIssueState: "OPEN", removalCondition, expiresAt: "2026-11-07",
}));

export function validatePolicy(policy) {
  exactKeys(policy, requiredPolicyKeys, "policy");
  if (policy.schemaVersion !== 1 || policy.artifactKind !== "terraform-static-analysis-policy-v1" || policy.inventoryPath !== inventoryRelativePath) fail("policy identity is invalid");
  exactKeys(policy.toolchain, ["terraform", "tflint", "checkov"], "toolchain");
  exactKeys(policy.toolchain.terraform, ["version"], "toolchain.terraform");
  exactKeys(policy.toolchain.tflint, ["version", "commit", "image", "ruleset", "rulesetVersion", "pluginDownload"], "toolchain.tflint");
  exactKeys(policy.toolchain.checkov, ["version", "commit", "image", "framework", "externalModuleDownload"], "toolchain.checkov");
  const { terraform, tflint, checkov } = policy.toolchain;
  if (terraform.version !== "1.14.6" || tflint.version !== "0.64.0" || tflint.commit !== "15c65a33b322750f6131e286cd9597896299ba32" || tflint.image !== "ghcr.io/terraform-linters/tflint@sha256:1c595f42d794c32c45a6ea8b58655fd66433d4ca3b1bc631c574a48d120bd19f" || tflint.ruleset !== "terraform/recommended" || tflint.rulesetVersion !== "0.15.0-bundled" || tflint.pluginDownload !== "DISABLED" || checkov.version !== "3.3.9" || checkov.commit !== "27f879342227f385ce1dbd619155f9aaed9d3cb4" || checkov.image !== "bridgecrew/checkov@sha256:12a62da01af22654883aee3b9da18ba4297f123f5122663bf65235db37934144" || checkov.framework !== "terraform" || checkov.externalModuleDownload !== "DISABLED") fail("toolchain pin is invalid");
  exactKeys(policy.execution, ["network", "repositoryMount", "reportMount", "callModuleType", "forbiddenInputs"], "execution");
  if (policy.execution.network !== "NONE" || policy.execution.repositoryMount !== "READ_ONLY" || policy.execution.reportMount !== "READ_WRITE" || policy.execution.callModuleType !== "LOCAL" || JSON.stringify(policy.execution.forbiddenInputs) !== JSON.stringify(["credentials", "state", "plan", "tfvars", "cloudApi"])) fail("execution isolation is invalid");
  exactKeys(policy.report, ["schemaVersion", "artifactKind", "filenames", "sarifVersion", "hashAlgorithm", "retentionDays"], "report");
  if (policy.report.schemaVersion !== 1 || policy.report.artifactKind !== "terraform-static-analysis-result-v1" || policy.report.sarifVersion !== "2.1.0" || policy.report.hashAlgorithm !== "sha256" || policy.report.retentionDays !== 14 || JSON.stringify(policy.report.filenames) !== JSON.stringify(["tflint.sarif", "checkov.sarif", "terraform-static-analysis-result.json", "terraform-static-analysis-summary.md"])) fail("report contract is invalid");
  if (!Array.isArray(policy.suppressions) || policy.suppressions.length !== approvedSuppressions.length) fail("suppressions are not the approved Platform decisions");
  for (const decision of policy.suppressions) exactKeys(decision, requiredSuppressionKeys, "suppression");
  if (JSON.stringify(policy.suppressions) !== JSON.stringify(approvedSuppressions)) fail("suppressions are not the approved Platform decisions");
  return policy;
}
export function loadPolicy() {
  const { bytes, value: policy } = readRepositoryJson(policyRelativePath);
  validatePolicy(policy);
  return { policy, bytes };
}
function loadInventory() {
  const { bytes, value: inventory } = readRepositoryJson(inventoryRelativePath);
  if (!Array.isArray(inventory.roots) || inventory.roots.length === 0) fail("inventory must contain executable roots");
  return { inventory, bytes };
}
function sourceDigest(rootPath) {
  const files = execFileSync("git", ["ls-files", "--", rootPath], { cwd: repository, encoding: "utf8" }).trim().split("\n").filter(Boolean).sort(compareCodepoint);
  if (files.length === 0) fail(`root ${rootPath} has no tracked source`);
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file}\0`).update(readFileSync(resolve(repository, file)));
  return hash.digest("hex");
}
function baseSarif(path) {
  const bytes = readFileSync(path, "utf8");
  let sarif;
  try { sarif = JSON.parse(bytes); } catch { fail(`${path} is malformed SARIF`); }
  if (!sarif || sarif.version !== "2.1.0" || !Array.isArray(sarif.runs) || sarif.runs.length === 0) fail(`${path} is not SARIF 2.1.0`);
  return { bytes, sarif };
}
function validateRun(run, name, version, informationUri = undefined) {
  if (!run?.tool?.driver || run.tool.driver.name !== name || run.tool.driver.version !== version || !Array.isArray(run.tool.driver.rules) || !Array.isArray(run.results) || (informationUri !== undefined && run.tool.driver.informationUri !== informationUri)) fail("SARIF driver identity is invalid");
}
function validateRunRules(run) {
  const ruleIds = new Set();
  for (const rule of run.tool.driver.rules) {
    if (!rule || typeof rule.id !== "string" || !rule.id || ruleIds.has(rule.id)) fail("SARIF rule identity is invalid or duplicated");
    ruleIds.add(rule.id);
  }
  for (const result of run.results) {
    if (typeof result.ruleId !== "string" || !result.ruleId || !ruleIds.has(result.ruleId)) fail("SARIF result references an unknown rule");
  }
}
function readLocation(result) {
  if (!result || typeof result.ruleId !== "string" || !result.ruleId || !Array.isArray(result.locations) || result.locations.length !== 1) fail("SARIF result lacks one exact identity location");
  return normalizeSarifPath(result.locations[0]?.physicalLocation?.artifactLocation?.uri);
}
function parseTflint(path) {
  const parsed = baseSarif(path);
  if (parsed.sarif.runs.length !== 2) fail("TFLint SARIF must have two ordered runs");
  const [lint, errors] = parsed.sarif.runs;
  validateRun(lint, "tflint", "0.64.0", tflintInfoUri);
  validateRun(errors, "tflint-errors", "0.64.0", tflintInfoUri);
  if (errors.results.length !== 0) fail("TFLint error run must be empty");
  validateRunRules(lint);
  validateRunRules(errors);
  for (const result of lint.results) {
    if (!new Set(["error", "warning", "note"]).has(result.level)) fail("TFLint result severity is unknown");
    readLocation(result);
  }
  return parsed;
}
function parseCheckovSarif(path) {
  const parsed = baseSarif(path);
  if (parsed.sarif.runs.length !== 1) fail("Checkov SARIF must have exactly one run");
  const [run] = parsed.sarif.runs;
  validateRun(run, "Checkov", "3.3.9");
  validateRunRules(run);
  for (const result of run.results) readLocation(result);
  return parsed;
}
function failedCheckovRecords(path) {
  const { value } = readJson(path);
  const reports = Array.isArray(value) ? value : [value];
  if (reports.length !== 1 || !reports[0] || typeof reports[0] !== "object") fail("Checkov JSON must contain exactly one Terraform report or clean summary");
  if (JSON.stringify(Object.keys(reports[0])) === JSON.stringify(cleanCheckovSummaryKeys)) {
    exactKeys(reports[0], cleanCheckovSummaryKeys, "Checkov clean summary");
    if (["passed", "failed", "skipped", "parsing_errors", "resource_count"].some((key) => reports[0][key] !== 0) || reports[0].checkov_version !== "3.3.9") fail("Checkov clean summary must contain only zero counts and pinned version");
    return { records: [], cleanSummary: true };
  }
  exactKeys(reports[0], ["check_type", "results", "summary", "url"], "Checkov JSON report");
  if (reports[0].check_type !== "terraform" || !reports[0].results || typeof reports[0].results !== "object") fail("Checkov JSON must contain exactly one Terraform report");
  const results = reports[0].results;
  exactKeys(results, ["passed_checks", "failed_checks", "skipped_checks", "parsing_errors"], "Checkov JSON results");
  for (const key of ["passed_checks", "failed_checks", "skipped_checks", "parsing_errors"]) if (!Array.isArray(results[key])) fail(`Checkov JSON ${key} must be an array`);
  for (const record of results.passed_checks) if (!record || typeof record !== "object" || Array.isArray(record) || record.check_result?.result !== "PASSED") fail("Checkov passed record is invalid");
  if (results.skipped_checks.length !== 0 || results.parsing_errors.length !== 0) fail("Checkov skipped or parser evidence is terminal");
  exactKeys(reports[0].summary, cleanCheckovSummaryKeys, "Checkov report summary");
  if (reports[0].summary.passed !== results.passed_checks.length || reports[0].summary.failed !== results.failed_checks.length || reports[0].summary.skipped !== results.skipped_checks.length || reports[0].summary.parsing_errors !== results.parsing_errors.length || !Number.isInteger(reports[0].summary.resource_count) || reports[0].summary.resource_count < 0 || reports[0].summary.checkov_version !== "3.3.9") fail("Checkov report summary does not match results");
  if (reports[0].url !== null && typeof reports[0].url !== "string") fail("Checkov report url is invalid");
  return { records: results.failed_checks.map((record) => {
    if (!record || typeof record.check_id !== "string" || !record.check_id || record.check_result?.result !== "FAILED") fail("Checkov failed record is invalid");
    const path = normalizeCheckovJsonPath(record.file_path);
    const hasResourceAddress = typeof record.resource_address === "string" && record.resource_address.length > 0;
    const canUseResource = (record.resource_address === undefined || record.resource_address === null) && typeof record.resource === "string" && record.resource.length > 0;
    if (!hasResourceAddress && !canUseResource) fail("Checkov failed record lacks resource identity");
    return { ruleId: record.check_id, path, resourceAddress: hasResourceAddress ? record.resource_address : record.resource, resourceIdentitySource: hasResourceAddress ? "RESOURCE_ADDRESS" : "RESOURCE" };
  }), cleanSummary: false };
}
function checkovFindings(rawSarifPath, rawJsonPath, root) {
  const sarif = parseCheckovSarif(rawSarifPath).sarif;
  const sarifResults = sarif.runs.flatMap((run) => run.results.map((result) => ({ result, ruleId: result.ruleId, path: readLocation(result) })));
  const { records: json, cleanSummary } = failedCheckovRecords(rawJsonPath);
  if (cleanSummary && sarifResults.length !== 0) fail("Checkov clean summary requires zero SARIF results");
  const used = new Set();
  const findings = json.map((item) => {
    const matches = sarifResults.map((candidate, index) => ({ candidate, index })).filter(({ candidate }) => candidate.ruleId === item.ruleId && candidate.path === item.path);
    if (matches.length !== 1) fail("Checkov JSON/SARIF identity join is missing or ambiguous");
    if (used.has(matches[0].index)) fail("Checkov SARIF evidence is ambiguously reused");
    used.add(matches[0].index);
    return { scanner: "CHECKOV", ruleId: item.ruleId, rootId: root.id, path: prefixedRootPath(root.path, item.path), resourceAddress: item.resourceAddress, resourceIdentitySource: item.resourceIdentitySource };
  });
  if (used.size !== sarifResults.length) fail("Checkov SARIF has unmatched failed evidence");
  return { parsed: parseCheckovSarif(rawSarifPath), findings, cleanSummary };
}
function tflintFindings(rawSarifPath, root) {
  const parsed = parseTflint(rawSarifPath);
  return { parsed, findings: parsed.sarif.runs[0].results.map((result) => ({ scanner: "TFLINT", ruleId: result.ruleId, rootId: root.id, path: prefixedRootPath(root.path, readLocation(result)), resourceAddress: "", resourceIdentitySource: null })) };
}
function scannerExitIsValid(scanner, exit, findings) {
  return scanner === "TFLINT" ? ((exit === 0 && findings === 0) || (exit === 2 && findings > 0)) : ((exit === 0 && findings === 0) || (exit === 1 && findings > 0));
}
function validateScan(input) {
  const { reportDirectory, scanner, rootId, rootPath, exit, rawSarifPath, structuredJsonPath } = input;
  if (!scannerNames.has(scanner) || !rootId || !safeRelativePath(rootPath) || !Number.isInteger(exit) || !safeRelativePath(rawSarifPath) || (scanner === "TFLINT" ? structuredJsonPath !== null : !safeRelativePath(structuredJsonPath))) fail("scan record input is invalid");
  const root = { id: rootId, path: rootPath };
  const sarifPath = internalPath(reportDirectory, rawSarifPath);
  const jsonPath = structuredJsonPath === null ? null : internalPath(reportDirectory, structuredJsonPath);
  const checkov = scanner === "CHECKOV" ? checkovFindings(sarifPath, jsonPath, root) : null;
  const findings = scanner === "TFLINT" ? tflintFindings(sarifPath, root).findings : checkov.findings;
  if (checkov?.cleanSummary && (exit !== 0 || findings.length !== 0)) fail("Checkov clean summary requires exit 0 and zero SARIF results");
  if (!scannerExitIsValid(scanner, exit, findings.length)) fail(`${scanner} exit ${exit} does not match current-root findings`);
  return { scanner, rootId, rootPath, exit, rawSarifPath, rawSarifSha256: sha256(readFileSync(sarifPath, "utf8")), structuredJsonPath, structuredJsonSha256: jsonPath === null ? null : sha256(readFileSync(jsonPath, "utf8")) };
}
export function recordScan(input) {
  const directory = resolvedRunDirectory(input);
  const record = validateScan({ ...input, reportDirectory: directory });
  const records = readRecords(rawRecordsPath(directory));
  if (records.some((item) => item.scanner === record.scanner && item.rootId === record.rootId)) fail(`duplicate ${record.scanner} record for ${record.rootId}`);
  writeJson(rawRecordsPath(directory), [...records, record]);
  return record;
}
function validateFixture(input) {
  const { reportDirectory, scanner, fixturePath, expectedRuleId, exit, rawSarifPath, structuredJsonPath } = input;
  if (!scannerNames.has(scanner) || !safeRelativePath(fixturePath) || !expectedRuleId || !Number.isInteger(exit)) fail("fixture record input is invalid");
  const root = { id: "fixture", path: "fixture" };
  const sarifPath = internalPath(reportDirectory, rawSarifPath);
  const jsonPath = structuredJsonPath === null ? null : internalPath(reportDirectory, structuredJsonPath);
  const findings = scanner === "TFLINT" ? tflintFindings(sarifPath, root).findings : checkovFindings(sarifPath, jsonPath, root).findings;
  if (!scannerExitIsValid(scanner, exit, findings.length) || findings.length !== 1 || findings[0].ruleId !== expectedRuleId) fail(`${scanner} fixture exit or expected rule is invalid`);
  return { scanner, fixturePath, sourceSha256: sha256(readFileSync(resolve(repository, fixturePath))), expectedRuleId, exit, rawSarifPath, rawSarifSha256: sha256(readFileSync(sarifPath, "utf8")), structuredJsonPath, structuredJsonSha256: jsonPath === null ? null : sha256(readFileSync(jsonPath, "utf8")) };
}
export function recordFixture(input) {
  const directory = resolvedRunDirectory(input);
  const record = validateFixture({ ...input, reportDirectory: directory });
  const records = readRecords(fixtureRecordsPath(directory));
  if (records.some((item) => item.fixturePath === record.fixturePath)) fail(`duplicate fixture record for ${record.fixturePath}`);
  writeJson(fixtureRecordsPath(directory), [...records, record]);
  return record;
}
function validateToolCheck({ reportDirectory, scanner, exit, stdoutPath, stderrPath }) {
  if (!scannerNames.has(scanner) || exit !== 0 || !safeRelativePath(stdoutPath) || !safeRelativePath(stderrPath)) fail("tool version probe is invalid");
  const output = readFileSync(internalPath(reportDirectory, stdoutPath), "utf8");
  const stderr = readFileSync(internalPath(reportDirectory, stderrPath), "utf8");
  const expected = scanner === "TFLINT" ? "TFLint version 0.64.0\n+ ruleset.terraform (0.15.0-bundled)\n" : "3.3.9\n";
  if (output !== expected) fail(`${scanner} version output is not pinned exact runtime output`);
  if (stderr !== "") fail(`${scanner} version probe stderr must be empty`);
  return { scanner, version: scanner === "TFLINT" ? "0.64.0" : "3.3.9", ruleset: scanner === "TFLINT" ? "0.15.0-bundled" : null, exit, stdoutPath, stdoutSha256: sha256(output), stderrPath, stderrSha256: sha256(stderr) };
}
export function recordToolCheck(input) {
  const reportDirectory = resolvedRunDirectory(input);
  const record = validateToolCheck({ ...input, reportDirectory });
  const records = readRecords(toolRecordsPath(reportDirectory));
  if (records.some((item) => item.scanner === record.scanner)) fail(`duplicate ${record.scanner} tool check`);
  writeJson(toolRecordsPath(reportDirectory), [...records, record]);
  return { scanner: record.scanner, version: record.version, ruleset: record.ruleset, stdoutSha256: record.stdoutSha256 };
}
function readAndValidateRecords(directory, inventory) {
  const scans = readRecords(rawRecordsPath(directory)).sort((a, b) => compareCodepoint(JSON.stringify(a), JSON.stringify(b)));
  const expected = expectedRoots(inventory);
  if (scans.length !== expected.length || scans.some((scan) => !expected.some(([scanner, rootId, rootPath]) => scan.scanner === scanner && scan.rootId === rootId && scan.rootPath === rootPath))) fail("scan records do not exactly cover the inventory");
  for (const scan of scans) {
    exactKeys(scan, scanKeys, "raw scan");
    const current = validateScan({ reportDirectory: directory, ...scan });
    if (JSON.stringify(current) !== JSON.stringify(scan)) fail("raw scan evidence changed after recording");
  }
  const fixtures = readRecords(fixtureRecordsPath(directory)).sort((a, b) => compareCodepoint(JSON.stringify(a), JSON.stringify(b)));
  const expectedFixtureSet = expectedFixtures();
  if (fixtures.length !== expectedFixtureSet.length || fixtures.some((item) => !expectedFixtureSet.some(([scanner, fixturePath, ruleId]) => item.scanner === scanner && item.fixturePath === fixturePath && item.expectedRuleId === ruleId))) fail("fixture checks do not exactly cover the contract");
  for (const fixture of fixtures) {
    exactKeys(fixture, fixtureKeys, "raw fixture");
    const current = validateFixture({ reportDirectory: directory, ...fixture });
    if (JSON.stringify(current) !== JSON.stringify(fixture)) fail("raw fixture evidence changed after recording");
  }
  const rawToolChecks = readRecords(toolRecordsPath(directory)).sort((a, b) => compareCodepoint(a.scanner, b.scanner));
  if (rawToolChecks.length !== 2 || JSON.stringify(rawToolChecks.map(({ scanner }) => scanner)) !== JSON.stringify(["CHECKOV", "TFLINT"])) fail("tool checks do not exactly cover pinned scanners");
  for (const rawTool of rawToolChecks) {
    exactKeys(rawTool, rawToolCheckKeys, "raw tool check");
    if (JSON.stringify(validateToolCheck({ reportDirectory: directory, ...rawTool })) !== JSON.stringify(rawTool)) fail("tool check evidence changed after recording");
  }
  const toolChecks = rawToolChecks.map(({ scanner, version, ruleset, stdoutSha256 }) => ({ scanner, version, ruleset, stdoutSha256 }));
  for (const tool of toolChecks) exactKeys(tool, toolCheckKeys, "tool check");
  return { scans, fixtures, toolChecks, rawToolChecks };
}
function normalizeRun(run, rootPath) {
  const copy = structuredClone(run);
  for (const result of copy.results) result.locations[0].physicalLocation.artifactLocation.uri = prefixedRootPath(rootPath, readLocation(result));
  return copy;
}
function mergeRules(runs) {
  const byId = new Map();
  for (const run of runs) for (const rule of run.tool.driver.rules) {
    if (!rule || typeof rule.id !== "string" || !rule.id) fail("SARIF rule identity is invalid");
    const bytes = JSON.stringify(rule);
    if (byId.has(rule.id) && byId.get(rule.id).bytes !== bytes) fail("conflicting SARIF rule definitions");
    byId.set(rule.id, { bytes, rule });
  }
  return [...byId.entries()].sort(([left], [right]) => compareCodepoint(left, right)).map(([, { rule }]) => structuredClone(rule));
}
function requireResultRules(run) {
  const ruleIds = new Set(run.tool.driver.rules.map(({ id }) => id));
  for (const result of run.results) if (!ruleIds.has(result.ruleId)) fail("SARIF result does not reference a merged rule");
}
export function combineSarifForScans(scans, scanner) {
  const selected = scans.filter((scan) => scan.scanner === scanner);
  if (selected.length === 0) fail(`no ${scanner} scan reports`);
  if (scanner === "TFLINT") {
    const parsed = selected.map((scan) => ({ scan, parsed: parseTflint(internalPath(scan.directory, scan.rawSarifPath)).sarif }));
    const first = normalizeRun(parsed[0].parsed.runs[0], parsed[0].scan.rootPath);
    const errors = structuredClone(parsed[0].parsed.runs[1]);
    first.tool.driver.rules = mergeRules(parsed.map(({ parsed: sarif }) => sarif.runs[0]));
    errors.tool.driver.rules = mergeRules(parsed.map(({ parsed: sarif }) => sarif.runs[1]));
    first.results = parsed.flatMap(({ scan, parsed: sarif }) => normalizeRun(sarif.runs[0], scan.rootPath).results);
    errors.results = [];
    requireResultRules(first);
    return { version: "2.1.0", runs: [first, errors] };
  }
  const parsed = selected.map((scan) => ({ scan, parsed: parseCheckovSarif(internalPath(scan.directory, scan.rawSarifPath)).sarif }));
  const first = normalizeRun(parsed[0].parsed.runs[0], parsed[0].scan.rootPath);
  first.tool.driver.rules = mergeRules(parsed.flatMap(({ parsed: sarif }) => sarif.runs));
  first.results = parsed.flatMap(({ scan, parsed: sarif }) => sarif.runs.flatMap((run) => normalizeRun(run, scan.rootPath).results));
  requireResultRules(first);
  return { version: "2.1.0", runs: [first] };
}
function resultFindings(scans, inventory, policy) {
  const findings = [];
  for (const scan of scans) {
    const root = inventory.roots.find((item) => item.id === scan.rootId && item.path === scan.rootPath);
    const paths = scan.scanner === "TFLINT" ? tflintFindings(internalPath(scan.directory, scan.rawSarifPath), root).findings : checkovFindings(internalPath(scan.directory, scan.rawSarifPath), internalPath(scan.directory, scan.structuredJsonPath), root).findings;
    for (const item of paths) {
      const matching = policy.suppressions.find((decision) => decision.scanner === item.scanner && decision.ruleId === item.ruleId && decision.rootId === item.rootId && decision.path === item.path && decision.resourceAddress === item.resourceAddress && decision.resourceIdentitySource === item.resourceIdentitySource);
      findings.push({ scanner: item.scanner, ruleId: item.ruleId, rootId: item.rootId, path: item.path, resourceAddress: item.resourceAddress, resourceIdentitySource: item.resourceIdentitySource, disposition: matching?.disposition ?? "FIX_REQUIRED" });
    }
  }
  findings.sort((a, b) => compareCodepoint(JSON.stringify(a), JSON.stringify(b)));
  if (new Set(findings.map((item) => JSON.stringify(item))).size !== findings.length) fail("duplicate normalized finding");
  return findings;
}
function buildResult({ reportDirectory, sourceSha, approvedRoot }) {
  const { policy, bytes: policyBytes } = loadPolicy();
  const { inventory, bytes: inventoryBytes } = loadInventory();
  if (!/^[0-9a-f]{40}$/i.test(sourceSha ?? "")) fail("sourceSha must be an exact commit SHA");
  const directory = resolvedRunDirectory({ reportDirectory, approvedRoot });
  const { scans, fixtures, toolChecks } = readAndValidateRecords(directory, inventory);
  for (const scan of scans) scan.directory = directory;
  const tflint = combineSarifForScans(scans, "TFLINT");
  const checkov = combineSarifForScans(scans, "CHECKOV");
  const findings = resultFindings(scans, inventory, policy);
  const unclassified = findings.filter((item) => item.disposition === "FIX_REQUIRED").length;
  const result = {
    schemaVersion: 1,
    artifactKind: "terraform-static-analysis-result-v1",
    sourceSha,
    inventory: { path: inventoryRelativePath, sha256: sha256(inventoryBytes) },
    policy: { path: policyRelativePath, sha256: sha256(policyBytes) },
    configuration: { tflintConfig: { path: tflintConfigRelativePath, sha256: sha256(readFileSync(resolve(repository, tflintConfigRelativePath), "utf8")) } },
    tools: policy.toolchain,
    roots: inventory.roots.map(({ id, path }) => ({ id, path, sourceDigest: sourceDigest(path) })).sort((a, b) => compareCodepoint(a.id, b.id)),
    reports: {
      tflintSarif: { path: "tflint.sarif", sha256: sha256(canonical(tflint)) },
      checkovSarif: { path: "checkov.sarif", sha256: sha256(canonical(checkov)) },
      toolChecks,
      scans: scans.map(({ directory: _directory, ...scan }) => scan),
      fixtureChecks: fixtures.map(({ rawSarifPath: _rawSarifPath, structuredJsonPath: _structuredJsonPath, ...fixture }) => fixture),
    },
    findings,
    summary: { tflint: findings.filter((item) => item.scanner === "TFLINT").length, checkov: findings.filter((item) => item.scanner === "CHECKOV").length, suppressed: findings.filter((item) => item.disposition !== "FIX_REQUIRED").length, unclassified },
    outcome: unclassified === 0 ? "PASS" : "FAIL",
  };
  const summaryBytes = `# Terraform static analysis\n\nOutcome: **${result.outcome}**\n\n- TFLint: ${result.summary.tflint}\n- Checkov: ${result.summary.checkov}\n- Suppressed: ${result.summary.suppressed}\n- Unclassified: ${result.summary.unclassified}\n`;
  return { result, directory, tflintBytes: canonical(tflint), checkovBytes: canonical(checkov), summaryBytes };
}
export function analyze(input) {
  const { result, directory, tflintBytes, checkovBytes, summaryBytes } = buildResult(input);
  writeFileSync(internalPath(directory, "tflint.sarif"), tflintBytes);
  writeFileSync(internalPath(directory, "checkov.sarif"), checkovBytes);
  writeFileSync(internalPath(directory, "terraform-static-analysis-result.json"), canonical(result));
  writeFileSync(internalPath(directory, "terraform-static-analysis-summary.md"), summaryBytes);
  return result;
}
function verifyFinalArtifacts(directory, { tflintBytes, checkovBytes, summaryBytes }) {
  if (readFileSync(internalPath(directory, "tflint.sarif"), "utf8") !== tflintBytes || readFileSync(internalPath(directory, "checkov.sarif"), "utf8") !== checkovBytes) fail("final combined SARIF differs from analyzed evidence");
  if (readFileSync(internalPath(directory, "terraform-static-analysis-summary.md"), "utf8") !== summaryBytes) fail("final summary differs from analyzed evidence");
}
export function enforce({ reportDirectory, sourceSha, tflintOutcome, checkovOutcome, approvedRoot }) {
  const directory = resolvedRunDirectory({ reportDirectory, approvedRoot });
  const resultPath = internalPath(directory, "terraform-static-analysis-result.json");
  const { bytes: resultBytes, value: result } = readCanonicalJson(resultPath);
  exactKeys(result, resultKeys, "result");
  exactKeys(result.inventory, ["path", "sha256"], "result.inventory");
  exactKeys(result.policy, ["path", "sha256"], "result.policy");
  exactKeys(result.configuration, ["tflintConfig"], "result.configuration");
  exactKeys(result.configuration.tflintConfig, ["path", "sha256"], "result.configuration.tflintConfig");
  exactKeys(result.reports, ["tflintSarif", "checkovSarif", "toolChecks", "scans", "fixtureChecks"], "result.reports");
  exactKeys(result.reports.tflintSarif, ["path", "sha256"], "result.reports.tflintSarif");
  exactKeys(result.reports.checkovSarif, ["path", "sha256"], "result.reports.checkovSarif");
  exactKeys(result.summary, ["tflint", "checkov", "suppressed", "unclassified"], "result.summary");
  for (const finding of result.findings) exactKeys(finding, findingKeys, "result finding");
  const built = buildResult({ reportDirectory: directory, sourceSha, approvedRoot: directory });
  const expected = built.result;
  verifyFinalArtifacts(directory, built);
  if (JSON.stringify(result) !== JSON.stringify(expected) || result.outcome !== "PASS" || tflintOutcome !== "success" || checkovOutcome !== "success") fail("current scanner result is not a successful PASS");
  writeJson(markerPath(directory), { sourceSha, resultSha256: sha256(resultBytes) });
}
export function cleanup({ reportDirectory, approvedRoot }) {
  const directory = resolvedRunDirectory({ reportDirectory, approvedRoot });
  const marker = readCanonicalJson(markerPath(directory)).value;
  exactKeys(marker, ["sourceSha", "resultSha256"], "cleanup marker");
  const resultPath = internalPath(directory, "terraform-static-analysis-result.json");
  const resultBytes = readFileSync(resultPath, "utf8");
  if (marker.resultSha256 !== sha256(resultBytes)) fail("cleanup marker does not bind the current result");
  const built = buildResult({ reportDirectory: directory, sourceSha: marker.sourceSha, approvedRoot: directory });
  const { result } = built;
  verifyFinalArtifacts(directory, built);
  if (JSON.stringify(JSON.parse(resultBytes)) !== JSON.stringify(result)) fail("cleanup raw evidence differs from the enforced result");
  for (const record of [...readRecords(rawRecordsPath(directory)), ...readRecords(fixtureRecordsPath(directory))]) {
    unlinkSync(internalPath(directory, record.rawSarifPath));
    if (record.structuredJsonPath !== null) unlinkSync(internalPath(directory, record.structuredJsonPath));
  }
  for (const tool of readRecords(toolRecordsPath(directory))) {
    unlinkSync(internalPath(directory, tool.stdoutPath));
    unlinkSync(internalPath(directory, tool.stderrPath));
  }
  for (const hidden of [rawRecordsPath(directory), fixtureRecordsPath(directory), toolRecordsPath(directory), markerPath(directory)]) unlinkSync(hidden);
  const fixtureDirectory = internalPath(directory, "fixtures");
  if (existsSync(fixtureDirectory)) rmSync(fixtureDirectory, { recursive: true, force: true });
  const expected = ["checkov.sarif", "terraform-static-analysis-result.json", "terraform-static-analysis-summary.md", "tflint.sarif"];
  if (JSON.stringify(readdirSync(directory).sort(compareCodepoint)) !== JSON.stringify(expected)) fail("cleanup did not leave the exact artifact set");
}
function inventoryRoots() { return loadInventory().inventory.roots.map(({ id, path }) => `${id}\t${path}`); }
function fixtureIds(scanner) {
  if (!scannerNames.has(scanner)) fail("fixture scanner is invalid");
  return fixtureRegistry.filter((fixture) => fixture.scanner === scanner).map(({ id }) => id);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "validate-policy") { loadPolicy(); process.stdout.write("terraform static analysis policy valid\n"); }
  else if (command === "list-roots") process.stdout.write(`${inventoryRoots().join("\n")}\n`);
  else if (command === "list-fixtures") process.stdout.write(`${fixtureIds(process.argv[3]).join("\n")}\n`);
  else if (command === "record-tool-check") {
    const [scanner, exit] = process.argv.slice(3);
    if (!scanner || !exit || process.argv.length !== 5 || !toolReportPaths[scanner]) fail("record-tool-check requires scanner and exit");
    recordToolCheck({ ...productionInput(), scanner, exit: Number(exit), ...toolReportPaths[scanner] });
  } else if (command === "record-scan") {
    const [scanner, rootId, exit] = process.argv.slice(3);
    if (!scanner || !rootId || !exit || process.argv.length !== 6) fail("record-scan requires scanner, root ID, and exit");
    const root = inventoryRoot(rootId);
    recordScan({ ...productionInput(), scanner, rootId: root.id, rootPath: root.path, exit: Number(exit), ...scanReportPaths(scanner, root.id) });
  } else if (command === "record-fixture") {
    const [scanner, fixtureId, exit] = process.argv.slice(3);
    if (!scanner || !fixtureId || !exit || process.argv.length !== 6) fail("record-fixture requires scanner, fixture ID, and exit");
    const fixture = fixtureDefinition(scanner, fixtureId);
    recordFixture({ ...productionInput(), scanner, fixturePath: fixture.fixturePath, expectedRuleId: fixture.expectedRuleId, exit: Number(exit), ...fixtureReportPaths(scanner, fixture.id) });
  } else if (command === "analyze") {
    if (process.argv.length !== 3) fail("analyze does not accept arguments");
    const result = analyze({ ...productionInput(), sourceSha: process.env.GITHUB_SHA });
    if (!result) fail("analysis did not produce a result");
  } else if (command === "enforce") {
    if (process.argv.length !== 3) fail("enforce does not accept arguments");
    enforce({ ...productionInput(), sourceSha: process.env.GITHUB_SHA, tflintOutcome: process.env.TFLINT_OUTCOME, checkovOutcome: process.env.CHECKOV_OUTCOME });
  } else if (command === "cleanup") {
    if (process.argv.length !== 3) fail("cleanup does not accept arguments");
    cleanup(productionInput());
  } else fail("expected validate-policy, list-roots, list-fixtures, record-tool-check, record-scan, record-fixture, analyze, enforce, or cleanup");
}
