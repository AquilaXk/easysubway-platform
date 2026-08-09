## 관련 이슈

<!-- 단일 완결 PR은 close #N, 스택 중간/umbrella 소속 PR은 Refs #N. 타 레포 이슈는 AquilaXk/easysubway#N 형태로 명기. -->

close #

## 작업 배경

-

## 작업 내용

-

## 검증

- 실행한 명령과 결과:

## 검증 증거

배포, 롤백·standby promotion, 백업·복구, 관측성(alert·dashboard), 수동 운영 확인이 필요한 항목은 리뷰어와 CI가 접근할 수 있는 증거로 적습니다 — PR 첨부 파일, CI artifact, 저장소에 커밋된 파일, 또는 접근 가능한 링크. 로컬 evidence 경로는 보조 정보로만 덧붙이며 단독으로는 증거가 되지 않습니다. 증거가 필요 없는 항목은 사유를 적습니다.

| 항목 | 대상 환경 | 확인 방법 | 증거 | 결과 |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## Operational impact

- [ ] no operational change
- [ ] deploy path change
- [ ] rollback / standby promotion change
- [ ] backup·restore procedure change
- [ ] observability (metric/log/alert/dashboard) change
- [ ] auth·접근 제어(ingress·관측 스택 인증) 변경
- [ ] infra provisioning (Terraform) change
- [ ] secret·env allowlist change
- [ ] contract pin change
- [ ] CI/CD workflow change (.github/workflows/**)

## Contract pin gate impact

- [ ] immutable Journey release tuple·release contract(`contracts/release/**`) 영향 없음
- [ ] immutable Journey release tuple의 identity digest와 tuple SHA256 검증을 통과했다.
- [ ] hub가 발행하지 않은 contract를 platform 쪽에서 추가하거나 변형하지 않는다.

## Deploy·recovery readiness impact

- [ ] 배포·복구 guardrail 영향 없음
- [ ] standby readiness 확인, fail-closed 전환, 롤백 경로를 실측으로 확인했다.
- [ ] 백업·복구 리허설(`tools/ops/postgres-restore-rehearsal.sh` 등) 결과를 갱신했다.

### Deployment unit decision

- backend image digest:
- staged contract bundle:
- compose/infra revision:
- alert·dashboard revision:

## 리뷰어 메모

- 리뷰어가 먼저 봐야 할 지점:

## 리스크

-

## 체크리스트

- [ ] PR 본문은 이 템플릿 섹션을 삭제하지 않고 모두 채웠다.
- [ ] CI 결과를 확인했다.
- [ ] CodeRabbit 리뷰를 확인했다.
- [ ] GitHub PR Review 객체가 있는지 확인했다. CodeRabbit status check만으로는 리뷰 완료로 보지 않는다.
- [ ] CodeRabbit 실행이 불가능하거나 PR Review 객체가 없으면 폴백 리뷰를 단일 PR review로 게시했다.
- [ ] 배포 영향이 있는 경우 CD Preflight 상태를 확인했다.
