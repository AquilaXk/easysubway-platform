<!--
A등급은 .github/PULL_REQUEST_TEMPLATE/full.md, B/C등급은 .github/PULL_REQUEST_TEMPLATE/short.md를 사용합니다.
gh CLI는 template 쿼리를 지원하지 않으므로 해당 파일 내용을 PR body로 직접 채웁니다.
리뷰·automerge 게이트는 등급과 무관하게 모든 PR 공통입니다.
-->

## Related issue

<!-- 이 PR로 이슈를 완전히 종료할 때만 Closes를 사용합니다. -->
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

## Verification

| Check | Result / Evidence |
| --- | --- |
| Focused test | |
| Required CI | |
| Deploy / activation / operations | Not required — reason: |

## Not run

<!-- 실행하지 않은 검증이 없으면 None. -->
- Check: None
- Reason:
- Rerun owner / condition:

## Risk

- Level: Low / Medium / High
- Main risk:
- Infrastructure / traffic / environment impact: None
- Failure behavior:

## Rollback / Recovery

- Rollback or recovery:
- State / config / deployment compatibility: Not applicable

## Checklist

- [ ] 이슈 범위와 실제 diff가 일치합니다.
- [ ] 관련 없는 변경을 포함하지 않았습니다.
- [ ] 필요한 검증 결과와 미실행 사유를 기록했습니다.
- [ ] 실패를 previous/alternate/orchestrator 경로의 성공으로 바꾸는 경로를 추가하지 않았습니다.
- [ ] GitHub PR Review 객체가 있는지 확인했습니다. CodeRabbit status check만으로는 리뷰 완료로 보지 않습니다.
