<div align="center">
  <h1>@cyanheads/ioda-outages-mcp-server</h1>
  <p><b>Investigate Internet outages with IODA events, alerts, and connectivity signals via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools • 1 Skill</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/ioda-outages-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/ioda-outages-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/ioda-outages-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/ioda-outages-mcp-server/releases/latest/download/ioda-outages-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=ioda-outages-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvaW9kYS1vdXRhZ2VzLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22ioda-outages-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fioda-outages-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://ioda-outages.caseyjhand.com/mcp](https://ioda-outages.caseyjhand.com/mcp)

</div>

---

## Overview

Internet outage evidence from [IODA](https://ioda.inetintel.cc.gatech.edu/), using its public v2 API. Resolve countries, regions, and autonomous systems; inspect recent detections and measurement coverage; then investigate events, alert transitions, per-entity outage rankings, and numeric signals. Runs over stdio, stateless Streamable HTTP, or the public hosted endpoint above, without an API key.

### Tools

| Tool | Description |
|:---|:---|
| `ioda_search_entities` | Resolve country, region, ASN, or geoasn names and codes |
| `ioda_get_status` | Inspect recent detection evidence and coverage across three numeric sources |
| `ioda_find_outages` | Retrieve overlapping outage events for an entity or globally |
| `ioda_summarize_outages` | Rank the entities of one type by IODA's per-window outage score |
| `ioda_get_signals` | Fetch BGP, active IPv4 /24 probing, or Merit telescope numeric series |
| `ioda_get_alerts` | Retrieve detection and recovery transitions with source baselines |

### Skills

| Skill | Description |
|:---|:---|
| `ioda-outages-guide` | Investigate Internet outages with the `ioda_*` tools — resolving places and networks to IODA codes, publication lag, signal resolution, and reading detections and rankings without over-claiming |

## Capability reference

### `ioda_search_entities` <sub>tool</sub>

- Required `entityType: country | region | asn | geoasn` (a geoasn is one ASN within a region or country); choose `query` (up to 200 UTF-16 code units after trimming) or `entityCode`, or omit both to list the type. Country codes use two letters, regions use IODA numeric codes, ASNs use decimal digits, and geoasns join an ASN and a region or country code (`40934-576`, `59962-IR`).
- Optional `relatedToType` and `relatedToCode` list `entityType` entities within one country, region, ASN, or geoasn; both or neither, `entityType` required, no `entityCode`, and a scope combines with `query`. Page this resolver to select codes for individual outage investigations.
- `limit` is 1–1,000, default 20, served at most 100; `page` starts at 0. Returns original `entities`, `pagination`, and `provenance`; a metadata match does not establish measurement coverage.

---

### `ioda_get_status` <sub>tool</sub>

- Required `entityType` (`country`, `region`, `asn`, or `geoasn`) and `entityCode`; `lookbackHours` is 1–240, default 6, served at most 24 with a notice naming the uncovered earlier window. Collects events, alerts, and `bgp`, `ping-slash24`, and `merit-nt` summaries within the returned `window`.
- `detection` is `observed`, `none_returned`, or `unknown`; source `coverage` is independently `recent`, `stale`, `no_data`, or `unknown`. `recent` means the latest completed observation ended within a 1,800-second publication allowance of the call, the same for all three sources, a server policy rather than an upstream SLA. Trailing nulls inside the allowance count as `pendingCount`, not `nullCount`.
- Each `signals` entry carries IODA's `unit` for its source (`Visible /24s`, `Up /24s`, `Unique Source IPs`); `latest`, `minimum`, and `maximum` are in that unit.
- `components` disclose partial failures and standalone-tool recovery. Event/alert pages carry continuation metadata; raw samples come from `ioda_get_signals`. All-component failure fails the call; an unknown country, region, or geoasn code fails with `entity_not_found`.

---

### `ioda_find_outages` <sub>tool</sub>

- Required `from` and `until`; optional `entityType` (`country`, `region`, `asn`, or `geoasn`), `entityCode`, and `source: bgp | ping-slash24 | merit-nt | gtr`. Omit entity filters for global scope; a code requires its type. Optional `relatedToType` and `relatedToCode` limit results to `entityType` entities within one country, region, ASN, or geoasn (both or neither, `entityType` required, no `entityCode`). `limit` is 1–1,000, default 20, served at most 100.
- Returns source `events`, `pagination`, and `provenance`. Scores retain their source meaning; starts may precede the window and an end clipped at `until` does not establish recovery.
- `includeAlerts` defaults to false; `extendWindowSeconds` is 0–12,096,000, served at most 1,209,600. Omitted, it is 1,209,600 with `entityType` and 86,400 without it, because large global extensions can time out; the applied value is echoed, and a notice discloses the global default. Global searches over multi-day windows can still time out: narrow the window or add `entityType`. Zero extension can miss long-running detections.

---

### `ioda_summarize_outages` <sub>tool</sub>

- Required `entityType`, `from`, and `until`; optional `entityCode` for one entity, or `relatedToType` and `relatedToCode` to rank `entityType` entities within one country, region, ASN, or geoasn (both or neither, no `entityCode`). `limit` is 1–1,000, default 20, served at most 100; `extendWindowSeconds` is 0–12,096,000, default 1,209,600, served at most 1,209,600. There is no `source` input.
- Returns `summaries` in IODA's order, descending `scores.overall`, with `pagination` and `provenance`. Each row carries the `entity`, `event_cnt` (IODA's count of source events before merging), and unmodified `scores`: `overall` plus one sum of event scores per `<source>.<method>` key. IODA merges overlapping events from different sources, scores each merged event as the product of its sources' scores, and sums the merged events into `overall`.
- Scores are window totals for ranking the rows of one request, not current status, and are not comparable across requests with different windows. Large type-only rankings (every region, for example) can time out; add `entityCode` or a related scope. An empty result is not an all-clear.

---

### `ioda_get_signals` <sub>tool</sub>

- Required entity pair (`entityType` may be `geoasn`), `from`, `until`, and `source: bgp | ping-slash24 | merit-nt` (`gtr` and `ucsd-nt` are not numeric sources here). `maxPoints` is 1–20,000, default 200, served at most 2,000: an upstream aggregation target, not a hard returned-sample cap.
- Returns every numeric subtype in `series`, source-specific `semantics` (measurement, IODA's `unit`, caveat), and `provenance`. An unknown country, region, or geoasn code fails with `entity_not_found`. Returned `until` is an exclusive bucket bound; alignment can extend beyond requested bounds. Coarse series carry a notice: values need not equal an unweighted mean of finer returned buckets, and non-null aggregates cannot establish complete finer-resolution coverage. Values, nulls, and units remain unchanged; status coverage stays `unknown` for coarse series.

---

### `ioda_get_alerts` <sub>tool</sub>

- Required `from` and `until`; optional entity, source, and related-scope filters match `ioda_find_outages`; a related scope is served at page 0 only, because IODA cannot continue scoped alerts. `limit` is 1–1,000, default 20, served at most 100; `extendWindowSeconds` is 0–12,096,000, default 0, served at most 1,209,600.
- Returns `alerts`, `pagination`, and `provenance`, retaining source `level`, `condition`, `value`, and `historyValue` when reported. `value` and `historyValue` are in the source unit for `bgp`, `ping-slash24`, and `merit-nt`; for `gtr` they are IODA Traffic divided by 1,000,000 and truncated. A missing transition does not establish health or rule out an event that began earlier.

---

### `ioda-outages-guide` <sub>skill</sub>

- Helps an agent investigate a shutdown or outage, check whether a place or network is degraded now, rank the worst-hit entities, and chart connectivity: where each IODA code comes from, `asn` versus `geoasn`, getting the clock from the server, publication lag, native signal resolution, and which conclusions the evidence supports
- Served over MCP as the resource `skill://ioda-outages-guide/SKILL.md` under the template `skill://{+path}`; also ships in `skills/` for plugin installs and the `.mcpb` bundle

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

IODA-specific:

- Keyless reads from a fixed HTTPS API origin; no local database or native helper.
- Historical windows use integer Unix seconds UTC: `from < until <= now`, at most 31 days. Alerts include transitions at both bounds (widened by extension); events and summaries include starts at `until`. Adjacent windows can duplicate boundary detections. Signal bounds describe aligned buckets; status echoes the requested window across components with different selection rules.
- `ignoreMethods: string[]` on events, alerts, and rankings excludes detections upstream before event construction and scoring: `source.method`, `source.*`, or `*.method`, with sources `bgp`, `ping-slash24`, `merit-nt`, and `gtr`. Case/whitespace normalize and duplicates collapse; an empty array excludes nothing. Malformed terms and `*.*` fail `invalid_arguments`; an explicit `source` plus its own `source.*` fails `invalid_ignore_methods`. Keep exclusions fixed across pages and ranking drill-downs; provider scores and order are preserved.
- Every related-scope outage response warns that membership coverage is unverified, even on short or empty pages. Page `ioda_search_entities` with the same entity type, scope, and limit, then query selected codes individually with the original window, source/exclusions, extension, and paging limit; each response supplies the concrete calls. `pagination.more` describes row pages, not scope completeness.
- Pagination is zero-based; follow `nextPage` with filters and `limit` unchanged. `more: "possible"` signals possible continuation, not a known total; restart at page 0 after changing the limit.
- Numeric inputs accept up to ten times their served cap (`limit` 100, `maxPoints` 2,000, `lookbackHours` 24, `extendWindowSeconds` 1,209,600); a larger value is served at the cap and a notice names the requested value, the served value, and the route to the rest. Minimums and values above the accepted maximum fail argument validation.
- Shared request pacing allows one in-flight request and at least two seconds between starts, with a 45-second invocation deadline. Avoid concurrent investigations.
- IODA describes macroscopic connectivity. Missing detections are not an all-clear; source scores are not universal severity, and observations cannot establish a shutdown cause or one office's connectivity.

Agent-friendly output:

- Provenance — endpoint links, fetch times, and the original Georgia Tech Research Corporation attribution accompany returned evidence; `applied` echoes effective inputs.
- Explicit uncertainty — null samples, missing fields, source coverage, and partial component failures stay distinct.
- Complete, bounded responses — `content[]` and `structuredContent` carry the same data, enrichment included. Upstream bodies cap at 2 MiB and the combined response at 96 KiB; past that, `response_too_large` names a smaller call instead of dropping records.

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http ioda-outages-mcp-server https://ioda-outages.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add ioda-outages-mcp-server -- npx -y @cyanheads/ioda-outages-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "ioda-outages-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/ioda-outages-mcp-server"]
    }
  }
}
```

IODA needs no API key or account, only outbound HTTPS to `api.ioda.inetintel.cc.gatech.edu`. For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

The server has no settings of its own. The common framework variables:

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_HOST` | HTTP bind address. | `127.0.0.1` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | MCP endpoint path. | `/mcp` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of framework overrides.

## Running the server

### Local development

Requires [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).

- **Clone and install:**

  ```sh
  git clone https://github.com/cyanheads/ioda-outages-mcp-server.git
  cd ioda-outages-mcp-server && bun install
  cp .env.example .env   # optional: no server-specific variables, framework overrides only
  ```

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker run --rm -p 3010:3010 ghcr.io/cyanheads/ioda-outages-mcp-server:latest
```

The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/ioda-outages-mcp-server`. To run it over stdio from an MCP client, use `"command": "docker"` with `"args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/ioda-outages-mcp-server:latest"]`. To build locally, `docker build -t ioda-outages-mcp-server .`; OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | Server identity, tool registration, published skill, service lifecycle |
| `skills/` | `ioda-outages-guide/SKILL.md`, the published agent skill |
| `src/mcp-server/tools/definitions/` | Six read-only tools |
| `src/mcp-server/tools/ioda-common.ts` | Shared input normalization, rendering, response budgeting |
| `src/services/ioda/` | Fixed-origin API client, schemas, pacing, status assessment |
| `tests/` | Contract, service, and formatting tests |
| `docs/design.md` | Domain contracts, design decisions, API evidence |
| `docs/tree.md` | Generated directory inventory |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules, and [`docs/design.md`](./docs/design.md) for the domain contracts. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.signal` for cancellation, and `ctx.enrich` for applied inputs and notices
- Register new tools in the `createApp()` arrays in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields, and keep both response surfaces complete

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0; see [LICENSE](./LICENSE). IODA data retains its Georgia Tech Research Corporation copyright and remains subject to the source's terms.

