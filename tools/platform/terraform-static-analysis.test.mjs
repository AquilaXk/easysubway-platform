import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyze, cleanup, combineSarifForScans, enforce, loadPolicy, recordFixture, recordScan, recordToolCheck, validatePolicy } from "./terraform-static-analysis.mjs";

const rootId = "oci-always-free-a1-flex";
const rootPath = "infra/terraform/oci/always-free-a1-flex";
const tflintFixture = "tools/platform/fixtures/terraform-static-analysis/tflint-required-version.tf.fixture";
const publicBucketFixture = "tools/platform/fixtures/terraform-static-analysis/checkov-oci-public-bucket.tf.fixture";
const sshFixture = "tools/platform/fixtures/terraform-static-analysis/checkov-oci-unrestricted-ssh.tf.fixture";
const tflintInfoUri = "https://github.com/terraform-linters/tflint";
const testReportRoot = process.env.RUNNER_TEMP ?? tmpdir();
const staticAnalysisRunnerSource = readFileSync(new URL("./terraform-static-analysis.mjs", import.meta.url), "utf8");
const approvedDecisions = [
  ["CKV_OCI_10", "datapack_object_storage.tf", "oci_objectstorage_bucket.datapack", "ACCEPTED_BOUNDED_RISK", "ObjectReadWithoutList로 known immutable datapack object GET만 허용하고 bucket list는 금지하는 현재 제품 전달 계약", "object URL을 아는 비인증 사용자가 해당 datapack object를 읽고 재전달할 수 있음", "40", "[Security][Platform][P1] public datapack private delivery로 CKV_OCI_10 bounded risk 제거", "지원 consumer의 private delivery 전환, public URL 의존 0, NoPublicAccess 적용·anonymous GET/list 실패, CKV_OCI_10 0, policy decision 삭제"],
  ["CKV_OCI_7", "datapack_object_storage.tf", "oci_objectstorage_bucket.datapack", "NOT_APPLICABLE_WITH_REASON", "현재 승인된 datapack delivery에는 object event를 소비하는 운영 계약이 없고 event emission만으로 보안·감사 결과가 생성되지 않음", "향후 object mutation audit·SIEM·event-driven lifecycle 요구가 생기면 현재 decision이 그 요구를 충족하지 못함", "46", "[Security][Platform][P2] datapack bucket object-event 필요성 판정 및 CKV_OCI_7 decision", "승인된 object-event consumer·retention·alert/audit owner·failure handling 확정, CKV_OCI_7 0, policy decision 삭제"],
  ["CKV_OCI_9", "datapack_object_storage.tf", "oci_objectstorage_bucket.datapack", "ACCEPTED_BOUNDED_RISK", "현재 OCI provider-managed encryption에 의존하며 승인된 Vault/key/IAM/rotation/recovery architecture가 없음", "customer-controlled key rotation·revocation·access audit 경계가 없어 object data key risk를 독립 통제하지 못함", "47", "[Security][Platform][P1] OCI CMK strategy로 datapack bucket·data volume CKV_OCI_9/3 해소", "approved regional Vault/key·least-privilege IAM·rotation·key-loss recovery, bucket kms_key_id plan evidence, CKV_OCI_9 0, policy decision 삭제"],
  ["CKV_OCI_2", "storage.tf", "oci_core_volume.data[0]", "ACCEPTED_BOUNDED_RISK", "현재 approved backup/restore architecture와 retention·cost·monitoring contract가 없음", "volume loss/corruption 시 재구성 불가능한 Docker data가 RPO/RTO 보장 없이 손실될 수 있음", "48", "[Resilience][Platform][P1] OCI data volume backup·restore contract로 CKV_OCI_2 해소", "approved backup policy·RPO/RTO·retention/cost·monitoring/alert owner·restore rehearsal, CKV_OCI_2 0, policy decision 삭제"],
  ["CKV_OCI_3", "storage.tf", "oci_core_volume.data[0]", "ACCEPTED_BOUNDED_RISK", "현재 OCI provider-managed encryption에 의존하며 승인된 Vault/key/IAM/rotation/recovery architecture가 없음", "customer-controlled key rotation·revocation·access audit 경계가 없어 block-volume data key risk를 독립 통제하지 못함", "47", "[Security][Platform][P1] OCI CMK strategy로 datapack bucket·data volume CKV_OCI_9/3 해소", "approved regional Vault/key·least-privilege IAM·rotation·key-loss recovery, volume kms_key_id plan evidence, CKV_OCI_3 0, policy decision 삭제"],
].map(([ruleId, file, resourceAddress, disposition, reason, impact, issue, ownerIssueTitle, removalCondition]) => ({
  scanner: "CHECKOV", ruleId, rootId, path: `${rootPath}/${file}`, resourceAddress, resourceIdentitySource: "RESOURCE", disposition, reason, impact,
  ownerIssueUrl: `https://github.com/AquilaXk/easysubway-platform/issues/${issue}`, ownerIssueTitle, ownerIssueState: "OPEN", removalCondition, expiresAt: "2026-11-07",
}));
const currentCheckovFindings = approvedDecisions.map(({ ruleId, path, resourceAddress }) => ({ ruleId, path: path.slice(`${rootPath}/`.length), resourceAddress }));

function write(directory, path, value) { writeFileSync(join(directory, path), value); }
function tflintSarif(ruleId = null, uri = "versions.tf", rule = ruleId ? { id: ruleId, name: ruleId } : null, region = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 }) {
  const result = ruleId ? [{ ruleId, level: "error", locations: [{ physicalLocation: { artifactLocation: { uri }, region } }] }] : [];
  return JSON.stringify({ version: "2.1.0", runs: [
    { tool: { driver: { name: "tflint", version: "0.64.0", informationUri: tflintInfoUri, rules: rule ? [rule] : [] } }, results: result },
    { tool: { driver: { name: "tflint-errors", version: "0.64.0", informationUri: tflintInfoUri, rules: [] } }, results: [] },
  ] });
}
function tflintSarifWithResults(results) {
  return JSON.stringify({ version: "2.1.0", runs: [
    { tool: { driver: { name: "tflint", version: "0.64.0", informationUri: tflintInfoUri, rules: [{ id: "terraform_required_version", name: "terraform_required_version" }] } }, results },
    { tool: { driver: { name: "tflint-errors", version: "0.64.0", informationUri: tflintInfoUri, rules: [] } }, results: [] },
  ] });
}
function checkovSarifRecords(records, driverName = "Checkov", rules = records.map(({ ruleId }) => ({ id: ruleId, name: ruleId }))) {
  return JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: driverName, version: "3.3.9", rules } }, results: records.map(({ ruleId, path }) => ({ ruleId, locations: [{ physicalLocation: { artifactLocation: { uri: path } } }] })) }] });
}
function checkovSarif(ruleId = null, uri = "datapack_object_storage.tf", driverName = "Checkov", rules = ruleId ? [{ id: ruleId, name: ruleId }] : []) {
  return checkovSarifRecords(ruleId ? [{ ruleId, path: uri }] : [], driverName, rules);
}
function checkovJsonRecords(records) {
  return JSON.stringify({ check_type: "terraform", results: {
    passed_checks: [], failed_checks: records.map(({ ruleId, path, resourceAddress }) => ({ check_id: ruleId, check_result: { result: "FAILED" }, file_path: `/${path}`, resource_address: null, resource: resourceAddress })), skipped_checks: [], parsing_errors: [],
  }, summary: { passed: 0, failed: records.length, skipped: 0, parsing_errors: 0, resource_count: 1, checkov_version: "3.3.9" }, url: null });
}
function checkovJson(ruleId = null, path = "/datapack_object_storage.tf", resourceAddress = null, resource = "oci_objectstorage_bucket.datapack") {
  return JSON.stringify({ check_type: "terraform", results: {
    passed_checks: [], failed_checks: ruleId ? [{ check_id: ruleId, check_result: { result: "FAILED" }, file_path: path, resource_address: resourceAddress, resource }] : [], skipped_checks: [], parsing_errors: [],
  }, summary: { passed: 0, failed: ruleId ? 1 : 0, skipped: 0, parsing_errors: 0, resource_count: 1, checkov_version: "3.3.9" }, url: null });
}
function cleanCheckovSummary(summary = { passed: 0, failed: 0, skipped: 0, parsing_errors: 0, resource_count: 0, checkov_version: "3.3.9" }) { return JSON.stringify(summary); }
function recordToolChecks(directory) {
  write(directory, "tflint-version.stdout", "TFLint version 0.64.0\n+ ruleset.terraform (0.15.0-bundled)\n");
  write(directory, "tflint-version.stderr", "");
  write(directory, "checkov-version.stdout", "3.3.9\n");
  write(directory, "checkov-version.stderr", "");
  recordToolCheck({ reportDirectory: directory, scanner: "TFLINT", exit: 0, stdoutPath: "tflint-version.stdout", stderrPath: "tflint-version.stderr" });
  recordToolCheck({ reportDirectory: directory, scanner: "CHECKOV", exit: 0, stdoutPath: "checkov-version.stdout", stderrPath: "checkov-version.stderr" });
}
function recordFixtures(directory) {
  const fixtures = [
    ["TFLINT", tflintFixture, "terraform_required_version", 2, tflintSarif("terraform_required_version", "main.tf"), null],
    ["CHECKOV", publicBucketFixture, "CKV_OCI_10", 1, checkovSarif("CKV_OCI_10", "main.tf"), checkovJson("CKV_OCI_10", "/main.tf")],
    ["CHECKOV", sshFixture, "CKV_OCI_19", 1, checkovSarif("CKV_OCI_19", "main.tf"), checkovJson("CKV_OCI_19", "/main.tf", null, "oci_core_security_list.public")],
  ];
  for (const [scanner, fixturePath, expectedRuleId, exit, sarif, json] of fixtures) {
    const stem = `fixture-${expectedRuleId}`;
    write(directory, `${stem}.sarif`, sarif);
    if (json) write(directory, `${stem}.json`, json);
    recordFixture({ reportDirectory: directory, scanner, fixturePath, exit, expectedRuleId, rawSarifPath: `${stem}.sarif`, structuredJsonPath: json ? `${stem}.json` : null });
  }
}
function recordApprovedReports(directory, findings = currentCheckovFindings) {
  write(directory, "tflint-root.sarif", tflintSarif());
  write(directory, "checkov-root.sarif", checkovSarifRecords(findings));
  write(directory, "checkov-root.json", checkovJsonRecords(findings));
  recordScan({ reportDirectory: directory, scanner: "TFLINT", rootId, rootPath, exit: 0, rawSarifPath: "tflint-root.sarif", structuredJsonPath: null });
  recordScan({ reportDirectory: directory, scanner: "CHECKOV", rootId, rootPath, exit: 1, rawSarifPath: "checkov-root.sarif", structuredJsonPath: "checkov-root.json" });
}

test("policy is closed and pins the exact bundled TFLint ruleset", () => {
  const { policy } = loadPolicy();
  assert.deepEqual(Object.keys(policy), ["schemaVersion", "artifactKind", "inventoryPath", "toolchain", "execution", "report", "suppressions"]);
  assert.equal(policy.toolchain.tflint.rulesetVersion, "0.15.0-bundled");
  assert.deepEqual(policy.suppressions, approvedDecisions);
  for (const key of ["ownerIssueUrl", "ownerIssueTitle", "ownerIssueState", "expiresAt", "path", "resourceAddress", "ruleId", "reason", "impact", "removalCondition", "resourceIdentitySource"]) {
    const mutated = structuredClone(policy);
    mutated.suppressions[0][key] = "mutated";
    assert.throws(() => validatePolicy(mutated), /approved Platform decisions/);
  }
  const reordered = structuredClone(policy);
  reordered.suppressions.reverse();
  assert.throws(() => validatePolicy(reordered), /approved Platform decisions/);
  const duplicated = structuredClone(policy);
  duplicated.suppressions.push(structuredClone(duplicated.suppressions[0]));
  assert.throws(() => validatePolicy(duplicated), /approved Platform decisions/);
});

test("test report directories use the production RUNNER_TEMP root", () => {
  assert.equal(testReportRoot, process.env.RUNNER_TEMP ?? tmpdir());
});

test("tracked source hashing uses only the fixed Git binary", () => {
  assert.match(staticAnalysisRunnerSource, /execFileSync\("\/usr\/bin\/git", \["ls-files"/);
  assert.equal(staticAnalysisRunnerSource.includes('execFileSync("git"'), false);
  assert.equal(/process\.env\.GIT(?:_|\b)/.test(staticAnalysisRunnerSource), false);
});

test("only the five approved current Checkov identities normalize away from FIX_REQUIRED", () => {
  const directory = mkdtempSync(join(testReportRoot, "terraform-static-analysis-unclassified-"));
  try {
    recordToolChecks(directory);
    recordApprovedReports(directory, [...currentCheckovFindings, { ruleId: "CKV_OCI_999", path: "storage.tf", resourceAddress: "oci_core_volume.data[0]" }]);
    recordFixtures(directory);
    const result = analyze({ reportDirectory: directory, sourceSha: "a".repeat(40) });
    assert.equal(result.outcome, "FAIL");
    assert.deepEqual(result.findings.find(({ ruleId }) => ruleId === "CKV_OCI_999"), { scanner: "CHECKOV", ruleId: "CKV_OCI_999", rootId, path: `${rootPath}/storage.tf`, startLine: null, startColumn: null, endLine: null, endColumn: null, resourceAddress: "oci_core_volume.data[0]", resourceIdentitySource: "RESOURCE", disposition: "FIX_REQUIRED" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("TFLint regions are exact finding identities and fail closed", () => {
  const directory = mkdtempSync(join(testReportRoot, "terraform-static-analysis-regions-"));
  const artifactUri = "infra/terraform/oci/always-free-a1-flex/locals.tf";
  const location = (region, uri = artifactUri) => ({ ruleId: "terraform_required_version", level: "error", locations: [{ physicalLocation: { artifactLocation: { uri }, region } }] });
  try {
    recordToolChecks(directory);
    write(directory, "tflint-root.sarif", tflintSarifWithResults([
      location({ startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 }),
      location({ startLine: 2, startColumn: 1, endLine: 2, endColumn: 2 }),
    ]));
    write(directory, "checkov-root.sarif", checkovSarifRecords(currentCheckovFindings));
    write(directory, "checkov-root.json", checkovJsonRecords(currentCheckovFindings));
    recordScan({ reportDirectory: directory, scanner: "TFLINT", rootId, rootPath, exit: 2, rawSarifPath: "tflint-root.sarif", structuredJsonPath: null });
    recordScan({ reportDirectory: directory, scanner: "CHECKOV", rootId, rootPath, exit: 1, rawSarifPath: "checkov-root.sarif", structuredJsonPath: "checkov-root.json" });
    recordFixtures(directory);
    const result = analyze({ reportDirectory: directory, sourceSha: "a".repeat(40) });
    assert.deepEqual(result.findings.filter(({ scanner }) => scanner === "TFLINT"), [
      { scanner: "TFLINT", ruleId: "terraform_required_version", rootId, path: artifactUri, startLine: 1, startColumn: 1, endLine: 1, endColumn: 2, resourceAddress: "", resourceIdentitySource: null, disposition: "FIX_REQUIRED" },
      { scanner: "TFLINT", ruleId: "terraform_required_version", rootId, path: artifactUri, startLine: 2, startColumn: 1, endLine: 2, endColumn: 2, resourceAddress: "", resourceIdentitySource: null, disposition: "FIX_REQUIRED" },
    ]);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "tflint.sarif"), "utf8")).runs[0].results.map(({ locations }) => locations[0].physicalLocation), [
      { artifactLocation: { uri: artifactUri }, region: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 } },
      { artifactLocation: { uri: artifactUri }, region: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 2 } },
    ]);
    for (const [name, uri, matcher] of [["missing-prefix", "locals.tf", /repository-relative/], ["duplicated-prefix", `${rootPath}/${artifactUri}`, /source scope/]]) {
      write(directory, "invalid-production.sarif", tflintSarifWithResults([location({ startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 }, uri)]));
      assert.throws(() => recordScan({ reportDirectory: directory, scanner: "TFLINT", rootId: name, rootPath, exit: 2, rawSarifPath: "invalid-production.sarif", structuredJsonPath: null }), matcher);
    }
    for (const [name, region] of [["missing", null], ["extra-key", { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2, byteOffset: 0 }], ["non-integer", { startLine: 1.5, startColumn: 1, endLine: 1, endColumn: 2 }], ["nonpositive", { startLine: 0, startColumn: 1, endLine: 1, endColumn: 2 }], ["reversed", { startLine: 2, startColumn: 1, endLine: 1, endColumn: 2 }]]) {
      const invalid = JSON.parse(tflintSarif("terraform_required_version"));
      if (region === null) delete invalid.runs[0].results[0].locations[0].physicalLocation.region;
      else invalid.runs[0].results[0].locations[0].physicalLocation.region = region;
      write(directory, "invalid.sarif", JSON.stringify(invalid));
      assert.throws(() => recordScan({ reportDirectory: directory, scanner: "TFLINT", rootId: `${name}-region`, rootPath, exit: 2, rawSarifPath: "invalid.sarif", structuredJsonPath: null }), /region/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("pinned-output-shaped TFLint version and two-run SARIF fail closed", () => {
  const directory = mkdtempSync(join(testReportRoot, "terraform-static-analysis-tflint-"));
  try {
    write(directory, "tflint-version.stdout", "TFLint version 0.64.0\n");
    write(directory, "tflint-version.stderr", "");
    assert.throws(() => recordToolCheck({ reportDirectory: directory, scanner: "TFLINT", exit: 0, stdoutPath: "tflint-version.stdout", stderrPath: "tflint-version.stderr" }), /version output/);
    write(directory, "tflint-version.stdout", "TFLint version 0.64.0\n+ ruleset.terraform (0.15.0-bundled)\n");
    write(directory, "tflint-version.stderr", "update available\n");
    assert.throws(() => recordToolCheck({ reportDirectory: directory, scanner: "TFLINT", exit: 0, stdoutPath: "tflint-version.stdout", stderrPath: "tflint-version.stderr" }), /version probe/);
    write(directory, "tflint-version.stderr", "");
    assert.throws(() => recordToolCheck({ reportDirectory: directory, scanner: "TFLINT", exit: 1, stdoutPath: "tflint-version.stdout", stderrPath: "tflint-version.stderr" }), /version probe/);
    write(directory, "tflint-root.sarif", JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "tflint", version: "0.64.0", informationUri: tflintInfoUri, rules: [] } }, results: [] }] }));
    assert.throws(() => recordScan({ reportDirectory: directory, scanner: "TFLINT", rootId, rootPath, exit: 0, rawSarifPath: "tflint-root.sarif", structuredJsonPath: null }), /two ordered runs/);
    write(directory, "tflint-root.sarif", JSON.stringify({ version: "2.1.0", runs: [
      { tool: { driver: { name: "tflint", version: "0.64.0", informationUri: tflintInfoUri, rules: [] } }, results: [] },
      { tool: { driver: { name: "tflint-errors", version: "0.64.0", informationUri: tflintInfoUri, rules: [] } }, results: [{ ruleId: "parser", locations: [{ physicalLocation: { artifactLocation: { uri: "versions.tf" } } }] }] },
    ] }));
    assert.throws(() => recordScan({ reportDirectory: directory, scanner: "TFLINT", rootId, rootPath, exit: 0, rawSarifPath: "tflint-root.sarif", structuredJsonPath: null }), /error run/);
    write(directory, "tflint-root.sarif", tflintSarif());
    recordScan({ reportDirectory: directory, scanner: "TFLINT", rootId, rootPath, exit: 0, rawSarifPath: "tflint-root.sarif", structuredJsonPath: null });
    write(directory, "tflint-root.sarif", tflintSarif("terraform_required_version", "versions.tf", { id: "other_rule" }));
    assert.throws(() => recordScan({ reportDirectory: directory, scanner: "TFLINT", rootId: "unknown-tflint-rule", rootPath, exit: 2, rawSarifPath: "tflint-root.sarif", structuredJsonPath: null }), /rule/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("report directory aliases and symlinks cannot become filesystem identities", () => {
  const directory = mkdtempSync(join(testReportRoot, "terraform-static-analysis-path-"));
  const alias = `${directory}-alias`;
  try {
    write(directory, "tflint-version.stdout", "TFLint version 0.64.0\n+ ruleset.terraform (0.15.0-bundled)\n");
    write(directory, "tflint-version.stderr", "");
    assert.throws(() => recordToolCheck({ reportDirectory: `${directory}/.`, scanner: "TFLINT", exit: 0, stdoutPath: "tflint-version.stdout", stderrPath: "tflint-version.stderr" }), /directory identity/);
    symlinkSync(directory, alias);
    assert.throws(() => recordToolCheck({ reportDirectory: alias, scanner: "TFLINT", exit: 0, stdoutPath: "tflint-version.stdout", stderrPath: "tflint-version.stderr" }), /real directory/);
  } finally { rmSync(alias, { force: true }); rmSync(directory, { recursive: true, force: true }); }
});

test("Checkov joins JSON resource identity to exactly one normalized SARIF result", () => {
  const directory = mkdtempSync(join(testReportRoot, "terraform-static-analysis-checkov-"));
  try {
    write(directory, "checkov-root.sarif", checkovSarif("CKV_OCI_10", "datapack_object_storage.tf"));
    write(directory, "checkov-root.json", checkovJson("CKV_OCI_10", "\\datapack_object_storage.tf"));
    recordScan({ reportDirectory: directory, scanner: "CHECKOV", rootId, rootPath, exit: 1, rawSarifPath: "checkov-root.sarif", structuredJsonPath: "checkov-root.json" });
    write(directory, "checkov-root.sarif", checkovSarif("CKV_OCI_10", "datapack_object_storage.tf", "checkov"));
    assert.throws(() => recordScan({ reportDirectory: directory, scanner: "CHECKOV", rootId, rootPath, exit: 1, rawSarifPath: "checkov-root.sarif", structuredJsonPath: "checkov-root.json" }), /driver identity/);
    write(directory, "checkov-root.sarif", checkovSarif("CKV_OCI_10", "datapack_object_storage.tf"));
    write(directory, "checkov-root.sarif", JSON.stringify({ version: "2.1.0", runs: [JSON.parse(checkovSarif("CKV_OCI_10")).runs[0], JSON.parse(checkovSarif("CKV_OCI_10")).runs[0]] }));
    assert.throws(() => recordScan({ reportDirectory: directory, scanner: "CHECKOV", rootId: "multi-run", rootPath, exit: 1, rawSarifPath: "checkov-root.sarif", structuredJsonPath: "checkov-root.json" }), /one run/);
    write(directory, "checkov-root.sarif", checkovSarif("CKV_OCI_10", "datapack_object_storage.tf", "Checkov", [{ id: "other_rule" }]));
    assert.throws(() => recordScan({ reportDirectory: directory, scanner: "CHECKOV", rootId: "unknown-checkov-rule", rootPath, exit: 1, rawSarifPath: "checkov-root.sarif", structuredJsonPath: "checkov-root.json" }), /rule/);
    write(directory, "checkov-root.sarif", checkovSarif("CKV_OCI_10", "datapack_object_storage.tf"));
    write(directory, "checkov-root.json", checkovJson("CKV_OCI_10", "/%2e%2e/escape.tf"));
    assert.throws(() => recordScan({ reportDirectory: directory, scanner: "CHECKOV", rootId, rootPath, exit: 1, rawSarifPath: "checkov-root.sarif", structuredJsonPath: "checkov-root.json" }), /unsafe|join/);
    write(directory, "checkov-root.sarif", checkovSarif("CKV_OCI_10", "%2e%2e/escape.tf"));
    write(directory, "checkov-root.json", checkovJson("CKV_OCI_10", "/../escape.tf"));
    assert.throws(() => recordScan({ reportDirectory: directory, scanner: "CHECKOV", rootId, rootPath, exit: 1, rawSarifPath: "checkov-root.sarif", structuredJsonPath: "checkov-root.json" }), /unsafe/);
    for (const uri of ["C:\\escape.tf", "..\\escape.tf", "\\\\server\\share\\escape.tf"]) {
      write(directory, "checkov-root.sarif", checkovSarif("CKV_OCI_10", uri));
      write(directory, "checkov-root.json", checkovJson("CKV_OCI_10", "/datapack_object_storage.tf"));
      assert.throws(() => recordScan({ reportDirectory: directory, scanner: "CHECKOV", rootId, rootPath, exit: 1, rawSarifPath: "checkov-root.sarif", structuredJsonPath: "checkov-root.json" }), /unsafe/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("full Checkov JSON report requires exact shape and summary counts", () => {
  const directory = mkdtempSync(join(testReportRoot, "terraform-static-analysis-checkov-report-"));
  try {
    write(directory, "checkov-root.sarif", checkovSarif("CKV_OCI_10"));
    write(directory, "checkov-root.json", checkovJson("CKV_OCI_10"));
    recordScan({ reportDirectory: directory, scanner: "CHECKOV", rootId, rootPath, exit: 1, rawSarifPath: "checkov-root.sarif", structuredJsonPath: "checkov-root.json" });
    const mismatched = JSON.parse(checkovJson("CKV_OCI_10"));
    mismatched.summary.failed = 0;
    write(directory, "checkov-root.json", JSON.stringify(mismatched));
    assert.throws(() => recordScan({ reportDirectory: directory, scanner: "CHECKOV", rootId: "mismatched-summary", rootPath, exit: 1, rawSarifPath: "checkov-root.sarif", structuredJsonPath: "checkov-root.json" }), /summary/);
    const extra = JSON.parse(checkovJson("CKV_OCI_10"));
    extra.extra = true;
    write(directory, "checkov-root.json", JSON.stringify(extra));
    assert.throws(() => recordScan({ reportDirectory: directory, scanner: "CHECKOV", rootId: "extra-report-key", rootPath, exit: 1, rawSarifPath: "checkov-root.sarif", structuredJsonPath: "checkov-root.json" }), /keys/);
    const missing = JSON.parse(checkovJson("CKV_OCI_10"));
    delete missing.url;
    write(directory, "checkov-root.json", JSON.stringify(missing));
    assert.throws(() => recordScan({ reportDirectory: directory, scanner: "CHECKOV", rootId: "missing-report-key", rootPath, exit: 1, rawSarifPath: "checkov-root.sarif", structuredJsonPath: "checkov-root.json" }), /keys/);
    const resultsExtra = JSON.parse(checkovJson("CKV_OCI_10"));
    resultsExtra.results.extra_checks = [];
    write(directory, "checkov-root.json", JSON.stringify(resultsExtra));
    assert.throws(() => recordScan({ reportDirectory: directory, scanner: "CHECKOV", rootId: "extra-results-key", rootPath, exit: 1, rawSarifPath: "checkov-root.sarif", structuredJsonPath: "checkov-root.json" }), /keys/);
    const corruptPassed = JSON.parse(checkovJson("CKV_OCI_10"));
    corruptPassed.results.passed_checks.push({ check_result: { result: "FAILED" } });
    corruptPassed.summary.passed = 1;
    write(directory, "checkov-root.json", JSON.stringify(corruptPassed));
    assert.throws(() => recordScan({ reportDirectory: directory, scanner: "CHECKOV", rootId: "corrupt-passed", rootPath, exit: 1, rawSarifPath: "checkov-root.sarif", structuredJsonPath: "checkov-root.json" }), /passed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("public bucket fixture is a CKV_OCI_10-only unfiltered scanner mutation", () => {
  const text = readFileSync(new URL("./fixtures/terraform-static-analysis/checkov-oci-public-bucket.tf.fixture", import.meta.url), "utf8");
  for (const literal of ["ObjectReadWithoutList", "object_events_enabled = true", "kms_key_id             = \"ocid1.key.oc1..example\"", "versioning             = \"Enabled\""]) assert.match(text, new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Checkov accepts only the direct all-zero documented clean summary with clean SARIF and exit zero", () => {
  const directory = mkdtempSync(join(testReportRoot, "terraform-static-analysis-clean-checkov-"));
  try {
    write(directory, "checkov-root.sarif", checkovSarif());
    write(directory, "checkov-root.json", cleanCheckovSummary());
    recordScan({ reportDirectory: directory, scanner: "CHECKOV", rootId, rootPath, exit: 0, rawSarifPath: "checkov-root.sarif", structuredJsonPath: "checkov-root.json" });
    write(directory, "checkov-root.json", cleanCheckovSummary({ passed: 0, failed: 1, skipped: 0, parsing_errors: 0, resource_count: 0, checkov_version: "3.3.9" }));
    assert.throws(() => recordScan({ reportDirectory: directory, scanner: "CHECKOV", rootId, rootPath, exit: 0, rawSarifPath: "checkov-root.sarif", structuredJsonPath: "checkov-root.json" }), /clean summary|keys/);
    write(directory, "checkov-root.json", JSON.stringify({ passed: 0, failed: 0 }));
    assert.throws(() => recordScan({ reportDirectory: directory, scanner: "CHECKOV", rootId, rootPath, exit: 0, rawSarifPath: "checkov-root.sarif", structuredJsonPath: "checkov-root.json" }), /clean summary|keys/);
    write(directory, "checkov-root.json", cleanCheckovSummary({ passed: 0, failed: 0, skipped: 0, parsing_errors: 0, resource_count: 0, checkov_version: "3.3.8" }));
    assert.throws(() => recordScan({ reportDirectory: directory, scanner: "CHECKOV", rootId, rootPath, exit: 0, rawSarifPath: "checkov-root.sarif", structuredJsonPath: "checkov-root.json" }), /clean summary/);
    write(directory, "checkov-root.json", JSON.stringify({ passed: 0, failed: 0, skipped: 0, parsing_errors: 0, resource_count: 0, checkov_version: "3.3.9", check_count: 0 }));
    assert.throws(() => recordScan({ reportDirectory: directory, scanner: "CHECKOV", rootId, rootPath, exit: 0, rawSarifPath: "checkov-root.sarif", structuredJsonPath: "checkov-root.json" }), /keys/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("combined SARIF merges all root rules deterministically and rejects conflicts", () => {
  const directory = mkdtempSync(join(testReportRoot, "terraform-static-analysis-combined-"));
  try {
    write(directory, "first.sarif", tflintSarif("a_rule", `${rootPath}/versions.tf`, { id: "a_rule", name: "A" }));
    write(directory, "second.sarif", tflintSarif("b_rule", `${rootPath}/locals.tf`, { id: "b_rule", name: "B" }));
    const scans = [
      { directory, scanner: "TFLINT", rootId, rootPath, rawSarifPath: "first.sarif" },
      { directory, scanner: "TFLINT", rootId, rootPath, rawSarifPath: "second.sarif" },
    ];
    const combined = combineSarifForScans(scans, "TFLINT");
    assert.deepEqual(combined.runs[0].tool.driver.rules.map(({ id }) => id), ["a_rule", "b_rule"]);
    assert.deepEqual(combined.runs[0].results.map(({ ruleId }) => ruleId), ["a_rule", "b_rule"]);
    write(directory, "second.sarif", tflintSarif("a_rule", `${rootPath}/locals.tf`, { id: "a_rule", name: "conflict" }));
    assert.throws(() => combineSarifForScans(scans, "TFLINT"), /conflicting SARIF rule/);
    write(directory, "first-checkov.sarif", checkovSarif("CKV_A", "first.tf"));
    write(directory, "second-checkov.sarif", checkovSarif("CKV_B", "second.tf"));
    const checkovCombined = combineSarifForScans([
      { directory, scanner: "CHECKOV", rootPath: "root-a", rawSarifPath: "first-checkov.sarif" },
      { directory, scanner: "CHECKOV", rootPath: "root-b", rawSarifPath: "second-checkov.sarif" },
    ], "CHECKOV");
    assert.deepEqual(checkovCombined.runs[0].tool.driver.rules.map(({ id }) => id), ["CKV_A", "CKV_B"]);
    assert.deepEqual(checkovCombined.runs[0].results.map(({ ruleId }) => ruleId), ["CKV_A", "CKV_B"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("analysis generates normalized combined SARIF and binds raw/tool/fixture evidence", () => {
  const directory = mkdtempSync(join(testReportRoot, "terraform-static-analysis-result-"));
  try {
    recordToolChecks(directory);
    recordApprovedReports(directory);
    recordFixtures(directory);
    const result = analyze({ reportDirectory: directory, sourceSha: "a".repeat(40) });
    assert.equal(result.outcome, "PASS");
    assert.deepEqual(Object.keys(result.reports), ["tflintSarif", "checkovSarif", "toolChecks", "scans", "fixtureChecks"]);
    assert.deepEqual(result.reports.toolChecks.map(({ scanner, version, ruleset }) => [scanner, version, ruleset]), [["CHECKOV", "3.3.9", null], ["TFLINT", "0.64.0", "0.15.0-bundled"]]);
    assert.deepEqual(result.findings, approvedDecisions.map(({ scanner, ruleId, rootId: findingRootId, path, resourceAddress, resourceIdentitySource, disposition }) => ({ scanner, ruleId, rootId: findingRootId, path, startLine: null, startColumn: null, endLine: null, endColumn: null, resourceAddress, resourceIdentitySource, disposition })).sort((left, right) => JSON.stringify(left) < JSON.stringify(right) ? -1 : JSON.stringify(left) > JSON.stringify(right) ? 1 : 0));
    assert.deepEqual(Object.keys(result.findings[0]), ["scanner", "ruleId", "rootId", "path", "startLine", "startColumn", "endLine", "endColumn", "resourceAddress", "resourceIdentitySource", "disposition"]);
    assert.deepEqual(Object.keys(result.reports.fixtureChecks[0]), ["scanner", "fixturePath", "sourceSha256", "expectedRuleId", "exit", "rawSarifSha256", "structuredJsonSha256"]);
    const combined = JSON.parse(readFileSync(join(directory, "checkov.sarif"), "utf8"));
    assert.equal(combined.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, `${rootPath}/datapack_object_storage.tf`);
    const checkovBytes = readFileSync(join(directory, "checkov.sarif"), "utf8");
    const summaryBytes = readFileSync(join(directory, "terraform-static-analysis-summary.md"), "utf8");
    write(directory, "checkov.sarif", "tampered\n");
    assert.throws(() => enforce({ reportDirectory: directory, sourceSha: "a".repeat(40), tflintOutcome: "success", checkovOutcome: "success" }), /combined SARIF/);
    assert.equal(readFileSync(join(directory, "checkov.sarif"), "utf8"), "tampered\n");
    write(directory, "checkov.sarif", checkovBytes);
    write(directory, "terraform-static-analysis-summary.md", "tampered\n");
    assert.throws(() => enforce({ reportDirectory: directory, sourceSha: "a".repeat(40), tflintOutcome: "success", checkovOutcome: "success" }), /summary/);
    assert.equal(readFileSync(join(directory, "terraform-static-analysis-summary.md"), "utf8"), "tampered\n");
    write(directory, "terraform-static-analysis-summary.md", summaryBytes);
    enforce({ reportDirectory: directory, sourceSha: "a".repeat(40), tflintOutcome: "success", checkovOutcome: "success" });
    const rawScanPath = join(directory, ".scanner-exits.json");
    const rawScans = readFileSync(rawScanPath, "utf8");
    const cleanupTargetMutation = JSON.parse(rawScans);
    cleanupTargetMutation[0].rawSarifPath = "checkov.sarif";
    write(directory, ".scanner-exits.json", `${JSON.stringify(cleanupTargetMutation)}\n`);
    assert.throws(() => cleanup({ reportDirectory: directory }), /SARIF|raw evidence/);
    assert.equal(readFileSync(join(directory, "checkov.sarif"), "utf8"), checkovBytes);
    write(directory, ".scanner-exits.json", rawScans);
    write(directory, "tflint-version.stderr", "tampered\n");
    assert.throws(() => cleanup({ reportDirectory: directory }), /version probe|tool check|raw evidence/);
    write(directory, "tflint-version.stderr", "");
    cleanup({ reportDirectory: directory });
    assert.deepEqual(readdirSync(directory).sort(), ["checkov.sarif", "terraform-static-analysis-result.json", "terraform-static-analysis-summary.md", "tflint.sarif"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
