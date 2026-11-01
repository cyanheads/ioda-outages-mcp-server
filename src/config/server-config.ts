/**
 * @fileoverview Server-specific environment configuration.
 * @module config/server-config
 */
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  clampLimits: z
    .stringbool()
    .default(true)
    .describe(
      'Serve an over-cap limit, maxPoints, lookbackHours, or extendWindowSeconds at its cap with a notice; false rejects it and advertises each cap as the schema maximum',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let parsed: ServerConfig | undefined;
const defaults = ServerConfigSchema.parse({});

/**
 * Parse the server's variables once. Called from `setup()`, after the framework has loaded
 * `.env`, so an invalid value stops startup with the variable named; never call it at import.
 */
export function getServerConfig(): ServerConfig {
  parsed ??= parseEnvConfig(ServerConfigSchema, { clampLimits: 'IODA_CLAMP_LIMITS' });
  return parsed;
}

/**
 * The configuration input schemas read when they are emitted or parsed: what `setup()` parsed,
 * or the schema defaults before it runs. Never parses the environment itself, because `tool()`
 * emits every input schema when its definition module is imported, before Node has loaded `.env`.
 */
export function activeServerConfig(): ServerConfig {
  return parsed ?? defaults;
}
