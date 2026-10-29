# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-10-28

Publishes the ioda-outages-guide agent skill over MCP (skill://ioda-outages-guide/SKILL.md) and in the npm package, Docker image, and .mcpb bundle, and moves to mcp-ts-core 0.13.18, which stops the HTTP transport retaining memory per request under Bun and drops repo-local and framework build-only files from the bundle.

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-10-24

Adds method exclusions for outage investigations and clarifies detection boundaries, related-scope membership, and coarse signal evidence.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-10-21

Adds ioda_summarize_outages for IODA's ranked per-entity outage scores, relatedTo scopes for listing a country's regions and networks, and geoasn entities. Fixes unknown-entity status, unscoped event timeouts, and trailing-bucket freshness.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-10-21

Internet outage investigation with keyless IODA evidence.
