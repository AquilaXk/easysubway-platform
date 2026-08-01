<!-- B/C등급(일반 코드 변경·낮은 위험 maintenance) 전용. A등급(운영 위험, contract pin·CI/CD workflow 변경)은 full.md를 사용합니다. -->

## 관련 이슈

<!-- umbrella `Refs #N` 또는 `이슈 없음(C등급)` 명기. 빈 칸 금지. -->

Refs #

## 작업 내용

-

## 검증

- 실행한 명령과 결과:

## 영향

- [ ] 운영 위험 없음 (deploy/rollback/backup·restore/observability/secret·auth 아님)
- [ ] 배포 경로·실행 환경(`tools/deploy/**`, `infra/docker-compose.yml`, `infra/nginx/**`, `infra/terraform/**`) 영향 없음
- [ ] 백업·복구 절차(`tools/ops/**`) 영향 없음
- [ ] 관측성(`infra/prometheus/**`, `infra/grafana/**`, `infra/loki/**`, `infra/alloy/**`, `infra/alertmanager/**`) 영향 없음
- [ ] contract pin(`contracts.lock.json`, `contracts/**`)·CI/CD workflow 변경 없음 (있으면 full.md로 전환)

## 체크리스트

- [ ] 이 PR은 B/C등급 작업이며 full template이 필요 없다.
- [ ] CI 결과를 확인했다.
- [ ] GitHub PR Review 객체가 있는지 확인했다. CodeRabbit status check만으로는 리뷰 완료로 보지 않는다.
- [ ] CodeRabbit 실행이 불가능하거나 PR Review 객체가 없으면 폴백 리뷰를 단일 PR review로 게시했다.
