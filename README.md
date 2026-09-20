# EasySubway Platform

### The operational foundation that keeps EasySubway deployable, verifiable, and resilient.

EasySubway Platform manages single-tenant container orchestration, deployment workflows, and disaster recovery for production services.

<details>
<summary><b>🇰🇷 한국어 설명 보기 (Switch to Korean)</b></summary>
<br>

### 쉬운 지하철이 예측 가능하게 배포되고, 상태를 확인하며, 안전하게 동작하도록.

EasySubway가 예측 가능하게 배포되고, 상태를 확인하며, 필요한 데이터를 복구할 수 있도록 운영 기반을 만듭니다.

#### Platform이 책임지는 일
- **K3s 배포 파이프라인**: 검증된 backend 이미지의 불변 다이제스트(immutable digest)를 소비하여 ARM64 실서버에 일관되게 배포합니다.
- **사전 검증**: 트래픽을 열기 전 데이터베이스 연결, 시크릿 바인딩, readiness 토큰을 빈틈없이 확인합니다.
- **안전한 트래픽 절체**: 새 파드가 준비되면 호스트 Nginx 프록시를 대상 NodePort로 전환하고 기존 워크로드를 안전하게 정리합니다.
- **철저한 Fail-Closed**: 이상 신호나 검증 불일치가 발견되면 임의의 롤백을 시도하지 않고 즉시 멈춰 시스템의 무결성을 지킵니다.
- **관측과 백업**: Prometheus 메트릭, Alertmanager 알림, PostgreSQL 및 파일 스토리지의 주기적 백업과 복구 리허설을 관리합니다.

#### 현재 범위
현재 Platform은 K3s 기반 Journey V3 운영 파이프라인을 전담합니다. 백엔드 바이너리와 서명된 데이터팩 아카이브의 정합성을 확인한 후 트래픽을 서비스에 연결합니다.

<br>
</details>

## What Platform does

- **K3s deployment pipeline**: Deploys verified, immutable container image digests to our ARM64 host without using floating tags.
- **Pre-switch verification**: Validates database connectivity, configuration secrets, and readiness tokens before directing traffic.
- **Clean traffic cutover**: Switches host Nginx reverse proxy routes to active NodePort services and safely drains retired workloads.
- **Fail-closed guarantees**: Any unexpected configuration or contract mismatch stops deployment immediately, preventing corrupt runtime state.
- **Observability and backups**: Connects Prometheus metrics, Alertmanager notifications, and scheduled backups for host databases and object storage.

## Current scope

Platform currently operates the production Journey V3 deployment pipeline running on K3s. Image builds, candidate data packs, and host service configurations are strictly verified before live traffic is connected.

Contact: [aquila@aquilaxk.site](mailto:aquila@aquilaxk.site)
