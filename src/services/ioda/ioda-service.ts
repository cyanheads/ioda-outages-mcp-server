/**
 * @fileoverview Fixed-origin, paced and bounded IODA evidence collection.
 * @module services/ioda/ioda-service
 */
import { type Context, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { IodaApiClient } from './api-client.js';
import { iodaError } from './errors.js';
import {
  AlertSchema,
  EntitySchema,
  EventSchema,
  NumericSeriesSchema,
  type Pagination,
  type StatusEvidence,
  StatusEvidenceSchema,
} from './schemas.js';
import { assessDetection, sourceCoverage, summarizeSeries } from './status.js';
import type {
  AlertRequest,
  AlertResult,
  EntityResult,
  EntitySearch,
  EventRequest,
  EventResult,
  IodaDependencies,
  RequestBudget,
  SignalRequest,
  SignalResult,
  StatusRequest,
} from './types.js';

function pagination(page: number, limit: number, returned: number): Pagination {
  return {
    page,
    limit,
    returned,
    more: returned >= limit ? 'possible' : 'no',
    ...(returned >= limit && { nextPage: page + 1 }),
  };
}

/** Independently authored client for the supported IODA GET endpoints. */
export class IodaService {
  private readonly client: IodaApiClient;

  constructor(dependencies: IodaDependencies = {}) {
    this.client = new IodaApiClient(dependencies);
  }

  /** Release the shared upstream queue during application shutdown. */
  dispose(): void {
    this.client.dispose();
  }

  /** Fetch one entity page; names are not coverage claims. */
  async searchEntities(
    input: EntitySearch,
    ctx: Context,
    budget: RequestBudget,
  ): Promise<EntityResult> {
    const result = await this.client.request(
      '/entities/query',
      {
        entityType: input.entityType,
        entityCode: input.entityCode,
        search: input.query,
        limit: input.limit,
        page: input.page,
      },
      z.array(EntitySchema),
      'ioda_search_entities',
      ctx,
      budget,
    );
    return {
      entities: result.data,
      pagination: pagination(input.page, input.limit, result.data.length),
      provenance: result.provenance,
    };
  }

  /** Fetch one original event page without merging or ranking source scores. */
  async getEvents(input: EventRequest, ctx: Context, budget: RequestBudget): Promise<EventResult> {
    const result = await this.client.request(
      '/outages/events',
      {
        from: input.from,
        until: input.until,
        entityType: input.entityType,
        entityCode: input.entityCode,
        datasource: input.source,
        includeAlerts: input.includeAlerts,
        extendWindow: input.extendWindowSeconds,
        format: 'ioda',
        overall: false,
        limit: input.limit,
        page: input.page,
      },
      z.array(EventSchema),
      'ioda_find_outages',
      ctx,
      budget,
    );
    return {
      events: result.data,
      pagination: pagination(input.page, input.limit, result.data.length),
      provenance: result.provenance,
    };
  }

  /** Fetch one original alert-transition page with literal levels and baselines. */
  async getAlerts(input: AlertRequest, ctx: Context, budget: RequestBudget): Promise<AlertResult> {
    const result = await this.client.request(
      '/outages/alerts',
      {
        from: input.from,
        until: input.until,
        entityType: input.entityType,
        entityCode: input.entityCode,
        datasource: input.source,
        extendWindow: input.extendWindowSeconds,
        limit: input.limit,
        page: input.page,
      },
      z.array(AlertSchema),
      'ioda_get_alerts',
      ctx,
      budget,
    );
    return {
      alerts: result.data,
      pagination: pagination(input.page, input.limit, result.data.length),
      provenance: result.provenance,
    };
  }

  /** Fetch all series/subtypes for exactly one supported numeric source. */
  async getNumericSignals(
    input: SignalRequest,
    ctx: Context,
    budget: RequestBudget,
  ): Promise<SignalResult> {
    const result = await this.client.request(
      `/signals/raw/${encodeURIComponent(input.entityType)}/${encodeURIComponent(input.entityCode)}`,
      {
        from: input.from,
        until: input.until,
        datasource: input.source,
        maxPoints: input.maxPoints,
      },
      z.tuple([z.array(NumericSeriesSchema)]),
      'ioda_get_signals',
      ctx,
      budget,
    );
    const series = result.data[0];
    for (const item of series) {
      if (
        item.datasource !== input.source ||
        item.entityType !== input.entityType ||
        item.entityCode !== input.entityCode
      ) {
        throw iodaError(
          JsonRpcErrorCode.SerializationError,
          'upstream_schema',
          'IODA returned a series outside the requested entity or source.',
          'ioda_get_signals',
        );
      }
      if (
        item.values.length > 0 &&
        (item.from <= 0 ||
          item.until <= item.from ||
          item.until - item.from !== item.values.length * item.step)
      ) {
        throw iodaError(
          JsonRpcErrorCode.SerializationError,
          'upstream_schema',
          'IODA returned inconsistent signal bucket bounds and step.',
          'ioda_get_signals',
          {
            recovery:
              'Call ioda_get_signals with a larger maxPoints or a narrower window; the source bucket intervals were inconsistent.',
          },
        );
      }
    }
    return { series, provenance: result.provenance };
  }

  /** Collect the five evidence components in fixed queue order with partial failures. */
  async getStatusEvidence(
    input: StatusRequest,
    ctx: Context,
    budget: RequestBudget,
  ): Promise<StatusEvidence> {
    const entity = { entityType: input.entityType, entityCode: input.entityCode };
    const window = { from: input.asOf - input.lookbackHours * 3600, until: input.asOf };
    const callerSignal = AbortSignal.any([ctx.signal, ...(budget.signal ? [budget.signal] : [])]);
    const collectionBudget = { ...budget, signal: callerSignal };
    const requests = [
      this.getEvents(
        {
          ...entity,
          ...window,
          includeAlerts: false,
          extendWindowSeconds: 1209600,
          limit: 20,
          page: 0,
        },
        ctx,
        collectionBudget,
      ),
      this.getAlerts(
        { ...entity, ...window, extendWindowSeconds: 0, limit: 100, page: 0 },
        ctx,
        collectionBudget,
      ),
      this.getNumericSignals(
        { ...entity, ...window, source: 'bgp', maxPoints: 2000 },
        ctx,
        collectionBudget,
      ),
      this.getNumericSignals(
        { ...entity, ...window, source: 'ping-slash24', maxPoints: 2000 },
        ctx,
        collectionBudget,
      ),
      this.getNumericSignals(
        { ...entity, ...window, source: 'merit-nt', maxPoints: 2000 },
        ctx,
        collectionBudget,
      ),
    ] as const;
    const outcomes = await Promise.allSettled(requests);
    if (callerSignal.aborted)
      throw iodaError(
        JsonRpcErrorCode.RequestCancelled,
        'request_cancelled',
        'IODA investigation cancelled.',
        'ioda_get_status',
      );
    if (
      outcomes.every((outcome) => outcome.status === 'rejected') &&
      outcomes[0].status === 'rejected'
    )
      throw outcomes[0].reason;
    const namedOutcomes = [
      ['events', outcomes[0]],
      ['alerts', outcomes[1]],
      ['bgp', outcomes[2]],
      ['ping-slash24', outcomes[3]],
      ['merit-nt', outcomes[4]],
    ] as const;
    const components = namedOutcomes.map(([component, outcome], index) => {
      if (outcome.status === 'fulfilled')
        return { component, state: 'ok' as const, provenance: outcome.value.provenance };
      const failure = outcome.reason as McpError;
      const tool =
        component === 'events'
          ? 'ioda_find_outages'
          : component === 'alerts'
            ? 'ioda_get_alerts'
            : 'ioda_get_signals';
      const hint = failure.data?.recovery;
      const recovery =
        typeof hint === 'object' && hint !== null && 'hint' in hint && typeof hint.hint === 'string'
          ? hint.hint
          : `Call ${tool} separately with a narrower window.`;
      return {
        component,
        state: 'failed' as const,
        failure: {
          code: failure.code,
          reason: String(failure.data?.reason ?? 'upstream_unavailable'),
          message: failure.message,
          recovery: `${recovery}${index >= 2 ? ` Use source ${component}.` : ''}`,
        },
      };
    });
    const events = outcomes[0].status === 'fulfilled' ? outcomes[0].value : undefined;
    const alerts = outcomes[1].status === 'fulfilled' ? outcomes[1].value : undefined;
    const signalOutcomes = [
      ['bgp', outcomes[2]],
      ['ping-slash24', outcomes[3]],
      ['merit-nt', outcomes[4]],
    ] as const;
    const signals = signalOutcomes.map(([source, outcome]) => {
      if (outcome.status === 'rejected')
        return { source, coverage: 'unknown' as const, series: [] };
      const result = outcome.value;
      const series = result.series.map((item) => summarizeSeries(item, window, input.asOf));
      return { source, coverage: sourceCoverage(series), series };
    });
    const limitations = [
      'IODA observations describe macroscopic Internet connectivity, not the connectivity of a particular office or user.',
      'IODA observations do not establish a cause or intent.',
      'An absence of detection does not prove healthy connectivity.',
    ];
    if (components.some((component) => component.state === 'failed'))
      limitations.push(
        'Evidence is incomplete because one or more components failed; use the component recovery routes.',
      );
    if (events?.pagination.more === 'possible')
      limitations.push(
        'The event page may be incomplete. Call ioda_find_outages with page 1, limit 20, the same entity and window, includeAlerts false, and extendWindowSeconds 1209600.',
      );
    if (alerts?.pagination.more === 'possible')
      limitations.push(
        'The alert page may be incomplete. Call ioda_get_alerts with page 1, limit 100, the same entity and window, and extendWindowSeconds 0.',
      );
    if (signals.some((item) => item.series.some((series) => series.step !== series.nativeStep)))
      limitations.push(
        'Coarser aggregate buckets cannot establish current coverage; inspect ioda_get_signals with a larger maxPoints or narrower window.',
      );
    if (
      signals.some((item) =>
        item.series.some(
          (series) => series.coverage === 'unknown' && series.nonNullCount + series.nullCount === 0,
        ),
      )
    )
      limitations.push(
        'Nonempty series without completed in-window buckets have unknown coverage because of bucket alignment.',
      );
    if (signals.some((item) => item.coverage === 'stale'))
      limitations.push(
        'Stale means the latest completed native bucket ended more than three native steps before asOf; this server policy is not an upstream SLA.',
      );
    return StatusEvidenceSchema.parse({
      entity,
      asOf: input.asOf,
      window,
      detection: assessDetection(events?.events, alerts?.alerts),
      ...(events && { events: { items: events.events, pagination: events.pagination } }),
      ...(alerts && { alerts: { items: alerts.alerts, pagination: alerts.pagination } }),
      signals,
      components,
      limitations,
    });
  }
}

let service: IodaService | undefined;
/** Initialize the single shared upstream service during application setup. */
export function initIodaService(dependencies: IodaDependencies = {}): void {
  service?.dispose();
  service = new IodaService(dependencies);
}
/** Access the initialized shared service. */
export function getIodaService(): IodaService {
  if (!service)
    throw new Error('IodaService not initialized — call initIodaService() during setup.');
  return service;
}
/** Dispose application-owned pacing state at shutdown. */
export function disposeIodaService(): void {
  service?.dispose();
  service = undefined;
}
