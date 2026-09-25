# EasySubway Platform

### The operational foundation that keeps EasySubway deployable, verifiable, and resilient.

EasySubway Platform manages single-tenant container orchestration, deployment workflows, and disaster recovery for production services.

<br>

[ English ] | [ 🇰🇷 한국어 ](./README.ko.md)

<br>

## What Platform does

- **K3s deployment pipeline**: Deploys verified, immutable container image digests to our ARM64 host without using floating tags.
- **Pre-switch verification**: Validates database connectivity, configuration secrets, and readiness tokens before directing traffic.
- **Clean traffic cutover**: Switches host Nginx reverse proxy routes to active NodePort services and safely drains retired workloads.
- **Fail-closed guarantees**: Any unexpected configuration or contract mismatch stops deployment immediately, preventing corrupt runtime state.
- **Observability and backups**: Connects Prometheus metrics, Alertmanager notifications, and scheduled backups for host databases and object storage.

## Current scope

Platform currently operates the production Journey V3 deployment pipeline running on K3s. Image builds, candidate data packs, and host service configurations are strictly verified before live traffic is connected.

Contact: [aquila@aquilaxk.site](mailto:aquila@aquilaxk.site)
