/**
 * @fileoverview Bundle agent-doc selector tests for the copied packaging scripts:
 * `clean-mcpb.ts` strips dependency agent docs only at a package root, and
 * `lint-packaging.ts` verifies with the same selector, so the MCP SDK's runtime
 * `dist/ext/skills/` modules survive the cleaner and the check.
 * The scripts load by computed URL at run time: a static import would pull them
 * into the `tsc` program, which the server's typecheck does not cover.
 * @module tests/scripts/bundle-agent-docs
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface AgentDocSelector {
  AGENT_DOC_ENTRY: RegExp;
}

const scriptUrl = (name: string) => new URL(`../../scripts/${name}`, import.meta.url);

const cleaner = (await import(scriptUrl('clean-mcpb.ts').href)) as AgentDocSelector & {
  filterAgentDocEntries: (entries: string[]) => string[];
};
const linter = (await import(scriptUrl('lint-packaging.ts').href)) as AgentDocSelector;

const runtimeEntries = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/pkg/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/pkg/lib/skills/loader.js',
  'node_modules/@scope/skills/index.js',
  'node_modules/@scope/pkg/dist/.claude/hooks.js',
];

const agentDocEntries = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/thread-stream/.claude/settings.json',
  'node_modules/pkg/skills/guide/SKILL.md',
  'node_modules/pkg/.agents/skills/guide/SKILL.md',
  'node_modules/@scope/pkg/skills/guide/references/notes.md',
  'node_modules/pkg/node_modules/dep/skills/guide/SKILL.md',
  'node_modules/@scope/pkg/node_modules/@scope/dep/framework-skills/x/SKILL.md',
  'node_modules/pkg/SKILL.md',
  'node_modules/pkg/docs/guide/SKILL.md',
];

describe.each([
  ['clean-mcpb.ts', cleaner],
  ['lint-packaging.ts', linter],
])('%s AGENT_DOC_ENTRY', (_name, script) => {
  it.each(runtimeEntries)('keeps runtime entry %s', (entry) => {
    expect(script.AGENT_DOC_ENTRY.test(entry)).toBe(false);
  });

  it.each(agentDocEntries)('selects agent-doc entry %s', (entry) => {
    expect(script.AGENT_DOC_ENTRY.test(entry)).toBe(true);
  });
});

describe('bundle agent-doc selector pair', () => {
  it('uses one selector in the cleaner and the packaging check', () => {
    expect(linter.AGENT_DOC_ENTRY.source).toBe(cleaner.AGENT_DOC_ENTRY.source);
  });

  it('strips exactly the agent docs from a mixed listing', () => {
    expect(cleaner.filterAgentDocEntries([...runtimeEntries, ...agentDocEntries])).toEqual(
      agentDocEntries,
    );
  });
});

describe('packaging script imports', () => {
  /** Literal relative specifiers `tsc` follows when a test imports the script statically. */
  const relativeSpecifiers = (source: string) =>
    [...source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)'(\.{1,2}\/[^']+)'/g)].map(
      (match) => match[1] as string,
    );

  it.each(['clean-mcpb.ts', 'lint-packaging.ts'])(
    '%s imports by literal specifier only modules that exist in this server',
    (name) => {
      const url = scriptUrl(name);
      const missing = relativeSpecifiers(readFileSync(url, 'utf-8')).filter((specifier) => {
        const target = new URL(specifier, url);
        return ![target, new URL(target.href.replace(/\.js$/, '.ts'))].some(existsSync);
      });
      expect(missing).toEqual([]);
    },
  );
});
