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
  Summary,
  TimeWindow,
} from './schemas.js';

/** Shared absolute invocation deadline in epoch milliseconds. */
export interface RequestBudget {
  deadline: number;
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
/** Entities related to one other entity, sent upstream as relatedTo=<type>/<code>. */
export interface RelatedScope {
  relatedToCode: string;
  relatedToType: EntityType;
}
/** Optional relatedTo scope; requests carry both halves or neither. */
export type ScopeFilter = Partial<RelatedScope>;
/** Canonical resolver request. */
export interface EntitySearch extends PageRequest, ScopeFilter {
  entityCode?: string;
  entityType: EntityType;
  query?: string;
}
/** Canonical event request. */
export interface EventRequest extends PageRequest, EntityFilter, ScopeFilter, TimeWindow {
  extendWindowSeconds: number;
  includeAlerts: boolean;
  source?: Source;
}
/** Canonical alert request. */
export interface AlertRequest extends PageRequest, EntityFilter, ScopeFilter, TimeWindow {
  extendWindowSeconds: number;
  source?: Source;
}
/** Canonical summary request; IODA ranks one entity type at a time. */
export interface SummaryRequest extends PageRequest, ScopeFilter, TimeWindow {
  entityCode?: string;
  entityType: EntityType;
  extendWindowSeconds: number;
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
/** Summary page result, in upstream order. */
export interface SummaryResult {
  pagination: Pagination;
  provenance: Provenance;
  summaries: Summary[];
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
