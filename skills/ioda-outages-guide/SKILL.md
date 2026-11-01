---
name: ioda-outages-guide
description: Gates and workflows for the ioda_* tools (IODA Internet outage detection). Covers resolving countries, provinces, and networks to IODA codes, asn vs geoasn, finding the current time, publication lag, signal resolution, and reading alerts, rankings, and BGP, probing, telescope, and Google traffic signals without over-claiming. Use when investigating an Internet shutdown or outage, checking whether a place or network is degraded now, ranking outages, or charting connectivity.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.1"
---

## Scope

IODA (Georgia Tech) tracks the connectivity of a country, a province or state, an autonomous system, or one ASN's footprint inside a country or region (geoasn) from outside vantage points. Sources:

| Source | What it sees | Where you get it |
|:-------|:-------------|:-----------------|
| `bgp` | Routes to the entity's address space (Visible /24s) | signals, events, alerts, rankings |
| `ping-slash24` | IPv4 /24 blocks answering active probes (Up /24s) | signals, events, alerts, rankings |
| `merit-nt` | Unsolicited traffic reaching the Merit network telescope (Unique Source IPs) | signals, events, alerts, rankings |
| `gtr` | Google Transparency Report product traffic (Traffic) | signals (countries only), events, alerts, rankings. Before 2022 it is the only numeric series, with gaps |

IODA's API starts in early 2022: no outage detections before 2022-01-26 UTC, and no `merit-nt`, `bgp`, or `ping-slash24` observations before 2022-01-09, 2022-01-18, and 2022-02-02. Older shutdowns (Iran, November 2019) return empty events, alerts, rankings, and core-source series, and the notice says so; only `gtr` signals reach back, to 2019 with gaps.

Keyless. Use it for network-level questions about places and providers. It does not answer whether a website, app, or cloud service is up, and it supplies timing and measurements, not cause: who ordered a shutdown, a cable cut, a power failure, or a storm comes from news sources (for example gdelt-mcp-server).

## Identifiers

- **Country**: ISO 3166-1 alpha-2 (`GB`, not `UK`: `entityCode` `UK` lists nothing, and a `query` of `uk` substring-matches Ukraine). `query` is a case-insensitive substring of IODA's own name (`iran` finds `IR`, "Iran (Islamic Republic Of)").
- **Region** (province, state): an IODA number (Tehran is `1829`), never an ISO 3166-2 code. Names follow IODA's transliteration (`Esfahan`; `Isfahan` returns nothing), so list the country's regions with `ioda_search_entities` (entityType `region`, related to the country, limit 100) and match by name instead of guessing spellings.
- **Placeholder regions**: country region lists can include `[Invalid Region (N)]` and `Unknown Region in <country>` rows (Iran's has both; the US and Germany list only the latter). These are geolocation catch-alls, not provinces. Listings, rankings, events, and alerts name their codes in the notice; leave them out of "which provinces" answers or label them as such.
- **ASN**: an ASN `entityCode` lookup always returns a row. IODA answers an ASN it holds no record of with a placeholder row (`AS4199999999` comes back with `ip_count` "0", no `org`, and empty signals rather than a failure), and the response names it in a notice, so a returned row does not prove IODA monitors the network. `ip_count` "0" is the sign; a missing `org` alone is not (private-use ASNs such as `AS64512` lack it and still have `bgp` series). Before building on an ASN with `ip_count` "0", fetch a short `bgp` series: an empty one means IODA holds no data for it, not that the network is down.
- **geoasn**: `<asn>-<CC>` or `<asn>-<regionCode>` (`60627-IR`), listed with entityType `geoasn` related to the country. A geoasn IODA lacks (`15169-IR`) fails `entity_not_found` on signals.

### asn or geoasn

An `asn` entity is the network's whole address space wherever it is announced; a `geoasn` is the slice geolocated to one country or region. `15169-US` shows markedly fewer visible /24s than `asn` 15169. Ranking "networks in Iran" both ways gives different lists: the top `asn` row can be absent from the `geoasn` top rows. Use `geoasn` when the question is about the country; use `asn` when it is about the operator as a whole.

## Gates

1. **Get the clock from the server.** Windows are Unix seconds, and a guessed "now" fails or skews them. An `invalid_window` rejection for a future `until` states the server's now in its message ("until … is after now (N)") without any upstream request; `ioda_get_status` also returns it as `asOf`.
2. **Trailing nulls near now are publication lag, not an outage.** The newest buckets come back null until IODA publishes them: in testing `bgp` ran about a quarter hour behind, `ping-slash24` a few minutes, `merit-nt` from ten minutes to over two hours (it publishes in batches), and `gtr` over an hour. `ioda_get_signals` counts each series' trailing nulls as not yet ended, pending (ended within the publication allowance: 1800 s for `bgp` and `ping-slash24`, 10800 s for `merit-nt` and `gtr`), or missing, and treats the first two as usually unpublished; a window that starts inside the allowance can return no series at all, and the notice says so. Before reading the end of a series, end the window at least the allowance plus one bucket before now, as the notice advises (35 minutes for `bgp`, 40 for `ping-slash24`, 3 hours 5 minutes for `merit-nt`, 3 hours 30 minutes for `gtr` at native resolution), or discount the trailing nulls. Nulls inside a window are missing observations: they can sit inside a real detection (two buckets of one `ping-slash24` drop were null), so a gap proves neither an outage nor normal service.
3. **Status has no baseline.** `ioda_get_status` gives detections, coverage, and the latest, minimum, and maximum values, but nothing to compare them with. Before calling a place "degraded", compare the latest value with the same source over the preceding days (`ioda_get_signals`), or read `historyValue` on its alerts. The strongest clean statement IODA supports is "no detections, with recent bgp and ping-slash24 coverage".
4. **Telescope gaps are routine.** `merit-nt` is often `stale` or `no_data` while `bgp` and `ping-slash24` are `recent`, for large countries as well as small ones (Cuba, Iran, and the UK in testing). Report that as a coverage gap, not as an outage signal.
5. **Quantify drops within one source.** An alert's `value` divided by its `historyValue` is the drop against IODA's baseline for that source, and `condition` is the threshold on that ratio: `< 0.99` for `bgp`, `< 0.8` for `ping-slash24` and `gtr`, `< 0.25` for `merit-nt`. One `ping-slash24` alert on Iran read `value` 2748 against `historyValue` 11497 (0.24, level `critical`); its recovery an hour later carried level `normal`, condition `normal`, ratio 0.98. Judge a recovery by its `value` against the detection's `historyValue` and `condition`, not its own `historyValue`, which IODA re-bases during long events: Tunisia's `ping-slash24` recovery read 6002 against 6058 (0.99), yet 0.73 of the detection's 8209. Never compare values or ratios across sources: units and baselines differ.
6. **Rule out a measurement-side event before attributing it to X.** Run `ioda_find_outages` with the event's `source` over the same window, entityType `country` and no entity code. When the same start and end appear on many unrelated countries, the event most likely sits on IODA's measurement side rather than in X; report it as such, never as X's outage. The Iran alert above was one: the identical one-hour `ping-slash24` event covered more than 100 countries at once (China, Austria, Canada, the UK among them).
7. **Name the sources that moved.** A drop visible in one source is a finding about that source: during that event `ping-slash24` fell while `bgp` and `merit-nt` stayed flat. Report it that way, and do not upgrade it to "the Internet was cut" or infer a mechanism. A ranking row's `scores` keys show which sources contributed: a row with only `gtr.sarima` rests on Google traffic alone.
8. **"Worst" needs more than the top score.** Small territories (Norfolk Island, the Cook Islands, Saint Pierre and Miquelon in testing) routinely top country rankings; the score measures IODA detections, not people affected. Before naming the worst-hit entity, check its events' durations with `ioda_find_outages` and its signals. Google traffic also reshapes rankings: re-running a month's country ranking with `ignoreMethods` `["gtr.*"]` dropped several of the top rows. Rank both ways when the answer should rest on network measurements, and say which you used. A long event can be a lasting step in one source rather than an outage of that length. Tunisia's two 14-day events recovered below their detections' thresholds; its `ping-slash24` held about 8,200 Up /24s before and 6,000 after. The baseline can also trail a step by weeks: Cabo Verde's `ping-slash24` fell from about 160 to 117 by 2026-08-21, its alerts kept `historyValue` 154 and flapped around `< 0.8` for a month, and a 26-day event from 2026-09-21 ran while the series held between 107 and 118. Before reporting an event's duration, chart its source with `ioda_get_signals` from weeks before the detection to after the recovery, and report a level that moved and stayed as a lasting change in that source, dated where the series steps.
9. **Scan many entities with one scoped call, not a loop.** Each `ioda_get_status` call makes five upstream requests paced about two seconds apart (8–10 s). For "which provinces or networks have trouble now", one scoped `ioda_get_alerts` over the last few hours replaces a status call per entity; then use status on the few that show up.

## Workflows

### Was there a shutdown in X, and where?

1. Resolve X. Call `ioda_find_outages` for the country over the period (split periods longer than 31 days into adjacent windows) for timing, sources, and scores.
2. For each event, rule out a measurement-side event (gate 6), then call `ioda_get_alerts` over a window spanning it to get `value` and `historyValue` per source (gate 5).
3. Rank where it hit: `ioda_summarize_outages` with entityType `region`, then `geoasn`, related to the country, over a window around the event. Drop the regions the response's placeholder notice names; follow its membership notice before calling any province unaffected.
4. Show the shape: `ioda_get_signals` for `bgp`, `ping-slash24`, and `merit-nt` over a few hours either side, at native resolution (next section).
5. Report the timing in UTC, which sources moved and by how much, and where. Leave cause to news sources.

### Charting signals

- Native steps: `bgp` and `merit-nt` 300 s, `ping-slash24` 600 s, `gtr` 1800 s. A series is native only when `maxPoints` ≥ (until − from) / native step.
- The default `maxPoints` of 200 aggregates any `bgp` window longer than about 16.7 hours (a 16-hour window came back at 300 s, 17 hours at 600 s). At the 10000 cap, every window of 31 days or less is native (8,928 buckets at 300 s). Below native, the step jumps to a coarser fixed width: a 31-day window came back at 21600 s at the default 200.
- Overlay by time, never by array index: bucket *i* starts at `from + i × step`, and over the same span `ping-slash24` has half as many native buckets as `bgp`.
- Units differ per source, so plot sources on separate axes or normalize each to its own pre-event level, and say so.

### Is X degraded right now?

`ioda_get_status` (default 6-hour lookback) for detections and coverage; then gate 3 for the baseline comparison and gate 4 for telescope gaps.

### Which countries were hit hardest this month?

`ioda_summarize_outages` with entityType `country` over the month (at most 31 days; a month-long country ranking answered in about 4 s in testing). Apply gate 8, then drill into the top rows with `ioda_find_outages` and `ioda_get_signals`. For regions or networks, rank within one country through the related scope rather than across every region or ASN at once.

### Compare a country's networks over a month

`ioda_summarize_outages` with entityType `geoasn` related to the country over the month, paging with `nextPage`. Drill into each network of interest with `ioda_find_outages` and `ioda_get_signals` using its geoasn code; switch to entityType `asn` only if the question is about the operator's whole network.
