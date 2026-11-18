import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CleanRoomBootstrapError,
  DEFAULT_REQUIRED_ENV_KEYS,
  EXPECTED_STAGE_ORDER,
  MAX_CONFIG_FILE_BYTES,
  parseCliArgs,
  verifyCleanRoomHostBootstrap,
} from "./verify-clean-room-host-bootstrap.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VERIFIER_SCRIPT = fileURLToPath(
  new URL("./verify-clean-room-host-bootstrap.mjs", import.meta.url),
);
const FIXED_NOW = new Date("2026-11-09T12:00:00.000Z");
const SECRET_SENTINEL = "super-secret-sentinel-value-do-not-leak-987654321";
const WEBHOOK_SENTINEL = "https://hooks.slack.com/services/T000/B000/SECRETWEBHOOK";

// Self-signed EC prime256v1 X.509 certificate (notBefore: 2026-11-09, notAfter: 2036-11-06T11:53:24Z)
const TEST_X509_PEM = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBgTCCASigAwIBAgIUPln7hqwguFEbF2yDlgHOvA3xW/UwCgYIKoZIzj0EAwIw",
  "JzElMCMGA1UEAwwcZWFzeXN1YndheS1hcGkuYXF1aWxheGsuc2l0ZTAeFw0yNjEx",
  "MDkxMTUzMjRaFw0zNjExMDYxMTUzMjRaMCcxJTAjBgNVBAMMHGVhc3lzdWJ3YXkt",
  "YXBpLmFxdWlsYXhrLnNpdGUwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATt5PB1",
  "l6hIy3nnJeH71XFLi/VR0v4ceP9NvsVr2XG8FwN4OBTAhiWG37AB9lWldJZgFfAl",
  "0Tx71acCp45jqK6cozIwMDAdBgNVHQ4EFgQUdkX7Pq66E5aDATH6/Z4QUmCWhdYw",
  "DwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBEAiA7ioFAHAIZgcX//G8V",
  "cYtD/ZOlaHzyAs7t+NsHKfhIUwIgO6bVPro+ELJxv0cQtIjAt3/EKXsJkp3CmDMc",
  "O8+8NI8=",
  "-----END CERTIFICATE-----",
  "",
].join("\n");

const sandboxes = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createSandbox() {
  const root = mkdtempSync(path.join(tmpdir(), "clean-room-bootstrap-"));
  sandboxes.push(root);
  return root;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function buildValidEnvContent() {
  const lines = [];
  for (const key of DEFAULT_REQUIRED_ENV_KEYS) {
    lines.push(`${key}=${SECRET_SENTINEL}_${key}`);
  }
  return `${lines.join("\n")}\n`;
}

function createCleanRoomFixture(overrides = {}) {
  const hostRoot = createSandbox();
  const dataMountPath = path.join(hostRoot, "var/lib/easysubway-data");
  const dockerDataRoot = path.join(dataMountPath, "docker");
  const dockerConfigPath = path.join(hostRoot, "etc/docker/daemon.json");
  const tlsDir = path.join(
    hostRoot,
    "etc/letsencrypt/live/easysubway-api.aquilaxk.site",
  );
  const tlsCertPath = path.join(tlsDir, "fullchain.pem");
  const tlsKeyPath = path.join(tlsDir, "privkey.pem");
  const nginxRoot = path.join(hostRoot, "etc/nginx");
  const deployRoot = path.join(hostRoot, "opt/easysubway");
  const backupDir = path.join(deployRoot, "backups");

  mkdirSync(dockerDataRoot, { recursive: true });
  mkdirSync(path.dirname(dockerConfigPath), { recursive: true });
  writeFileSync(
    dockerConfigPath,
    `${JSON.stringify({ "data-root": dockerDataRoot }, null, 2)}\n`,
  );

  mkdirSync(tlsDir, { recursive: true });
  writeFileSync(tlsCertPath, TEST_X509_PEM);
  writeFileSync(
    tlsKeyPath,
    `-----BEGIN PRIVATE KEY-----\n${SECRET_SENTINEL}\n-----END PRIVATE KEY-----\n`,
  );

  mkdirSync(path.join(nginxRoot, "conf.d"), { recursive: true });
  writeFileSync(path.join(nginxRoot, "nginx.conf"), "worker_processes auto;\n");
  writeFileSync(
    path.join(nginxRoot, "conf.d/easysubway.conf"),
    "server { listen 443 ssl; }\n",
  );
  writeFileSync(
    path.join(nginxRoot, "conf.d/default-proxy.conf"),
    "proxy_http_version 1.1;\n",
  );
  writeFileSync(
    path.join(nginxRoot, "conf.d/real-ip.conf"),
    "real_ip_header CF-Connecting-IP;\n",
  );

  mkdirSync(backupDir, { recursive: true });
  writeFileSync(path.join(deployRoot, ".env"), buildValidEnvContent());

  const dumpName = "easysubway-postgres-20261109T030000Z.dump";
  const dumpBytes = Buffer.from("PGDMP-clean-room-authoritative-dump");
  const dumpPath = path.join(backupDir, dumpName);
  writeFileSync(dumpPath, dumpBytes);
  writeFileSync(`${dumpPath}.sha256`, `${sha256Hex(dumpBytes)}  ${dumpName}\n`);

  writeFileSync(path.join(dataMountPath, "PG_VERSION"), "16\n");
  mkdirSync(path.join(dataMountPath, ".minio.sys"), { recursive: true });

  const backupControlOutputs = {
    backup_policy_id: {
      value: "ocid1.volumebackuppolicy.oc1.ap-chuncheon-1.aaaaaaaabackuppolicy",
    },
    backup_policy_assignment_id: {
      value: "ocid1.volumebackuppolicyassign.oc1.ap-chuncheon-1.aaaaaaaaassignment",
    },
    event_rule_enabled: { value: true },
    event_rule_id: { value: "ocid1.eventrule.oc1.ap-chuncheon-1.aaaaaaaerule" },
    notification_topic_id: {
      value: "ocid1.onstopic.oc1.ap-chuncheon-1.aaaaaaaatopic",
    },
    subscription_id: {
      value: "ocid1.onssubscription.oc1.ap-chuncheon-1.aaaaaaaasub",
    },
    subscription_state: { value: "ACTIVE" },
    slack_webhook_endpoint: { value: WEBHOOK_SENTINEL },
  };

  const commands = [];
  const defaultCommandRunner = (command, args) => {
    commands.push([command, ...args]);
    const joined = [command, ...args].join(" ");
    if (command === "mountpoint" && args[0] === "-q" && args[1] === dataMountPath) {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (
      command === "systemctl" &&
      args[0] === "is-active" &&
      args[1] === "easysubway-data-volume-setup.service"
    ) {
      return { status: 0, stdout: "active\n", stderr: "" };
    }
    if (command === "nginx" && args[0] === "-t") {
      return {
        status: 0,
        stdout: "",
        stderr: "nginx: configuration file /etc/nginx/nginx.conf test is successful\n",
      };
    }
    if (
      command === "bash" &&
      args[0]?.endsWith("tools/platform/bootstrap-single-node-k3s.sh") &&
      args[1] === "--mode" &&
      args[2] === "VERIFY"
    ) {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (joined.includes("systemctl list-units")) {
      return {
        status: 0,
        stdout:
          "actions.runner.AquilaXk-easysubway-platform.oci-arm64.service loaded active running GitHub Actions Runner\n",
        stderr: "",
      };
    }
    return { status: 1, stdout: "", stderr: `unexpected command: ${joined}` };
  };

  return {
    hostRoot,
    dataMountPath,
    dockerDataRoot,
    dockerConfigPath,
    tlsCertPath,
    tlsKeyPath,
    nginxRoot,
    deployRoot,
    backupDir,
    dumpPath,
    backupControlOutputs,
    commands,
    options: {
      repoRoot: REPO_ROOT,
      dataVolumeMountPath: dataMountPath,
      dockerDataRoot,
      dockerDaemonConfigPath: dockerConfigPath,
      tlsCertPath,
      tlsKeyPath,
      nginxConfigRoot: nginxRoot,
      deployRoot,
      backupDir,
      backupControlOutputs,
      ...overrides.options,
    },
    effects: {
      commandRunner: overrides.commandRunner ?? defaultCommandRunner,
      now: overrides.now ?? (() => FIXED_NOW),
      ...(overrides.readCertificateNotAfter
        ? { readCertificateNotAfter: overrides.readCertificateNotAfter }
        : {}),
    },
  };
}

test("clean-room host bootstrap verifier succeeds across all 6 stages in order and emits a sanitized receipt", () => {
  const fixture = createCleanRoomFixture();
  const receipt = verifyCleanRoomHostBootstrap(fixture.options, fixture.effects);

  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.artifactKind, "platform-clean-room-host-bootstrap-receipt-v1");
  assert.equal(receipt.status, "READY");
  assert.equal(receipt.verifiedAt, FIXED_NOW.toISOString());
  assert.deepEqual(
    receipt.stages.map((stage) => stage.id),
    EXPECTED_STAGE_ORDER,
  );
  assert.equal(receipt.stages.every((stage) => stage.status === "VERIFIED"), true);

  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes(SECRET_SENTINEL), false);
  assert.equal(serialized.includes(WEBHOOK_SENTINEL), false);
});

test("Stage 1 fails closed when data volume is not mounted, setup service is inactive, or docker data-root mismatches", () => {
  const unmounted = createCleanRoomFixture({
    commandRunner: (command, args) => {
      if (command === "mountpoint") {
        return { status: 1, stdout: "", stderr: "not a mountpoint" };
      }
      return { status: 0, stdout: "active\n", stderr: "" };
    },
  });
  assert.throws(
    () => verifyCleanRoomHostBootstrap(unmounted.options, unmounted.effects),
    (err) =>
      err instanceof CleanRoomBootstrapError &&
      err.stage === "DATA_VOLUME_AND_DOCKER" &&
      err.code === "E_CLEAN_ROOM_DATA_VOLUME_UNMOUNTED",
  );

  const inactiveService = createCleanRoomFixture({
    commandRunner: (command, args) => {
      if (command === "mountpoint") return { status: 0, stdout: "", stderr: "" };
      if (command === "systemctl" && args[1] === "easysubway-data-volume-setup.service") {
        return { status: 3, stdout: "inactive\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.throws(
    () => verifyCleanRoomHostBootstrap(inactiveService.options, inactiveService.effects),
    (err) =>
      err instanceof CleanRoomBootstrapError &&
      err.stage === "DATA_VOLUME_AND_DOCKER" &&
      err.code === "E_CLEAN_ROOM_DATA_VOLUME_SERVICE_INACTIVE",
  );

  const wrongDockerRoot = createCleanRoomFixture();
  writeFileSync(
    wrongDockerRoot.dockerConfigPath,
    JSON.stringify({ "data-root": "/var/lib/docker" }),
  );
  assert.throws(
    () => verifyCleanRoomHostBootstrap(wrongDockerRoot.options, wrongDockerRoot.effects),
    (err) =>
      err instanceof CleanRoomBootstrapError &&
      err.stage === "DATA_VOLUME_AND_DOCKER" &&
      err.code === "E_CLEAN_ROOM_DOCKER_DATA_ROOT_MISMATCH",
  );
});

test("Stage 2 fails closed when origin TLS cert/key is symlinked, expires within 7 days, or nginx -t fails", () => {
  const symlinkCert = createCleanRoomFixture();
  const outsideCert = path.join(symlinkCert.hostRoot, "outside-cert.pem");
  writeFileSync(outsideCert, TEST_X509_PEM);
  rmSync(symlinkCert.tlsCertPath);
  symlinkSync(outsideCert, symlinkCert.tlsCertPath);

  assert.throws(
    () => verifyCleanRoomHostBootstrap(symlinkCert.options, symlinkCert.effects),
    (err) =>
      err instanceof CleanRoomBootstrapError &&
      err.stage === "ORIGIN_TLS_AND_HOST_NGINX" &&
      err.code === "E_CLEAN_ROOM_TLS_FILE_INVALID",
  );

  // Real X.509 certificate expires on 2036-11-06T11:53:24Z; 4 days remaining (< 7 days threshold) must fail
  const expiringSoon = createCleanRoomFixture({
    now: () => new Date("2036-11-02T12:00:00.000Z"),
  });
  assert.throws(
    () => verifyCleanRoomHostBootstrap(expiringSoon.options, expiringSoon.effects),
    (err) =>
      err instanceof CleanRoomBootstrapError &&
      err.stage === "ORIGIN_TLS_AND_HOST_NGINX" &&
      err.code === "E_CLEAN_ROOM_TLS_CERT_EXPIRING",
  );

  const missingNginxConf = createCleanRoomFixture();
  rmSync(path.join(missingNginxConf.nginxRoot, "conf.d/real-ip.conf"));
  assert.throws(
    () => verifyCleanRoomHostBootstrap(missingNginxConf.options, missingNginxConf.effects),
    (err) =>
      err instanceof CleanRoomBootstrapError &&
      err.stage === "ORIGIN_TLS_AND_HOST_NGINX" &&
      err.code === "E_CLEAN_ROOM_NGINX_CONFIG_INVALID",
  );

  const failingNginxTest = createCleanRoomFixture({
    commandRunner: (command, args) => {
      if (command === "nginx" && args[0] === "-t") {
        return { status: 1, stdout: "", stderr: "nginx: [emerg] invalid parameter" };
      }
      return { status: 0, stdout: "active\n", stderr: "" };
    },
  });
  assert.throws(
    () => verifyCleanRoomHostBootstrap(failingNginxTest.options, failingNginxTest.effects),
    (err) =>
      err instanceof CleanRoomBootstrapError &&
      err.stage === "ORIGIN_TLS_AND_HOST_NGINX" &&
      err.code === "E_CLEAN_ROOM_NGINX_TEST_FAILED",
  );
});

test("Stage 3 fails closed on missing .env keys, cross-key interpolation, backup sha256 mismatch, symlinked dump, or missing restore markers", () => {
  const emptyKeyEnv = createCleanRoomFixture();
  writeFileSync(
    path.join(emptyKeyEnv.deployRoot, ".env"),
    `${buildValidEnvContent().replace(/EASYSUBWAY_POSTGRES_PASSWORD=.*/, "EASYSUBWAY_POSTGRES_PASSWORD=")}`,
  );
  assert.throws(
    () => verifyCleanRoomHostBootstrap(emptyKeyEnv.options, emptyKeyEnv.effects),
    (err) =>
      err instanceof CleanRoomBootstrapError &&
      err.stage === "ENV_AND_BACKUP_RESTORE_INPUTS" &&
      err.code === "E_CLEAN_ROOM_ENV_INVALID",
  );

  const interpolatedEnv = createCleanRoomFixture();
  writeFileSync(
    path.join(interpolatedEnv.deployRoot, ".env"),
    `${buildValidEnvContent()}EXTRA_KEY=\${EASYSUBWAY_POSTGRES_PASSWORD}\n`,
  );
  assert.throws(
    () => verifyCleanRoomHostBootstrap(interpolatedEnv.options, interpolatedEnv.effects),
    (err) =>
      err instanceof CleanRoomBootstrapError &&
      err.stage === "ENV_AND_BACKUP_RESTORE_INPUTS" &&
      err.code === "E_CLEAN_ROOM_ENV_INVALID",
  );

  const badChecksum = createCleanRoomFixture();
  writeFileSync(`${badChecksum.dumpPath}.sha256`, `${"0".repeat(64)}  dump\n`);
  assert.throws(
    () => verifyCleanRoomHostBootstrap(badChecksum.options, badChecksum.effects),
    (err) =>
      err instanceof CleanRoomBootstrapError &&
      err.stage === "ENV_AND_BACKUP_RESTORE_INPUTS" &&
      err.code === "E_CLEAN_ROOM_BACKUP_CHECKSUM_MISMATCH",
  );

  const symlinkDump = createCleanRoomFixture();
  const outsideDump = path.join(symlinkDump.hostRoot, "outside.dump");
  writeFileSync(outsideDump, "outside");
  rmSync(symlinkDump.dumpPath);
  symlinkSync(outsideDump, symlinkDump.dumpPath);
  assert.throws(
    () => verifyCleanRoomHostBootstrap(symlinkDump.options, symlinkDump.effects),
    (err) =>
      err instanceof CleanRoomBootstrapError &&
      err.stage === "ENV_AND_BACKUP_RESTORE_INPUTS" &&
      err.code === "E_CLEAN_ROOM_BACKUP_FILE_INVALID",
  );

  const missingMarker = createCleanRoomFixture();
  rmSync(path.join(missingMarker.dataMountPath, ".minio.sys"), {
    recursive: true,
    force: true,
  });
  assert.throws(
    () => verifyCleanRoomHostBootstrap(missingMarker.options, missingMarker.effects),
    (err) =>
      err instanceof CleanRoomBootstrapError &&
      err.stage === "ENV_AND_BACKUP_RESTORE_INPUTS" &&
      err.code === "E_CLEAN_ROOM_RESTORE_MARKER_MISSING",
  );
});

test("Stage 4 fails closed when RBAC manifest is missing or bootstrap-single-node-k3s.sh --mode VERIFY fails", () => {
  const missingRbacRepo = createCleanRoomFixture();
  const fakeRepoRoot = createSandbox();
  mkdirSync(path.join(fakeRepoRoot, "infra/k3s"), { recursive: true });
  mkdirSync(path.join(fakeRepoRoot, "contracts/release"), { recursive: true });
  writeFileSync(
    path.join(fakeRepoRoot, "contracts/release/platform-data-volume-backup-contract.json"),
    readFileSync(
      path.join(REPO_ROOT, "contracts/release/platform-data-volume-backup-contract.json"),
    ),
  );
  writeFileSync(path.join(fakeRepoRoot, "infra/k3s/deployer-rbac.json"), "{}");
  writeFileSync(
    path.join(fakeRepoRoot, "infra/k3s/data-workflow-scheduler-rbac.json"),
    "{}",
  );

  assert.throws(
    () =>
      verifyCleanRoomHostBootstrap(
        { ...missingRbacRepo.options, repoRoot: fakeRepoRoot },
        missingRbacRepo.effects,
      ),
    (err) =>
      err instanceof CleanRoomBootstrapError &&
      err.stage === "SINGLE_NODE_K3S_BOOTSTRAP" &&
      err.code === "E_CLEAN_ROOM_K3S_RBAC_MISSING",
  );

  const k3sVerifyFailed = createCleanRoomFixture({
    commandRunner: (command, args) => {
      if (
        command === "bash" &&
        args[0]?.endsWith("tools/platform/bootstrap-single-node-k3s.sh")
      ) {
        return { status: 1, stdout: "", stderr: "E_K3S_SERVICE_INACTIVE\n" };
      }
      return { status: 0, stdout: "active\n", stderr: "" };
    },
  });
  assert.throws(
    () => verifyCleanRoomHostBootstrap(k3sVerifyFailed.options, k3sVerifyFailed.effects),
    (err) =>
      err instanceof CleanRoomBootstrapError &&
      err.stage === "SINGLE_NODE_K3S_BOOTSTRAP" &&
      err.code === "E_CLEAN_ROOM_K3S_VERIFY_FAILED",
  );
});

test("Stage 5 fails with E_CLEAN_ROOM_BACKUP_ALERT_INACTIVE when subscription_state is PENDING, event_rule_enabled is false, or assignment id is empty", () => {
  const pendingSub = createCleanRoomFixture();
  pendingSub.options.backupControlOutputs = {
    ...pendingSub.backupControlOutputs,
    subscription_state: { value: "PENDING" },
  };
  assert.throws(
    () => verifyCleanRoomHostBootstrap(pendingSub.options, pendingSub.effects),
    (err) =>
      err instanceof CleanRoomBootstrapError &&
      err.stage === "BACKUP_ALERT_SUBSCRIPTION_AND_OBSERVABILITY" &&
      err.code === "E_CLEAN_ROOM_BACKUP_ALERT_INACTIVE",
  );

  const disabledRule = createCleanRoomFixture();
  disabledRule.options.backupControlOutputs = {
    ...disabledRule.backupControlOutputs,
    event_rule_enabled: { value: false },
  };
  assert.throws(
    () => verifyCleanRoomHostBootstrap(disabledRule.options, disabledRule.effects),
    (err) =>
      err instanceof CleanRoomBootstrapError &&
      err.stage === "BACKUP_ALERT_SUBSCRIPTION_AND_OBSERVABILITY" &&
      err.code === "E_CLEAN_ROOM_BACKUP_ALERT_INACTIVE",
  );

  const emptyAssignment = createCleanRoomFixture();
  emptyAssignment.options.backupControlOutputs = {
    ...emptyAssignment.backupControlOutputs,
    backup_policy_assignment_id: { value: "   " },
  };
  assert.throws(
    () => verifyCleanRoomHostBootstrap(emptyAssignment.options, emptyAssignment.effects),
    (err) =>
      err instanceof CleanRoomBootstrapError &&
      err.stage === "BACKUP_ALERT_SUBSCRIPTION_AND_OBSERVABILITY" &&
      err.code === "E_CLEAN_ROOM_BACKUP_ALERT_INACTIVE",
  );
});

test("Stage 6 fails closed when GitHub Actions self-hosted runner service is not active", () => {
  const inactiveRunner = createCleanRoomFixture({
    commandRunner: (command, args) => {
      const joined = [command, ...args].join(" ");
      if (joined.includes("systemctl list-units")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "active\n", stderr: "" };
    },
  });

  assert.throws(
    () => verifyCleanRoomHostBootstrap(inactiveRunner.options, inactiveRunner.effects),
    (err) =>
      err instanceof CleanRoomBootstrapError &&
      err.stage === "SELF_HOSTED_RUNNER_SERVICE" &&
      err.code === "E_CLEAN_ROOM_RUNNER_INACTIVE",
  );
});

test("malicious path traversal and oversized config files are rejected fail-closed", () => {
  const traversal = createCleanRoomFixture({
    options: {
      tlsCertPath: "/etc/letsencrypt/live/../../etc/shadow",
    },
  });
  assert.throws(
    () => verifyCleanRoomHostBootstrap(traversal.options, traversal.effects),
    (err) =>
      err instanceof CleanRoomBootstrapError &&
      err.stage === "ORIGIN_TLS_AND_HOST_NGINX" &&
      err.code === "E_CLEAN_ROOM_TLS_FILE_INVALID",
  );

  const oversized = createCleanRoomFixture();
  writeFileSync(
    oversized.dockerConfigPath,
    Buffer.alloc(MAX_CONFIG_FILE_BYTES + 1, 0x20),
  );
  assert.throws(
    () => verifyCleanRoomHostBootstrap(oversized.options, oversized.effects),
    (err) =>
      err instanceof CleanRoomBootstrapError &&
      err.stage === "DATA_VOLUME_AND_DOCKER" &&
      err.code === "E_CLEAN_ROOM_DOCKER_CONFIG_INVALID",
  );

  assert.throws(
    () => parseCliArgs(["--unknown-flag"]),
    (err) => err instanceof CleanRoomBootstrapError && err.code === "E_CLEAN_ROOM_USAGE",
  );
});

test("CLI entry point and Platform CI workflow contract", () => {
  const cliResult = spawnSync(process.execPath, [VERIFIER_SCRIPT, "--help"], {
    encoding: "utf8",
  });
  assert.equal(cliResult.status, 0, cliResult.stderr);
  assert.match(cliResult.stdout, /verify-clean-room-host-bootstrap\.mjs/);

  const ciWorkflow = readFileSync(
    path.join(REPO_ROOT, ".github/workflows/ci.yml"),
    "utf8",
  );
  assert.match(
    ciWorkflow,
    /^\s*node --test tools\/platform\/verify-clean-room-host-bootstrap\.test\.mjs$/m,
  );
});
