<div align="center">
  <h1>@cyanheads/ioda-outages-mcp-server</h1>
  <p><b>Investigate Internet outages with IODA events, alerts, and connectivity signals via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/ioda-outages-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/ioda-outages-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/ioda-outages-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.3-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/ioda-outages-mcp-server/releases/latest/download/ioda-outages-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=ioda-outages-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvaW9kYS1vdXRhZ2VzLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22ioda-outages-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fioda-outages-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Internet outage evidence from [IODA](https://ioda.inetintel.cc.gatech.edu/), using its public v2 API. Resolve countries, regions, and autonomous systems; inspect recent detections and measurement coverage; then investigate events, alert transitions, and numeric signals. Runs over stdio or stateless Streamable HTTP without an API key.

### Tools

| Tool | Description |
|:---|:---|
| `ioda_search_entities` | Resolve country, region, or ASN names and codes |
| `ioda_get_status` | Inspect recent detection evidence and coverage across three numeric sources |
| `ioda_find_outages` | Retrieve overlapping outage events for an entity or globally |
| `ioda_get_signals` | Fetch BGP, active IPv4 /24 probing, or Merit telescope numeric series |
| `ioda_get_alerts` | Retrieve detection and recovery transitions with source baselines |

## Capability reference

### `ioda_search_entities` <sub>tool</sub>

- Required `entityType: country | region | asn`; choose `query` (up to 200 trimmed characters) or `entityCode`, or omit both to list the type. Country codes use two letters, regions use IODA numeric codes, and ASNs use decimal digits.
- Up to 100 records per page, default 20; `page` starts at 0. Returns original `entities`, `pagination`, and `provenance`; a metadata match does not establish measurement coverage.

---

### `ioda_get_status` <sub>tool</sub>

- Required `entityType` and `entityCode`; `lookbackHours` is 1–24, default 6. Collects events, alerts, and `bgp`, `ping-slash24`, and `merit-nt` summaries within the returned `window`.
- `detection` is `observed`, `none_returned`, or `unknown`; source `coverage` is independently `recent`, `stale`, `no_data`, or `unknown`. Native completed buckets count as recent within three native sampling intervals; this is a server policy, not an upstream SLA.
- `components` disclose partial failures and standalone-tool recovery. Event/alert pages carry continuation metadata; raw samples come from `ioda_get_signals`. All-component failure fails the call.

---

### `ioda_find_outages` <sub>tool</sub>

- Required `from` and `until`; optional `entityType`, `entityCode`, and `source: bgp | ping-slash24 | merit-nt | gtr`. Omit entity filters for global scope; a code requires its type. Up to 100 events per page, default 20.
- Returns source `events`, `pagination`, and `provenance`. Scores retain their source meaning; starts may precede the window and an end clipped at `until` does not establish recovery.
- `includeAlerts` defaults to false; `extendWindowSeconds` is 0–1,209,600, default 1,209,600. Zero extension can miss long-running detections.

---

### `ioda_get_signals` <sub>tool</sub>

- Required entity pair, `from`, `until`, and `source: bgp | ping-slash24 | merit-nt`. `maxPoints` is 1–2,000, default 200: an upstream aggregation target, not a hard returned-sample cap.
- Returns every numeric subtype in `series`, source-specific `semantics`, and `provenance`. `from`, `until`, `step`, `nativeStep`, and nulls preserve aligned bucket boundaries and missing observations; smaller targets lose temporal resolution.
- `gtr` and `ucsd-nt` are not supported numeric sources. Null is not zero connectivity, and coarse or future boundary buckets cannot certify current coverage.

---

### `ioda_get_alerts` <sub>tool</sub>

- Required `from` and `until`; optional entity/source filters match `ioda_find_outages`. Up to 100 transitions per page, default 20; `extendWindowSeconds` is 0–1,209,600, default 0.
- Returns `alerts`, `pagination`, and `provenance`, retaining source `level`, `condition`, `value`, and `historyValue` when reported. A missing transition does not establish health or rule out an event that began earlier.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

IODA-specific:

- Keyless reads from a fixed HTTPS API origin; no local database or native helper.
- Historical windows use integer Unix seconds UTC: `from < until <= now`, at most 31 days. Split longer investigations into adjacent windows.
- Pagination is zero-based; follow `nextPage` with filters and `limit` unchanged. `more: "possible"` signals possible continuation, not a known total; restart at page 0 after changing the limit.
- Shared request pacing allows one in-flight request and at least two seconds between starts, with a 45-second invocation deadline. Avoid concurrent investigations.
- IODA describes macroscopic connectivity. Missing detections are not an all-clear; source scores are not universal severity, and observations cannot establish a shutdown cause or one office's connectivity.

Agent-friendly output:

- Provenance — endpoint links, fetch times, and original Georgia Tech Research Corporation attribution accompany returned evidence; `applied` echoes effective inputs.
- Explicit uncertainty — null samples, missing fields, source coverage, and partial component failures stay distinct.
- Complete response surfaces — `content[]` and `structuredContent` carry the same data, including enrichment; records are never silently dropped to fit.
- Bounded responses — upstream bodies are capped at 2 MiB and the combined response at 96 KiB. `response_too_large` gives recovery: reduce page limits and restart at 0, disable `includeAlerts`, lower `maxPoints`, or split windows. For status, shorten `lookbackHours` or call the standalone tools.

## Getting started

Add one of these configurations to your MCP client. IODA requires no API key.

```json
{
  "mcpServers": {
    "ioda-outages-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/ioda-outages-mcp-server@latest"]
    }
  }
}
```

Or with npx (Node.js v24+):

```json
{
  "mcpServers": {
    "ioda-outages-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/ioda-outages-mcp-server@latest"]
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "ioda-outages-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/ioda-outages-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP from a local checkout:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Endpoint: http://127.0.0.1:3010/mcp
```

### Prerequisites

- [Bun v1.4.0+](https://bun.sh/) or Node.js v24+ for running the package; Bun for development.
- Network access to `api.ioda.inetintel.cc.gatech.edu`.

### Installation

```sh
git clone https://github.com/cyanheads/ioda-outages-mcp-server.git
cd ioda-outages-mcp-server
bun install
cp .env.example .env
bun run rebuild
```

## Configuration

There are no server-specific environment variables. Common framework settings:

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | `stdio` or `http` | `stdio` |
| `MCP_HTTP_HOST` | HTTP bind address | `127.0.0.1` |
| `MCP_HTTP_PORT` | HTTP port | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | MCP endpoint path | `/mcp` |
| `MCP_SESSION_MODE` | HTTP session posture | `stateless` |
| `MCP_AUTH_MODE` | `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Minimum logging level | `info` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

See [`.env.example`](./.env.example) for framework overrides.

## Running the server

```sh
bun run rebuild
bun run start:stdio
# Or:
bun run start:http
```

To serve HTTP in Docker:

```sh
docker run --rm -p 127.0.0.1:3010:3010 -e MCP_TRANSPORT_TYPE=http ghcr.io/cyanheads/ioda-outages-mcp-server:latest
```

## Project structure

| Path | Purpose |
|:---|:---|
| `src/index.ts` | Server identity, tool registration, service lifecycle |
| `src/mcp-server/tools/definitions/` | Five read-only tools |
| `src/mcp-server/tools/ioda-common.ts` | Shared input normalization, rendering, response budgeting |
| `src/services/ioda/` | Fixed-origin API client, schemas, pacing, status assessment |
| `tests/` | Contract, service, and formatting tests |
| `docs/design.md` | Domain contracts, design decisions, API evidence |
| `docs/tree.md` | Generated directory inventory |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for project conventions and [`docs/design.md`](./docs/design.md) for the API contract.

- Keep handlers small; framework catches thrown failures.
- Validate external records without inventing absent fields.
- Preserve all data on both client response surfaces and keep uncertainty visible.
- Register definitions in the `createApp()` arrays in `src/index.ts`.

```sh
bun run devcheck
bun run test
```

## Contributing

Issues are welcome, with the tool name, inputs, and expected behavior. Redact credentials and personal information.

## License

Apache-2.0; see [LICENSE](./LICENSE). IODA data retains its Georgia Tech Research Corporation copyright and remains subject to the source's terms.

