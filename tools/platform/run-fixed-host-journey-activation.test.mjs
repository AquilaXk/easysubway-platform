import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  access,
  mkdtemp,
  open as openFileSystem,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  createFixedHostJourneyActivationEffects,
  createFixedHostJourneyActivationHost,
  FixedHostJourneyActivationError,
  renderFixedHostNginxConfig,
  runFixedHostJourneyActivation,
} from "./run-fixed-host-journey-activation.mjs";
import * as fixedHostRuntime from "./run-fixed-host-journey-activation.mjs";

const digest = (value) => `sha256:${value.repeat(64)}`;

function input(root) {
  return {
    operationDirectory: path.join(root, "operation"),
    operationId: digest("7"),
    deployRoot: "/opt/easysubway",
    runUrl: "https://github.com/AquilaXk/easysubway-platform/actions/runs/31670000000",
    generatedAt: "2026-08-13T05:00:00.000Z",
    tuple: {
      schemaVersion: "JOURNEY_RELEASE_TUPLE_V1",
      artifactKind: "journey-release-tuple",
      backendImageDigest: digest("a"),
      backendConfigDigest: digest("b"),
      journeyContractDigest: digest("c"),
      serverRouteBundleDigest: digest("d"),
      deploymentRevision: "e".repeat(40),
      environmentIdentity: "production",
      tupleSha256: digest("f"),
    },
    dataDescriptorSha256: digest("1"),
    candidateBindingSha256: digest("2"),
    descriptorBindingSha256: digest("3"),
    candidateGeneration: 9,
    trafficGeneration: 17,
  };
}

function effects(events, failAt) {
  const step = (name, result) => async () => {
    events.push(name);
    if (name === failAt) throw new Error(`injected ${name}`);
    return structuredClone(result);
  };
  const lock = {
    evidenceDigest: digest("4"),
    verify: async () => {
      events.push("lock.verify");
      if (failAt === "lock.verify") throw new Error("injected lock loss");
    },
    close: async () => events.push("lock.close"),
  };
  return {
    acquireDeployLock: async () => {
      events.push("lock.acquire");
      if (failAt === "lock.acquire") throw new Error("injected lock acquisition");
      return lock;
    },
    verifyInputs: step("inputs.verify", undefined),
    startStandby: step("standby.start", {
      schemaVersion: "PLATFORM_JOURNEY_COMPOSE_CANDIDATE_RUNTIME_V1",
      artifactKind: "journey-compose-candidate-runtime",
      orchestrator: "COMPOSE",
      instances: [{
        instanceIdentity: "backend-standby",
        failureDomainIdentity: "oci-host-easysubway-a1",
        baseUrl: "http://127.0.0.1:8082",
      }],
    }),
    runCanary: step("canary.run", {
      schemaVersion: "PLATFORM_JOURNEY_CANDIDATE_CANARY_V1",
      artifactKind: "journey-candidate-canary",
      tupleSha256: digest("f"),
      passed: true,
      evidenceDigest: digest("5"),
      legacyGraphSuccessCount: 0,
      localRouteInvocationCount: 0,
      staleJourneyServedCount: 0,
      alternateEndpointSuccessCount: 0,
    }),
    observeCandidate: step("candidate.observe", {
      schemaVersion: "PLATFORM_JOURNEY_CANDIDATE_OBSERVATIONS_V1",
      artifactKind: "journey-candidate-observations",
      orchestrator: "COMPOSE",
      bindingSha256: digest("2"),
      tupleSha256: digest("f"),
      instances: [{
        instanceIdentity: "backend-standby",
        failureDomainIdentity: "oci-host-easysubway-a1",
        tupleSha256: digest("f"),
        backendImageDigest: digest("a"),
        backendConfigDigest: digest("b"),
        journeyContractDigest: digest("c"),
        serverRouteBundleDigest: digest("d"),
        deploymentRevision: "e".repeat(40),
        environmentIdentity: "production",
        candidateGeneration: 9,
        warmed: true,
        ready: true,
        readinessEvidenceDigest: digest("6"),
      }],
      canary: {
        passed: true,
        evidenceDigest: digest("5"),
        legacyGraphSuccessCount: 0,
        localRouteInvocationCount: 0,
        staleJourneyServedCount: 0,
        alternateEndpointSuccessCount: 0,
      },
    }),
    admitCandidate: step("candidate.admit", {
      schemaVersion: "PLATFORM_JOURNEY_CANDIDATE_ADMISSION_V1",
      artifactKind: "journey-candidate-admission",
      orchestrator: "COMPOSE",
      tupleSha256: digest("f"),
      backendImageDigest: digest("a"),
      backendConfigDigest: digest("b"),
      journeyContractDigest: digest("c"),
      serverRouteBundleDigest: digest("d"),
      deploymentRevision: "e".repeat(40),
      environmentIdentity: "production",
      bindingSha256: digest("2"),
      canaryEvidenceDigest: digest("5"),
      candidateGeneration: 9,
      candidateAdmissionSha256: digest("7"),
    }),
    activateStandby: step("standby.activate", {
      instanceIdentity: "backend-standby",
      candidateAdmissionSha256: digest("7"),
      candidateGeneration: 9,
      trafficGeneration: 17,
      activeReadinessEvidenceDigest: digest("8"),
    }),
    switchNginx: async ({ fromPort, toPort }) => {
      const name = `nginx.${fromPort}.${toPort}`;
      events.push(name);
      if (name === failAt) throw new Error(`injected ${name}`);
      return {
        fromPort,
        toPort,
        nginxConfigSha256: digest(toPort === 8082 ? "9" : "a"),
        nginxTestPassed: true,
        reloadCompleted: true,
        evidenceDigest: digest(toPort === 8082 ? "b" : "c"),
      };
    },
    drainAndRecreateCanonical: step("canonical.drain-recreate", {
      signal: "SIGTERM",
      stopGracePeriodSeconds: 30,
      newRequestAdmissionAfterSignal: 0,
      inFlightSnapshotPinned: true,
      inFlightCompleted: true,
      oldProcessExited: true,
      withinBudget: true,
      droppedJourneyCount: 0,
      duplicateJourneyCount: 0,
      evidenceDigest: digest("d"),
    }),
    activateCanonical: step("canonical.activate", {
      instanceIdentity: "backend",
      candidateAdmissionSha256: digest("7"),
      candidateGeneration: 9,
      trafficGeneration: 17,
      activeReadinessEvidenceDigest: digest("e"),
    }),
    removeStandby: step("standby.remove", {
      standbyRemoved: true,
      orphanedStandbyCount: 0,
      evidenceDigest: digest("0"),
    }),
    cleanupStandby: step("standby.cleanup", undefined),
  };
}

async function missing(pathname) {
  await assert.rejects(access(pathname));
}

test("success holds one lock, performs exact fixed-host order and writes V2 receipt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fixed-host-runtime-"));
  const events = [];

  const receipt = await runFixedHostJourneyActivation(input(root), effects(events));

  assert.deepEqual(events, [
    "lock.acquire",
    "lock.verify", "inputs.verify", "standby.start",
    "lock.verify", "inputs.verify", "canary.run",
    "lock.verify", "inputs.verify", "candidate.observe",
    "lock.verify", "inputs.verify", "candidate.admit",
    "lock.verify", "inputs.verify", "standby.activate",
    "lock.verify", "inputs.verify", "nginx.8080.8082",
    "lock.verify", "inputs.verify", "canonical.drain-recreate",
    "lock.verify", "inputs.verify", "canonical.activate",
    "lock.verify", "inputs.verify", "nginx.8082.8080",
    "lock.verify", "inputs.verify", "standby.remove",
    "lock.verify", "inputs.verify",
    "lock.close",
  ]);
  assert.equal(receipt.schemaVersion, "PLATFORM_ACTIVATION_RECEIPT_V2");
  assert.equal(receipt.outcome, "ACTIVE_SERVING");
  assert.equal(receipt.operation.deployLockPath, "${DEPLOY_ROOT}/deploy.lock");
  assert.equal(receipt.bindings.candidateAdmissionSha256, digest("7"));
  assert.equal(receipt.candidate.canaryEvidenceDigest, digest("5"));
  assert.equal(receipt.candidate.standbyActiveReadinessEvidenceDigest, digest("8"));
  assert.equal(receipt.activation.canonicalActiveReadinessEvidenceDigest, digest("e"));
  assert.equal(receipt.activation.standbySwitch.toPort, 8082);
  assert.equal(receipt.activation.canonicalSwitch.toPort, 8080);
  assert.deepEqual(Object.values(receipt.fallbackZero), [0, 0, 0, 0]);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, "operation", "activation-receipt.json"), "utf8")),
    receipt,
  );
  await missing(path.join(root, "operation", "failed-operation.json"));
});

test("precommit failure cleans standby and never calls Nginx or canonical effects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fixed-host-precommit-"));
  const events = [];

  await assert.rejects(
    runFixedHostJourneyActivation(
      input(root),
      effects(events, "candidate.admit"),
      { failureNow: () => "2026-08-13T05:01:23.456Z" },
    ),
    (error) => error instanceof FixedHostJourneyActivationError &&
      error.code === "FIXED_HOST_PRECOMMIT_FAILED",
  );

  assert.ok(events.includes("standby.cleanup"));
  assert.ok(events.includes("lock.close"));
  assert.ok(!events.some((event) => event.startsWith("nginx.")));
  assert.ok(!events.some((event) => event.startsWith("canonical.")));
  await missing(path.join(root, "operation", "activation-receipt.json"));
  const failure = JSON.parse(
    await readFile(path.join(root, "operation", "failed-operation.json"), "utf8"),
  );
  assert.equal(failure.phase, "FAILED_PRECOMMIT");
  assert.equal(failure.failedAt, "2026-08-13T05:01:23.456Z");
  assert.notEqual(failure.failedAt, input(root).generatedAt);
  assert.equal(failure.successReceiptCreated, false);
  assert.deepEqual(Object.values(failure.fallbackZero), [0, 0, 0, 0]);

  const clockFailureRoot = await mkdtemp(path.join(tmpdir(), "fixed-host-clock-failure-"));
  await assert.rejects(
    runFixedHostJourneyActivation(
      input(clockFailureRoot),
      effects([], "candidate.admit"),
      { failureNow: () => { throw new Error("clock failure"); } },
    ),
    (error) => error instanceof FixedHostJourneyActivationError &&
      error.code === "FIXED_HOST_PRECOMMIT_FAILED",
  );
});

test("post-switch failure leaves admitted standby serving and emits no success receipt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fixed-host-postswitch-"));
  const events = [];

  await assert.rejects(
    runFixedHostJourneyActivation(
      input(root),
      effects(events, "canonical.drain-recreate"),
    ),
    (error) => error instanceof FixedHostJourneyActivationError &&
      error.code === "FIXED_HOST_POSTSWITCH_FAILED",
  );

  assert.ok(events.includes("nginx.8080.8082"));
  assert.ok(!events.includes("standby.cleanup"));
  assert.ok(!events.includes("standby.remove"));
  await missing(path.join(root, "operation", "activation-receipt.json"));
  const failure = JSON.parse(
    await readFile(path.join(root, "operation", "failed-operation.json"), "utf8"),
  );
  assert.equal(failure.phase, "FAILED_POSTSWITCH");
  assert.equal(failure.admittedStandbyMayRemainServing, true);
  assert.equal(failure.successReceiptCreated, false);
});

test("an indeterminate first Nginx switch preserves standby and is postswitch failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fixed-host-indeterminate-"));
  const events = [];
  const injected = effects(events);
  injected.switchNginx = async () => {
    events.push("nginx.indeterminate");
    const error = new Error("reload state unknown");
    error.trafficCommitted = true;
    throw error;
  };

  await assert.rejects(
    runFixedHostJourneyActivation(input(root), injected),
    (error) => error instanceof FixedHostJourneyActivationError &&
      error.code === "FIXED_HOST_POSTSWITCH_FAILED",
  );

  assert.ok(!events.includes("standby.cleanup"));
  const failure = JSON.parse(
    await readFile(path.join(root, "operation", "failed-operation.json"), "utf8"),
  );
  assert.equal(failure.trafficCommitted, true);
  assert.equal(failure.admittedStandbyMayRemainServing, true);
});

test("typed precommit errors are remapped after the first traffic commit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fixed-host-typed-phase-"));
  const events = [];
  const injected = effects(events);
  const originalSwitch = injected.switchNginx;
  injected.switchNginx = async (request) => {
    if (request.fromPort === 8082) {
      throw new FixedHostJourneyActivationError("FIXED_HOST_PRECOMMIT_FAILED");
    }
    return originalSwitch(request);
  };

  await assert.rejects(
    runFixedHostJourneyActivation(input(root), injected),
    (error) => error instanceof FixedHostJourneyActivationError &&
      error.code === "FIXED_HOST_POSTSWITCH_FAILED",
  );
});

test("cross-stage identity drift fails before traffic commit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fixed-host-identity-drift-"));
  const events = [];
  const injected = effects(events);
  const originalCanary = injected.runCanary;
  injected.runCanary = async (request) => ({
    ...await originalCanary(request),
    tupleSha256: digest("0"),
  });

  await assert.rejects(
    runFixedHostJourneyActivation(input(root), injected),
    (error) => error instanceof FixedHostJourneyActivationError &&
      error.code === "FIXED_HOST_PRECOMMIT_FAILED",
  );

  assert.ok(events.includes("standby.cleanup"));
  assert.ok(!events.some((event) => event.startsWith("nginx.")));
});

test("operation evidence is create-only and an existing operation has host effects zero", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fixed-host-collision-"));
  const value = input(root);
  const events = [];
  await writeFile(value.operationDirectory, "owned-file", "utf8");

  await assert.rejects(
    runFixedHostJourneyActivation(value, effects(events)),
    (error) => error instanceof FixedHostJourneyActivationError &&
      error.code === "FIXED_HOST_OPERATION_EXISTS",
  );
  assert.deepEqual(events, []);
  assert.equal(await readFile(value.operationDirectory, "utf8"), "owned-file");
});

test("terminal adapters are delegated exactly once with fixed instance URLs and inherited lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fixed-host-adapters-"));
  const inputValue = input(root);
  const underlyingEvents = [];
  const base = effects(underlyingEvents);
  const calls = [];
  const adapters = {
    startJourneyComposeCandidates: async (value) => {
      calls.push(["start", value]);
      value.candidateEnvironmentConsumer({
        EASYSUBWAY_BACKEND_IMAGE: `ghcr.io/aquilaxk/easysubway-backend@${digest("a")}`,
        EASYSUBWAY_JOURNEY_V3_ROUTE_BUNDLE_STARTUP_DESCRIPTOR_BASE64: "descriptor",
        EASYSUBWAY_JOURNEY_V3_READINESS_SERVICE_TOKEN: "t".repeat(32),
      });
      return base.startStandby();
    },
    runJourneyCandidateCanary: async (value) => {
      calls.push(["canary", value]);
      return base.runCanary();
    },
    observeJourneyCandidateReadiness: async (value) => {
      calls.push(["observe", value]);
      return base.observeCandidate();
    },
    admitJourneyReleaseCandidate: async (value) => {
      calls.push(["admit", value]);
      return base.admitCandidate();
    },
    activateJourneyBackend: async (value) => {
      calls.push([`activate:${value.instanceIdentity}`, value]);
      return value.instanceIdentity === "backend-standby"
        ? base.activateStandby()
        : base.activateCanonical();
    },
  };
  const host = {
    acquireDeployLock: base.acquireDeployLock,
    verifyInputs: base.verifyInputs,
    switchNginx: base.switchNginx,
    drainAndRecreateCanonical: base.drainAndRecreateCanonical,
    removeStandby: base.removeStandby,
    cleanupStandby: base.cleanupStandby,
    setCandidateEnvironment: (environment) => {
      calls.push(["environment", environment]);
    },
  };
  const delegated = createFixedHostJourneyActivationEffects({
    config: {
      bindingPath: "/inputs/binding.json",
      descriptorBindingPath: "/inputs/descriptor-binding.json",
      tuplePath: "/inputs/tuple.json",
      descriptorPath: "/inputs/descriptor.json",
      composeEnvPath: "/inputs/compose.env",
      backendEnvPath: "/inputs/backend.env",
      projectName: "easysubway",
      serviceToken: "t".repeat(32),
      currentPublicKeyPem: "public-key-fixture",
      canary: {
        canaryRequestIdentity: "candidate-canary-1",
        requestId: "01J9VV0K000000000000000000",
        originStationId: "origin",
        destinationStationId: "destination",
        mobilityProfile: "STANDARD",
        constraintMode: "NONE",
        maxTransfers: 3,
        alternativeCount: 1,
      },
    },
    adapters,
    host,
  });

  await runFixedHostJourneyActivation(inputValue, delegated);

  assert.deepEqual(calls.map(([name]) => name), [
    "start", "environment", "canary", "observe", "admit",
    "activate:backend-standby", "activate:backend",
  ]);
  assert.equal(calls[0][1].operationId, inputValue.operationId);
  assert.equal(calls[0][1].trafficGeneration, 17);
  assert.equal(typeof calls[0][1].deployLockRunner, "function");
  assert.equal(
    calls[1][1].EASYSUBWAY_BACKEND_IMAGE,
    `ghcr.io/aquilaxk/easysubway-backend@${digest("a")}`,
  );
  assert.equal(calls[2][1].baseUrl, "http://127.0.0.1:8082");
  assert.equal(calls[2][1].candidateGeneration, 9);
  assert.equal(calls[5][1].baseUrl, "http://127.0.0.1:8082");
  assert.equal(calls[6][1].baseUrl, "http://127.0.0.1:8080");
  assert.equal(calls[5][1].trafficGeneration, 17);
  assert.equal(calls[6][1].trafficGeneration, 17);
});

test("Nginx render changes only three canonical proxy targets and rejects drift", () => {
  const source = Buffer.from([
    "location = /api/v2/routes/search {",
    "  proxy_pass http://127.0.0.1:8081;",
    "}",
    "location = /actuator/health/readiness {",
    "  proxy_pass http://127.0.0.1:8080;",
    "}",
    "location = /actuator/health/liveness {",
    "  proxy_pass http://127.0.0.1:8080;",
    "}",
    "location / {",
    "  proxy_pass http://127.0.0.1:8080;",
    "}",
    "",
  ].join("\n"));

  const standby = renderFixedHostNginxConfig(source, 8080, 8082);
  assert.equal(standby.toString("utf8").match(/127\.0\.0\.1:8082/g)?.length, 3);
  assert.match(standby.toString("utf8"), /127\.0\.0\.1:8081/);
  assert.deepEqual(renderFixedHostNginxConfig(standby, 8082, 8080), source);
  assert.throws(() => renderFixedHostNginxConfig(source, 8082, 8080));
  assert.throws(() => renderFixedHostNginxConfig(Buffer.from("proxy_pass http://127.0.0.1:8080;\n"), 8080, 8082));
});

test("concrete host holds stable inputs and runs exact Nginx, SIGTERM and Compose operations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fixed-host-concrete-"));
  const immutableInput = path.join(root, "tuple.json");
  const composeEnvPath = path.join(root, "compose.env");
  const backendEnvPath = path.join(root, "backend.env");
  const nginxConfigPath = path.join(root, "easysubway.conf");
  const baseComposePath = path.join(root, "docker-compose.yml");
  const candidateComposePath = path.join(root, "docker-compose.candidate.yml");
  await Promise.all([
    writeFile(immutableInput, "immutable\n"),
    writeFile(composeEnvPath, "COMPOSE_PROJECT_NAME=easysubway\n"),
    writeFile(backendEnvPath, "SPRING_PROFILES_ACTIVE=prod\n"),
    writeFile(baseComposePath, "services: {}\n"),
    writeFile(candidateComposePath, "services: {}\n"),
    writeFile(nginxConfigPath, Buffer.from([
      "location = /api/v2/routes/search { proxy_pass http://127.0.0.1:8081; }",
      "location = /actuator/health/readiness { proxy_pass http://127.0.0.1:8080; }",
      "location = /actuator/health/liveness { proxy_pass http://127.0.0.1:8080; }",
      "location / { proxy_pass http://127.0.0.1:8080; }",
      "",
    ].join("\n"))),
  ]);
  const commands = [];
  const dockerEnvironments = [];
  const probes = [];
  let currentNs = 0n;
  const commandRunner = async (request) => {
    commands.push([request.command, ...request.args]);
    if (request.command === "docker") dockerEnvironments.push(request.env);
    if (request.command === "docker" && request.args.includes("stop")) {
      currentNs = 29_000_000_000n;
    }
    if (request.command === "docker" && request.args[0] === "inspect") {
      currentNs = 40_000_000_000n;
      return {
        status: 0,
        signal: null,
        timedOut: false,
        stdout: `${JSON.stringify({
          Running: false,
          OOMKilled: false,
          ExitCode: 143,
          Error: "",
          FinishedAt: "2026-08-13T05:00:00.000000000Z",
        })}\n`,
        stderr: "",
      };
    }
    if (request.command === "docker" && request.args.includes("ps")) {
      return { status: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
    }
    return { status: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
  };
  const lockEvents = [];
  const host = await createFixedHostJourneyActivationHost({
    inputPaths: [immutableInput, composeEnvPath, backendEnvPath],
    nginxConfigPath,
    composeEnvPath,
    backendEnvPath,
    baseComposePath,
    candidateComposePath,
    projectName: "easysubway",
    ambientEnvironment: { PATH: process.env.PATH },
    commandRunner,
    deployLockRunner: async ({ lockPath }) => ({
      verify: async () => lockEvents.push(`verify:${lockPath}`),
      close: async () => lockEvents.push(`close:${lockPath}`),
    }),
    nginxTargetProbe: async (request) => probes.push(request),
    nowNs: () => currentNs,
  });

  const lock = await host.acquireDeployLock({
    lockPath: "/opt/easysubway/deploy.lock",
    operationId: digest("7"),
  });
  host.setCandidateEnvironment({
    EASYSUBWAY_BACKEND_IMAGE: `ghcr.io/aquilaxk/easysubway-backend@${digest("a")}`,
    EASYSUBWAY_JOURNEY_V3_ROUTE_BUNDLE_STARTUP_DESCRIPTOR_BASE64: "descriptor",
    EASYSUBWAY_JOURNEY_V3_READINESS_SERVICE_TOKEN: "t".repeat(32),
  });
  await lock.verify();
  await host.verifyInputs();
  const standbySwitch = await host.switchNginx({
    input: input(root),
    fromPort: 8080,
    toPort: 8082,
    activation: {
      instanceIdentity: "backend-standby",
      activeReadinessEvidenceDigest: digest("8"),
    },
  });
  assert.equal(standbySwitch.nginxTestPassed, true);
  assert.equal(standbySwitch.reloadCompleted, true);
  assert.equal((await readFile(nginxConfigPath, "utf8")).match(/127\.0\.0\.1:8082/g)?.length, 3);
  const termination = await host.drainAndRecreateCanonical({ input: input(root) });
  assert.deepEqual({
    signal: termination.signal,
    stopGracePeriodSeconds: termination.stopGracePeriodSeconds,
    oldProcessExited: termination.oldProcessExited,
    withinBudget: termination.withinBudget,
  }, {
    signal: "SIGTERM",
    stopGracePeriodSeconds: 30,
    oldProcessExited: true,
    withinBudget: true,
  });
  const canonicalSwitch = await host.switchNginx({
    input: input(root),
    fromPort: 8082,
    toPort: 8080,
    activation: {
      instanceIdentity: "backend",
      activeReadinessEvidenceDigest: digest("e"),
    },
  });
  assert.equal(canonicalSwitch.toPort, 8080);
  assert.equal((await readFile(nginxConfigPath, "utf8")).match(/127\.0\.0\.1:8080/g)?.length, 3);
  assert.equal((await host.removeStandby()).standbyRemoved, true);
  await lock.close();
  await host.close();

  assert.deepEqual(commands, [
    ["nginx", "-t"],
    ["nginx", "-s", "reload"],
    ["docker", "compose", "--project-name", "easysubway", "--env-file", composeEnvPath,
      "-f", baseComposePath, "-f", candidateComposePath, "--profile", "journey-candidate",
      "stop", "--timeout", "30", "backend"],
    ["docker", "inspect", "--format", "{{json .State}}", "easysubway-backend"],
    ["docker", "compose", "--project-name", "easysubway", "--env-file", composeEnvPath,
      "-f", baseComposePath, "-f", candidateComposePath, "--profile", "journey-candidate",
      "up", "--detach", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "backend"],
    ["nginx", "-t"],
    ["nginx", "-s", "reload"],
    ["docker", "compose", "--project-name", "easysubway", "--env-file", composeEnvPath,
      "-f", baseComposePath, "-f", candidateComposePath, "--profile", "journey-candidate",
      "rm", "--force", "--stop", "backend-standby"],
    ["docker", "compose", "--project-name", "easysubway", "--env-file", composeEnvPath,
      "-f", baseComposePath, "-f", candidateComposePath, "--profile", "journey-candidate",
      "ps", "--all", "--quiet", "backend-standby"],
  ]);
  assert.deepEqual(lockEvents, [
    "verify:/opt/easysubway/deploy.lock",
    "verify:/opt/easysubway/deploy.lock",
    "close:/opt/easysubway/deploy.lock",
  ]);
  assert.equal(dockerEnvironments.length, 5);
  assert.equal(
    dockerEnvironments.every((environment) =>
      environment.EASYSUBWAY_BACKEND_IMAGE ===
        `ghcr.io/aquilaxk/easysubway-backend@${digest("a")}` &&
      environment.EASYSUBWAY_BACKEND_ENV_FILE === backendEnvPath),
    true,
  );
  assert.deepEqual(probes.map(({ expectedPort, instanceIdentity, evidenceDigest }) =>
    [expectedPort, instanceIdentity, evidenceDigest]), [
    [8082, "backend-standby", digest("8")],
    [8080, "backend", digest("e")],
  ]);
});

test("directory sync failure after Nginx rename restores canonical bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fixed-host-nginx-sync-"));
  const immutableInput = path.join(root, "tuple.json");
  const composeEnvPath = path.join(root, "compose.env");
  const backendEnvPath = path.join(root, "backend.env");
  const nginxConfigPath = path.join(root, "easysubway.conf");
  const baseComposePath = path.join(root, "docker-compose.yml");
  const candidateComposePath = path.join(root, "docker-compose.candidate.yml");
  const canonical = Buffer.from([
    "proxy_pass http://127.0.0.1:8080;",
    "proxy_pass http://127.0.0.1:8080;",
    "proxy_pass http://127.0.0.1:8080;",
    "",
  ].join("\n"));
  for (const pathname of [immutableInput, composeEnvPath, backendEnvPath,
    baseComposePath, candidateComposePath]) {
    await writeFile(pathname, "original\n");
  }
  await writeFile(nginxConfigPath, canonical);
  let syncCount = 0;
  const host = await createFixedHostJourneyActivationHost({
    inputPaths: [immutableInput],
    nginxConfigPath,
    composeEnvPath,
    backendEnvPath,
    baseComposePath,
    candidateComposePath,
    projectName: "easysubway",
    ambientEnvironment: {},
    commandRunner: async () => ({
      status: 0, signal: null, timedOut: false, stdout: "", stderr: "",
    }),
    deployLockRunner: async () => ({ verify: async () => {}, close: async () => {} }),
    directorySync: async () => {
      syncCount += 1;
      if (syncCount === 1) throw new Error("injected directory sync failure");
    },
    nginxTargetProbe: async () => {},
  });

  await assert.rejects(host.switchNginx({
    input: input(root),
    fromPort: 8080,
    toPort: 8082,
    activation: {
      instanceIdentity: "backend-standby",
      activeReadinessEvidenceDigest: digest("8"),
    },
  }));
  assert.deepEqual(await readFile(nginxConfigPath), canonical);
  await host.close();
});

test("failed evidence sync never publishes a final receipt path", async () => {
  assert.equal(typeof fixedHostRuntime.publishCreateOnlyEvidence, "function");
  const root = await mkdtemp(path.join(tmpdir(), "fixed-host-evidence-sync-"));
  const openFile = async (...args) => {
    const handle = await openFileSystem(...args);
    return {
      writeFile: (...values) => handle.writeFile(...values),
      sync: async () => {
        throw new Error("injected evidence sync failure");
      },
      stat: (...values) => handle.stat(...values),
      close: (...values) => handle.close(...values),
    };
  };

  await assert.rejects(fixedHostRuntime.publishCreateOnlyEvidence(
    root,
    "activation-receipt.json",
    { outcome: "ACTIVE_SERVING" },
    "pretty",
    { openFile },
  ));
  await missing(path.join(root, "activation-receipt.json"));
  assert.deepEqual(await readdir(root), []);
});

test("production Nginx probe verifies loopback TLS active identity and evidence", async () => {
  let requestOptions;
  const responseBody = {
    instanceId: "backend-standby",
    releaseTupleSha256: "f".repeat(64),
    trafficGeneration: 17,
    servingReady: true,
    draining: false,
    evidenceSha256: "8".repeat(64),
  };
  const requestImpl = (options) => {
    requestOptions = options;
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = () => {};
    request.end = () => queueMicrotask(() => {
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = {
        "content-type": "application/json; charset=UTF-8",
        "cache-control": "private, no-store",
      };
      request.emit("response", response);
      response.end(JSON.stringify(responseBody));
    });
    return request;
  };

  await fixedHostRuntime.probeFixedHostNginxTarget({
    expectedPort: 8082,
    instanceIdentity: "backend-standby",
    evidenceDigest: digest("8"),
    tupleSha256: digest("f"),
    trafficGeneration: 17,
    serviceToken: "t".repeat(32),
    requestImpl,
  });

  assert.deepEqual({
    host: requestOptions.host,
    port: requestOptions.port,
    servername: requestOptions.servername,
    method: requestOptions.method,
    path: requestOptions.path,
    agent: requestOptions.agent,
    hostHeader: requestOptions.headers.Host,
  }, {
    host: "127.0.0.1",
    port: 443,
    servername: "easysubway-api.aquilaxk.site",
    method: "GET",
    path: "/internal/v1/journey/readiness/active",
    agent: false,
    hostHeader: "easysubway-api.aquilaxk.site",
  });
});

test("concrete host rejects immutable input drift before another effect", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fixed-host-drift-"));
  const immutableInput = path.join(root, "tuple.json");
  const composeEnvPath = path.join(root, "compose.env");
  const backendEnvPath = path.join(root, "backend.env");
  const nginxConfigPath = path.join(root, "easysubway.conf");
  const baseComposePath = path.join(root, "docker-compose.yml");
  const candidateComposePath = path.join(root, "docker-compose.candidate.yml");
  for (const pathname of [immutableInput, composeEnvPath, backendEnvPath, nginxConfigPath,
    baseComposePath, candidateComposePath]) {
    await writeFile(pathname, "original\n");
  }
  const host = await createFixedHostJourneyActivationHost({
    inputPaths: [immutableInput],
    nginxConfigPath,
    composeEnvPath,
    backendEnvPath,
    baseComposePath,
    candidateComposePath,
    projectName: "easysubway",
    ambientEnvironment: {},
    commandRunner: async () => {
      throw new Error("must not run");
    },
    deployLockRunner: async () => ({ verify: async () => {}, close: async () => {} }),
  });
  await writeFile(immutableInput, "modified\n");
  await assert.rejects(host.verifyInputs(), /changed/);
  await host.close();
});
