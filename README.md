# EasySubway Platform

EasySubway가 예측 가능하게 배포되고, 상태를 확인하며, 필요한 데이터를 복구할 수 있도록 운영 기반을 만듭니다.

## Platform이 책임지는 일

- 검증된 backend 이미지의 **immutable digest**를 소비하는 일관된 배포
- standby readiness 확인과 fail-closed 전환·복구 guardrail을 통한 안전한 전환
- 메트릭·로그·알림을 연결한 상태 관측과 장애 신호 확인
- PostgreSQL, 원천 데이터, 시설 제보 사진의 백업과 복구 리허설
- 서비스 실행 환경과 배포 경로의 상태 유지

## 현재 범위

현재 Platform은 backend 이미지 digest를 배포 단위로 운영합니다. 배포 전후의 상태 확인과 관측, 백업·복구 검증을 함께 다루며, 이상 신호가 있으면 배포를 계속 진행하지 않도록 설계되어 있습니다.

## 문의

Platform 운영 관련 문의나 개선 제안은 [aquila@aquilaxk.site](mailto:aquila@aquilaxk.site)로 남겨주세요.
