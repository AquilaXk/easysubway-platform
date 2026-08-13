import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CandidateAdmissionError,
  admitJourneyReleaseCandidate,
  formatCandidateAdmissionSuccess,
} from "./admit-journey-release-candidate.mjs";

const script = fileURLToPath(
  new URL("./admit-journey-release-candidate.mjs", import.meta.url),
);
const bindingScript = fileURLToPath(
  new URL("./bind-journey-release-candidate.mjs", import.meta.url),
);
const acquisitionScript = fileURLToPath(
  new URL("./acquire-server-route-bundle.mjs", import.meta.url),
);
const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("admits one canonical inactive-candidate exact-tuple observation set", async () => {
  const fixture = writeFixture();
  const before = fixture.contents();
  const result = await admitJourneyReleaseCandidate(fixture.paths);

  assert.deepEqual(result, expectedAdmission(fixture));
  assert.equal(
    formatCandidateAdmissionSuccess(result),
    `${JSON.stringify(expectedAdmission(fixture))}\n`,
  );
  assert.deepEqual(fixture.contents(), before);
});

test("rejects missing or additional candidate instances", async () => {
  const mutations = [
    (value) => value.instances.pop(),
    (value) => { value.instances.push({ ...value.instances[0] }); },
  ];

  for (const mutate of mutations) {
    const fixture = writeFixture({ mutateObservations: mutate });
    await assert.rejects(
      admitJourneyReleaseCandidate(fixture.paths),
      admissionError("CANDIDATE_ADMISSION_TOPOLOGY_INVALID"),
    );
  }
});

test("rejects binding, tuple, orchestrator, and every-instance identity mismatch", async () => {
  const cases = [
    { mutateBinding: (value) => { value.serverRouteBundleDigest = digest("f"); } },
    { mutateObservations: (value) => { value.bindingSha256 = digest("f"); } },
    { mutateObservations: (value) => { value.orchestrator = "KUBERNETES"; } },
    { mutateObservations: (value) => { value.tupleSha256 = digest("f"); } },
    { mutateObservations: (value) => { value.instances[0].backendConfigDigest = digest("f"); } },
    { mutateObservations: (value) => { value.instances[0].deploymentRevision = "f".repeat(40); } },
  ];

  for (const options of cases) {
    const fixture = writeFixture(options);
    await assert.rejects(
      admitJourneyReleaseCandidate(fixture.paths),
      admissionError("CANDIDATE_ADMISSION_IDENTITY_MISMATCH"),
    );
  }
});

test("rejects any unwarmed or unready instance and any failed or fallback canary", async () => {
  const notReady = [
    (value) => { value.instances[0].warmed = false; },
    (value) => { value.instances[0].ready = false; },
  ];
  for (const mutateObservations of notReady) {
    const fixture = writeFixture({ mutateObservations });
    await assert.rejects(
      admitJourneyReleaseCandidate(fixture.paths),
      admissionError("CANDIDATE_ADMISSION_INSTANCE_NOT_READY"),
    );
  }

  const failedCanaries = [
    (value) => { value.canary.passed = false; },
    (value) => { value.canary.legacyGraphSuccessCount = 1; },
    (value) => { value.canary.localRouteInvocationCount = 1; },
    (value) => { value.canary.staleJourneyServedCount = 1; },
    (value) => { value.canary.alternateEndpointSuccessCount = 1; },
  ];
  for (const mutateObservations of failedCanaries) {
    const fixture = writeFixture({ mutateObservations });
    await assert.rejects(
      admitJourneyReleaseCandidate(fixture.paths),
      admissionError("CANDIDATE_ADMISSION_CANARY_FAILED"),
    );
  }
});

test("rejects malformed, open, reordered, and noncanonical bytes", async () => {
  const invalid = [
    { bindingBody: "{" },
    { tupleBody: "[]\n" },
    { observationsBody: "{}\n" },
    {
      mutateObservations: (value) => { value.unexpected = true; },
    },
    {
      mutateObservations: (value) => { value.instances[0].instanceIdentity = 123; },
    },
    {
      mutateObservations: (value) => { delete value.instances[0].candidateGeneration; },
    },
    {
      mutateObservations: (value) => { value.instances[0].candidateGeneration = 0; },
    },
    {
      encodeObservations: (value) => `${JSON.stringify({
        artifactKind: value.artifactKind,
        schemaVersion: value.schemaVersion,
        orchestrator: value.orchestrator,
        bindingSha256: value.bindingSha256,
        tupleSha256: value.tupleSha256,
        instances: value.instances,
        canary: value.canary,
      }, null, 2)}\n`,
    },
    {
      encodeObservations: (value) => JSON.stringify(value),
    },
  ];

  for (const options of invalid) {
    const fixture = writeFixture(options);
    await assert.rejects(
      admitJourneyReleaseCandidate(fixture.paths),
      admissionError("CANDIDATE_ADMISSION_INPUT_INVALID"),
    );
  }
});

test("rejects a final input mutation after validation", async () => {
  const fixture = writeFixture();
  await assert.rejects(
    admitJourneyReleaseCandidate({
      ...fixture.paths,
      beforeFinalVerification: () => {
        writeFileSync(fixture.paths.observationsPath, `${fixture.observationsBody} `);
      },
    }),
    admissionError("CANDIDATE_ADMISSION_INPUT_UNSTABLE"),
  );
});

test("CLI accepts only exact arguments and rejects symlink input without leaking paths", () => {
  const fixture = writeFixture();
  const success = run(fixture.paths);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stdout, `${JSON.stringify(expectedAdmission(fixture))}\n`);
  assert.equal(success.stderr, "");

  const linkedScript = join(fixture.root, "admit-journey-release-candidate.mjs");
  symlinkSync(script, linkedScript);
  symlinkSync(
    bindingScript,
    join(fixture.root, "bind-journey-release-candidate.mjs"),
  );
  symlinkSync(
    acquisitionScript,
    join(fixture.root, "acquire-server-route-bundle.mjs"),
  );
  const linkedSuccess = spawnSync(process.execPath, [
    "--preserve-symlinks-main",
    linkedScript,
    "--binding",
    fixture.paths.bindingPath,
    "--tuple",
    fixture.paths.tuplePath,
    "--observations",
    fixture.paths.observationsPath,
  ], { encoding: "utf8" });
  assert.equal(linkedSuccess.status, 0, linkedSuccess.stderr);
  assert.equal(linkedSuccess.stdout, success.stdout);

  const invalid = spawnSync(process.execPath, [script, "--binding", fixture.paths.bindingPath], {
    encoding: "utf8",
  });
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, "");
  assert.equal(
    invalid.stderr,
    "CANDIDATE_ADMISSION_USAGE expected exact candidate admission arguments\n",
  );

  const linked = join(fixture.root, "binding-link.json");
  symlinkSync(fixture.paths.bindingPath, linked);
  const symlinked = run({ ...fixture.paths, bindingPath: linked });
  assert.equal(symlinked.status, 2);
  assert.equal(symlinked.stdout, "");
  assert.equal(
    symlinked.stderr,
    "CANDIDATE_ADMISSION_INPUT_INVALID candidate admission input validation failed\n",
  );
  assert.equal(symlinked.stderr.includes(fixture.root), false);
});

function writeFixture({
  mutateBinding = () => {},
  mutateTuple = () => {},
  mutateObservations = () => {},
  bindingBody,
  tupleBody,
  observationsBody,
  encodeObservations = canonicalPretty,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "journey-candidate-admission-"));
  temporaryRoots.push(root);
  const tuple = validTuple();
  mutateTuple(tuple);
  const tupleBytes = tupleBody ?? canonicalPretty(tuple);
  const binding = validBinding(tuple);
  mutateBinding(binding);
  const bindingBytes = bindingBody ?? `${JSON.stringify(binding)}\n`;
  const observations = validObservations(tuple, bindingBytes);
  mutateObservations(observations);
  const observationBytes = observationsBody ?? encodeObservations(observations);
  const paths = {
    bindingPath: join(root, "binding.json"),
    tuplePath: join(root, "tuple.json"),
    observationsPath: join(root, "observations.json"),
  };
  writeFileSync(paths.bindingPath, bindingBytes);
  writeFileSync(paths.tuplePath, tupleBytes);
  writeFileSync(paths.observationsPath, observationBytes);
  return {
    root,
    paths,
    tuple,
    binding,
    observations,
    bindingBody: bindingBytes,
    observationsBody: observationBytes,
    contents: () => Object.values(paths).map((path) => readFileSync(path, "utf8")),
  };
}

function validTuple() {
  const tuple = {
    schemaVersion: "JOURNEY_RELEASE_TUPLE_V1",
    artifactKind: "journey-release-tuple",
    backendImageDigest: digest("a"),
    backendConfigDigest: digest("b"),
    journeyContractDigest: digest("c"),
    serverRouteBundleDigest: digest("d"),
    deploymentRevision: "e".repeat(40),
    environmentIdentity: "production",
    tupleSha256: "",
  };
  tuple.tupleSha256 = tupleHash(tuple);
  return tuple;
}

function validBinding(tuple) {
  return {
    schemaVersion: "JOURNEY_RELEASE_CANDIDATE_BINDING_V1",
    artifactKind: "journey-release-candidate-binding",
    orchestrator: "COMPOSE",
    tupleSha256: tuple.tupleSha256,
    deploymentRevision: tuple.deploymentRevision,
    environmentIdentity: tuple.environmentIdentity,
    handoffSha256: "f".repeat(64),
    serverRouteBundleDigest: tuple.serverRouteBundleDigest,
  };
}

function validObservations(tuple, bindingBytes) {
  return {
    schemaVersion: "PLATFORM_JOURNEY_CANDIDATE_OBSERVATIONS_V1",
    artifactKind: "journey-candidate-observations",
    orchestrator: "COMPOSE",
    bindingSha256: sha256(bindingBytes),
    tupleSha256: tuple.tupleSha256,
    instances: [
      validInstance(tuple, "candidate-01", "oci-host-easysubway-a1", "1"),
    ],
    canary: {
      passed: true,
      evidenceDigest: digest("9"),
      legacyGraphSuccessCount: 0,
      localRouteInvocationCount: 0,
      staleJourneyServedCount: 0,
      alternateEndpointSuccessCount: 0,
    },
  };
}

function validInstance(tuple, instanceIdentity, failureDomainIdentity, evidence) {
  return {
    instanceIdentity,
    failureDomainIdentity,
    tupleSha256: tuple.tupleSha256,
    backendImageDigest: tuple.backendImageDigest,
    backendConfigDigest: tuple.backendConfigDigest,
    journeyContractDigest: tuple.journeyContractDigest,
    serverRouteBundleDigest: tuple.serverRouteBundleDigest,
    deploymentRevision: tuple.deploymentRevision,
    environmentIdentity: tuple.environmentIdentity,
    candidateGeneration: 7,
    warmed: true,
    ready: true,
    readinessEvidenceDigest: digest(evidence),
  };
}

function expectedAdmission(fixture) {
  const admission = {
    schemaVersion: "PLATFORM_JOURNEY_CANDIDATE_ADMISSION_V1",
    artifactKind: "journey-candidate-admission",
    orchestrator: fixture.binding.orchestrator,
    tupleSha256: fixture.tuple.tupleSha256,
    backendImageDigest: fixture.tuple.backendImageDigest,
    backendConfigDigest: fixture.tuple.backendConfigDigest,
    journeyContractDigest: fixture.tuple.journeyContractDigest,
    serverRouteBundleDigest: fixture.tuple.serverRouteBundleDigest,
    deploymentRevision: fixture.tuple.deploymentRevision,
    environmentIdentity: fixture.tuple.environmentIdentity,
    bindingSha256: sha256(fixture.bindingBody),
    observationsSha256: sha256(fixture.observationsBody),
    handoffSha256: fixture.binding.handoffSha256,
    instanceCount: fixture.observations.instances.length,
    failureDomainCount: new Set(
      fixture.observations.instances.map((instance) => instance.failureDomainIdentity),
    ).size,
    canaryEvidenceDigest: fixture.observations.canary.evidenceDigest,
    candidateGeneration: fixture.observations.instances[0].candidateGeneration,
  };
  return {
    ...admission,
    candidateAdmissionSha256: sha256(`${JSON.stringify(admission)}\n`),
  };
}

function run({ bindingPath, tuplePath, observationsPath }) {
  return spawnSync(process.execPath, [
    script,
    "--binding",
    bindingPath,
    "--tuple",
    tuplePath,
    "--observations",
    observationsPath,
  ], { encoding: "utf8" });
}

function canonicalPretty(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function tupleHash(tuple) {
  const fields = [
    "backendImageDigest",
    "backendConfigDigest",
    "journeyContractDigest",
    "serverRouteBundleDigest",
    "deploymentRevision",
    "environmentIdentity",
  ];
  return sha256(`${fields.map((field) => tuple[field]).join("\n")}\n`);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

function admissionError(code) {
  return (error) => error instanceof CandidateAdmissionError && error.code === code;
}
