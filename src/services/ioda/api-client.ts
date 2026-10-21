/**
 * @fileoverview Bounded fixed-origin HTTP exchanges and shared IODA pacing.
 * @module services/ioda/api-client
 */
import { type Context, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createPacer, httpStatusToErrorCode, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { type IodaTool, iodaError } from './errors.js';
import type { Provenance } from './schemas.js';
import type { IodaDependencies, RequestBudget } from './types.js';

const ORIGIN = 'https://api.ioda.inetintel.cc.gatech.edu/v2';
const BODY_BYTES = 2 * 1024 * 1024;
const EnvelopeSchema = z.object({
  error: z.json().optional(),
  data: z.json(),
  metadata: z
    .object({ requestTime: z.json().optional(), responseTime: z.json().optional() })
    .optional(),
  copyright: z.json().optional(),
});

/** Owns one shared queue and the full exchange/parse retry boundary. */
export class IodaApiClient {
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly pacer = createPacer({
    name: 'ioda',
    maxConcurrent: 1,
    minStartGapMs: 2000,
    maxQueueDepth: 20,
  });

  constructor(dependencies: IodaDependencies = {}) {
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.now = dependencies.now ?? Date.now;
  }

  /** Release queued work and the shared pacer's timer at shutdown. */
  dispose(): void {
    this.pacer.dispose();
  }

  async request<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    schema: z.ZodType<T>,
    tool: IodaTool,
    ctx: Context,
    budget: RequestBudget,
  ): Promise<{ data: T; provenance: Provenance }> {
    const signal = AbortSignal.any([ctx.signal, ...(budget.signal ? [budget.signal] : [])]);
    const remaining = budget.deadline - 1000 - this.now();
    if (signal.aborted)
      throw iodaError(
        JsonRpcErrorCode.RequestCancelled,
        'request_cancelled',
        'IODA investigation cancelled.',
        tool,
      );
    if (remaining <= 0)
      throw iodaError(
        JsonRpcErrorCode.Timeout,
        'upstream_timeout',
        'IODA collection deadline expired.',
        tool,
      );
    const url = new URL(`${ORIGIN}${path}`);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value));
    try {
      return await withRetry(
        ({ signal: retrySignal }) =>
          this.pacer.run(
            () => this.attempt(url, path, schema, tool, retrySignal, budget.deadline - 1000),
            { signal: retrySignal },
          ),
        {
          signal,
          deadlineMs: remaining,
          maxRetries: 1,
          baseDelayMs: 2000,
          jitter: 0,
          operation: 'IodaRequest',
          context: ctx,
          isTransient: (error) =>
            error instanceof McpError &&
            (error.code === JsonRpcErrorCode.ServiceUnavailable || error.data?.status === 504),
        },
      );
    } catch (error) {
      if (signal.aborted)
        throw iodaError(
          JsonRpcErrorCode.RequestCancelled,
          'request_cancelled',
          'IODA investigation cancelled.',
          tool,
        );
      if (error instanceof McpError) {
        if (error.data?.reason === 'pacer_shed')
          throw iodaError(
            JsonRpcErrorCode.RateLimited,
            'upstream_queue_full',
            'IODA upstream request queue is full.',
            tool,
          );
        if (error.code === JsonRpcErrorCode.Timeout)
          throw iodaError(
            JsonRpcErrorCode.Timeout,
            'upstream_timeout',
            'IODA collection timed out.',
            tool,
          );
        throw error;
      }
      throw iodaError(
        JsonRpcErrorCode.ServiceUnavailable,
        'upstream_unavailable',
        'IODA network request failed.',
        tool,
      );
    }
  }

  private async attempt<T>(
    url: URL,
    path: string,
    schema: z.ZodType<T>,
    tool: IodaTool,
    signal: AbortSignal,
    deadline: number,
  ): Promise<{ data: T; provenance: Provenance }> {
    if (signal.aborted || this.now() >= deadline) {
      throw iodaError(
        JsonRpcErrorCode.Timeout,
        'upstream_timeout',
        'IODA collection deadline expired before dispatch.',
        tool,
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(0, Math.min(10_000, deadline - this.now())),
    );
    const combined = AbortSignal.any([signal, controller.signal]);
    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () =>
          reject(
            iodaError(
              JsonRpcErrorCode.Timeout,
              'upstream_timeout',
              'IODA exchange timed out or was cancelled.',
              tool,
            ),
          );
        if (combined.aborted) onAbort();
        else combined.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([this.exchange(url, path, schema, tool, combined), aborted]);
    } finally {
      clearTimeout(timeout);
      if (onAbort) combined.removeEventListener('abort', onAbort);
    }
  }

  private async exchange<T>(
    url: URL,
    path: string,
    schema: z.ZodType<T>,
    tool: IodaTool,
    signal: AbortSignal,
  ): Promise<{ data: T; provenance: Provenance }> {
    let response: Response;
    try {
      response = await this.fetch(url, {
        signal,
        redirect: 'manual',
        headers: {
          Accept: 'application/json',
          'User-Agent':
            'ioda-outages-mcp-server (+https://github.com/cyanheads/ioda-outages-mcp-server)',
        },
      });
    } catch {
      throw iodaError(
        JsonRpcErrorCode.ServiceUnavailable,
        'upstream_unavailable',
        'IODA network request failed.',
        tool,
      );
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const status = response.status;
      const reason =
        status === 400
          ? 'upstream_bad_request'
          : status === 422
            ? 'upstream_unprocessable'
            : status === 404
              ? 'entity_not_found'
              : status === 429
                ? 'upstream_rate_limited'
                : status === 401
                  ? 'upstream_unauthorized'
                  : status === 403
                    ? 'upstream_forbidden'
                    : status === 408 || status === 504
                      ? 'upstream_timeout'
                      : 'upstream_unavailable';
      const retryAfter = response.headers.get('retry-after');
      throw iodaError(
        httpStatusToErrorCode(status) ?? JsonRpcErrorCode.ServiceUnavailable,
        reason,
        `IODA returned HTTP ${status}.`,
        tool,
        { status, ...(retryAfter !== null && { retryAfter }) },
      );
    }
    let text: string;
    try {
      text = await readBoundedBody(response, signal, tool);
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw iodaError(
        JsonRpcErrorCode.ServiceUnavailable,
        'upstream_unavailable',
        'IODA response stream failed.',
        tool,
      );
    }
    if (/^\s*<(?:!doctype\s+html|html[\s>])/i.test(text))
      throw iodaError(
        JsonRpcErrorCode.ServiceUnavailable,
        'upstream_unavailable',
        'IODA returned an HTML service error.',
        tool,
      );
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw iodaError(
        JsonRpcErrorCode.SerializationError,
        'upstream_schema',
        'IODA returned invalid JSON.',
        tool,
      );
    }
    const envelope = EnvelopeSchema.safeParse(raw);
    if (!envelope.success)
      throw iodaError(
        JsonRpcErrorCode.SerializationError,
        'upstream_schema',
        'IODA returned an invalid response envelope.',
        tool,
      );
    if (
      envelope.data.error !== undefined &&
      envelope.data.error !== null &&
      envelope.data.error !== ''
    )
      throw iodaError(
        JsonRpcErrorCode.InvalidParams,
        'upstream_bad_request',
        'IODA rejected the request in its response envelope.',
        tool,
      );
    const parsed = schema.safeParse(envelope.data.data);
    if (!parsed.success)
      throw iodaError(
        JsonRpcErrorCode.SerializationError,
        'upstream_schema',
        'IODA response records did not match the expected schema.',
        tool,
      );
    const metadata = envelope.data.metadata;
    return {
      data: parsed.data,
      provenance: {
        endpoint: `${ORIGIN}${path}`,
        fetchedAt: new Date(this.now()).toISOString(),
        ...(metadata?.requestTime !== undefined && { requestTime: metadata.requestTime }),
        ...(metadata?.responseTime !== undefined && { responseTime: metadata.responseTime }),
        ...(envelope.data.copyright !== undefined && { copyright: envelope.data.copyright }),
      },
    };
  }
}

async function readBoundedBody(
  response: Response,
  signal: AbortSignal,
  tool: IodaTool,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  let size = 0;
  const chunks: Uint8Array[] = [];
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted)
        throw iodaError(
          JsonRpcErrorCode.Timeout,
          'upstream_timeout',
          'IODA body collection timed out or was cancelled.',
          tool,
        );
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_BYTES) {
        cancel();
        throw iodaError(
          JsonRpcErrorCode.ValidationError,
          'response_too_large',
          'IODA response exceeded the 2 MiB upstream body budget.',
          tool,
        );
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
