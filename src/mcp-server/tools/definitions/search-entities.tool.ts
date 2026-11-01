/**
 * @fileoverview ioda_search_entities public IODA tool contract.
 * @module mcp-server/tools/definitions/search-entities.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  type Entity,
  EntitySchema,
  getIodaService,
  PaginationSchema,
  ProvenanceSchema,
} from '@/services/ioda/index.js';
import {
  clampLimit,
  composeEnrichment,
  emptyPageNotice,
  enrichment,
  enrichmentTrailer,
  entityFilter,
  entityInputs,
  entityType,
  filterInputs,
  finish,
  invocationClock,
  pageInputs,
  placeholderRegionNotice,
  queryInput,
  relatedScope,
  renderOutput,
  scopeInputs,
  searchQuery,
  unknownScopeNotice,
} from '../ioda-common.js';

/**
 * IODA answers an asn entityCode it holds no record of with a synthesized row whose attrs are
 * only fqid and ip_count "0". No real ASN row sampled on 2026-11-01 carried ip_count "0", while
 * some lack org, so ip_count alone is the sign; the row says nothing about whether series exist.
 */
function placeholderAsnNotice(entities: readonly Entity[]): string | undefined {
  return (
    entities
      .filter((entity) => entity.type === 'asn' && entity.attrs?.ip_count === '0')
      .map(
        ({ code }) =>
          `ASN ${code} came back as IODA's placeholder row (attrs.ip_count "0"), which IODA returns for an ASN it holds no record of, so the row neither confirms the ASN nor shows whether IODA measures it. Call ioda_get_signals with entityType asn, entityCode ${code}, a source, and a window to check for observations.`,
      )
      .join(' ') || undefined
  );
}
const Output = z.object({
  entities: z.array(EntitySchema).describe('Original entity metadata; not measurement coverage.'),
  pagination: PaginationSchema.describe('Upstream page and possible continuation.'),
  provenance: ProvenanceSchema.describe('Endpoint and original source attribution.'),
});
export const searchEntities = tool('ioda_search_entities', {
  description:
    'Resolve country, region, autonomous-system, or geoasn (one ASN within a region or country) names and codes for outage investigations. Choose entityType and either query or entityCode; omit both to list the type. Countries use two letters, regions numeric IODA codes, ASNs decimal digits (AS prefix accepted), geoasns an ASN and a region or country code (40934-576, 59962-IR). Add relatedToType and relatedToCode to list entityType entities within one country, region, ASN, or geoasn, such as the regions or networks of a country; a scope combines with query. Region results can include IODA geolocation catch-alls named [Invalid Region (N)] or Unknown Region in <country>, which are not provinces or states; a notice names them. Metadata does not establish measurement coverage. Pages are zero-based; keep limit fixed when continuing.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    entityType: entityInputs.entityType,
    entityCode: filterInputs.entityCode,
    query: queryInput,
    ...scopeInputs,
    ...pageInputs,
  }),
  output: Output,
  enrichment,
  enrichmentTrailer,
  errors: [
    {
      reason: 'invalid_entity',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'entityCode is incompatible with entityType, zero or out of range.',
      recovery:
        'Call ioda_search_entities with entityType and query to resolve a country, region, ASN, or geoasn, then call ioda_search_entities with the selected entityType and a returned code as entityCode.',
    },
    {
      reason: 'conflicting_search',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both query and entityCode were provided.',
      recovery:
        'Call ioda_search_entities with either query or entityCode, leaving the other omitted.',
    },
    {
      reason: 'invalid_scope',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'relatedToType and relatedToCode are incomplete or incompatible, the code is zero or out of range, or a scope comes with entityCode.',
      recovery:
        'Call ioda_search_entities with entityType, both relatedToType and relatedToCode (country, region, asn, or geoasn and its code), and no entityCode, or omit both scope fields.',
    },
    {
      reason: 'upstream_bad_request',
      code: JsonRpcErrorCode.InvalidParams,
      thrownBy: 'service',
      when: 'IODA rejects the request with HTTP 400 or an error envelope.',
      recovery:
        'Call ioda_search_entities with a supported entityType and either query or entityCode; use a shorter query or omit it to list that type.',
    },
    {
      reason: 'upstream_unprocessable',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'IODA rejects the request with HTTP 422.',
      recovery:
        'Call ioda_search_entities with a supported entityType and either query or entityCode; use a shorter query or omit it to list that type.',
    },
    {
      reason: 'entity_not_found',
      code: JsonRpcErrorCode.NotFound,
      thrownBy: 'service',
      when: 'IODA returns an explicit entity 404.',
      recovery:
        'Call ioda_search_entities with entityType and the name as query, then retry ioda_search_entities with the selected entityType and a returned code as entityCode.',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      thrownBy: 'service',
      retryable: true,
      when: 'IODA returns HTTP 429.',
      recovery:
        'Call ioda_search_entities again later, waiting at least the reported retryAfter duration when present; avoid concurrent investigations.',
    },
    {
      reason: 'upstream_queue_full',
      code: JsonRpcErrorCode.RateLimited,
      thrownBy: 'service',
      retryable: true,
      when: 'The shared request queue is full.',
      recovery:
        'Call ioda_search_entities again later; avoid concurrent investigations while the shared upstream queue is full.',
    },
    {
      reason: 'upstream_schema',
      code: JsonRpcErrorCode.SerializationError,
      thrownBy: 'service',
      when: 'IODA data or bucket metadata does not validate, or the response body is over 4 MiB.',
      recovery:
        'Retry ioda_search_entities once with a smaller limit and page 0; if the response still cannot be parsed, stop this search and report the response schema failure.',
    },
  ],
  async handler(input, ctx) {
    const { deadline } = invocationClock();
    const filter = entityFilter(input);
    const type = entityType(input.entityType);
    const scope = relatedScope(input);
    const query = searchQuery(input.query);
    if (query && filter.entityCode) throw ctx.fail('conflicting_search');
    const limit = clampLimit(input.limit, input.page, ctx, 'ioda_search_entities');
    const request = {
      entityType: type,
      ...(filter.entityCode && { entityCode: filter.entityCode }),
      ...(query && { query }),
      ...scope,
      limit: limit.value,
      page: input.page,
    };
    const result = await getIodaService().searchEntities(request, ctx, { deadline });
    const empty = !result.entities.length;
    // An empty first page reads by the inputs given: query advice only for a query.
    const zeroHit = query
      ? 'No matching entities. Call ioda_search_entities with a shorter query or omit query to list this entity type.'
      : filter.entityCode
        ? `IODA lists no ${type} with entityCode ${filter.entityCode}. Call ioda_search_entities with entityType ${type} and the name as query to find its code.`
        : `IODA lists no ${type} entities${scope ? ` within ${scope.relatedToType} ${scope.relatedToCode}` : ''}.`;
    return finish(
      Output,
      result,
      composeEnrichment(
        { ...request, ...(scope && { scope: 'related' }) },
        [
          limit.notice,
          placeholderRegionNotice(result.entities),
          placeholderAsnNotice(result.entities),
          empty && (input.page > 0 ? emptyPageNotice('ioda_search_entities') : zeroHit),
          empty && !input.page && scope && unknownScopeNotice,
        ],
        result.pagination,
      ),
      ctx,
      'ioda_search_entities',
      deadline,
    );
  },
  format: renderOutput,
});
