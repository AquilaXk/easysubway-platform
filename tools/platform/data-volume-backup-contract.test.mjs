import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("Terraform binds one daily incremental policy and one exact failure alert to the data volume", () => {
  const storage = read("infra/terraform/oci/always-free-a1-flex/storage.tf");
  const alerts = read("infra/terraform/oci/always-free-a1-flex/backup-alerts.tf");
  const variables = read("infra/terraform/oci/always-free-a1-flex/variables.tf");
  const example = read("infra/terraform/oci/always-free-a1-flex/terraform.tfvars.example");

  assert.equal(occurrences(storage, /resource "oci_core_volume_backup_policy" "data"/g), 1);
  assert.equal(occurrences(storage, /resource "oci_core_volume_backup_policy_assignment" "data"/g), 1);
  assert.match(storage, /count\s*=\s*var\.create_data_volume \? 1 : 0/);
  assert.match(storage, /backup_type\s*=\s*"INCREMENTAL"/);
  assert.match(storage, /period\s*=\s*"ONE_DAY"/);
  assert.match(storage, /retention_seconds\s*=\s*345600/);
  assert.match(storage, /hour_of_day\s*=\s*3/);
  assert.match(storage, /offset_type\s*=\s*"STRUCTURED"/);
  assert.match(storage, /time_zone\s*=\s*"REGIONAL_DATA_CENTER_TIME"/);
  assert.match(storage, /asset_id\s*=\s*oci_core_volume\.data\[0\]\.id/);
  assert.match(storage, /policy_id\s*=\s*oci_core_volume_backup_policy\.data\[0\]\.id/);
  assert.doesNotMatch(storage, /destination_region|xrc_kms_key_id|boot_volume_backup/);

  assert.equal(occurrences(alerts, /resource "oci_ons_notification_topic" "data_volume_backup"/g), 1);
  assert.equal(occurrences(alerts, /resource "oci_ons_subscription" "data_volume_backup"/g), 1);
  assert.equal(occurrences(alerts, /resource "oci_events_rule" "data_volume_backup_failed"/g), 1);
  assert.match(alerts, /protocol\s*=\s*"EMAIL"/);
  assert.match(alerts, /endpoint\s*=\s*var\.data_volume_backup_alert_email/);
  assert.match(alerts, /event_types\s*=\s*\[\s*"com\.oraclecloud\.blockvolumes\.createvolumebackup\.end"\s*\]/s);
  assert.match(alerts, /status\s*=\s*\["operationFailed"\]/);
  assert.match(alerts, /volumeId\s*=\s*\[oci_core_volume\.data\[0\]\.id\]/);
  assert.match(alerts, /action_type\s*=\s*"ONS"/);
  assert.match(alerts, /topic_id\s*=\s*oci_ons_notification_topic\.data_volume_backup\[0\]\.id/);
  assert.doesNotMatch(alerts, /@example\.(com|org)|https?:\/\//);

  const variableBlock = variables.match(/variable "data_volume_backup_alert_email" \{[\s\S]*?\n\}/)?.[0];
  assert.ok(variableBlock, "data_volume_backup_alert_email variable must exist");
  assert.match(variableBlock, /type\s*=\s*string/);
  assert.match(variableBlock, /nullable\s*=\s*false/);
  assert.match(variableBlock, /sensitive\s*=\s*true/);
  assert.doesNotMatch(variableBlock, /default\s*=/);
  assert.equal(occurrences(example, /^data_volume_backup_alert_email\s*=\s*"owner@example\.com"$/gm), 1);
});

test("CI and static-risk policy require the backup contract and remove only CKV_OCI_2", () => {
  const policy = JSON.parse(read("tools/platform/terraform-static-analysis-policy.json"));
  const runner = read("tools/platform/terraform-static-analysis.mjs");
  const staticTests = read("tools/platform/terraform-static-analysis.test.mjs");
  const workflow = read(".github/workflows/ci.yml");

  assert.equal(policy.suppressions.some(({ ruleId }) => ruleId === "CKV_OCI_2"), false);
  assert.equal(policy.suppressions.some(({ ruleId }) => ruleId === "CKV_OCI_3"), true);
  assert.doesNotMatch(runner, /\["CKV_OCI_2",/);
  assert.doesNotMatch(staticTests, /\["CKV_OCI_2",/);
  assert.match(runner, /\["CKV_OCI_3",/);
  assert.match(staticTests, /\["CKV_OCI_3",/);
  assert.equal(occurrences(workflow, /^\s*node --test tools\/platform\/data-volume-backup-contract\.test\.mjs$/gm), 1);
});
