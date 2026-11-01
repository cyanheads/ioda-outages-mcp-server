/**
 * @fileoverview IODA_CLAMP_LIMITS parsing and the pre-setup defaults the input schemas read.
 * @module tests/config/server-config
 */
import { config } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/** A fresh module per case: `getServerConfig()` keeps its first parse for the process. */
async function fresh() {
  vi.resetModules();
  return import('../../src/config/server-config.js');
}
beforeAll(() => {
  /**
   * The framework loads ./.env into process.env on its first config read, once per process, and
   * never over a variable already set. Trigger that load now, so no later read can add
   * IODA_CLAMP_LIMITS between a case's stub and its parse, whatever order the cases run in.
   */
  expect(config.environment).toBeTypeOf('string');
});
afterEach(() => vi.unstubAllEnvs());

describe('IODA_CLAMP_LIMITS', () => {
  it('clamps when unset', async () => {
    vi.stubEnv('IODA_CLAMP_LIMITS', undefined);
    expect((await fresh()).getServerConfig()).toStrictEqual({ clampLimits: true });
  });
  it.each(['false', '0', 'no', 'off', 'FALSE'])('reads %j as strict', async (value) => {
    vi.stubEnv('IODA_CLAMP_LIMITS', value);
    expect((await fresh()).getServerConfig()).toStrictEqual({ clampLimits: false });
  });
  it.each(['true', '1', 'yes', 'on'])('reads %j as clamping', async (value) => {
    vi.stubEnv('IODA_CLAMP_LIMITS', value);
    expect((await fresh()).getServerConfig()).toStrictEqual({ clampLimits: true });
  });
  it.each(['', `\${IODA_CLAMP_LIMITS}`])(
    'reads %j, what a host forwards for an option left blank, as unset',
    async (value) => {
      vi.stubEnv('IODA_CLAMP_LIMITS', value);
      expect((await fresh()).getServerConfig()).toStrictEqual({ clampLimits: true });
    },
  );
  it('fails an unrecognized value with a ConfigurationError naming the variable', async () => {
    vi.stubEnv('IODA_CLAMP_LIMITS', 'maybe');
    const { getServerConfig } = await fresh();
    const error = (() => {
      try {
        getServerConfig();
      } catch (thrown) {
        return thrown;
      }
      return;
    })();
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.ConfigurationError });
    expect((error as McpError).message).toBe(
      'Server config validation failed:\n  - IODA_CLAMP_LIMITS (clampLimits): Invalid option: expected one of "true"|"1"|"yes"|"on"|"y"|"enabled"|"false"|"0"|"no"|"off"|"n"|"disabled"',
    );
  });
  it('parses once: a later change to the variable leaves the parsed mode', async () => {
    vi.stubEnv('IODA_CLAMP_LIMITS', 'false');
    const { getServerConfig } = await fresh();
    expect(getServerConfig()).toStrictEqual({ clampLimits: false });
    vi.stubEnv('IODA_CLAMP_LIMITS', 'true');
    expect(getServerConfig()).toStrictEqual({ clampLimits: false });
  });
  it('serves the defaults before getServerConfig() without reading the environment', async () => {
    // An invalid value: reading it would throw.
    vi.stubEnv('IODA_CLAMP_LIMITS', 'maybe');
    const { activeServerConfig, getServerConfig } = await fresh();
    expect(activeServerConfig()).toStrictEqual({ clampLimits: true });
    vi.stubEnv('IODA_CLAMP_LIMITS', 'false');
    expect(activeServerConfig()).toStrictEqual({ clampLimits: true });
    expect(getServerConfig()).toStrictEqual({ clampLimits: false });
    expect(activeServerConfig()).toStrictEqual({ clampLimits: false });
  });
});
