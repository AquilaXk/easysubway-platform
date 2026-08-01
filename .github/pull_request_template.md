<!--
작업 등급에 맞는 템플릿을 사용하세요.
- A등급(운영 위험: deploy, rollback·standby promotion, backup·restore, observability(metric/log/alert/dashboard), secret·env allowlist, infra provisioning(Terraform), contract pin(contracts.lock.json), CI/CD workflow 변경): .github/PULL_REQUEST_TEMPLATE/full.md 내용으로 교체합니다.
- B/C등급(일반 코드 변경·낮은 위험 maintenance): .github/PULL_REQUEST_TEMPLATE/short.md 내용으로 교체합니다(아래 기본형과 동일).
- 웹 UI에서는 ?template=full.md 또는 ?template=short.md 쿼리를 쓸 수 있습니다. gh CLI는 template 쿼리를 지원하지 않으므로 템플릿 파일 내용을 body로 직접 채웁니다.
- 리뷰·automerge 게이트는 등급과 무관하게 모든 PR 공통입니다.
-->

## 관련 이슈

<!-- 단일 PR은 `Closes #N`, 스택 중간/umbrella는 `Refs #N`, C등급 issue 생략 시 `이슈 없음(C등급)` 명기. 빈 칸 금지. -->

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

- [ ] 작업 등급에 맞는 템플릿을 사용했다.
- [ ] CI 결과를 확인했다.
- [ ] GitHub PR Review 객체가 있는지 확인했다. CodeRabbit status check만으로는 리뷰 완료로 보지 않는다.
