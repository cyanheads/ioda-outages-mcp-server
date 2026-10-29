---
name: ioda-outages-guide
description: Gates and workflows for the ioda_* tools (IODA Internet outage detection). Covers resolving countries, provinces, and networks to IODA codes, asn vs geoasn, finding the current time, publication lag, signal resolution, and reading alerts, rankings, and BGP, probing, and telescope signals without over-claiming. Use when investigating an Internet shutdown or outage, checking whether a place or network is degraded now, ranking outages, or charting connectivity.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

IODA (Georgia Tech) tracks the connectivity of a country, a province or state, an autonomous system, or one ASN's footprint inside a country or region (geoasn) from outside vantage points. Sources:

| Source | What it sees | Where you get it |
|:-------|:-------------|:-----------------|
| `bgp` | Routes to the entity's address space (Visible /24s) | signals, events, alerts, rankings |
| `ping-slash24` | IPv4 /24 blocks answering active probes (Up /24s) | signals, events, alerts, rankings |
| `merit-nt` | Unsolicited traffic reaching the Merit network telescope (Unique Source IPs) | signals, events, alerts, rankings |
| `gtr` | Google Transparency Report product traffic | events, alerts, rankings only; `ioda_get_signals` rejects it. Expect it on countries only |

Keyless. Use it for network-level questions about places and providers. It does not answer whether a website, app, or cloud service is up, and it supplies timing and measurements, not cause: who ordered a shutdown, a cable cut, a power failure, or a storm comes from news sources (for example gdelt-mcp-server).

## Identifiers

- **Country**: ISO 3166-1 alpha-2 (`GB`, not `UK`: `entityCode` `UK` lists nothing, and a `query` of `uk` substring-matches Ukraine). `query` is a case-insensitive substring of IODA's own name (`iran` finds `IR`, "Iran (Islamic Republic Of)").
- **Region** (province, state): an IODA number (Tehran is `1829`), never an ISO 3166-2 code. Names follow IODA's transliteration (`Esfahan`; `Isfahan` returns nothing), so list the country's regions with `ioda_search_entities` (entityType `region`, related to the country, limit 100) and match by name instead of guessing spellings.
- **Placeholder regions**: country region lists can include `[Invalid Region (N)]` and `Unknown Region in <country>` rows (Iran's has both; the US and Germany list only the latter). These are geolocation catch-alls, not provinces; leave them out of "which provinces" answers or label them as such.
- **ASN**: an ASN `entityCode` lookup always returns a row. IODA synthesizes unassigned ASNs (`AS4199999999` comes back with `ip_count` "0", no `org`, and empty signals rather than a failure), so a returned row does not prove IODA monitors the network. Neither field alone settles it: `AS64512` (a private-use ASN) shows `ip_count` "512" and no `org`, yet has `bgp` signals. Fetch a short `bgp` series before building on an ASN with no `org`.
- **geoasn**: `<asn>-<CC>` or `<asn>-<regionCode>` (`60627-IR`), listed with entityType `geoasn` related to the country. A geoasn IODA lacks (`15169-IR`) fails `entity_not_found` on signals.

### asn or geoasn

An `asn` entity is the network's whole address space wherever it is announced; a `geoasn` is the slice geolocated to one country or region. `15169-US` shows markedly fewer visible /24s than `asn` 15169. Ranking "networks in Iran" both ways gives different lists: the top `asn` row can be absent from the `geoasn` top rows. Use `geoasn` when the question is about the country; use `asn` when it is about the operator as a whole.

## Gates

1. **Get the clock from the server.** Windows are Unix seconds, and a guessed "now" fails or skews them. An `invalid_window` rejection for a future `until` states the server's now in its message ("until … is after now (N)") without any upstream request; `ioda_get_status` also returns it as `asOf`.
2. **Trailing nulls near now are publication lag, not an outage.** The newest buckets come back null until IODA publishes them: in testing `bgp` ran about a quarter hour behind, `ping-slash24` a few minutes, and `merit-nt` an hour or more. Before reading the end of a series, end the window at least 30 minutes before now (more than an hour for `merit-nt`) or discount the trailing nulls. Nulls inside a window are missing observations: they can sit inside a real detection (two buckets of one `ping-slash24` drop were null), so a gap proves neither an outage nor normal service.
3. **Status has no baseline.** `ioda_get_status` gives detections, coverage, and the latest, minimum, and maximum values, but nothing to compare them with. Before calling a place "degraded", compare the latest value with the same source over the preceding days (`ioda_get_signals`), or read `historyValue` on its alerts. The strongest clean statement IODA supports is "no detections, with recent bgp and ping-slash24 coverage".
4. **Telescope gaps are routine.** `merit-nt` is often `stale` or `no_data` while `bgp` and `ping-slash24` are `recent`, for large countries as well as small ones (Cuba, Iran, and the UK in testing). Report that as a coverage gap, not as an outage signal.
5. **Quantify drops within one source.** An alert's `value` divided by its `historyValue` is the drop against IODA's baseline for that source; `condition` `< 0.8` is the threshold on that ratio. One `ping-slash24` alert on Iran read `value` 2748 against `historyValue` 11497 (0.24, level `critical`); its recovery an hour later carried level `normal`, condition `normal`, ratio 0.98. Never compare values or ratios across sources: units and baselines differ.
6. **Rule out a measurement-side event before attributing it to X.** Run `ioda_find_outages` with the event's `source` over the same window, entityType `country` and no entity code. When the same start and end appear on many unrelated countries, the event most likely sits on IODA's measurement side rather than in X; report it as such, never as X's outage. The Iran alert above was one: the identical one-hour `ping-slash24` event covered more than 100 countries at once (China, Austria, Canada, the UK among them).
7. **Name the sources that moved.** A drop visible in one source is a finding about that source: during that event `ping-slash24` fell while `bgp` and `merit-nt` stayed flat. Report it that way, and do not upgrade it to "the Internet was cut" or infer a mechanism. A ranking row's `scores` keys show which sources contributed: a row with only `gtr.sarima` rests on Google traffic alone.
8. **"Worst" needs more than the top score.** Small territories (Norfolk Island, the Cook Islands, Saint Pierre and Miquelon in testing) routinely top country rankings; the score measures IODA detections, not people affected. Before naming the worst-hit entity, check its events' durations with `ioda_find_outages` and its signals. Google traffic also reshapes rankings: re-running a month's country ranking with `ignoreMethods` `["gtr.*"]` dropped several of the top rows. Rank both ways when the answer should rest on network measurements, and say which you used.
9. **Scan many entities with one scoped call, not a loop.** Each `ioda_get_status` call makes five upstream requests paced about two seconds apart (8–10 s). For "which provinces or networks have trouble now", one scoped `ioda_get_alerts` over the last few hours replaces a status call per entity; then use status on the few that show up.

## Workflows

### Was there a shutdown in X, and where?

1. Resolve X. Call `ioda_find_outages` for the country over the period (split periods longer than 31 days into adjacent windows) for timing, sources, and scores.
2. For each event, rule out a measurement-side event (gate 6), then call `ioda_get_alerts` over a window spanning it to get `value` and `historyValue` per source (gate 5).
3. Rank where it hit: `ioda_summarize_outages` with entityType `region`, then `geoasn`, related to the country, over a window around the event. Drop placeholder regions; follow the response's membership notice before calling any province unaffected.
4. Show the shape: `ioda_get_signals` for `bgp`, `ping-slash24`, and `merit-nt` over a few hours either side, at native resolution (next section).
5. Report the timing in UTC, which sources moved and by how much, and where. Leave cause to news sources.

### Charting signals

- Native steps: `bgp` and `merit-nt` 300 s, `ping-slash24` 600 s. A series is native only when `maxPoints` ≥ (until − from) / native step.
- The default `maxPoints` of 200 aggregates any `bgp` window longer than about 16.7 hours (a 16-hour window came back at 300 s, 17 hours at 600 s). At the 2000 cap, `bgp` and `merit-nt` stay native up to about 6.9 days and `ping-slash24` up to about 13.9 days. Beyond that the step jumps to a coarser fixed width: a 31-day window came back at 1800 s for all three sources at `maxPoints` 2000, and at 21600 s at the default 200.
- Overlay by time, never by array index: bucket *i* starts at `from + i × step`, and over the same span `ping-slash24` has half as many native buckets as `bgp`.
- Units differ per source, so plot sources on separate axes or normalize each to its own pre-event level, and say so.

### Is X degraded right now?

`ioda_get_status` (default 6-hour lookback) for detections and coverage; then gate 3 for the baseline comparison and gate 4 for telescope gaps.

### Which countries were hit hardest this month?

`ioda_summarize_outages` with entityType `country` over the month (at most 31 days; a month-long country ranking answered in about 4 s in testing). Apply gate 8, then drill into the top rows with `ioda_find_outages` and `ioda_get_signals`. For regions or networks, rank within one country through the related scope rather than across every region or ASN at once.

### Compare a country's networks over a month

`ioda_summarize_outages` with entityType `geoasn` related to the country over the month, paging with `nextPage`. Drill into each network of interest with `ioda_find_outages` and `ioda_get_signals` using its geoasn code; switch to entityType `asn` only if the question is about the operator's whole network.
