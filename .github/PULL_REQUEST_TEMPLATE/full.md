<!-- High-risk IaC, environment, security, deployment, activation, traffic, recovery or release changes. -->

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
