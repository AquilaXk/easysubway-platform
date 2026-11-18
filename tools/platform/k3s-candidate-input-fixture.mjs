import { createHash } from "node:crypto";

// 테스트 전용: 렌더러가 받는 PLATFORM_K3S_CANDIDATE_INPUT_V1 입력의 결정적 fixture를 만든다.
const digest = (character) => `sha256:${character.repeat(64)}`;

export function k3sCandidateInputFixture(overrides = {}) {
  const releaseTuple = {
    schemaVersion: "JOURNEY_RELEASE_TUPLE_V1",
    artifactKind: "journey-release-tuple",
    backendImageDigest: digest("a"),
    backendConfigDigest: digest("b"),
    journeyContractDigest: digest("c"),
    serverRouteBundleDigest: digest("d"),
    deploymentRevision: "e".repeat(40),
    environmentIdentity: "production",
  };
  const identity = Object.values(releaseTuple).slice(2);
  return {
    schemaVersion: "PLATFORM_K3S_CANDIDATE_INPUT_V1",
    artifactKind: "platform-k3s-candidate-input",
    releaseTuple,
    tupleSha256: `sha256:${createHash("sha256").update(`${identity.join("\n")}\n`, "utf8").digest("hex")}`,
    candidateGeneration: 7,
    trafficGeneration: 12,
    nodeInternalIp: "10.0.0.12",
    postgresPort: 15432,
    objectStoragePort: 9000,
    secretIdentity: digest("9"),
    ...overrides,
  };
}
