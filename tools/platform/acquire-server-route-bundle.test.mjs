import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open as openFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AcquisitionError,
  acquireServerRouteBundle,
  buildObjectUrl,
  formatAcquisitionSuccess,
  inspectAcquiredServerRouteBundleCandidate,
} from "./acquire-server-route-bundle.mjs";
import {
  CandidateBindingError,
  bindJourneyReleaseCandidate,
  formatCandidateBindingSuccess,
} from "./bind-journey-release-candidate.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const contractPath = join(
  repositoryRoot,
  "contracts/release/server-route-bundle-object-acquisition-contract.json",
);
const scriptPath = join(
  repositoryRoot,
  "tools/platform/acquire-server-route-bundle.mjs",
);
const bindingScriptPath = join(
  repositoryRoot,
  "tools/platform/bind-journey-release-candidate.mjs",
);
const workflowPath = join(repositoryRoot, ".github/workflows/ci.yml");
const focusedCommand =
  "node --test tools/platform/acquire-server-route-bundle.test.mjs";
const temporaryRoots = [];
const objectPaths = [
  "compatibility.json",
  "manifest.json",
  "manifest.signing-input.json",
  "payload/accessibility.sqlite.zst",
  "payload/fare.sqlite.zst",
  "payload/timetable.sqlite.zst",
  "payload/topology.sqlite.zst",
  "provenance.json",
];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acquires the exact ordered eight objects once and atomically publishes one candidate", async () => {
  const fixture = makeFixture();
  const calls = [];

  const result = await acquireServerRouteBundle({
    contractPath,
    handoffPath: fixture.handoffPath,
    outputRoot: fixture.outputRoot,
    fetchObject: successfulTransport(fixture.objects, calls),
  });

  assert.deepEqual(result, {
    handoffSha256: fixture.handoff.handoffSha256,
    serverRouteBundleDigest:
      fixture.handoff.platformRelease.serverRouteBundleDigest,
  });
  assert.equal(
    formatAcquisitionSuccess(result),
    `ACQUIRED ${fixture.handoff.handoffSha256} ${fixture.handoff.platformRelease.serverRouteBundleDigest}\n`,
  );
  assert.deepEqual(
    calls,
    fixture.handoff.publicationReceipt.objects.map((entry) =>
      buildObjectUrl(
        fixture.handoff.publicationReceipt.locator.publicBaseUrl,
        entry.objectKey,
      ),
    ),
  );
  assert.equal(new Set(calls).size, 8);

  const candidate = join(fixture.outputRoot, fixture.handoff.handoffSha256);
  assert.deepEqual(readdirSync(fixture.outputRoot), [fixture.handoff.handoffSha256]);
  assert.equal(
    readFileSync(join(candidate, "handoff.json"), "utf8"),
    canonicalJson(fixture.handoff),
  );
  for (const relative of objectPaths) {
    assert.deepEqual(
      readFileSync(join(candidate, "objects", relative)),
      fixture.objects.get(relative),
    );
  }
});

test("rejects handoff and producer identity drift before every network boundary", async () => {
  const cases = [
    {
      code: "HANDOFF_SHAPE_INVALID",
      mutate: (value) => {
        value.handoffSha256 = "0".repeat(64);
      },
      rebind: false,
    },
    {
      code: "PRODUCER_IDENTITY_MISMATCH",
      mutate: (value) => {
        value.publicationReceipt.repository.gitSha = "f".repeat(40);
      },
    },
    {
      code: "HANDOFF_SHAPE_INVALID",
      mutate: (value) => {
        value.release.result = "NO_GO";
      },
    },
    {
      code: "HANDOFF_SHAPE_INVALID",
      mutate: (value) => {
        value.release.finalSha256 = [value.release.finalSha256];
      },
    },
    {
      code: "HANDOFF_SHAPE_INVALID",
      mutate: (value) => {
        value.manifest.signature.value = 123;
      },
      rebind: "manifest",
    },
    {
      code: "OBJECT_IDENTITY_MISMATCH",
      mutate: (value) => {
        value.publicationReceipt.objects[2].sha256 = "f".repeat(64);
      },
    },
    {
      code: "OBJECT_IDENTITY_MISMATCH",
      mutate: (value) => {
        value.platformRelease.serverRouteBundleDigest =
          `sha256:${"f".repeat(64)}`;
      },
    },
  ];

  for (const item of cases) {
    const fixture = makeFixture();
    item.mutate(fixture.handoff);
    if (item.rebind === "manifest") {
      rebindManifestHandoff(fixture.handoff);
    } else if (item.rebind !== false) {
      rebindHandoff(fixture.handoff);
    }
    writeFileSync(fixture.handoffPath, canonicalJson(fixture.handoff));
    let calls = 0;

    await assert.rejects(
      acquireServerRouteBundle({
        contractPath,
        handoffPath: fixture.handoffPath,
        outputRoot: fixture.outputRoot,
        fetchObject: async () => {
          calls += 1;
          throw new Error("network must not run");
        },
      }),
      errorWithCode(item.code),
      item.code,
    );
    assert.equal(calls, 0, item.code);
    assert.deepEqual(readdirSync(fixture.outputRoot), []);
  }
});

test("rejects acquisition contract pin and invariant drift before network", async () => {
  const cases = [
    (contract) => {
      contract.producer.gitSha = "f".repeat(40);
    },
    (contract) => {
      contract.producer.schemas[0].rawSha256 = "f".repeat(64);
    },
    (contract) => contract.consumedJsonPointers.reverse(),
    (contract) => {
      contract.candidateOutput.overwriteAllowed = true;
    },
  ];

  for (const [index, mutate] of cases.entries()) {
    const fixture = makeFixture();
    const contract = JSON.parse(readFileSync(contractPath, "utf8"));
    mutate(contract);
    const changedContractPath = join(fixture.root, `contract-${index}.json`);
    writeFileSync(changedContractPath, JSON.stringify(contract));
    let calls = 0;

    await assert.rejects(
      acquireServerRouteBundle({
        contractPath: changedContractPath,
        handoffPath: fixture.handoffPath,
        outputRoot: fixture.outputRoot,
        fetchObject: async () => {
          calls += 1;
        },
      }),
      errorWithCode("OUTPUT_POLICY_VIOLATION"),
    );
    assert.equal(calls, 0);
    assert.deepEqual(readdirSync(fixture.outputRoot), []);
  }
});

test("rejects reordered, duplicated, unknown, prefix, and traversal inventory before network", async () => {
  const cases = [
    (handoff) => handoff.publicationReceipt.objects.reverse(),
    (handoff) => {
      handoff.publicationReceipt.objects[1] = structuredClone(
        handoff.publicationReceipt.objects[0],
      );
    },
    (handoff) => {
      handoff.publicationReceipt.objects[0].unknown = true;
    },
    (handoff) => {
      handoff.publicationReceipt.objects[0].objectKey =
        `other/${handoff.publicationReceipt.objects[0].path}`;
    },
    (handoff) => {
      const entry = handoff.publicationReceipt.objects[0];
      entry.path = "../compatibility.json";
      entry.objectKey =
        `${handoff.publicationReceipt.locator.objectPrefix}${entry.path}`;
    },
  ];

  for (const mutate of cases) {
    const fixture = makeFixture();
    mutate(fixture.handoff);
    rebindHandoff(fixture.handoff);
    writeFileSync(fixture.handoffPath, canonicalJson(fixture.handoff));
    let calls = 0;

    await assert.rejects(
      acquireServerRouteBundle({
        contractPath,
        handoffPath: fixture.handoffPath,
        outputRoot: fixture.outputRoot,
        fetchObject: async () => {
          calls += 1;
          throw new Error("network must not run");
        },
      }),
      errorWithCode("INVENTORY_INVALID"),
    );
    assert.equal(calls, 0);
    assert.deepEqual(readdirSync(fixture.outputRoot), []);
  }
});

test("rejects redirect, non-200, encoded, and wrong-length responses without candidate visibility", async () => {
  const cases = [
    response(302, { location: "https://example.invalid/alternate" }, Buffer.alloc(0)),
    response(404, {}, Buffer.from("not found")),
    response(200, { "content-encoding": "gzip" }, Buffer.from("ignored")),
    response(200, { "content-length": "999" }, Buffer.from("ignored")),
  ];

  for (const rejectedResponse of cases) {
    const fixture = makeFixture();
    const first = fixture.handoff.publicationReceipt.objects[0];
    await assert.rejects(
      acquireServerRouteBundle({
        contractPath,
        handoffPath: fixture.handoffPath,
        outputRoot: fixture.outputRoot,
        fetchObject: async (url) => {
          assert.equal(
            url,
            buildObjectUrl(
              fixture.handoff.publicationReceipt.locator.publicBaseUrl,
              first.objectKey,
            ),
          );
          return rejectedResponse;
        },
      }),
      (error) => {
        assert.equal(error instanceof AcquisitionError, true);
        assert.equal(
          ["CURRENT_OBJECT_UNAVAILABLE", "LOCATOR_POLICY_VIOLATION"].includes(
            error.code,
          ),
          true,
        );
        assert.equal(error.message.includes("objectstorage"), false);
        assert.equal(error.message.includes(first.objectKey), false);
        assert.equal(error.message.includes(fixture.outputRoot), false);
        return true;
      },
    );
    assert.deepEqual(readdirSync(fixture.outputRoot), []);
  }
});

test("rejects short, empty, oversized, mismatched, and interrupted bodies", async () => {
  const variants = [
    () => Buffer.alloc(0),
    (expected) => expected.subarray(0, expected.length - 1),
    (expected) => Buffer.concat([expected, Buffer.from("x")]),
    (expected) => Buffer.alloc(expected.length, 0x78),
    () => interruptedBody(),
  ];

  for (const body of variants) {
    const fixture = makeFixture();
    const first = fixture.handoff.publicationReceipt.objects[0];
    const expected = fixture.objects.get(first.path);
    await assert.rejects(
      acquireServerRouteBundle({
        contractPath,
        handoffPath: fixture.handoffPath,
        outputRoot: fixture.outputRoot,
        fetchObject: async () => response(200, {}, body(expected)),
      }),
      errorWithCode(
        body === variants[4]
          ? "CURRENT_OBJECT_UNAVAILABLE"
          : "OBJECT_IDENTITY_MISMATCH",
      ),
    );
    assert.deepEqual(readdirSync(fixture.outputRoot), []);
  }
});

test("rejects a changed local second read and removes only its hidden stage", async () => {
  const fixture = makeFixture();
  await assert.rejects(
    acquireServerRouteBundle({
      contractPath,
      handoffPath: fixture.handoffPath,
      outputRoot: fixture.outputRoot,
      fetchObject: successfulTransport(fixture.objects),
      beforeSecondRead: ({ stageRoot }) => {
        const target = join(stageRoot, "objects", objectPaths[0]);
        const original = readFileSync(target);
        writeFileSync(target, Buffer.alloc(original.length, 0x78));
      },
    }),
    errorWithCode("OBJECT_READ_UNSTABLE"),
  );
  assert.deepEqual(readdirSync(fixture.outputRoot), []);
});

test("streams second-read verification in bounded chunks", async () => {
  const fixture = makeFixture({ largePayloadSize: 192 * 1024 });
  const reads = [];

  await acquireServerRouteBundle({
    contractPath,
    handoffPath: fixture.handoffPath,
    outputRoot: fixture.outputRoot,
    fetchObject: successfulTransport(fixture.objects),
    onSecondReadChunk: (event) => reads.push(event),
  });

  const topologyReads = reads.filter(
    (event) => event.path === "payload/topology.sqlite.zst",
  );
  assert.equal(topologyReads.length > 1, true);
  assert.equal(
    topologyReads.every((event) => event.bytesRead > 0 && event.bytesRead <= 64 * 1024),
    true,
  );
  assert.equal(
    topologyReads.reduce((sum, event) => sum + event.bytesRead, 0),
    192 * 1024,
  );
});

test("classifies local write failures as output errors", async () => {
  const fixture = makeFixture();

  await assert.rejects(
    acquireServerRouteBundle({
      contractPath,
      handoffPath: fixture.handoffPath,
      outputRoot: fixture.outputRoot,
      fetchObject: successfulTransport(fixture.objects),
      openOutputFile: async (...args) => {
        const handle = await openFile(...args);
        return {
          write: async () => {
            throw new Error("simulated local write failure");
          },
          close: () => handle.close(),
        };
      },
    }),
    errorWithCode("OUTPUT_POLICY_VIOLATION"),
  );
  assert.deepEqual(readdirSync(fixture.outputRoot), []);
});

test("classifies candidate handoff write failures as output errors", async () => {
  const fixture = makeFixture();
  let handoffWriteAttempts = 0;

  await assert.rejects(
    acquireServerRouteBundle({
      contractPath,
      handoffPath: fixture.handoffPath,
      outputRoot: fixture.outputRoot,
      fetchObject: successfulTransport(fixture.objects),
      openOutputFile: async (...args) => {
        const handle = await openFile(...args);
        if (!args[0].endsWith("/handoff.json")) return handle;
        return {
          writeFile: async () => {
            handoffWriteAttempts += 1;
            throw new Error("simulated handoff write failure");
          },
          close: () => handle.close(),
        };
      },
    }),
    errorWithCode("OUTPUT_POLICY_VIOLATION"),
  );
  assert.equal(handoffWriteAttempts, 1);
  assert.deepEqual(readdirSync(fixture.outputRoot), []);
});

test("destroys the response body when target creation fails", async () => {
  const fixture = makeFixture();
  const first = fixture.handoff.publicationReceipt.objects[0];
  const tracked = trackedBody(fixture.objects.get(first.path));

  await assert.rejects(
    acquireServerRouteBundle({
      contractPath,
      handoffPath: fixture.handoffPath,
      outputRoot: fixture.outputRoot,
      fetchObject: async () => response(200, {}, tracked.body),
      openOutputFile: async () => {
        throw new Error("simulated target open failure");
      },
    }),
    errorWithCode("OUTPUT_POLICY_VIOLATION"),
  );
  assert.equal(tracked.destroyCalls(), 1);
  assert.deepEqual(readdirSync(fixture.outputRoot), []);
});

test("rejects nonempty, symlink, and existing candidate outputs before network", async () => {
  const fixture = makeFixture();
  const older = join(fixture.outputRoot, "older-local-cache");
  writeFileSync(older, "must remain untouched");
  let calls = 0;
  await assert.rejects(
    acquireServerRouteBundle({
      contractPath,
      handoffPath: fixture.handoffPath,
      outputRoot: fixture.outputRoot,
      fetchObject: async () => {
        calls += 1;
      },
    }),
    errorWithCode("OUTPUT_POLICY_VIOLATION"),
  );
  assert.equal(calls, 0);
  assert.equal(readFileSync(older, "utf8"), "must remain untouched");

  const symlinkRoot = makeTemporaryRoot();
  const external = makeTemporaryRoot();
  const link = join(symlinkRoot, "output-link");
  symlinkSync(external, link);
  await assert.rejects(
    acquireServerRouteBundle({
      contractPath,
      handoffPath: fixture.handoffPath,
      outputRoot: link,
      fetchObject: async () => {
        calls += 1;
      },
    }),
    errorWithCode("OUTPUT_POLICY_VIOLATION"),
  );
  assert.equal(calls, 0);
  assert.deepEqual(readdirSync(external), []);

  const ancestorRoot = makeTemporaryRoot();
  const realParent = makeTemporaryRoot();
  mkdirSync(join(realParent, "output"));
  const parentLink = join(ancestorRoot, "parent-link");
  symlinkSync(realParent, parentLink);
  await assert.rejects(
    acquireServerRouteBundle({
      contractPath,
      handoffPath: fixture.handoffPath,
      outputRoot: join(parentLink, "output"),
      fetchObject: async () => {
        calls += 1;
      },
    }),
    errorWithCode("OUTPUT_POLICY_VIOLATION"),
  );
  assert.equal(calls, 0);
  assert.deepEqual(readdirSync(join(realParent, "output")), []);
});

test("rejects duplicate JSON keys and invalid CLI forms with sanitized typed output", async () => {
  const fixture = makeFixture();
  const duplicate = canonicalJson(fixture.handoff).replace(
    /^\{/,
    '{"schemaVersion":1,',
  );
  writeFileSync(fixture.handoffPath, duplicate);
  let calls = 0;
  await assert.rejects(
    acquireServerRouteBundle({
      contractPath,
      handoffPath: fixture.handoffPath,
      outputRoot: fixture.outputRoot,
      fetchObject: async () => {
        calls += 1;
      },
    }),
    errorWithCode("HANDOFF_SHAPE_INVALID"),
  );
  assert.equal(calls, 0);

  for (const args of [[], ["--contract", contractPath], ["--unknown", "value"]]) {
    const result = spawnSync(process.execPath, [scriptPath, ...args], {
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^OUTPUT_POLICY_VIOLATION [^\n]+\n$/);
    assert.equal(result.stderr.includes(repositoryRoot), false);
  }
});

test("binds one exact staged tuple to one exact candidate without mutating either input", async () => {
  const fixture = makeFixture({ largePayloadSize: 192 * 1024 });
  const candidateRoot = await acquireFixture(fixture);
  const tuple = stagedTuple(fixture);
  const tuplePath = writeTuple(fixture, tuple);
  const beforeCandidate = fingerprintCandidate(candidateRoot);
  const beforeTuple = readFileSync(tuplePath);
  const reads = [];

  const result = await bindJourneyReleaseCandidate({
    contractPath,
    tuplePath,
    candidateRoot,
    orchestrator: "COMPOSE",
    inspectCandidate: (input) =>
      inspectAcquiredServerRouteBundleCandidate({
        ...input,
        onReadChunk: (event) => reads.push(event),
      }),
  });

  assert.deepEqual(result, {
    schemaVersion: "JOURNEY_RELEASE_CANDIDATE_BINDING_V1",
    artifactKind: "journey-release-candidate-binding",
    orchestrator: "COMPOSE",
    tupleSha256: tuple.tupleSha256,
    deploymentRevision: tuple.deploymentRevision,
    environmentIdentity: tuple.environmentIdentity,
    handoffSha256: fixture.handoff.handoffSha256,
    serverRouteBundleDigest:
      fixture.handoff.platformRelease.serverRouteBundleDigest,
  });
  assert.equal(formatCandidateBindingSuccess(result), `${JSON.stringify(result)}\n`);
  for (const pass of [1, 2]) {
    const topologyReads = reads.filter(
      (event) =>
        event.pass === pass && event.path === "payload/topology.sqlite.zst",
    );
    assert.equal(topologyReads.length > 1, true);
    assert.equal(
      topologyReads.every(
        (event) => event.bytesRead > 0 && event.bytesRead <= 64 * 1024,
      ),
      true,
    );
    assert.equal(
      topologyReads.reduce((sum, event) => sum + event.bytesRead, 0),
      192 * 1024,
    );
  }
  assert.deepEqual(readFileSync(tuplePath), beforeTuple);
  assert.deepEqual(fingerprintCandidate(candidateRoot), beforeCandidate);
});

test("rejects malformed staged tuples before candidate inspection", async () => {
  const fixture = makeFixture();
  const tuple = stagedTuple(fixture);
  const duplicate = canonicalTuple(tuple).replace(
    /^\{\n/,
    `{\n  "schemaVersion": "JOURNEY_RELEASE_TUPLE_V1",\n`,
  );
  const cases = [
    JSON.stringify(tuple),
    duplicate,
    canonicalTuple(Object.fromEntries(Object.entries(tuple).toReversed())),
    canonicalTuple({ ...tuple, unexpected: true }),
    canonicalTuple({ ...tuple, tupleSha256: `sha256:${"0".repeat(64)}` }),
  ];
  let inspections = 0;

  for (const [index, bytes] of cases.entries()) {
    const tuplePath = writeTuple(fixture, tuple, bytes, `tuple-invalid-${index}.json`);
    await assert.rejects(
      bindJourneyReleaseCandidate({
        contractPath,
        tuplePath,
        candidateRoot: join(fixture.outputRoot, "must-not-be-inspected"),
        orchestrator: "COMPOSE",
        inspectCandidate: async () => {
          inspections += 1;
          throw new Error("candidate inspection must not run");
        },
      }),
      candidateBindingError("CANDIDATE_TUPLE_INVALID"),
    );
  }
  assert.equal(inspections, 0);
});

test("rejects a tuple and acquired bundle digest mismatch", async () => {
  const fixture = makeFixture();
  const candidateRoot = await acquireFixture(fixture);
  const tuple = stagedTuple(fixture, {
    serverRouteBundleDigest: `sha256:${"e".repeat(64)}`,
  });
  const tuplePath = writeTuple(fixture, tuple);

  await assert.rejects(
    bindJourneyReleaseCandidate({
      contractPath,
      tuplePath,
      candidateRoot,
      orchestrator: "COMPOSE",
    }),
    candidateBindingError("CANDIDATE_IDENTITY_MISMATCH"),
  );
});

test("rejects malformed candidate names, trees, links, special files, and handoff drift", async () => {
  const cases = [
    {
      mutate: (candidateRoot, fixture) => {
        const wrongName = join(fixture.outputRoot, "wrong-handoff-name");
        renameSync(candidateRoot, wrongName);
        return wrongName;
      },
    },
    {
      mutate: (candidateRoot) => {
        writeFileSync(join(candidateRoot, "objects", "unexpected.json"), "unexpected");
        return candidateRoot;
      },
    },
    {
      mutate: (candidateRoot) => {
        rmSync(join(candidateRoot, "objects", objectPaths[0]));
        return candidateRoot;
      },
    },
    {
      mutate: (candidateRoot) => {
        const target = join(candidateRoot, "objects", objectPaths[0]);
        rmSync(target);
        symlinkSync("/dev/null", target);
        return candidateRoot;
      },
    },
    {
      mutate: (candidateRoot) => {
        const target = join(candidateRoot, "objects", objectPaths[0]);
        rmSync(target);
        createFifo(target);
        return candidateRoot;
      },
    },
    {
      mutate: (candidateRoot) => {
        writeFileSync(join(candidateRoot, "handoff.json"), "{}\n");
        return candidateRoot;
      },
    },
  ];

  for (const { mutate } of cases) {
    const fixture = makeFixture();
    const acquiredRoot = await acquireFixture(fixture);
    const candidateRoot = mutate(acquiredRoot, fixture);
    const tuplePath = writeTuple(fixture, stagedTuple(fixture));
    await assert.rejects(
      bindJourneyReleaseCandidate({
        contractPath,
        tuplePath,
        candidateRoot,
        orchestrator: "COMPOSE",
      }),
      candidateBindingError("CANDIDATE_BUNDLE_INVALID"),
    );
  }
});

test("rejects object, handoff, and directory mutation between candidate passes", async () => {
  const mutations = [
    (candidateRoot) => {
      const target = join(candidateRoot, "objects", objectPaths[0]);
      writeFileSync(target, Buffer.alloc(readFileSync(target).length, 0x78));
    },
    (candidateRoot) => {
      const target = join(candidateRoot, "handoff.json");
      writeFileSync(target, Buffer.concat([readFileSync(target), Buffer.from(" ")]));
    },
    (candidateRoot) => {
      writeFileSync(join(candidateRoot, "objects", "unexpected.json"), "unexpected");
    },
  ];

  for (const mutate of mutations) {
    const fixture = makeFixture();
    const candidateRoot = await acquireFixture(fixture);
    await assert.rejects(
      inspectAcquiredServerRouteBundleCandidate({
        contractPath,
        candidateRoot,
        beforeSecondPass: ({ candidateRoot: root }) => mutate(root),
      }),
      errorWithCode("OBJECT_READ_UNSTABLE"),
    );
  }
});

test("rejects an object mutated after its second-pass bytes were hashed", async () => {
  const fixture = makeFixture();
  const candidateRoot = await acquireFixture(fixture);
  let mutated = false;

  await assert.rejects(
    inspectAcquiredServerRouteBundleCandidate({
      contractPath,
      candidateRoot,
      onReadChunk: (event) => {
        if (mutated || event.pass !== 2 || event.path !== objectPaths[0]) return;
        mutated = true;
        const target = join(candidateRoot, "objects", objectPaths[0]);
        writeFileSync(target, Buffer.alloc(readFileSync(target).length, 0x78));
      },
    }),
    errorWithCode("OBJECT_READ_UNSTABLE"),
  );
  assert.equal(mutated, true);
});

test("rejects an oversized candidate object before hashing its bytes", async () => {
  const fixture = makeFixture();
  const candidateRoot = await acquireFixture(fixture);
  writeFileSync(
    join(candidateRoot, "objects", objectPaths[0]),
    Buffer.alloc(256 * 1024, 0x78),
  );
  let oversizedBytesRead = 0;

  await assert.rejects(
    inspectAcquiredServerRouteBundleCandidate({
      contractPath,
      candidateRoot,
      onReadChunk: (event) => {
        if (event.pass === 1 && event.path === objectPaths[0]) {
          oversizedBytesRead += event.bytesRead;
        }
      },
    }),
    errorWithCode("OBJECT_IDENTITY_MISMATCH"),
  );
  assert.equal(oversizedBytesRead, 0);
});

test("inspects only the exact candidate and leaves sibling-shaped sources untouched", async () => {
  const fixture = makeFixture();
  const candidateRoot = await acquireFixture(fixture);
  const siblingRoot = join(fixture.outputRoot, "older-local-hub-cache-candidate");
  mkdirSync(siblingRoot);
  writeFileSync(join(siblingRoot, "marker"), "must remain unread and unchanged");
  const siblingBefore = readFileSync(join(siblingRoot, "marker"));
  const tuplePath = writeTuple(fixture, stagedTuple(fixture));

  await bindJourneyReleaseCandidate({
    contractPath,
    tuplePath,
    candidateRoot,
    orchestrator: "COMPOSE",
  });

  assert.deepEqual(readFileSync(join(siblingRoot, "marker")), siblingBefore);
  assert.deepEqual(readdirSync(fixture.outputRoot).sort(), [
    fixture.handoff.handoffSha256,
    "older-local-hub-cache-candidate",
  ].sort());
});

test("binding CLI emits exact canonical success or sanitized typed failure", async () => {
  const fixture = makeFixture();
  const candidateRoot = await acquireFixture(fixture);
  const tuple = stagedTuple(fixture);
  const tuplePath = writeTuple(fixture, tuple);
  const expected = {
    schemaVersion: "JOURNEY_RELEASE_CANDIDATE_BINDING_V1",
    artifactKind: "journey-release-candidate-binding",
    orchestrator: "KUBERNETES",
    tupleSha256: tuple.tupleSha256,
    deploymentRevision: tuple.deploymentRevision,
    environmentIdentity: tuple.environmentIdentity,
    handoffSha256: fixture.handoff.handoffSha256,
    serverRouteBundleDigest:
      fixture.handoff.platformRelease.serverRouteBundleDigest,
  };
  const success = spawnSync(process.execPath, [
    bindingScriptPath,
    "--candidate",
    candidateRoot,
    "--orchestrator",
    "KUBERNETES",
    "--contract",
    contractPath,
    "--tuple",
    tuplePath,
  ], { encoding: "utf8", timeout: 5_000 });
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stdout, `${JSON.stringify(expected)}\n`);
  assert.equal(success.stderr, "");

  const suppliedSecret = "secret-value-that-must-not-appear";
  const failure = spawnSync(process.execPath, [
    bindingScriptPath,
    "--contract",
    contractPath,
    "--tuple",
    tuplePath,
    "--candidate",
    candidateRoot,
    "--orchestrator",
    suppliedSecret,
  ], { encoding: "utf8", timeout: 5_000 });
  assert.equal(failure.status, 2);
  assert.equal(failure.stdout, "");
  assert.match(failure.stderr, /^CANDIDATE_BINDING_USAGE [^\n]+\n$/);
  assert.equal(failure.stderr.includes(suppliedSecret), false);
  assert.equal(failure.stderr.includes(repositoryRoot), false);
});

test("binding CLI executes through a symlinked entrypoint", async () => {
  const fixture = makeFixture();
  const candidateRoot = await acquireFixture(fixture);
  const tuple = stagedTuple(fixture);
  const tuplePath = writeTuple(fixture, tuple);
  const linkedTools = join(fixture.root, "linked-tools");
  mkdirSync(linkedTools);
  const linkedScript = join(linkedTools, "bind-journey-release-candidate.mjs");
  symlinkSync(bindingScriptPath, linkedScript);
  symlinkSync(
    join(repositoryRoot, "tools/platform/acquire-server-route-bundle.mjs"),
    join(linkedTools, "acquire-server-route-bundle.mjs"),
  );
  const expected = {
    schemaVersion: "JOURNEY_RELEASE_CANDIDATE_BINDING_V1",
    artifactKind: "journey-release-candidate-binding",
    orchestrator: "COMPOSE",
    tupleSha256: tuple.tupleSha256,
    deploymentRevision: tuple.deploymentRevision,
    environmentIdentity: tuple.environmentIdentity,
    handoffSha256: fixture.handoff.handoffSha256,
    serverRouteBundleDigest:
      fixture.handoff.platformRelease.serverRouteBundleDigest,
  };

  for (const nodeOptions of [[], ["--preserve-symlinks-main"]]) {
    const result = spawnSync(process.execPath, [
      ...nodeOptions,
      linkedScript,
      "--contract",
      contractPath,
      "--tuple",
      tuplePath,
      "--candidate",
      candidateRoot,
      "--orchestrator",
      "COMPOSE",
    ], { encoding: "utf8", timeout: 5_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
    assert.equal(result.stderr, "");
  }
});

test("Platform CI runs the exact acquisition test once in jobs.platform", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  assert.equal(workflow.split(focusedCommand).length - 1, 1);
  const jobsIndex = workflow.indexOf("jobs:\n");
  const platformJob = workflow
    .slice(jobsIndex + "jobs:\n".length)
    .match(/^  platform:\n(?<block>(?:^(?:    .*|)\n?)*)/m);
  assert.notEqual(platformJob, null);
  assert.match(platformJob.groups.block, new RegExp(`^          ${focusedCommand}$`, "m"));
});

function makeFixture({ largePayloadSize = 0 } = {}) {
  const root = makeTemporaryRoot();
  const outputRoot = join(root, "output");
  mkdirSync(outputRoot);
  const sourceSnapshotSetHash = "2".repeat(64);
  const objects = new Map([
    ["compatibility.json", Buffer.from(canonicalJson({ backendMax: 3, backendMin: 3 }))],
    ["manifest.signing-input.json", Buffer.from(canonicalJson({ signed: "input" }))],
    ["payload/accessibility.sqlite.zst", Buffer.from("accessibility")],
    ["payload/fare.sqlite.zst", Buffer.from("fare")],
    ["payload/timetable.sqlite.zst", Buffer.from("timetable")],
    [
      "payload/topology.sqlite.zst",
      largePayloadSize > 0
        ? Buffer.alloc(largePayloadSize, 0x74)
        : Buffer.from("topology"),
    ],
    ["provenance.json", Buffer.from(canonicalJson({ sourceSnapshotSetHash }))],
  ]);
  const componentDigests = {
    accessibility: sha(objects.get("payload/accessibility.sqlite.zst")),
    fare: sha(objects.get("payload/fare.sqlite.zst")),
    timetable: sha(objects.get("payload/timetable.sqlite.zst")),
    topology: sha(objects.get("payload/topology.sqlite.zst")),
  };
  const payloadInventory = Object.keys(componentDigests)
    .map((component) => {
      const path = `payload/${component}.sqlite.zst`;
      return {
        path,
        sizeBytes: objects.get(path).length,
        sha256: componentDigests[component],
      };
    })
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
  const payloadSha256 = sha(Buffer.from(canonicalJson(payloadInventory)));
  const manifest = {
    manifestVersion: 1,
    artifactKind: "server-route-bundle",
    bundleId: "bundle-current",
    releaseSequence: 7,
    stationSetSha256: "3".repeat(64),
    payloadSha256,
    topologySha256: componentDigests.topology,
    timetableSha256: componentDigests.timetable,
    accessibilitySha256: componentDigests.accessibility,
    fareSha256: componentDigests.fare,
    provenanceSha256: sha(objects.get("provenance.json")),
    compatibilitySha256: sha(objects.get("compatibility.json")),
    serviceTimezone: "Asia/Seoul",
    activeFrom: "2026-08-11T09:00:00.000+09:00",
    freshUntil: "2026-08-18T09:00:00.000+09:00",
    schemaCompatibility: { backendMin: 3, backendMax: 3 },
    keyId: "production-v1",
    signature: {
      algorithm: "rsa-sha256-server-route-bundle-v1",
      value: "fixture-signature",
    },
  };
  objects.set("manifest.json", Buffer.from(canonicalJson(manifest)));

  const objectPrefix = `server-route-bundles/v1/${"4".repeat(64)}/`;
  const receiptPayload = {
    schemaVersion: 1,
    artifactKind: "server-route-bundle-publication-receipt",
    repository: {
      name: "AquilaXk/easysubway-data",
      gitSha: "2b1390c1c764fde10b9da8ca8015a9252e5342fb",
    },
    candidate: {
      bundleId: manifest.bundleId,
      releaseSequence: manifest.releaseSequence,
      stationSetSha256: manifest.stationSetSha256,
      sourceSnapshotSetHash,
      signingInputSha256: sha(objects.get("manifest.signing-input.json")),
      signedManifestRawSha256: sha(objects.get("manifest.json")),
      payloadRootSha256: manifest.payloadSha256,
      componentInventorySha256: manifest.payloadSha256,
      componentDigests,
      activeFrom: manifest.activeFrom,
      freshUntil: manifest.freshUntil,
      keyId: manifest.keyId,
      prePublicationFinalSha256: "5".repeat(64),
    },
    locator: {
      publicBaseUrl:
        "https://objectstorage.ap-seoul-1.oraclecloud.com/n/namespace/b/bucket/o",
      objectPrefix,
    },
    objects: objectPaths.map((path) => ({
      path,
      objectKey: `${objectPrefix}${path}`,
      sizeBytes: objects.get(path).length,
      sha256: sha(objects.get(path)),
    })),
  };
  const receipt = {
    ...receiptPayload,
    receiptSha256: sha(Buffer.from(canonicalJson(receiptPayload))),
  };
  const handoffPayload = {
    schemaVersion: 1,
    artifactKind: "server-route-bundle-consumer-handoff",
    manifest,
    sourceSnapshotSetHash,
    publicationReceipt: receipt,
    release: {
      result: "GO",
      finalSha256: "6".repeat(64),
      finalRawSha256: "7".repeat(64),
      publicationReceiptSha256: receipt.receiptSha256,
      publicationReceiptRawSha256: sha(Buffer.from(canonicalJson(receipt))),
      promotionEvidenceSha256: "8".repeat(64),
    },
    backendAdmission: {
      manifestSha256: sha(objects.get("manifest.json")),
      finalEvidenceReference: `sha256:${"7".repeat(64)}`,
      promotionEvidenceReference: `sha256:${"8".repeat(64)}`,
      immutablePublicationReceiptIdentity: `sha256:${sha(Buffer.from(canonicalJson(receipt)))}`,
    },
    platformRelease: {
      serverRouteBundleDigest: `sha256:${sha(objects.get("manifest.json"))}`,
    },
  };
  const handoff = {
    ...handoffPayload,
    handoffSha256: sha(Buffer.from(canonicalJson(handoffPayload))),
  };
  const handoffPath = join(root, "handoff.json");
  writeFileSync(handoffPath, canonicalJson(handoff));
  return { root, outputRoot, handoffPath, handoff, objects };
}

function rebindHandoff(handoff) {
  const receiptPayload = structuredClone(handoff.publicationReceipt);
  delete receiptPayload.receiptSha256;
  handoff.publicationReceipt.receiptSha256 = sha(
    Buffer.from(canonicalJson(receiptPayload)),
  );
  handoff.release.publicationReceiptSha256 =
    handoff.publicationReceipt.receiptSha256;
  handoff.release.publicationReceiptRawSha256 = sha(
    Buffer.from(canonicalJson(handoff.publicationReceipt)),
  );
  handoff.backendAdmission.immutablePublicationReceiptIdentity =
    `sha256:${handoff.release.publicationReceiptRawSha256}`;
  const payload = structuredClone(handoff);
  delete payload.handoffSha256;
  handoff.handoffSha256 = sha(Buffer.from(canonicalJson(payload)));
}

function rebindManifestHandoff(handoff) {
  const manifestBytes = Buffer.from(canonicalJson(handoff.manifest));
  const manifestSha256 = sha(manifestBytes);
  const manifestEntry = handoff.publicationReceipt.objects.find(
    (entry) => entry.path === "manifest.json",
  );
  manifestEntry.sizeBytes = manifestBytes.length;
  manifestEntry.sha256 = manifestSha256;
  handoff.publicationReceipt.candidate.signedManifestRawSha256 = manifestSha256;
  handoff.backendAdmission.manifestSha256 = manifestSha256;
  handoff.platformRelease.serverRouteBundleDigest = `sha256:${manifestSha256}`;
  rebindHandoff(handoff);
}

function successfulTransport(objects, calls = []) {
  return async (url, entry) => {
    calls.push(url);
    const bytes = objects.get(entry.path);
    return response(200, { "content-length": String(bytes.length) }, bytes);
  };
}

async function acquireFixture(fixture) {
  await acquireServerRouteBundle({
    contractPath,
    handoffPath: fixture.handoffPath,
    outputRoot: fixture.outputRoot,
    fetchObject: successfulTransport(fixture.objects),
  });
  return join(fixture.outputRoot, fixture.handoff.handoffSha256);
}

function stagedTuple(fixture, overrides = {}) {
  const identity = {
    backendImageDigest: `sha256:${"a".repeat(64)}`,
    backendConfigDigest: `sha256:${"b".repeat(64)}`,
    journeyContractDigest: `sha256:${"c".repeat(64)}`,
    serverRouteBundleDigest:
      fixture.handoff.platformRelease.serverRouteBundleDigest,
    deploymentRevision: "d".repeat(40),
    environmentIdentity: "production",
    ...overrides,
  };
  const identityBytes = `${[
    identity.backendImageDigest,
    identity.backendConfigDigest,
    identity.journeyContractDigest,
    identity.serverRouteBundleDigest,
    identity.deploymentRevision,
    identity.environmentIdentity,
  ].join("\n")}\n`;
  return {
    schemaVersion: "JOURNEY_RELEASE_TUPLE_V1",
    artifactKind: "journey-release-tuple",
    ...identity,
    tupleSha256: `sha256:${sha(identityBytes)}`,
  };
}

function canonicalTuple(tuple) {
  return `${JSON.stringify(tuple, null, 2)}\n`;
}

function writeTuple(fixture, tuple, bytes = canonicalTuple(tuple), name = "tuple.json") {
  const path = join(fixture.root, name);
  writeFileSync(path, bytes);
  return path;
}

function fingerprintCandidate(candidateRoot) {
  return {
    root: readdirSync(candidateRoot).sort(),
    objects: readdirSync(join(candidateRoot, "objects")).sort(),
    payload: readdirSync(join(candidateRoot, "objects", "payload")).sort(),
    handoff: readFileSync(join(candidateRoot, "handoff.json")).toString("base64"),
    files: Object.fromEntries(
      objectPaths.map((relativePath) => [
        relativePath,
        readFileSync(join(candidateRoot, "objects", relativePath)).toString("base64"),
      ]),
    ),
  };
}

function response(statusCode, headers, body) {
  return { statusCode, headers, body };
}

async function* interruptedBody() {
  yield Buffer.from("partial");
  throw new Error("transport interrupted with sensitive details");
}

function trackedBody(bytes) {
  let calls = 0;
  return {
    body: {
      destroy: () => {
        calls += 1;
      },
      async *[Symbol.asyncIterator]() {
        yield bytes;
      },
    },
    destroyCalls: () => calls,
  };
}

function errorWithCode(code) {
  return (error) => {
    assert.equal(error instanceof AcquisitionError, true);
    assert.equal(error.code, code);
    return true;
  };
}

function candidateBindingError(code) {
  return (error) => {
    assert.equal(error instanceof CandidateBindingError, true);
    assert.equal(error.code, code);
    return true;
  };
}

function createFifo(path) {
  const result = spawnSync("mkfifo", [path], { encoding: "utf8", timeout: 5_000 });
  assert.equal(result.status, 0, result.stderr);
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeTemporaryRoot() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "platform-bundle-acquisition-test-")),
  );
  temporaryRoots.push(root);
  return root;
}
