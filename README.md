# EasySubway Platform

EasySubway Platform keeps production releases predictable, observable, and easy to verify.

## What Platform takes care of

- Deploying verified Backend and Data releases to Kubernetes/K3s with immutable identities
- Checking startup, readiness, and Journey canaries before moving traffic
- Running a public smoke check after activation
- Connecting metrics, logs, and alerts so service health is easy to follow
- Backing up and restoring PostgreSQL, source data, and facility-report photos
- Stopping with a typed failure when any required input or check fails, with no legacy, stale-release, local, or Compose fallback

## Final scope

Platform runs the approved Journey release on K3s from verified, source-free artifacts. A candidate receives production traffic only after its release identity, readiness, and no-fallback behavior have all been proven. The active service is then checked again through the public edge, and every activation ends with an immutable success or failure receipt.

## Contact

For Platform questions or suggestions, email [aquila@aquilaxk.site](mailto:aquila@aquilaxk.site).
