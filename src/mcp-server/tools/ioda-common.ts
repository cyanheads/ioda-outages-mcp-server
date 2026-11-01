/**
 * @fileoverview Canonical IODA inputs, served caps, lossless rendering, and the shared result path.
 * @module mcp-server/tools/ioda-common
 */
import { type Context, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { ATTR_MCP_TOOL_NAME, createCounter, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import { activeServerConfig } from '@/config/server-config.js';
import { cancelledError, type IodaTool, iodaError } from '@/services/ioda/errors.js';
import {
  ARCHIVE_STARTS,
  type Entity,
  type EntityReference,
  type EntityType,
  EntityTypeSchema,
  MAX_POINTS,
  type Pagination,
  type RelatedScope,
  type SignalSource,
  SignalSourceSchema,
  type Source,
  SourceSchema,
} from '@/services/ioda/index.js';
import type { AlertRequest, EventRequest, SummaryRequest } from '@/services/ioda/types.js';

/**
 * The largest value one call serves. A larger read is served at the cap and disclosed in the
 * notice, unless IODA_CLAMP_LIMITS=false makes the cap the schema maximum.
 */
export const SERVED_CAPS = {
  limit: 1000,
  maxPoints: MAX_POINTS,
  lookbackHours: 24,
  extendWindowSeconds: 1209600,
} as const;
type CappedInput = keyof typeof SERVED_CAPS;
const clamping = () => activeServerConfig().clampLimits;
/**
 * A whole-number input served at its cap. Clamping, the default, accepts any larger value, so
 * the integer check is `multipleOf(1)` plus a refinement (`multipleOf` tolerates float noise
 * such as 20.000000000000004) rather than `.int()`, which advertises 9007199254740991. Under
 * IODA_CLAMP_LIMITS=false the cap is enforced with Zod's own `too_big` issue. The mode is read
 * at parse time, never when the schema is built: `tool()` emits every input schema when its
 * module is imported, before `setup()` parses the environment, so a schema that read the mode
 * when built (`z.lazy` included, which resolves on that first emission) would keep the default.
 */
export function cappedInput(name: CappedInput, minimum: number) {
  const cap = SERVED_CAPS[name];
  const whole = `Use a whole number for ${name}.`;
  return z
    .number()
    .multipleOf(1, whole)
    .min(minimum)
    .refine(Number.isInteger, { message: whole, when: ({ issues }) => issues.length === 0 })
    .check((payload) => {
      if (payload.issues.length || clamping() || payload.value <= cap) return;
      payload.issues.push({
        code: 'too_big',
        origin: 'number',
        maximum: cap,
        inclusive: true,
        input: payload.value,
      });
    });
}
/**
 * The JSON Schema metadata of a {@link cappedInput}, applied last: its description and
 * `maximum` are getters, read each time `tools/list` emits the schema.
 */
export function cappedMeta(name: CappedInput, describe: (clamped: boolean, cap: number) => string) {
  const cap = SERVED_CAPS[name];
  return {
    type: 'integer',
    get description() {
      return describe(clamping(), cap);
    },
    get maximum() {
      return clamping() ? undefined : cap;
    },
  };
}

/** Flag-free grammars preserve case and padding in the advertised JSON Schema. */
const inputGrammars = {
  type: '[cC][oO][uU][nN][tT][rR][yY]|[rR][eE][gG][iI][oO][nN]|[aA][sS][nN]|[gG][eE][oO][aA][sS][nN]',
  code: '[a-zA-Z]{2}|(?:[aA][sS])?[0-9]+(?:-(?:[0-9]+|[a-zA-Z]{2}))?',
  numericSource:
    '[bB][gG][pP]|[pP][iI][nN][gG]-[sS][lL][aA][sS][hH]24|[mM][eE][rR][iI][tT]-[nN][tT]',
};
/** Blank and nonblank branches never split the same whitespace run between quantifiers. */
function inputPattern(grammar: string, optionalBlank: boolean): RegExp {
  const nonblank = `\\s*(?:${grammar})\\s*`;
  return new RegExp(`^(?:${optionalBlank ? `\\s*|${nonblank}` : nonblank})$(?![\\s\\S])`);
}
const typeMessage =
  'Call ioda_search_entities with entityType country, region, asn, or geoasn; case and surrounding whitespace are accepted.';
const codeMessage =
  'Use two country letters, decimal region digits, an optionally AS-prefixed ASN, or an ASN joined by a hyphen to region digits or two country letters; call ioda_search_entities to resolve a code.';
const entityDescriptions = {
  type: 'country, region, asn, or geoasn (one ASN within a region or country); whitespace and case are normalized.',
  code: 'Two-letter country code, IODA numeric region code, decimal ASN (AS prefix accepted), or geoasn code joining an ASN and a region or country code (40934-576, 59962-IR); resolve names with ioda_search_entities and pass a returned code here.',
};
/** Optional query grammar measures UTF-16 code units between the first and last non-whitespace. */
export const queryInput = z
  .string()
  .regex(
    /^(?:\s*|\s*\S(?:[\s\S]{0,198}\S)?\s*)$(?![\s\S])/,
    'Use a query of at most 200 UTF-16 code units after trimming, or omit query to list the entity type with ioda_search_entities.',
  )
  .optional()
  .describe(
    'Case-insensitive name substring, matched literally (% and _ are not wildcards); trimmed to at most 200 UTF-16 code units, and blank is omitted. Mutually exclusive with entityCode.',
  );
/** Exactly one ioda_get_signals source: a core source or gtr. */
export const signalSourceInput = z
  .string()
  .regex(
    inputPattern(`${inputGrammars.numericSource}|[gG][tT][rR]`, false),
    'Call ioda_get_signals with source bgp, ping-slash24, merit-nt, or gtr; case and surrounding whitespace are accepted.',
  )
  .describe(
    'Exactly bgp, ping-slash24, merit-nt, or gtr; case and whitespace normalized. gtr (Google Transparency Report traffic) covers countries only; ucsd-nt is not supported.',
  );

/** Transport strings admit the canonicalization promised to callers. */
export const entityInputs = {
  entityType: z
    .string()
    .regex(inputPattern(inputGrammars.type, false), typeMessage)
    .describe(entityDescriptions.type),
  entityCode: z
    .string()
    .regex(inputPattern(inputGrammars.code, false), codeMessage)
    .describe(entityDescriptions.code),
};
/** Optional filters explicitly allow global scope. */
export const filterInputs = {
  entityType: z
    .string()
    .regex(inputPattern(inputGrammars.type, true), typeMessage)
    .optional()
    .describe(entityDescriptions.type),
  entityCode: z
    .string()
    .regex(inputPattern(inputGrammars.code, true), codeMessage)
    .optional()
    .describe(entityDescriptions.code),
  source: z
    .string()
    .regex(
      inputPattern(`${inputGrammars.numericSource}|[gG][tT][rR]`, true),
      'Call ioda_find_outages or ioda_get_alerts with source bgp, ping-slash24, merit-nt, or gtr, or omit source to search all sources.',
    )
    .optional()
    .describe(
      'bgp, ping-slash24, merit-nt, or gtr; blank means all sources. Case and whitespace are normalized.',
    ),
};
/** Upstream exclusions accept one source or method wildcard, never both. */
export const ignoreMethodsInput = z
  .array(
    z
      .string()
      .regex(
        inputPattern(
          `(?:(?:${inputGrammars.numericSource}|[gG][tT][rR])\\.(?:\\*|[^\\s.,|*]+)|\\*\\.[^\\s.,|*]+)`,
          false,
        ),
        'Use <source>.<method>, <source>.*, or *.<method> with source bgp, ping-slash24, merit-nt, or gtr; supply separate ignoreMethods array entries, without commas, pipes, or *.*.',
      )
      .describe('One detection method exclusion; case and surrounding whitespace are normalized.'),
  )
  .optional()
  .describe(
    'Detection methods to exclude upstream before event construction and scoring; duplicates are removed, and an empty array excludes nothing. Keep fixed across ranking and drill-down calls.',
  );
/** An optional scope listing entityType entities related to one other entity. */
export const scopeInputs = {
  relatedToType: z
    .string()
    .regex(inputPattern(inputGrammars.type, true), typeMessage)
    .optional()
    .describe(
      'Scope type: country, region, asn, or geoasn. With relatedToCode, returns entityType entities related to that entity, such as the regions or networks of one country. Requires entityType and excludes entityCode; blank is omitted. Outage membership coverage is unverified independently of row pagination; page ioda_search_entities and query selected codes individually.',
    ),
  relatedToCode: z
    .string()
    .regex(inputPattern(inputGrammars.code, true), codeMessage)
    .optional()
    .describe(
      'Scope entity code, normalized like entityCode for relatedToType (IR, 1829, AS42337, 60627-IR); resolve names with ioda_search_entities. Provide with relatedToType.',
    ),
};
/**
 * One upstream page with a fixed limit across continuation calls. `page` has no cap, so it keeps
 * `.int()`: its advertised safe-integer maximum is the bound `pagination.page` echoes.
 */
export const pageInputs = {
  limit: cappedInput('limit', 1)
    .default(20)
    .meta(
      cappedMeta('limit', (clamped, cap) =>
        clamped
          ? `Default 20; a larger value returns at most ${cap} and says so. Keep fixed when continuing.`
          : `Default 20, at most ${cap}. Keep fixed when continuing.`,
      ),
    ),
  page: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Zero-based upstream page; restart at 0 when changing limit.'),
};
/** The UTC day of an archive start, as YYYY-MM-DD. */
function archiveDay(series: keyof typeof ARCHIVE_STARTS): string {
  return new Date(ARCHIVE_STARTS[series] * 1000).toISOString().slice(0, 10);
}
/** Historical windows are always explicit. */
export const windowInputs = {
  from: z
    .number()
    .int()
    .positive()
    .describe(
      `Inclusive Unix seconds UTC; no milliseconds; window at most 31 days. IODA's API holds no outage detections before ${archiveDay('detections')} UTC.`,
    ),
  until: z
    .number()
    .int()
    .positive()
    .describe(
      'Inclusive Unix seconds UTC for transition/event-start selection, after from and no later than now; adjacent windows can duplicate boundary detections.',
    ),
};
/** Requested signal bounds differ from the aligned returned bucket interval. */
export const signalWindowInputs = {
  from: windowInputs.from.describe(
    `Requested start Unix seconds UTC; window at most 31 days. Aligned returned buckets may begin earlier. IODA's API holds no merit-nt observations before ${archiveDay('merit-nt')} UTC, no bgp before ${archiveDay('bgp')}, and no ping-slash24 before ${archiveDay('ping-slash24')}.`,
  ),
  until: windowInputs.until.describe(
    'Requested end Unix seconds UTC, after from and no later than now. Returned bucket bounds are exclusive and may extend beyond this requested bound due to alignment.',
  ),
};
/** Required canonical request echo with optional result guidance. */
export const enrichment = {
  applied: z
    .record(z.string(), z.json())
    .describe('Every normalized input, effective window, filter and pagination value.'),
  notice: z.string().optional().describe('Result interpretation and concrete next call.'),
  truncated: z
    .object({
      shown: z.number().int().nonnegative().describe('Returned records'),
      cap: z.number().int().positive().describe('Requested page capacity'),
    })
    .optional()
    .describe('A full page may have further records; not an exact total.'),
};
const EnrichmentSchema = z.object(enrichment);
/** Locally validated enrichment values, disjoint from domain output. */
type Enrichment = z.infer<typeof EnrichmentSchema>;

/** One captured invocation clock and its absolute 45-second deadline. */
export function invocationClock(): { now: number; deadline: number } {
  const now = Date.now();
  return { now, deadline: now + 45_000 };
}
/** Empty optional text is absent before semantic validation. */
function optionalText(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
/** Normalize the query after its transport schema checked the trimmed length. */
export function searchQuery(value: string | undefined): string | undefined {
  return optionalText(value);
}
/** Canonicalize an ioda_get_signals source admitted by its transport grammar. */
export function signalSource(value: string): SignalSource {
  return SignalSourceSchema.parse(value.trim().toLowerCase());
}
/**
 * Empty-result guidance for an ASN. IODA answers an ASN it holds no metadata for with a
 * synthesized entity instead of an error, and unknown ASNs return empty evidence, not
 * entity_not_found. Every placeholder row carries ip_count "0"; no real row did on 2026-11-01.
 */
export const asnPlaceholderNotice =
  'A returned ioda_search_entities row does not confirm IODA holds data for an ASN: IODA answers an ASN it has no record of with a placeholder row whose attrs.ip_count is "0".';
/** Each tool's declared invalid_entity contract supplies the recovery hint. */
function invalidEntity(message: string) {
  return validationError(message, { reason: 'invalid_entity' });
}
/** A type from the shared vocabulary, or undefined. */
function canonicalType(value: string): EntityType | undefined {
  return EntityTypeSchema.safeParse(value.trim().toLowerCase()).data;
}
/** Canonical entity vocabulary without guessing names or subdivision codes. */
export function entityType(value: string): EntityType {
  const type = canonicalType(value);
  if (!type) throw invalidEntity('entityType must be country, region, asn, or geoasn.');
  return type;
}
/** An ASN, optionally AS-prefixed, a hyphen, then region digits or two country letters. */
const GEOASN_CODE = /^(?:as)?(\d+)-(\d+|[a-z]{2})$/i;
/** Decimal digits without leading zeros; zero and ASNs past 32 bits name no entity. */
function positive(digits: string, asn: boolean): string | undefined {
  const canonical = digits.replace(/^0+/, '');
  if (!canonical || (asn && (canonical.length > 10 || Number(canonical) > 4294967295))) return;
  return canonical;
}
/** The code IODA matches exactly for a type, or the rule the code breaks; callers choose the reason. */
function canonicalCode(type: EntityType, raw: string): { code: string } | { problem: string } {
  const outOfRange = { problem: 'ASN must be 1–4294967295; region codes must be positive.' };
  if (type === 'country')
    return /^[a-z]{2}$/i.test(raw)
      ? { code: raw.toUpperCase() }
      : {
          problem:
            'Country codes require exactly two ASCII letters; resolve names with ioda_search_entities.',
        };
  if (type === 'geoasn') {
    const match = GEOASN_CODE.exec(raw);
    if (!match)
      return {
        problem:
          'geoasn codes are an ASN, a hyphen, and a numeric region code or two-letter country code, such as 40934-576 or 59962-IR; resolve names with ioda_search_entities.',
      };
    const [, asn = '', area = ''] = match;
    const asnCode = positive(asn, true);
    const areaCode = /^\d/.test(area) ? positive(area, false) : area.toUpperCase();
    return asnCode && areaCode ? { code: `${asnCode}-${areaCode}` } : outOfRange;
  }
  const digits = type === 'asn' ? raw.replace(/^as/i, '') : raw;
  if (!/^\d+$/.test(digits))
    return { problem: 'Region and ASN codes require positive decimal digits.' };
  const code = positive(digits, type === 'asn');
  return code ? { code } : outOfRange;
}
/** Canonical entity pair; optional scopes may provide a type without a code. */
export function entityFilter(input: {
  entityType?: string | undefined;
  entityCode?: string | undefined;
}): Partial<EntityReference> {
  const rawType = optionalText(input.entityType);
  const rawCode = optionalText(input.entityCode);
  if (!rawType) {
    if (rawCode) throw invalidEntity('entityCode requires entityType.');
    return {};
  }
  const type = entityType(rawType);
  if (!rawCode) return { entityType: type };
  const canonical = canonicalCode(type, rawCode);
  if ('problem' in canonical) throw invalidEntity(canonical.problem);
  return { entityType: type, entityCode: canonical.code };
}
/** Each tool's declared invalid_scope contract supplies the recovery hint. */
function invalidScope(message: string) {
  return validationError(message, { reason: 'invalid_scope' });
}
/**
 * The canonical relatedTo scope, or undefined when both halves are absent or blank. A scope
 * needs entityType, since IODA matches a bare code across entity types, and excludes
 * entityCode, which IODA refuses or silently intersects with the scope. Violations throw
 * invalid_scope before any request.
 */
export function relatedScope(input: {
  entityType?: string | undefined;
  entityCode?: string | undefined;
  relatedToType?: string | undefined;
  relatedToCode?: string | undefined;
}): RelatedScope | undefined {
  const rawType = optionalText(input.relatedToType);
  const rawCode = optionalText(input.relatedToCode);
  if (!rawType && !rawCode) return;
  if (!rawType || !rawCode)
    throw invalidScope(
      'relatedToType and relatedToCode go together; provide both, or omit both for no scope.',
    );
  const type = canonicalType(rawType);
  if (!type) throw invalidScope('relatedToType must be country, region, asn, or geoasn.');
  const canonical = canonicalCode(type, rawCode);
  if ('problem' in canonical)
    throw invalidScope(`relatedToCode does not fit relatedToType ${type}: ${canonical.problem}`);
  if (!optionalText(input.entityType))
    throw invalidScope(
      'A relatedTo scope requires entityType, the type of entity to list within it; without it IODA matches codes across entity types.',
    );
  if (optionalText(input.entityCode))
    throw invalidScope(
      'A relatedTo scope lists every entityType entity within it, so it cannot be combined with entityCode; omit entityCode to use the scope.',
    );
  return { relatedToType: type, relatedToCode: canonical.code };
}
/** Require the complete pair for single-entity workflows. */
export function requiredEntity(input: { entityType: string; entityCode: string }): EntityReference {
  const parsed = entityFilter(input);
  if (!parsed.entityType || !parsed.entityCode)
    throw invalidEntity('Both entityType and entityCode are required.');
  return { entityType: parsed.entityType, entityCode: parsed.entityCode };
}
/** Normalize event/alert source names admitted by the transport grammar without substitution. */
export function sourceFilter(value: string | undefined): Source | undefined {
  const text = optionalText(value)?.toLowerCase();
  if (!text) return undefined;
  return SourceSchema.parse(text);
}
/** Normalize exclusions without filtering or recomputing any provider records. */
export function ignoredMethods(
  values: string[] | undefined,
  source?: Source,
): string[] | undefined {
  const methods = values && [...new Set(values.map((value) => value.trim().toLowerCase()))];
  if (source && methods?.includes(`${source}.*`))
    throw validationError(`source ${source} conflicts with ignoreMethods ${source}.*.`, {
      reason: 'invalid_ignore_methods',
    });
  return methods;
}
/** Millisecond timestamps have exceeded this since 1973; Unix seconds reach it in year 5138. */
const MILLISECOND_BOUND = 100_000_000_000;
const MAX_WINDOW_SECONDS = 31 * 86400;
/** The first broken window rule, in a fixed order, with the offending values. */
function windowViolation(
  { from, until }: { from: number; until: number },
  nowSeconds: number,
): string | undefined {
  const milliseconds = Object.entries({ from, until }).filter(
    ([, value]) => value >= MILLISECOND_BOUND,
  );
  if (milliseconds.length)
    return `${milliseconds.map(([bound, value]) => `${bound} ${value}`).join(' and ')} ${milliseconds.length > 1 ? 'look' : 'looks'} like milliseconds; pass Unix seconds (divide by 1000).`;
  if (from >= until) return `from ${from} is not before until ${until}.`;
  if (until > nowSeconds) return `until ${until} is after now (${nowSeconds}).`;
  if (until - from > MAX_WINDOW_SECONDS)
    return `The window spans ${until - from} seconds, over the 31-day limit of ${MAX_WINDOW_SECONDS}.`;
  return;
}
/** Reject an invalid historical interval; the declared invalid_window contract supplies recovery. */
export function validateWindow(input: { from: number; until: number }, now: number): void {
  const violation = windowViolation(input, Math.floor(now / 1000));
  if (violation) throw validationError(violation, { reason: 'invalid_window' });
}
/** A served value and, when the request exceeded its cap, the notice disclosing it. */
interface Served {
  notice?: string;
  value: number;
}
/** Created on first use: a counter made at import binds to the no-op meter OTel starts with. */
let clampCounter: ReturnType<typeof createCounter> | undefined;
/**
 * Serve an over-cap read at its cap, naming requested, served, and the route to the rest. Each
 * clamp writes one log line and one count labelled by tool and input; the requested value is
 * caller-chosen, so it goes on the log line only.
 */
function serve(
  name: CappedInput,
  requested: number,
  ctx: Context,
  tool: IodaTool,
  rest: (cap: number) => string,
): Served {
  const cap = SERVED_CAPS[name];
  if (requested <= cap) return { value: requested };
  ctx.log.info(`Served ${name} at its cap`, { tool, input: name, requested, served: cap });
  clampCounter ??= createCounter(
    'ioda.input.clamps',
    'Over-cap inputs served at their cap',
    '{clamps}',
  );
  clampCounter.add(1, { [ATTR_MCP_TOOL_NAME]: tool, 'ioda.input.name': name });
  return {
    value: cap,
    notice: `${name} ${requested} exceeds the cap of ${cap}; served ${cap}. ${rest(cap)}`,
  };
}
/** Pages count served records, so a later page starts after page × cap records. */
export function clampLimit(requested: number, page: number, ctx: Context, tool: IodaTool): Served {
  return serve(
    'limit',
    requested,
    ctx,
    tool,
    (cap) =>
      `${page > 0 ? `Page ${page} starts after the first ${page * cap} records. ` : ''}Every limit of ${cap} or more serves the same pages.`,
  );
}
/** IODA aggregates to the served target, so any larger request returns the same buckets. */
export function clampMaxPoints(requested: number, ctx: Context): Served {
  return serve(
    'maxPoints',
    requested,
    ctx,
    'ioda_get_signals',
    (cap) => `Every maxPoints of ${cap} or more requests the same aggregation.`,
  );
}
/**
 * The uncovered earlier hours stay reachable through the standalone window tools, whose windows
 * span at most 31 days: a longer uncovered span is named by its latest 31 days.
 */
export function clampLookbackHours(requested: number, asOf: number, ctx: Context): Served {
  return serve('lookbackHours', requested, ctx, 'ioda_get_status', (cap) => {
    const until = asOf - cap * 3600;
    const call = (from: number) =>
      `call ioda_find_outages, ioda_get_alerts, or ioda_get_signals (once per source) with the same entityType and entityCode, from ${from} and until ${until}`;
    const uncoveredSeconds = (requested - cap) * 3600;
    if (uncoveredSeconds <= MAX_WINDOW_SECONDS)
      return `For the uncovered earlier window, ${call(until - uncoveredSeconds)}.`;
    return `The uncovered earlier window spans ${requested - cap} hours, over the 31-day window limit. For its latest 31 days, ${call(until - MAX_WINDOW_SECONDS)}; for earlier hours back to from ${until - uncoveredSeconds}, repeat with adjacent windows of at most 31 days, each ending at the previous from.`;
  });
}
/**
 * IODA selects alert transitions from `from − extension` to `until + extension`. Alerts return
 * them as found; events and summaries keep only events overlapping the window, so there the
 * extension bounds how early an overlapping event's start is found. Each over-cap tail states
 * that loss for its tool with concrete windows that validate: `from` moves back by the uncovered
 * extension (at most 31 days less a second) and `until` moves back only as far as the 31-day
 * limit needs, so the window still covers `from`. Applied whether supplied or defaulted.
 */
export function clampExtendWindow(
  requested: number,
  tool: 'ioda_find_outages' | 'ioda_get_alerts' | 'ioda_summarize_outages',
  window: { from: number; until: number },
  now: number,
  ctx: Context,
): Served {
  return serve('extendWindowSeconds', requested, ctx, tool, (cap) => {
    const shift = Math.min(requested - cap, MAX_WINDOW_SECONDS - 1);
    const from = window.from - shift;
    const earlier = `from ${from}, until ${Math.min(window.until, from + MAX_WINDOW_SECONDS)}`;
    const keep = `then keep only the events whose until is at or after ${window.from}.`;
    if (tool === 'ioda_find_outages')
      return `An event overlapping the window that began more than ${cap} seconds before from can be missing or reported with a later start. To search earlier starts, call ioda_find_outages at page 0 with ${earlier}, extendWindowSeconds ${cap}, and the other filters unchanged, ${keep}`;
    if (tool === 'ioda_summarize_outages')
      return `Events overlapping the window that began more than ${cap} seconds before from are not counted, or are counted from a later start. To check one entity for such an event, call ioda_find_outages with this entityType, that entity's code as entityCode, ${earlier}, and extendWindowSeconds ${cap}, ${keep}`;
    const nowSeconds = Math.floor(now / 1000);
    const alerts = `call ioda_get_alerts at page 0 with ${earlier}, extendWindowSeconds ${cap}, and the other filters unchanged`;
    // Transitions past until + cap exist only once that moment has passed.
    if (window.until + cap >= nowSeconds)
      return `Transitions more than ${cap} seconds before from are not returned. To reach them, ${alerts}.`;
    const until = Math.min(nowSeconds, window.until + shift);
    return `Transitions more than ${cap} seconds before from or after until are not returned. To reach the earlier ones, ${alerts}; for the later ones, use from ${Math.max(window.from, until - MAX_WINDOW_SECONDS)} and until ${until} instead.`;
  });
}
/**
 * Two-space JSON layout, except arrays holding only numbers and nulls stay on one line.
 * Pieces accumulate in `out` and join once, so cost stays linear in the rendered size.
 */
function layout(value: unknown, indent: string, out: string[]): void {
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.every((item) => item === null || typeof item === 'number')) {
      out.push(JSON.stringify(value));
      return;
    }
    out.push('[');
    for (let index = 0; index < value.length; index++) {
      out.push(index ? ',\n' : '\n', inner);
      layout(value[index], inner, out);
    }
    out.push(`\n${indent}]`);
    return;
  }
  if (value === null || typeof value !== 'object') {
    out.push(JSON.stringify(value));
    return;
  }
  const keys = Object.keys(value);
  if (!keys.length) {
    out.push('{}');
    return;
  }
  out.push('{');
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index] as string;
    out.push(index ? ',\n' : '\n', inner, JSON.stringify(key), ': ');
    layout((value as Record<string, unknown>)[key], inner, out);
  }
  out.push(`\n${indent}}`);
}
/** Dynamically fenced JSON cannot promote source text to Markdown structure. */
export function renderJson(value: unknown): string {
  const out: string[] = [];
  // The JSON round trip applies JSON.stringify's own value rules (toJSON, undefined, NaN) first.
  layout(JSON.parse(JSON.stringify(value)), '', out);
  const text = out.join('');
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}json\n${text}\n${fence}`;
}
/** A typed endpoint is also a real Markdown link; plain source strings stay data. */
export function renderOutput(value: unknown): { type: 'text'; text: string }[] {
  const endpoints: string[] = [];
  const output = value as {
    provenance?: { endpoint: string };
    components?: { provenance?: { endpoint: string } }[];
  };
  if (output.provenance) endpoints.push(output.provenance.endpoint);
  for (const component of output.components ?? [])
    if (component.provenance) endpoints.push(component.provenance.endpoint);
  const links = endpoints.map((url) => markdownLink('IODA endpoint', url));
  return [
    {
      type: 'text',
      text: `## IODA evidence\n\n${renderJson(value)}${links.length ? `\n\n${links.join('\n')}` : ''}`,
    },
  ];
}
/** The exact render callbacks used by the framework enrichment trailer. */
export const enrichmentTrailer = {
  applied: { render: (value: unknown) => renderJson({ applied: value }) },
  notice: { render: (value: unknown) => renderJson({ notice: value }) },
  truncated: { render: (value: unknown) => renderJson({ truncated: value }) },
};
/** One notice fragment; `false` and `undefined` fragments are skipped. */
type NoticePart = string | false | undefined;
/** Guidance for an empty page past the first, worded alike by every paged tool. */
export function emptyPageNotice(tool: IodaTool): string {
  return `This page is empty. Call ${tool} with page 0 and unchanged filters, or return to the previous page.`;
}
/** Empty first-page guidance for an entityCode filter: IODA lists nothing for an unknown code. */
export const unknownCodeNotice =
  'IODA returns an empty page rather than an error for an unknown entityCode; call ioda_search_entities with the same entityType and entityCode to verify it.';
/** Empty first-page guidance for a relatedTo scope: IODA lists nothing within an unknown scope code. */
export const unknownScopeNotice =
  'IODA returns an empty page rather than an error for an unknown relatedToCode; call ioda_search_entities with relatedToType as entityType and relatedToCode as entityCode to verify it.';
/**
 * A region row IODA keeps as a geolocation catch-all rather than a province or state. IODA names
 * them `[Invalid Region (N)]` or `Unknown Region in <country>`; of IODA's 4,884 regions on
 * 2026-11-01, the 292 placeholders matched one of the two shapes and no other region matched either.
 */
export function isPlaceholderRegion(entity: Entity): boolean {
  return (
    entity.type === 'region' &&
    (/^\[Invalid Region \(\d+\)\]$/.test(entity.name) ||
      entity.name.startsWith('Unknown Region in '))
  );
}
/** Names a page's placeholder region codes once each, in page order; rows stay as IODA returns them. */
export function placeholderRegionNotice(entities: readonly Entity[]): string | undefined {
  const codes = [...new Set(entities.filter(isPlaceholderRegion).map((entity) => entity.code))];
  if (!codes.length) return;
  return codes.length === 1
    ? `Region ${codes[0]} is an IODA geolocation catch-all rather than a province or state; do not report it as one.`
    : `Regions ${codes.join(', ')} are IODA geolocation catch-alls rather than provinces or states; do not report them as such.`;
}
/** A series with a known archive start: one core numeric source, or outage detections. */
export type ArchiveSeries = keyof typeof ARCHIVE_STARTS;
/**
 * Where a window sits against an archive start. `before` ends at or before the start, so it can
 * hold no records; `straddles` begins before it. Pass alert windows widened by their extension.
 */
export function archivePosition(
  window: { from: number; until: number },
  series: ArchiveSeries,
): 'before' | 'straddles' | 'after' {
  const start = ARCHIVE_STARTS[series];
  if (window.until <= start) return 'before';
  return window.from < start ? 'straddles' : 'after';
}
/**
 * The archive sentence for an empty result. `before` replaces advice to verify the code or try
 * an earlier or wider window, which reaches further into the gap; `straddles` joins the tool's
 * usual guidance.
 */
export function archiveNotice(series: ArchiveSeries, position: 'before' | 'straddles'): string {
  const date = archiveDay(series);
  const records =
    series === 'detections'
      ? 'outage detections (alerts, events, or summary rows)'
      : `${series} observations`;
  return position === 'before'
    ? `IODA's API holds no ${records} before ${date} UTC, and this window ends by then, so an earlier window or another entity code returns none either.`
    : `IODA's API holds no ${records} before ${date} UTC, so only the part of this window from then on can return any.`;
}
/** Membership completeness is independent of returned outage-row page exhaustion. */
export function relatedMembershipNotice(
  tool: 'ioda_find_outages' | 'ioda_get_alerts' | 'ioda_summarize_outages',
  request: AlertRequest | EventRequest | SummaryRequest,
): string | undefined {
  const { entityType, relatedToType, relatedToCode, page: _page, limit, ...filters } = request;
  if (!relatedToType) return;
  const search = { entityType, relatedToType, relatedToCode, page: 0, limit };
  const individual = { entityType, entityCode: '<returned code>', ...filters, page: 0, limit };
  return `Membership coverage is unverified: IODA evaluates a bounded related set, so members can be omitted even when pagination.more is no. Row pagination does not establish complete scope coverage. Page ioda_search_entities with ${JSON.stringify(search)}, keeping the same scope and limit while increasing page; then remove relatedToType and relatedToCode and call ${tool} for each selected code with ${JSON.stringify(individual)}, keeping all filters and limit fixed across its pages.`;
}
/**
 * The single notice path for every tool. Parts join in the order given — served-cap and
 * served-default disclosures first, then result guidance. A full page reports `truncated`
 * against the served limit, never an invented total; when it carries `nextPage`, the
 * continuation closes the notice, and when it does not, the tool's parts name the route.
 */
export function composeEnrichment(
  applied: Enrichment['applied'],
  notices: NoticePart[],
  pagination?: Pagination,
): Enrichment {
  const full = pagination?.more === 'possible' ? pagination : undefined;
  const notice = [
    ...notices,
    full?.nextPage !== undefined &&
      'Another page may exist. Keep filters and limit fixed and use nextPage; restart at page 0 if changing limit.',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    applied,
    ...(notice && { notice }),
    ...(full && { truncated: { shown: full.returned, cap: full.limit } }),
  };
}
/**
 * Validate the domain result and its enrichment, then publish the enrichment unless the call was
 * cancelled or ran past its deadline. The page is the caller's page: nothing here shortens it.
 */
export function finish<S extends z.ZodObject>(
  schema: S,
  output: z.input<S>,
  values: Enrichment,
  ctx: Context,
  tool: IodaTool,
  deadline: number,
): z.output<S> {
  const domain = schema.parse(output);
  const parsedEnrichment = EnrichmentSchema.parse(values);
  if (ctx.signal.aborted) throw cancelledError(tool);
  if (Date.now() >= deadline)
    throw iodaError(
      JsonRpcErrorCode.Timeout,
      'upstream_timeout',
      'IODA invocation deadline expired during assembly.',
      tool,
    );
  ctx.enrich(parsedEnrichment);
  return domain;
}
