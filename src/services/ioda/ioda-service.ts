/**
 * @fileoverview Fixed-origin, paced and bounded IODA evidence collection.
 * @module services/ioda/ioda-service
 */
import { type Context, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { IodaApiClient } from './api-client.js';
import { cancelledError, type IodaTool, iodaError } from './errors.js';
import {
  AlertSchema,
  EntitySchema,
  EventSchema,
  NumericSeriesSchema,
  type NumericSource,
  type Pagination,
  type Provenance,
  SOURCE_UNITS,
  type StatusEvidence,
  SummarySchema,
} from './schemas.js';
import {
  assessDetection,
  PUBLICATION_ALLOWANCE_SECONDS,
  sourceCoverage,
  summarizeSeries,
} from './status.js';
import type {
  AlertRequest,
  AlertResult,
  EntityResult,
  EntitySearch,
  EventRequest,
  EventResult,
  IodaDependencies,
  RequestBudget,
  ScopeFilter,
  SignalRequest,
  SignalResult,
  StatusRequest,
  SummaryRequest,
  SummaryResult,
} from './types.js';

/** The largest maxPoints one signal request serves; status requests it. */
export const MAX_POINTS = 2000;
/** Fixed component requests behind ioda_get_status, echoed by the tool as applied inputs. */
export const STATUS_REQUESTS = {
  events: { limit: 20, page: 0, includeAlerts: false, extendWindowSeconds: 1209600 },
  alerts: { limit: 100, page: 0, extendWindowSeconds: 0 },
  signals: { maxPoints: MAX_POINTS },
} as const;

type StatusComponent = StatusEvidence['components'][number];

/** A full page may have more records; only a continuable request advertises nextPage. */
function pagination(page: number, limit: number, returned: number, continuable = true): Pagination {
  const full = returned >= limit;
  return {
    page,
    limit,
    returned,
    more: full ? 'possible' : 'no',
    ...(full && continuable && { nextPage: page + 1 }),
  };
}
/** IODA's relatedTo parameter; requests carry both scope halves or neither. */
function relatedTo({ relatedToType, relatedToCode }: ScopeFilter): string | undefined {
  return relatedToType && `${relatedToType}/${relatedToCode}`;
}

/** One status component outcome; a failure keeps its classified reason and standalone route. */
function componentOutcome(
  component: StatusComponent['component'],
  tool: IodaTool,
  outcome: PromiseSettledResult<{ provenance: Provenance }>,
): StatusComponent {
  if (outcome.status === 'fulfilled')
    return { component, state: 'ok', provenance: outcome.value.provenance };
  const failure = outcome.reason as McpError;
  const hint = failure.data?.recovery;
  const recovery =
    typeof hint === 'object' && hint !== null && 'hint' in hint && typeof hint.hint === 'string'
      ? hint.hint
      : `Call ${tool} separately with a narrower window.`;
  return {
    component,
    state: 'failed',
    failure: {
      code: failure.code,
      reason: String(failure.data?.reason ?? 'upstream_unavailable'),
      message: failure.message,
      recovery: `${recovery}${tool === 'ioda_get_signals' ? ` Use source ${component}.` : ''}`,
    },
  };
}

/**
 * The signal failure naming an unknown entity: IODA has no metadata for it on a numeric source,
 * and no component returned an event, alert, or series. Detections for such a code come back
 * empty rather than failing, so they never contradict it.
 */
function unknownEntity(
  events: PromiseSettledResult<EventResult>,
  alerts: PromiseSettledResult<AlertResult>,
  signals: readonly PromiseSettledResult<SignalResult>[],
): McpError | undefined {
  const returned =
    (events.status === 'fulfilled' && events.value.events.length > 0) ||
    (alerts.status === 'fulfilled' && alerts.value.alerts.length > 0) ||
    signals.some((outcome) => outcome.status === 'fulfilled' && outcome.value.series.length > 0);
  if (returned) return undefined;
  const missing = signals.find(
    (outcome): outcome is PromiseRejectedResult =>
      outcome.status === 'rejected' &&
      (outcome.reason as McpError).data?.reason === 'entity_not_found',
  );
  return missing?.reason as McpError | undefined;
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
        relatedTo: relatedTo(input),
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
        relatedTo: relatedTo(input),
        datasource: input.source,
        includeAlerts: input.includeAlerts,
        ignoreMethods: input.ignoreMethods?.length ? input.ignoreMethods.join(',') : undefined,
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

  /**
   * Fetch one page of IODA's per-entity summary in its own order (descending overall score).
   * No datasource or orderBy is sent: the endpoint has no source filter, and its default order
   * is the ranking. Scoped summary pages continue, unlike scoped alerts.
   */
  async getSummary(
    input: SummaryRequest,
    ctx: Context,
    budget: RequestBudget,
  ): Promise<SummaryResult> {
    const result = await this.client.request(
      '/outages/summary',
      {
        from: input.from,
        until: input.until,
        entityType: input.entityType,
        entityCode: input.entityCode,
        relatedTo: relatedTo(input),
        ignoreMethods: input.ignoreMethods?.length ? input.ignoreMethods.join(',') : undefined,
        extendWindow: input.extendWindowSeconds,
        limit: input.limit,
        page: input.page,
      },
      z.array(SummarySchema),
      'ioda_summarize_outages',
      ctx,
      budget,
    );
    return {
      summaries: result.data,
      pagination: pagination(input.page, input.limit, result.data.length),
      provenance: result.provenance,
    };
  }

  /**
   * Fetch one original alert-transition page with literal levels and baselines. IODA offsets a
   * scoped request's related-entity list by page, so a scoped page has no continuation.
   */
  async getAlerts(input: AlertRequest, ctx: Context, budget: RequestBudget): Promise<AlertResult> {
    const scope = relatedTo(input);
    const result = await this.client.request(
      '/outages/alerts',
      {
        from: input.from,
        until: input.until,
        entityType: input.entityType,
        entityCode: input.entityCode,
        relatedTo: scope,
        ignoreMethods: input.ignoreMethods?.length ? input.ignoreMethods.join(',') : undefined,
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
      pagination: pagination(input.page, input.limit, result.data.length, !scope),
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
            // A larger maxPoints is a lever only below the served cap; status already requests it.
            recovery: `Call ioda_get_signals with ${input.maxPoints < MAX_POINTS ? `a larger maxPoints (up to ${MAX_POINTS}) or ` : ''}a narrower window; the source bucket intervals were inconsistent.`,
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
    const numericSignals = (source: NumericSource) =>
      this.getNumericSignals(
        { ...entity, ...window, source, ...STATUS_REQUESTS.signals },
        ctx,
        budget,
      );
    const outcomes = await Promise.allSettled([
      this.getEvents({ ...entity, ...window, ...STATUS_REQUESTS.events }, ctx, budget),
      this.getAlerts({ ...entity, ...window, ...STATUS_REQUESTS.alerts }, ctx, budget),
      numericSignals('bgp'),
      numericSignals('ping-slash24'),
      numericSignals('merit-nt'),
    ]);
    if (ctx.signal.aborted) throw cancelledError('ioda_get_status');
    const [eventOutcome, alertOutcome, bgp, probing, telescope] = outcomes;
    const signalOutcomes = [
      ['bgp', bgp],
      ['ping-slash24', probing],
      ['merit-nt', telescope],
    ] as const;
    const missing = unknownEntity(eventOutcome, alertOutcome, [bgp, probing, telescope]);
    if (missing) {
      const status = missing.data?.status;
      throw iodaError(
        JsonRpcErrorCode.NotFound,
        'entity_not_found',
        missing.message,
        'ioda_get_status',
        typeof status === 'number' ? { status } : {},
      );
    }
    if (
      eventOutcome.status === 'rejected' &&
      outcomes.every((outcome) => outcome.status === 'rejected')
    )
      throw eventOutcome.reason;
    const components = [
      componentOutcome('events', 'ioda_find_outages', eventOutcome),
      componentOutcome('alerts', 'ioda_get_alerts', alertOutcome),
      ...signalOutcomes.map(([source, outcome]) =>
        componentOutcome(source, 'ioda_get_signals', outcome),
      ),
    ];
    const events = eventOutcome.status === 'fulfilled' ? eventOutcome.value : undefined;
    const alerts = alertOutcome.status === 'fulfilled' ? alertOutcome.value : undefined;
    const signals = signalOutcomes.map(([source, outcome]) => {
      const unit = SOURCE_UNITS[source];
      if (outcome.status === 'rejected')
        return { source, unit, coverage: 'unknown' as const, series: [] };
      const series = outcome.value.series.map((item) => summarizeSeries(item, window, input.asOf));
      return { source, unit, coverage: sourceCoverage(series), series };
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
        `The event page may be incomplete. Call ioda_find_outages with page 1, limit ${STATUS_REQUESTS.events.limit}, the same entity and window, includeAlerts false, and extendWindowSeconds ${STATUS_REQUESTS.events.extendWindowSeconds}.`,
      );
    if (alerts?.pagination.more === 'possible')
      limitations.push(
        `The alert page may be incomplete. Call ioda_get_alerts with page 1, limit ${STATUS_REQUESTS.alerts.limit}, the same entity and window, and extendWindowSeconds ${STATUS_REQUESTS.alerts.extendWindowSeconds}.`,
      );
    if (signals.some((item) => item.series.some((series) => series.step !== series.nativeStep)))
      limitations.push(
        'Coarser aggregate buckets cannot establish current coverage: upstream aggregates underlying samples, so values need not equal an unweighted mean of finer returned buckets and non-null aggregates cannot establish complete finer-resolution coverage. Inspect ioda_get_signals over a narrower window.',
      );
    if (
      signals.some((item) =>
        item.series.some(
          (series) =>
            series.coverage === 'unknown' &&
            series.nonNullCount + series.nullCount + series.pendingCount === 0,
        ),
      )
    )
      limitations.push(
        'Nonempty series without completed in-window buckets have unknown coverage because of bucket alignment.',
      );
    if (signals.some((item) => item.coverage === 'stale'))
      limitations.push(
        `Stale means the latest completed bucket ended more than the ${PUBLICATION_ALLOWANCE_SECONDS}-second publication allowance before asOf; this server policy is not an upstream SLA.`,
      );
    return {
      entity,
      asOf: input.asOf,
      window,
      detection: assessDetection(events?.events, alerts?.alerts),
      ...(events && { events: { items: events.events, pagination: events.pagination } }),
      ...(alerts && { alerts: { items: alerts.alerts, pagination: alerts.pagination } }),
      signals,
      components,
      limitations,
    };
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
