// production-deploy 환경을 쓰는 workflow별 허용 배포 행위자의 단일 출처(platform#247).
// 사람 승인이 없는 환경(ACTOR_GATE)에서 영수증 검증기와 assembler가 이 표만 쓴다.
// 각 workflow의 job `if`와 첫 step 게이트가 이 표와 같은 목록을 쓰는지는 production-deploy-actor-gates.test.mjs가 고정한다.
const OWNER = "AquilaXk";
const RELEASE_CHAIN_APP = "easysubway-release-chain[bot]";

// 영수증 검증기를 호출하는 workflow의 run 기록 path가 키다. K3s 배포만 릴리스 체인 App이 dispatch한다.
export const DEPLOY_ACTORS_BY_WORKFLOW = Object.freeze({
  ".github/workflows/data-workflow-scheduler-deploy.yml": Object.freeze([OWNER]),
  ".github/workflows/observability-config-deploy.yml": Object.freeze([OWNER]),
  ".github/workflows/origin-certificate-renew.yml": Object.freeze([OWNER]),
  ".github/workflows/production-deploy-effective-admission-receipt.yml": Object.freeze([OWNER]),
  ".github/workflows/source-free-journey-deploy.yml": Object.freeze([OWNER]),
  ".github/workflows/source-free-journey-k3s-deploy.yml": Object.freeze([OWNER, RELEASE_CHAIN_APP]),
  ".github/workflows/source-reachability-probe-deploy.yml": Object.freeze([OWNER]),
});

/** 알려진 workflow path면 그 workflow의 허용 행위자 사본을, 아니면 undefined를 돌려준다. */
export function allowedActorsFor(workflowPath) {
  return typeof workflowPath === "string" && Object.hasOwn(DEPLOY_ACTORS_BY_WORKFLOW, workflowPath)
    ? [...DEPLOY_ACTORS_BY_WORKFLOW[workflowPath]]
    : undefined;
}
