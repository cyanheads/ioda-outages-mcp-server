/**
 * @fileoverview IODA service request and result types.
 * @module services/ioda/types
 */
import type {
  Alert,
  Entity,
  EntityReference,
  EntityType,
  Event,
  NumericSeries,
  NumericSource,
  Pagination,
  Provenance,
  Source,
  TimeWindow,
} from './schemas.js';

/** Shared absolute invocation deadline in epoch milliseconds. */
export interface RequestBudget {
  deadline: number;
  signal?: AbortSignal;
}
/** Zero-based upstream page request. */
export interface PageRequest {
  limit: number;
  page: number;
}
/** Optional upstream entity scope. */
export interface EntityFilter {
  entityCode?: string;
  entityType?: EntityType;
}
/** Canonical resolver request. */
export interface EntitySearch extends PageRequest {
  entityCode?: string;
  entityType: EntityType;
  query?: string;
}
/** Canonical event request. */
export interface EventRequest extends PageRequest, EntityFilter, TimeWindow {
  extendWindowSeconds: number;
  includeAlerts: boolean;
  source?: Source;
}
/** Canonical alert request. */
export interface AlertRequest extends PageRequest, EntityFilter, TimeWindow {
  extendWindowSeconds: number;
  source?: Source;
}
/** Canonical single-source signal request. */
export interface SignalRequest extends EntityReference, TimeWindow {
  maxPoints: number;
  source: NumericSource;
}
/** Captured status clock and lookback window. */
export interface StatusRequest extends EntityReference {
  asOf: number;
  lookbackHours: number;
}
/** Resolver result. */
export interface EntityResult {
  entities: Entity[];
  pagination: Pagination;
  provenance: Provenance;
}
/** Event page result. */
export interface EventResult {
  events: Event[];
  pagination: Pagination;
  provenance: Provenance;
}
/** Alert page result. */
export interface AlertResult {
  alerts: Alert[];
  pagination: Pagination;
  provenance: Provenance;
}
/** Raw numeric signal result, before tool-level semantics. */
export interface SignalResult {
  provenance: Provenance;
  series: NumericSeries[];
}
/** Injectable network and clock seam; origin and policy remain fixed. */
export interface IodaDependencies {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}
