import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  assertSafeImagePruneTargets,
  HostBackendImagePruneError,
  pruneHostBackendImages,
} from "./prune-host-backend-images.mjs";

const repoRoot = new URL("../..", import.meta.url).pathname;
const cliPath = join(repoRoot, "tools", "platform", "prune-host-backend-images.mjs");

const digest = (char) => `sha256:${char.repeat(64)}`;
const imageId = (char) => `sha256:${char.repeat(64)}`;

const DIGEST_ACTIVE = digest("a");
const DIGEST_PREVIOUS = digest("b");
const DIGEST_THIRD = digest("c");
const DIGEST_STALE_1 = digest("d");
const DIGEST_STALE_2 = digest("e");
const DIGEST_POD_EXTRA = digest("f");

const ID_ACTIVE = imageId("1");
const ID_PREVIOUS = imageId("2");
const ID_THIRD = imageId("3");
const ID_STALE_1 = imageId("4");
const ID_STALE_2 = imageId("5");
const ID_POD_EXTRA = imageId("6");
const ID_POSTGRES = imageId("9");

function buildDefaultHostState({
  activeDigest = DIGEST_ACTIVE,
  previousDigest = DIGEST_PREVIOUS,
  podExtraDigest = undefined,
  k3sImages = [
    {
      id: ID_ACTIVE,
      repoTags: ["ghcr.io/aquilaxk/easysubway-backend:active"],
      repoDigests: [`ghcr.io/aquilaxk/easysubway-backend@${DIGEST_ACTIVE}`],
    },
    {
      id: ID_PREVIOUS,
      repoTags: ["ghcr.io/aquilaxk/easysubway-backend:previous"],
      repoDigests: [`ghcr.io/aquilaxk/easysubway-backend@${DIGEST_PREVIOUS}`],
    },
    {
      id: ID_THIRD,
      repoTags: ["ghcr.io/aquilaxk/easysubway-backend:third"],
      repoDigests: [`ghcr.io/aquilaxk/easysubway-backend@${DIGEST_THIRD}`],
    },
    {
      id: ID_STALE_1,
      repoTags: ["ghcr.io/aquilaxk/easysubway-backend:stale-1"],
      repoDigests: [`ghcr.io/aquilaxk/easysubway-backend@${DIGEST_STALE_1}`],
    },
    {
      id: ID_STALE_2,
      repoTags: ["easysubway-backend:stale-2"],
      repoDigests: [`ghcr.io/aquilaxk/easysubway-backend@${DIGEST_STALE_2}`],
    },
    {
      id: imageId("8"),
      repoTags: ["rancher/mirrored-pause:3.6"],
      repoDigests: [`rancher/mirrored-pause@${digest("8")}`],
    },
  ],
  dockerRunningContainerImages = [ID_POSTGRES],
  dockerImagesLines = [
    `ghcr.io/aquilaxk/easysubway-backend\t${ID_ACTIVE}\t${DIGEST_ACTIVE}`,
    `ghcr.io/aquilaxk/easysubway-backend\t${ID_PREVIOUS}\t${DIGEST_PREVIOUS}`,
    `easysubway-backend\t${ID_THIRD}\t${DIGEST_THIRD}`,
    `ghcr.io/aquilaxk/easysubway-backend\t${ID_STALE_1}\t${DIGEST_STALE_1}`,
    `easysubway-backend\t${ID_STALE_2}\t<none>`,
    `imresamu/postgis\t${ID_POSTGRES}\t${digest("9")}`,
  ],
} = {}) {
  const pods = [
    {
      metadata: { name: "journey-candidate-active-pod", namespace: "easysubway-journey" },
      status: {
        phase: "Running",
        containerStatuses: [
          {
            image: `ghcr.io/aquilaxk/easysubway-backend@${activeDigest}`,
            imageID: `ghcr.io/aquilaxk/easysubway-backend@${activeDigest}`,
          },
        ],
      },
      spec: {
        containers: [{ image: `ghcr.io/aquilaxk/easysubway-backend@${activeDigest}` }],
      },
    },
  ];
  if (podExtraDigest) {
    pods.push({
      metadata: { name: "journey-candidate-preparing-pod", namespace: "easysubway-journey" },
      status: {
        phase: "Pending",
        containerStatuses: [
          {
            image: `ghcr.io/aquilaxk/easysubway-backend@${podExtraDigest}`,
            imageID: ID_POD_EXTRA,
          },
        ],
      },
      spec: {
        containers: [{ image: `ghcr.io/aquilaxk/easysubway-backend@${podExtraDigest}` }],
      },
    });
  }

  const journeyItems = [
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name: "journey-active",
        namespace: "easysubway-journey",
        annotations: {
          "easysubway.io/backend-image-digest": activeDigest,
        },
      },
      spec: {
        selector: {
          "easysubway.io/candidate-token": "c-active",
        },
      },
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: "journey-candidate-c-active",
        namespace: "easysubway-journey",
        annotations: {
          "easysubway.io/backend-image-digest": activeDigest,
        },
      },
      spec: {
        template: {
          spec: {
            containers: [{ image: `ghcr.io/aquilaxk/easysubway-backend@${activeDigest}` }],
          },
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: "journey-config-c-active",
        namespace: "easysubway-journey",
        creationTimestamp: "2026-10-30T12:00:00Z",
      },
      data: {
        EASYSUBWAY_JOURNEY_V3_READINESS_BACKEND_IMAGE_DIGEST: activeDigest,
      },
    },
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: "journey-config-b-previous",
        namespace: "easysubway-journey",
        creationTimestamp: "2026-10-29T12:00:00Z",
      },
      data: {
        EASYSUBWAY_JOURNEY_V3_READINESS_BACKEND_IMAGE_DIGEST: previousDigest,
      },
    },
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: "journey-config-a-older",
        namespace: "easysubway-journey",
        creationTimestamp: "2026-10-20T12:00:00Z",
      },
      data: {
        EASYSUBWAY_JOURNEY_V3_READINESS_BACKEND_IMAGE_DIGEST: DIGEST_STALE_2,
      },
    },
  ];

  return {
    pods,
    journeyItems,
    k3sImages,
    dockerRunningContainerImages,
    dockerImagesLines,
  };
}

function createFakeRunner(state = buildDefaultHostState(), {
  failKubectl = false,
  failCrictlRmiIds = new Set(),
  failDockerRmiIds = new Set(),
  failDockerPs = false,
} = {}) {
  const calls = [];
  const k3sRemoved = [];
  const dockerRemoved = [];
  let dockerImagePruneCount = 0;

  const runner = async (command, args) => {
    calls.push({ command, args });
    const joined = [command, ...args].join(" ");

    if (joined.includes("kubectl get pods -A -o json")) {
      if (failKubectl) throw new Error("kubectl pods query failed");
      return { stdout: JSON.stringify({ items: state.pods }), stderr: "" };
    }
    if (joined.includes("kubectl -n easysubway-journey get deployment,service,configmap -o json")) {
      if (failKubectl) throw new Error("kubectl journey resources query failed");
      return { stdout: JSON.stringify({ items: state.journeyItems }), stderr: "" };
    }
    if (joined.includes("crictl images -o json")) {
      return { stdout: JSON.stringify({ images: state.k3sImages }), stderr: "" };
    }
    if (joined.includes("crictl rmi ")) {
      const targetId = args.at(-1);
      if (failCrictlRmiIds.has(targetId)) {
        throw new Error(`crictl rmi failed for ${targetId}`);
      }
      k3sRemoved.push(targetId);
      return { stdout: `Deleted: ${targetId}\n`, stderr: "" };
    }
    if (command === "docker" && args[0] === "ps" && args[1] === "-q") {
      if (failDockerPs) throw new Error("docker ps failed");
      const containerIds = state.dockerRunningContainerImages.map((_, idx) => `container-${idx + 1}`);
      return { stdout: containerIds.length > 0 ? `${containerIds.join("\n")}\n` : "", stderr: "" };
    }
    if (command === "docker" && args[0] === "inspect") {
      return {
        stdout: `${state.dockerRunningContainerImages.join("\n")}\n`,
        stderr: "",
      };
    }
    if (command === "docker" && args[0] === "images") {
      return {
        stdout: `${state.dockerImagesLines.join("\n")}\n`,
        stderr: "",
      };
    }
    if (command === "docker" && args[0] === "rmi" && args[1] === "-f") {
      const targetId = args[2];
      if (failDockerRmiIds.has(targetId)) {
        throw new Error(`docker rmi failed for ${targetId}`);
      }
      dockerRemoved.push(targetId);
      return { stdout: `Deleted: ${targetId}\n`, stderr: "" };
    }
    if (command === "docker" && args[0] === "image" && args[1] === "prune" && args[2] === "-f") {
      dockerImagePruneCount += 1;
      return { stdout: "Total reclaimed space: 1.2GB\n", stderr: "" };
    }
    throw new Error(`unexpected command: ${joined}`);
  };

  return { calls, k3sRemoved, dockerRemoved, getDockerImagePruneCount: () => dockerImagePruneCount, runner };
}

test("DRY_RUN collects K3s and Docker protected sets, keeps newest 3 + protected images, and performs 0 deletions", async () => {
  const host = createFakeRunner();
  const result = await pruneHostBackendImages({
    mode: "DRY_RUN",
    keepCount: 3,
    commandRunner: host.runner,
  });

  assert.equal(result.status, "OK");
  assert.equal(result.mode, "DRY_RUN");
  assert.equal(result.keepCount, 3);
  assert.ok(result.protectedDigests.includes(DIGEST_ACTIVE));
  assert.ok(result.protectedDigests.includes(DIGEST_PREVIOUS));
  assert.equal(result.k3sRemovedCount, 0);
  assert.equal(result.dockerRemovedCount, 0);
  assert.deepEqual(result.k3s.pruneTargetIds, [ID_STALE_1, ID_STALE_2]);
  assert.deepEqual(result.docker.pruneTargetIds, [ID_STALE_1, ID_STALE_2]);
  assert.deepEqual(host.k3sRemoved, []);
  assert.deepEqual(host.dockerRemoved, []);
  assert.equal(host.getDockerImagePruneCount(), 0);
});

test("EXECUTE removes only stale backend images outside protected set and keepCount=3 across K3s and Docker", async () => {
  const host = createFakeRunner();
  const result = await pruneHostBackendImages({
    mode: "EXECUTE",
    keepCount: 3,
    commandRunner: host.runner,
  });

  assert.equal(result.status, "OK");
  assert.equal(result.mode, "EXECUTE");
  assert.equal(result.k3sRemovedCount, 2);
  assert.equal(result.dockerRemovedCount, 2);
  assert.deepEqual(host.k3sRemoved, [ID_STALE_1, ID_STALE_2]);
  assert.deepEqual(host.dockerRemoved, [ID_STALE_1, ID_STALE_2]);
  assert.equal(host.getDockerImagePruneCount(), 1);
  assert.deepEqual(result.warnings, []);
});

test("protects running Pod image/imageID, running Docker container image ID, and explicit active/previous digests even beyond keepCount", async () => {
  const state = buildDefaultHostState({
    podExtraDigest: DIGEST_STALE_1,
    dockerRunningContainerImages: [ID_POSTGRES, ID_STALE_2],
    dockerImagesLines: [
      `ghcr.io/aquilaxk/easysubway-backend\t${ID_ACTIVE}\t${DIGEST_ACTIVE}`,
      `ghcr.io/aquilaxk/easysubway-backend\t${ID_PREVIOUS}\t${DIGEST_PREVIOUS}`,
      `easysubway-backend\t${ID_THIRD}\t${DIGEST_THIRD}`,
      `ghcr.io/aquilaxk/easysubway-backend\t${ID_STALE_1}\t<none>`,
      `easysubway-backend\t${ID_STALE_2}\t<none>`,
      `imresamu/postgis\t${ID_POSTGRES}\t${digest("9")}`,
    ],
  });
  const host = createFakeRunner(state);
  const result = await pruneHostBackendImages({
    mode: "EXECUTE",
    keepCount: 3,
    activeDigest: DIGEST_ACTIVE,
    previousDigest: DIGEST_PREVIOUS,
    commandRunner: host.runner,
  });

  assert.equal(result.status, "OK");
  assert.ok(result.protectedDigests.includes(DIGEST_STALE_1));
  assert.ok(result.protectedImageIds.includes(ID_STALE_2));
  assert.deepEqual(host.k3sRemoved, [ID_STALE_2]);
  assert.deepEqual(host.dockerRemoved, [ID_STALE_1]);
});

test("assertSafeImagePruneTargets throws HostBackendImagePruneError when a protected digest or imageId enters prune targets", () => {
  assert.throws(
    () =>
      assertSafeImagePruneTargets(
        [{ id: ID_ACTIVE, digests: [DIGEST_ACTIVE] }],
        {
          protectedDigests: new Set([DIGEST_ACTIVE]),
          protectedImageIds: new Set([ID_PREVIOUS]),
        },
      ),
    (error) =>
      error instanceof HostBackendImagePruneError &&
      error.code === "E_IMAGE_PRUNE_PROTECTED_TARGET",
  );

  assert.throws(
    () =>
      assertSafeImagePruneTargets(
        [{ id: ID_PREVIOUS, digests: [] }],
        {
          protectedDigests: new Set([DIGEST_ACTIVE]),
          protectedImageIds: new Set([ID_PREVIOUS]),
        },
      ),
    (error) =>
      error instanceof HostBackendImagePruneError &&
      error.code === "E_IMAGE_PRUNE_PROTECTED_TARGET",
  );
});

test("bestEffort mode returns DEGRADED with warnings and never flips a committed deploy on runtime or rmi failure", async () => {
  const host = createFakeRunner(buildDefaultHostState(), {
    failCrictlRmiIds: new Set([ID_STALE_1]),
    failDockerRmiIds: new Set([ID_STALE_2]),
  });

  const result = await pruneHostBackendImages({
    mode: "EXECUTE",
    keepCount: 3,
    bestEffort: true,
    commandRunner: host.runner,
  });

  assert.equal(result.status, "DEGRADED");
  assert.equal(result.k3sRemovedCount, 1);
  assert.equal(result.dockerRemovedCount, 1);
  assert.deepEqual(host.k3sRemoved, [ID_STALE_2]);
  assert.deepEqual(host.dockerRemoved, [ID_STALE_1]);
  assert.equal(result.warnings.length, 2);

  // If kubectl fails in bestEffort mode, K3s image deletion is skipped safely without throwing
  const brokenK3sHost = createFakeRunner(buildDefaultHostState(), {
    failKubectl: true,
  });
  const degradedK3s = await pruneHostBackendImages({
    mode: "EXECUTE",
    keepCount: 3,
    bestEffort: true,
    commandRunner: brokenK3sHost.runner,
  });
  assert.equal(degradedK3s.status, "DEGRADED");
  assert.equal(degradedK3s.k3sRemovedCount, 0);
  assert.deepEqual(brokenK3sHost.k3sRemoved, []);
  assert.equal(degradedK3s.dockerRemovedCount, 2);
  assert.ok(degradedK3s.warnings.length >= 1);
});

test("CLI --best-effort exits 0 with structured JSON summary even when host runtime commands are unavailable", () => {
  const result = spawnSync(
    process.execPath,
    [cliPath, "--mode", "DRY_RUN", "--keep-count", "3", "--best-effort"],
    {
      encoding: "utf8",
      env: { PATH: "/nonexistent" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "DEGRADED");
  assert.equal(parsed.k3sRemovedCount, 0);
  assert.equal(parsed.dockerRemovedCount, 0);
  assert.ok(Array.isArray(parsed.protectedDigests));
  assert.ok(Array.isArray(parsed.warnings));
  assert.ok(parsed.warnings.length > 0);
});

test("source-free-journey-k3s-deploy.yml and ci.yml wire the host backend image prune step and test", () => {
  const workflow = readFileSync(
    join(repoRoot, ".github", "workflows", "source-free-journey-k3s-deploy.yml"),
    "utf8",
  );
  const activateIdx = workflow.indexOf("- name: Activate exact Journey release on K3s");
  const pruneIdx = workflow.indexOf("- name: Reclaim stale host backend images after K3s activation");
  assert.notEqual(activateIdx, -1);
  assert.notEqual(pruneIdx, -1);
  assert.ok(activateIdx < pruneIdx, "image prune step must run after K3s activation");
  assert.match(
    workflow.slice(pruneIdx),
    /node tools\/platform\/prune-host-backend-images\.mjs --mode EXECUTE --keep-count 3 --best-effort/,
  );

  const ci = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  assert.equal(
    ci.split("node --test tools/platform/prune-host-backend-images.test.mjs").length - 1,
    1,
  );
});
