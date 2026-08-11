<!-- A등급: high-risk IaC, environment, security, deployment, activation, traffic, recovery, release, CI/CD 변경. -->

## Related issue

Related #

## Summary

- Problem:
- Outcome:

## Changes

-

## Scope

### Included

-

### Excluded

-

### Ownership / dependencies

- Accountable owner or plan:
- Required predecessor output:
- Concurrent work overlap: None

## Contract & Compatibility

- Deployment / environment / state contract:
- Immutable release identity:
- Backward compatibility:
- Migration or cutover:

## Operational impact

- [ ] no operational change
- [ ] deploy / rollback / standby promotion change
- [ ] backup·restore or observability change
- [ ] auth·접근 제어 or secret·env allowlist change
- [ ] Terraform or CI/CD workflow change

## Contract pin gate impact

- [ ] immutable Journey release tuple·release contract 영향 없음
- [ ] identity digest와 tuple SHA256 검증을 통과했습니다.
- [ ] hub가 발행하지 않은 contract를 추가하거나 변형하지 않습니다.

## Deploy·recovery readiness impact

- [ ] 배포·복구 guardrail 영향 없음
- [ ] standby readiness, fail-closed 전환, rollback 경로를 확인했습니다.
- [ ] backup·restore rehearsal이 필요하면 결과를 갱신했습니다.

### Deployment unit decision

- backend image digest:
- staged contract bundle:
- compose / infra revision:
- alert / dashboard revision:

## Verification

| Check | Result / Evidence |
| --- | --- |
| Focused RED → GREEN | |
| Affected integration | |
| Required CI | |
| Deploy / activation / traffic | Not required — reason: |
| Security / DR / operations | Not applicable — reason: |

## Not run

- Check: None
- Reason:
- Rerun owner / condition:

## Risk

- Level: High
- Main risk:
- Failure behavior:
- Candidate / active / traffic / environment mutation on failure:
- Fallback or degraded-success path introduced: No

## Rollout / Recovery

- Rollout or activation:
- Monitoring / success signal:
- Rollback or recovery:
- State / config / deployment compatibility after rollback:

## Review focus

-

## Checklist

- [ ] 이슈 범위와 실제 diff가 일치합니다.
- [ ] 관련 없는 변경이나 다른 owner의 surface를 포함하지 않았습니다.
- [ ] 위험에 필요한 검증과 미실행 사유를 기록했습니다.
- [ ] 실패·호환성·activation·recovery 동작이 명확합니다.
- [ ] current failure를 previous/alternate/orchestrator 경로의 성공으로 바꾸지 않습니다.
- [ ] GitHub PR Review 객체가 있는지 확인했습니다. CodeRabbit status check만으로는 리뷰 완료로 보지 않습니다.
- [ ] CodeRabbit Review 객체가 없으면 지원되는 Codex CLI 폴백 Review를 단일 GitHub PR Review로 게시했습니다.
- [ ] 배포 영향이 있는 경우 CD Preflight 상태를 확인했습니다.
