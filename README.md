# EasySubway Platform

### The operational foundation that keeps EasySubway deployable, verifiable, and resilient.

EasySubway Platform manages single-tenant container orchestration, deployment workflows, and disaster recovery for production services.

<br>

[ English ] | [ 🇰🇷 한국어 ](./README.ko.md)

<br>

## What Platform does

- **K3s deployment pipeline**: Deploys immutable container image digests to the ARM64 host without relying on floating tags.
- **Readiness checks**: Checks database connectivity, secret bindings, and service readiness before directing live traffic.
- **Traffic cutover**: Switches host Nginx reverse proxy routes to active NodePort services and drains retired workloads cleanly.
- **Deterministic halts**: Stops deployment immediately when required runtime configuration or target state is missing or invalid, preventing broken live traffic.
- **Observability and backups**: Connects Prometheus metrics, Alertmanager notifications, and backups for host databases and object storage.

## Current scope

Platform runs the production Journey V3 deployment and runtime infrastructure on K3s, delivering pinned backend container images, data pack bundles, and host routing configurations.

Contact: [aquila@aquilaxk.site](mailto:aquila@aquilaxk.site)
