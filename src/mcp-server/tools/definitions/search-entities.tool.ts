/**
 * @fileoverview ioda_search_entities public IODA tool contract.
 * @module mcp-server/tools/definitions/search-entities.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  EntitySchema,
  getIodaService,
  PaginationSchema,
  ProvenanceSchema,
} from '@/services/ioda/index.js';
import {
  enrichment,
  enrichmentTrailer,
  entityFilter,
  entityInputs,
  entityType,
  finish,
  pageEnrichment,
  pageInputs,
  renderOutput,
  searchQuery,
} from '../ioda-common.js';

const Output = z.object({
  entities: z.array(EntitySchema).describe('Original entity metadata; not measurement coverage.'),
  pagination: PaginationSchema.describe('Upstream page and possible continuation.'),
  provenance: ProvenanceSchema.describe('Endpoint and original source attribution.'),
});
export const searchEntities = tool('ioda_search_entities', {
  description:
    'Resolve country, region, or autonomous-system names and codes for outage investigations. Choose entityType and either query or entityCode; omit both to list the type. Countries use two letters, regions numeric IODA codes, ASNs decimal digits (AS prefix accepted). Metadata does not establish measurement coverage. Pages are zero-based; keep limit fixed when continuing.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    entityType: entityInputs.entityType,
    entityCode: entityInputs.entityCode.optional(),
    query: z
      .string()
      .optional()
      .describe(
        'Name substring, trimmed to at most 200 characters; blank is omitted. Mutually exclusive with entityCode.',
      ),
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
      when: 'Invalid entity type, code, or incomplete pair.',
      recovery:
        'Call ioda_search_entities with entityType and query to resolve a country, region, or ASN, then call ioda_search_entities with the selected entityType and a returned code as entityCode.',
    },
    {
      reason: 'conflicting_search',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both query and entityCode were provided.',
      recovery:
        'Call ioda_search_entities with either query or entityCode, leaving the other omitted.',
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
      when: 'IODA data or bucket metadata does not validate.',
      recovery:
        'Retry ioda_search_entities once with a smaller limit and page 0; if the response still cannot be parsed, stop this search and report the response schema failure.',
    },
    {
      reason: 'response_too_large',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'The upstream body or combined response exceeds its byte budget.',
      recovery:
        'Call ioda_search_entities with a smaller limit and page 0, then continue with that fixed limit.',
    },
  ],
  async handler(input, ctx) {
    const now = Date.now();
    const deadline = now + 45000;
    const filter = entityFilter(input, 'ioda_search_entities');
    const type = entityType(input.entityType, 'ioda_search_entities');
    const query = searchQuery(input.query);
    if (query && filter.entityCode) throw ctx.fail('conflicting_search');
    const request = {
      entityType: type,
      ...(filter.entityCode && { entityCode: filter.entityCode }),
      ...(query && { query }),
      limit: input.limit,
      page: input.page,
    };
    const result = await getIodaService().searchEntities(request, ctx, { deadline });
    const notices: string[] = [];
    if (!result.entities.length) {
      notices.push(
        input.page > 0
          ? 'This page is empty. Call ioda_search_entities with page 0 and the same filters, or return to the previous page.'
          : 'No matching entities. Call ioda_search_entities with a shorter query or omit query to list this entity type.',
      );
      if (filter.entityCode)
        notices.push(
          'No entity metadata matched. Call ioda_search_entities with query to resolve the name; metadata alone does not establish signal coverage.',
        );
    }
    return finish(
      Output,
      result,
      pageEnrichment(request, result.pagination, notices.join(' ')),
      ctx,
      'ioda_search_entities',
      deadline,
    );
  },
  format: renderOutput,
});
