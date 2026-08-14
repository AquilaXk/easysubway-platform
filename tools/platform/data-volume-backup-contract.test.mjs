import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const repository = new URL("../../", import.meta.url);

function read(path) {
  return readFileSync(new URL(path, repository), "utf8");
}

function occurrences(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

test("data volume backup contract is closed to the single-host startup decision", () => {
  const contract = JSON.parse(read("contracts/release/platform-data-volume-backup-contract.json"));

  assert.deepEqual(contract, {
    schemaVersion: 1,
    artifactKind: "platform-data-volume-backup-contract-v1",
    target: {
      terraformAddress: "oci_core_volume.data[0]",
      controlRoot: "infra/terraform/oci/data-volume-backup-control",
      controlVolumeInput: "var.data_volume_ocid",
      stateDisposition: "OWNER_LOCAL_EXTERNAL",
      mountPath: "/var/lib/easysubway-data",
      dockerDataRoot: "/var/lib/easysubway-data/docker",
      authoritativeData: ["POSTGRESQL", "PRIVATE_OBJECT_STORAGE"],
      rebuildableData: ["CONTAINER_IMAGES", "CONTAINER_RUNTIME_STATE", "APPLICATION_LOGS", "OBSERVABILITY_STATE"],
    },
    policy: {
      backupType: "INCREMENTAL",
      period: "ONE_DAY",
      hourOfDay: 3,
      offsetType: "STRUCTURED",
      timeZone: "REGIONAL_DATA_CENTER_TIME",
      retentionSeconds: 345600,
      maxRetainedBackups: 4,
      freeTierCombinedBackupLimit: 5,
      destinationRegion: null,
      encryption: "OCI_PROVIDER_MANAGED",
    },
    objectives: {
      maximumRpoHours: 28,
      maximumRestoreRtoHours: 4,
    },
    alert: {
      owner: "AquilaXk",
      eventType: "com.oraclecloud.blockvolumes.createvolumebackup.end",
      status: "operationFailed",
      protocol: "EMAIL",
      endpointSource: "var.data_volume_backup_alert_email",
      activationInput: "var.enable_backup_failure_event_rule",
      defaultEventRuleEnabled: false,
      requiredWhen: "ACTIVE_EVENT_RULE_APPLY",
      requiredSubscriptionState: "ACTIVE",
    },
    restore: {
      source: "LATEST_AVAILABLE_EXACT_POLICY_BACKUP",
      target: "NEW_VOLUME",
      attachment: "READ_ONLY",
      productionOverwrite: false,
      requiredMarkers: ["PG_VERSION", ".minio.sys"],
      receipt: "SANITIZED_CREATE_ONLY",
      cleanup: "DETACH_AND_DELETE_REHEARSAL_VOLUME",
    },
    excluded: [
      "BOOT_VOLUME_BACKUP",
      "SECOND_BACKUP_POLICY",
      "CROSS_REGION_COPY",
      "CUSTOMER_MANAGED_KEY",
      "PITR",
      "SECOND_SERVER",
    ],
  });
});

test("standalone Terraform root owns one existing-volume policy and exact failure alert", () => {
  const storage = read("infra/terraform/oci/always-free-a1-flex/storage.tf");
  const broadVariables = read("infra/terraform/oci/always-free-a1-flex/variables.tf");
  const broadExample = read("infra/terraform/oci/always-free-a1-flex/terraform.tfvars.example");
  const versions = read("infra/terraform/oci/data-volume-backup-control/versions.tf");
  const providers = read("infra/terraform/oci/data-volume-backup-control/providers.tf");
  const variables = read("infra/terraform/oci/data-volume-backup-control/variables.tf");
  const resources = read("infra/terraform/oci/data-volume-backup-control/main.tf");
  const outputs = read("infra/terraform/oci/data-volume-backup-control/outputs.tf");

  assert.equal(occurrences(storage, /resource "oci_core_volume" "data"/g), 1);
  assert.equal(occurrences(storage, /resource "oci_core_volume_attachment" "data"/g), 1);
  assert.doesNotMatch(storage, /volume_backup_policy|backup_policy_id|destination_region|boot_volume_backup/);
  assert.equal(existsSync(new URL("../../infra/terraform/oci/always-free-a1-flex/backup-alerts.tf", import.meta.url)), false);
  assert.doesNotMatch(broadVariables, /data_volume_backup_alert_email/);
  assert.doesNotMatch(broadExample, /data_volume_backup_alert_email/);

  assert.match(versions, /backend "local" \{\}/);
  assert.match(versions, /source\s*=\s*"oracle\/oci"/);
  assert.match(versions, /version\s*=\s*"~> 8\.8"/);
  assert.match(providers, /auth\s*=\s*"APIKey"/);
  assert.match(providers, /config_file_profile\s*=\s*var\.config_file_profile/);
  assert.match(providers, /region\s*=\s*var\.region/);

  assert.equal(occurrences(resources, /resource "oci_core_volume_backup_policy" "data"/g), 1);
  assert.equal(occurrences(resources, /resource "oci_core_volume_backup_policy_assignment" "data"/g), 1);
  assert.match(resources, /backup_type\s*=\s*"INCREMENTAL"/);
  assert.match(resources, /period\s*=\s*"ONE_DAY"/);
  assert.match(resources, /retention_seconds\s*=\s*345600/);
  assert.match(resources, /hour_of_day\s*=\s*3/);
  assert.match(resources, /offset_type\s*=\s*"STRUCTURED"/);
  assert.match(resources, /time_zone\s*=\s*"REGIONAL_DATA_CENTER_TIME"/);
  assert.match(resources, /asset_id\s*=\s*var\.data_volume_ocid/);
  assert.match(resources, /policy_id\s*=\s*oci_core_volume_backup_policy\.data\.id/);
  assert.doesNotMatch(resources, /backup_policy_id|destination_region|xrc_kms_key_id|boot_volume_backup/);

  assert.equal(occurrences(resources, /resource "oci_ons_notification_topic" "data_volume_backup"/g), 1);
  assert.equal(occurrences(resources, /resource "oci_ons_subscription" "data_volume_backup"/g), 1);
  assert.equal(occurrences(resources, /resource "oci_events_rule" "data_volume_backup_failed"/g), 1);
  assert.match(resources, /protocol\s*=\s*"EMAIL"/);
  assert.match(resources, /endpoint\s*=\s*var\.data_volume_backup_alert_email/);
  assert.match(resources, /count\s*=\s*var\.enable_backup_failure_event_rule\s*\?\s*1\s*:\s*0/);
  assert.match(resources, /condition\s*=\s*oci_ons_subscription\.data_volume_backup\.state\s*==\s*"ACTIVE"/);
  assert.match(resources, /error_message\s*=\s*"data volume backup alert subscription must be ACTIVE before enabling the event rule\."/);
  assert.match(resources, /event_types\s*=\s*\[\s*"com\.oraclecloud\.blockvolumes\.createvolumebackup\.end"\s*\]/s);
  assert.match(resources, /status\s*=\s*\["operationFailed"\]/);
  assert.match(resources, /volumeId\s*=\s*\[var\.data_volume_ocid\]/);
  assert.match(resources, /action_type\s*=\s*"ONS"/);
  assert.match(resources, /topic_id\s*=\s*oci_ons_notification_topic\.data_volume_backup\.id/);
  assert.doesNotMatch(resources, /@example\.(com|org)|https?:\/\//);

  const variableBlock = variables.match(/variable "data_volume_backup_alert_email" \{[\s\S]*?\n\}/)?.[0];
  assert.ok(variableBlock, "data_volume_backup_alert_email variable must exist");
  assert.match(variableBlock, /type\s*=\s*string/);
  assert.match(variableBlock, /sensitive\s*=\s*true/);
  assert.match(variableBlock, /trimspace\(var\.data_volume_backup_alert_email\)/);
  const activationBlock = variables.match(/variable "enable_backup_failure_event_rule" \{[\s\S]*?\n\}/)?.[0];
  assert.ok(activationBlock, "enable_backup_failure_event_rule variable must exist");
  assert.match(activationBlock, /type\s*=\s*bool/);
  assert.match(activationBlock, /default\s*=\s*false/);
  for (const name of ["compartment_ocid", "config_file_profile", "data_volume_ocid", "name_prefix", "region"]) {
    assert.match(variables, new RegExp(`variable "${name}"`));
  }
  assert.equal(variables.includes(String.raw`regex("^ocid1\\.(compartment|tenancy)\\."`), true);
  assert.equal(variables.includes(String.raw`regex("^ocid1\\.volume\\."`), true);
  for (const name of ["backup_policy_id", "backup_policy_assignment_id", "event_rule_enabled", "event_rule_id", "notification_topic_id", "subscription_id", "subscription_state"]) {
    assert.match(outputs, new RegExp(`output "${name}"`));
  }
  assert.match(outputs, /value\s*=\s*one\(oci_events_rule\.data_volume_backup_failed\[\*\]\.id\)/);
});

test("CI and static-risk policy bind CKV_OCI_2 to the recommended assignment scanner exception", () => {
  const policy = JSON.parse(read("tools/platform/terraform-static-analysis-policy.json"));
  const runner = read("tools/platform/terraform-static-analysis.mjs");
  const staticTests = read("tools/platform/terraform-static-analysis.test.mjs");
  const workflow = read(".github/workflows/ci.yml");

  const backupDecision = policy.suppressions.filter(({ ruleId }) => ruleId === "CKV_OCI_2");
  assert.equal(backupDecision.length, 1);
  assert.equal(backupDecision[0].resourceAddress, "oci_core_volume.data[0]");
  assert.equal(backupDecision[0].disposition, "NOT_APPLICABLE_WITH_REASON");
  assert.match(backupDecision[0].reason, /deprecated direct backup_policy_id/);
  assert.match(backupDecision[0].reason, /별도 Terraform state root/);
  assert.match(backupDecision[0].impact, /deterministic two-root ownership contract와 live assignment read-back/);
  assert.match(backupDecision[0].removalCondition, /cross-root state relationship/);
  assert.equal(policy.suppressions.some(({ ruleId }) => ruleId === "CKV_OCI_3"), true);
  assert.match(runner, /\["CKV_OCI_2",[^\n]+"NOT_APPLICABLE_WITH_REASON"/);
  assert.match(staticTests, /\["CKV_OCI_2",[^\n]+"NOT_APPLICABLE_WITH_REASON"/);
  assert.match(runner, /\["CKV_OCI_3",/);
  assert.match(staticTests, /\["CKV_OCI_3",/);
  assert.equal(occurrences(workflow, /^\s*node --test tools\/platform\/data-volume-backup-contract\.test\.mjs$/gm), 1);
});
