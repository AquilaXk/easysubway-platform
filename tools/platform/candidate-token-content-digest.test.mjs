import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { k3sCandidateInputFixture } from "./k3s-candidate-input-fixture.mjs";

// Issue #228: candidate token(=ConfigMap·Secret·Deployment·candidate Service 이름)은 렌더된 candidate 내용이
// 달라지면 반드시 달라져야 한다. 같은 이름에 다른 내용을 apply하면 immutable ConfigMap이 거부되거나
// 기존 Deployment가 바뀐다.
const root = new URL("../..", import.meta.url);
const rendererSource = new URL("tools/platform/render-journey-kubernetes-candidate.mjs", root);
const observabilityContract = new URL("contracts/release/platform-k3s-observability-contract.json", root);
const digest = (character) => `sha256:${character.repeat(64)}`;

function input(overrides = {}) {
  return k3sCandidateInputFixture({ candidateGeneration: 1, trafficGeneration: 37125930222, ...overrides });
}

// 렌더러 사본을 저장소와 같은 상대 배치(tools/platform, contracts/release)로 만들어, 입력은 같고 렌더러
// 소스만 다른 상황을 재현한다.
function render(value, { transformSource = (source) => source } = {}) {
  const temporary = mkdtempSync(join(tmpdir(), "platform-k3s-token-"));
  try {
    mkdirSync(join(temporary, "tools/platform"), { recursive: true });
    mkdirSync(join(temporary, "contracts/release"), { recursive: true });
    const source = readFileSync(rendererSource, "utf8");
    const transformed = transformSource(source);
    if (transformed === undefined) throw new Error("renderer transform failed");
    writeFileSync(join(temporary, "tools/platform/render.mjs"), transformed);
    copyFileSync(observabilityContract, join(temporary, "contracts/release/platform-k3s-observability-contract.json"));
    const inputPath = join(temporary, "input.json");
    writeFileSync(inputPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    const result = spawnSync(process.execPath, [join(temporary, "tools/platform/render.mjs"), "--input", inputPath], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function candidateNames(rendered) {
  const deployment = rendered.candidateObjects.find(({ kind }) => kind === "Deployment");
  const candidateService = rendered.candidateObjects.find(({ kind, metadata }) =>
    kind === "Service" && metadata.name.startsWith("journey-candidate-"));
  return {
    token: rendered.releaseIdentity.candidateToken,
    configMap: rendered.configPlan.name,
    secret: rendered.secretPlan.name,
    deployment: deployment.metadata.name,
    candidateService: candidateService.metadata.name,
  };
}

function assertAllNamesDiffer(left, right) {
  for (const key of Object.keys(left)) {
    assert.notEqual(left[key], right[key], `${key} must change when candidate content changes`);
  }
}

test("same input rendered by a renderer with a different Deployment spec gets new candidate names", () => {
  const value = input();
  const current = render(value);
  const changed = render(value, {
    transformSource: (source) => {
      const target = '{ name: "logs", emptyDir: { sizeLimit: "256Mi" } }';
      if (!source.includes(target)) return undefined;
      return source.replace(target, '{ name: "logs", emptyDir: { sizeLimit: "512Mi" } }');
    },
  });
  const currentDeployment = current.candidateObjects.find(({ kind }) => kind === "Deployment");
  const changedDeployment = changed.candidateObjects.find(({ kind }) => kind === "Deployment");
  assert.notDeepEqual(currentDeployment.spec, changedDeployment.spec);
  assertAllNamesDiffer(candidateNames(current), candidateNames(changed));
});

// 리뷰 F2: digest 입력(ConfigMap data, candidate Service)을 각각 따로 고정한다. trafficGeneration과 입력은
// 그대로 두고 렌더러 소스에서 한 객체만 바꿔, 다른 변화가 섞이지 않게 한다.
function withoutToken(rendered, kind) {
  const token = rendered.releaseIdentity.candidateToken;
  const pick = {
    configMap: rendered.configPlan.overrides,
    deployment: rendered.candidateObjects.find((object) => object.kind === "Deployment"),
    candidateService: rendered.candidateObjects.find((object) =>
      object.kind === "Service" && object.metadata.name.startsWith("journey-candidate-")),
  }[kind];
  return JSON.parse(JSON.stringify(pick).replaceAll(token, "TOKEN"));
}

function renderReplacing(target, replacement) {
  return render(input(), {
    transformSource: (source) => (source.split(target).length === 2 ? source.replace(target, replacement) : undefined),
  });
}

test("a ConfigMap-only content change gets new candidate names", () => {
  const current = render(input());
  const changed = renderReplacing('EASYSUBWAY_PUSH_DELIVERY_ENABLED: "false"', 'EASYSUBWAY_PUSH_DELIVERY_ENABLED: "true"');
  assert.notDeepEqual(withoutToken(current, "configMap"), withoutToken(changed, "configMap"));
  assert.deepEqual(withoutToken(current, "deployment"), withoutToken(changed, "deployment"));
  assert.deepEqual(withoutToken(current, "candidateService"), withoutToken(changed, "candidateService"));
  assertAllNamesDiffer(candidateNames(current), candidateNames(changed));
});

test("a candidate-Service-only content change gets new candidate names", () => {
  const current = render(input());
  const changed = renderReplacing('      type: "ClusterIP",\n', '      type: "ClusterIP",\n      sessionAffinity: "ClientIP",\n');
  assert.notDeepEqual(withoutToken(current, "candidateService"), withoutToken(changed, "candidateService"));
  assert.deepEqual(withoutToken(current, "configMap"), withoutToken(changed, "configMap"));
  assert.deepEqual(withoutToken(current, "deployment"), withoutToken(changed, "deployment"));
  assertAllNamesDiffer(candidateNames(current), candidateNames(changed));
});

test("same tuple with a different traffic generation (ConfigMap data) gets new candidate names", () => {
  const first = render(input({ trafficGeneration: 37125930222 }));
  const second = render(input({ trafficGeneration: 37129430478 }));
  assert.notEqual(
    first.configPlan.overrides.EASYSUBWAY_JOURNEY_V3_READINESS_TRAFFIC_GENERATION,
    second.configPlan.overrides.EASYSUBWAY_JOURNEY_V3_READINESS_TRAFFIC_GENERATION,
  );
  assertAllNamesDiffer(candidateNames(first), candidateNames(second));
});

test("different secret identity gets new candidate names", () => {
  assertAllNamesDiffer(
    candidateNames(render(input({ secretIdentity: digest("8") }))),
    candidateNames(render(input({ secretIdentity: digest("9") }))),
  );
});

test("identical input and renderer keep identical names and output", () => {
  const first = render(input());
  const second = render(input());
  assert.deepEqual(first, second);
  assert.match(first.releaseIdentity.candidateToken, /^[a-f0-9]{20}$/);
  assert.equal(first.configPlan.overrides.EASYSUBWAY_JOURNEY_V3_READINESS_INSTANCE_ID, candidateNames(first).deployment);
});

test("CI runs this contract exactly once", () => {
  const ci = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8");
  assert.equal(ci.split("node --test tools/platform/candidate-token-content-digest.test.mjs").length - 1, 1);
});
