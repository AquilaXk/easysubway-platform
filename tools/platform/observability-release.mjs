// platform#227·#273: 관측 설정 release 트리. 어떤 설정 디렉터리와 unit을 담는지(MANAGED_UNITS), release 스테이징·digest·symlink 전환과
// 강제 종료가 남긴 임시 항목 정리를 맡는다. 호스트의 docker 상태는 다루지 않는다(deploy-observability-config.mjs).
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { fail, sha256 } from "./observability-deploy-primitives.mjs";

// release에 담기지만 이 도구가 컨테이너를 건드리지 않는 설정 디렉터리(이슈 #227 범위 밖).
export const MATERIALIZED_ONLY_DIRS = Object.freeze(["alertmanager", "alloy", "grafana", "loki"]);
// 이 도구가 compose로 맞추고 마운트 내용과 라이브 상태까지 대조하는 서비스. configDirs는 그 서비스의 설정 원천 디렉터리,
// mounts는 컨테이너 안 경로와 release 안 원천 파일의 짝이다. optional unit은 그 디렉터리가 없는 트리(그 unit 이전의 main 커밋)에서
// 빠진다. 그래서 옛 커밋으로 되돌리는 DEPLOY·PREVIEW·자동 복원이 모두 같은 규칙으로 prometheus만 맞추고 probe는 건드리지 않는다.
// job은 그 unit이 읽히는 Prometheus job으로, release의 prometheus.yml이 담아야 한다. liveSeries는 검증 때 라이브 Prometheus에서
// 컨테이너 수렴 뒤의 새 표본이 나와야 하는 시계열이다({metric, value?}, value가 있으면 그 값이어야 하고 selector는 job으로 만든다).
// scrapeProof는 호스트 상태와 무관하게 exporter가 scrape마다 내는 metric으로, 복원이 요구하는 것은 이 새 표본의 존재뿐이다.
// blackbox는 probe가 실패해도 /probe에 200으로 답해 target이 up이므로, probe가 실제로 원 서버 인증서를 읽었는지는 liveSeries로만 가린다(platform#270).
export const PROMETHEUS = Object.freeze({
  service: "prometheus",
  container: "easysubway-prometheus",
  configDirs: Object.freeze(["prometheus"]),
  optional: false,
  healthy: true,
  mounts: Object.freeze([
    ["/etc/prometheus/prometheus.yml", "prometheus/prometheus.yml"],
    ["/etc/prometheus/alerts.yml", "prometheus/alerts.yml"],
  ]),
  job: null,
  scrapeProof: null,
  liveSeries: Object.freeze([]),
});
export const MANAGED_UNITS = Object.freeze([
  PROMETHEUS,
  Object.freeze({
    service: "origin-certificate-probe",
    container: "easysubway-origin-certificate-probe",
    configDirs: Object.freeze(["blackbox"]),
    optional: true,
    healthy: false,
    mounts: Object.freeze([["/etc/blackbox_exporter/origin-certificate.yml", "blackbox/origin-certificate.yml"]]),
    job: "origin_certificate_probe",
    scrapeProof: "probe_success",
    liveSeries: Object.freeze([Object.freeze({ metric: "probe_ssl_earliest_cert_expiry" }), Object.freeze({ metric: "probe_success", value: "1" })]),
  }),
]);
const CONFIG_DIRS = Object.freeze([...MATERIALIZED_ONLY_DIRS, ...MANAGED_UNITS.flatMap((unit) => unit.configDirs)].toSorted(codepointCompare));
const OPTIONAL_DIRS = Object.freeze(MANAGED_UNITS.filter((unit) => unit.optional).flatMap((unit) => unit.configDirs));


function listFiles(root, prefix = "") {
  const found = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const stat = lstatSync(join(root, relative));
    if (stat.isSymbolicLink()) fail("E_OBS_DEPLOY_SOURCE", `symlink is not allowed: ${relative}`);
    if (stat.isDirectory()) found.push(...listFiles(root, relative));
    else if (stat.isFile()) found.push(relative);
    else fail("E_OBS_DEPLOY_SOURCE", `not a regular file: ${relative}`);
  }
  return found;
}

function digestFiles(root, files) {
  const sorted = [...files].sort(codepointCompare);
  return Object.fromEntries(sorted.map((file) => [file, sha256(readFileSync(join(root, file)))]));
}

const manifestDigest = (entries) => sha256(Object.entries(entries).map(([file, digest]) => `${digest}  ${file}\n`).join(""));

/** 트리(source의 infra 또는 release)가 담은 설정 디렉터리와 그 트리가 배포하는 unit. 빠져도 되는 것은 optional unit의 디렉터리뿐이다. */
function treeLayout(root) {
  if (!existsSync(join(root, "docker-compose.yml"))) fail("E_OBS_DEPLOY_SOURCE", "missing docker-compose.yml");
  const dirs = CONFIG_DIRS.filter((dir) => existsSync(join(root, dir)));
  const missing = CONFIG_DIRS.filter((dir) => !dirs.includes(dir) && !OPTIONAL_DIRS.includes(dir));
  if (missing.length > 0) fail("E_OBS_DEPLOY_SOURCE", `missing ${missing.join(",")}`);
  return { dirs, units: MANAGED_UNITS.filter((unit) => unit.configDirs.every((dir) => dirs.includes(dir))) };
}

/** 트리의 파일 digest(경로 순서)와 디렉터리별·전체 digest, 그리고 그 트리가 배포하는 unit. */
export function describeTree(root) {
  const { dirs, units } = treeLayout(root);
  const fileDigests = digestFiles(root, ["docker-compose.yml", ...dirs.flatMap((dir) => listFiles(root, dir))]);
  const directoryDigests = Object.fromEntries(dirs.map((dir) => [
    dir,
    manifestDigest(Object.fromEntries(Object.entries(fileDigests).filter(([file]) => file.startsWith(`${dir}/`)).map(([file, digest]) => [file.slice(dir.length + 1), digest]))),
  ]));
  return { files: fileDigests, directoryDigests, configDigest: manifestDigest(fileDigests), units };
}

export function stageRelease(sourceRoot, stagingDir) {
  const infra = join(sourceRoot, "infra");
  const { dirs } = treeLayout(infra);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true, mode: 0o755 });
  const sources = [["docker-compose.yml", join(infra, "docker-compose.yml")]];
  for (const dir of dirs) for (const file of listFiles(infra, dir)) sources.push([file, join(infra, file)]);
  for (const [relative, source] of sources) {
    const target = join(stagingDir, relative);
    mkdirSync(join(target, ".."), { recursive: true, mode: 0o755 });
    writeFileSync(target, readFileSync(source));
    chmodSync(target, 0o444);
  }
  for (const dir of listDirectories(stagingDir)) chmodSync(join(stagingDir, dir), 0o755);
  chmodSync(stagingDir, 0o755);
  return describeTree(stagingDir);
}

function listDirectories(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    return [relative, ...listDirectories(root, relative)];
  });
}

export function atomicSymlink(root, name, target) {
  const temporary = join(root, `.${name}.tmp-${process.pid}`);
  rmSync(temporary, { force: true });
  symlinkSync(target, temporary);
  renameSync(temporary, join(root, name));
}

export function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * 강제 종료된 이전 실행이 남긴 `.staging-<sha12>-<pid>` 디렉터리와 `.current|previous.tmp-<pid>` symlink를 지운다.
 * pid가 살아 있으면 다른 실행이 쓰는 중으로 보고 건드리지 않는다. 호출 시점에 이 실행이 deploy.lock을 쥐고 있어 다른 DEPLOY는 돌지 않으며,
 * pid 재사용으로 못 지우는 경우는 남겨 두는 쪽(무해)으로 실패한다.
 */
export function reapStaleArtifacts(root, isProcessAlive) {
  const candidates = [
    [join(root, "releases"), /^\.staging-[0-9a-f]{12}-(\d+)$/u],
    [root, /^\.(?:current|previous)\.tmp-(\d+)$/u],
  ];
  const reaped = [];
  for (const [directory, pattern] of candidates) {
    for (const entry of readdirSync(directory)) {
      const match = pattern.exec(entry);
      if (!match || isProcessAlive(Number(match[1]))) continue;
      rmSync(join(directory, entry), { recursive: true, force: true });
      reaped.push(entry);
    }
  }
  return reaped;
}

export function readManagedLink(root, name) {
  const path = join(root, name);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isSymbolicLink()) fail("E_OBS_DEPLOY_STATE", `${name} is not a symlink`);
  const match = /^releases\/([0-9a-f]{40})$/u.exec(readlinkSync(path));
  if (!match || !existsSync(join(root, "releases", match[1]))) fail("E_OBS_DEPLOY_STATE", `${name} does not point at a managed release`);
  return match[1];
}
