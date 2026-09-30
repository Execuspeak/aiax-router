import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validate } from '../scripts/build-routing-table.js';
import { adapters } from '../src/adapters/index.js';
import { getPrice } from '../src/core/prices.js';
import { isRoutingTable, loadRoutingTable } from '../src/core/routing-table.js';
import type { Candidate, Category, Difficulty, Effort, RoutingTable } from '../src/core/types.js';

/**
 * The three data files the router ships with, checked against each other.
 * `routing-table.json` is rewritten by a weekly bot pull request and the other
 * two are edited by hand, so the checks here are rules about the data, never a
 * snapshot of today's scores: a routine refresh must keep passing.
 */
const ROOT = join(import.meta.dirname, '..');
const read = <T>(file: string): T =>
  JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as T;

interface Alias {
  provider: string;
  model: string;
}
interface PriceBook {
  providers: Record<
    string,
    { default: { input: number; output: number }; models: Record<string, { input: number; output: number }> }
  >;
}

const table = read<RoutingTable>('routing-table.json');
const aliases = read<{ aliases: Record<string, Alias> }>('model-aliases.json').aliases;
const prices = read<PriceBook>('model-prices.json');

const CATEGORIES: Category[] = [
  'coding',
  'agentic-coding',
  'reasoning',
  'writing',
  'chat',
  'long-context',
];
const DIFFICULTIES: Difficulty[] = ['trivial', 'easy', 'medium', 'hard'];
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh'];
const PROVIDERS = new Set(adapters.map((a) => a.id));

const key = (c: { provider: string; model: string }) => `${c.provider}/${c.model}`;
const allCandidates: Candidate[] = CATEGORIES.flatMap((c) => table.categories[c]);
const routable = new Set(allCandidates.map(key));

// getPrice reads a live-price cache from the config dir first; keep the
// person's own cache out of these checks so only the checked-in book counts.
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aiax-routing-data-'));
  process.env.AIAX_ROUTER_HOME = home;
});
afterEach(() => {
  delete process.env.AIAX_ROUTER_HOME;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('routing-table.json', () => {
  it('passes the gate the router loads it through', () => {
    expect(isRoutingTable(table)).toBe(true);
  });

  it('passes the gate the weekly refresh writes it through', () => {
    expect(() => validate(table)).not.toThrow();
  });

  it('has exactly the categories the router knows, so none is silently ignored', () => {
    expect(Object.keys(table.categories).sort()).toEqual([...CATEGORIES].sort());
  });

  it('has difficulty floors that rise with difficulty and stay on the 0-100 scale', () => {
    const floors = DIFFICULTIES.map((d) => table.difficultyFloor[d]);
    for (const f of floors) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(100);
    }
    for (let i = 1; i < floors.length; i++) {
      expect(floors[i], DIFFICULTIES[i]).toBeGreaterThan(floors[i - 1]);
    }
  });

  it('keeps every candidate inside the ranges selection assumes', () => {
    for (const category of CATEGORIES) {
      for (const c of table.categories[category]) {
        const where = `${category} ${key(c)}`;
        expect(c.score, where).toBeGreaterThanOrEqual(0);
        expect(c.score, where).toBeLessThanOrEqual(100);
        expect(c.costWeight, where).toBeGreaterThanOrEqual(0);
        expect(c.costWeight, where).toBeLessThanOrEqual(5);
        expect(c.tokensPerTask, where).toBeGreaterThan(0);
        if (c.maxEffort !== undefined) expect(EFFORTS, where).toContain(c.maxEffort);
      }
    }
  });

  it('lists each model at most once per category', () => {
    for (const category of CATEGORIES) {
      const keys = table.categories[category].map(key);
      expect(new Set(keys).size, category).toBe(keys.length);
    }
  });

  it('only routes to providers that have an adapter', () => {
    for (const c of allCandidates) expect(PROVIDERS, key(c)).toContain(c.provider);
  });

  it('gives a model the same effort ceiling in every category', () => {
    // maxEffort is what the CLI accepts for that model, not a per-category call.
    const ceiling = new Map<string, Effort | undefined>();
    for (const c of allCandidates) {
      if (!ceiling.has(key(c))) ceiling.set(key(c), c.maxEffort);
      expect(c.maxEffort, key(c)).toBe(ceiling.get(key(c)));
    }
  });

  it('can serve hard work in every category without dropping below the bar', () => {
    for (const category of CATEGORIES) {
      const best = Math.max(...table.categories[category].map((c) => c.score));
      expect(best, category).toBeGreaterThanOrEqual(table.difficultyFloor.hard);
    }
  });
});

describe('model-prices.json', () => {
  it('has a positive default price for every provider it lists', () => {
    for (const [provider, entry] of Object.entries(prices.providers)) {
      expect(PROVIDERS, provider).toContain(provider);
      expect(entry.default.input, provider).toBeGreaterThan(0);
      expect(entry.default.output, provider).toBeGreaterThan(0);
      for (const [model, p] of Object.entries(entry.models)) {
        expect(p.input, `${provider}/${model}`).toBeGreaterThan(0);
        expect(p.output, `${provider}/${model}`).toBeGreaterThan(0);
      }
    }
  });

  it('prices every routable model by name, not just by provider default', () => {
    for (const c of allCandidates) {
      expect(prices.providers[c.provider]?.models?.[c.model], key(c)).toBeDefined();
    }
  });

  it('is what getPrice returns for every routable model when there is no live cache', () => {
    for (const c of allCandidates) {
      expect(getPrice(c.provider, c.model), key(c)).toEqual(
        prices.providers[c.provider].models[c.model],
      );
    }
  });

  it('falls back to the provider default for a model it does not list', () => {
    expect(getPrice('claude', 'some-future-model')).toEqual(prices.providers.claude.default);
    expect(getPrice('no-such-provider', 'x')).toBeNull();
  });
});

describe('model-aliases.json', () => {
  it('maps every leaderboard name onto a model the router can route to', () => {
    // An alias to a model outside the table would add a `needsCuration` row with
    // guessed cost numbers on the next refresh, instead of updating a real one.
    for (const [name, alias] of Object.entries(aliases)) {
      expect(PROVIDERS, name).toContain(alias.provider);
      expect(routable, name).toContain(key(alias));
    }
  });

  it('maps every leaderboard name onto a priced model', () => {
    for (const [name, alias] of Object.entries(aliases)) {
      expect(prices.providers[alias.provider]?.models?.[alias.model], name).toBeDefined();
    }
  });

  // Routable models with no leaderboard alias keep their hand-seeded scores
  // forever, because the weekly refresh has no name to find them under. Each
  // one belongs on this list on purpose, so a new model cannot slip in unaliased.
  const HAND_SCORED_ONLY = new Set(['claude/haiku']);

  it('leaves no routable model unreachable from the leaderboards by accident', () => {
    const aliased = new Set(Object.values(aliases).map(key));
    for (const k of routable) {
      if (HAND_SCORED_ONLY.has(k)) continue;
      expect(aliased, k).toContain(k);
    }
  });

  it('keeps the hand-scored list honest', () => {
    const aliased = new Set(Object.values(aliases).map(key));
    for (const k of HAND_SCORED_ONLY) {
      expect(routable, `${k} is no longer routable; drop it from the list`).toContain(k);
      expect(aliased, `${k} has an alias now; drop it from the list`).not.toContain(k);
    }
  });
});

describe('loadRoutingTable', () => {
  it('loads the bundled table when there is no override', () => {
    expect(loadRoutingTable()).toEqual(table);
  });

  it('prefers a valid override in the config dir', () => {
    const override: RoutingTable = {
      ...table,
      generatedAt: '2030-01-01T00:00:00Z',
    };
    writeFileSync(join(home, 'routing-table.json'), JSON.stringify(override));
    expect(loadRoutingTable().generatedAt).toBe('2030-01-01T00:00:00Z');
  });

  it('ignores a broken override, says so, and keeps routing on the bundled table', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(join(home, 'routing-table.json'), '{"schemaVersion":1,"categories":{}}');
    expect(loadRoutingTable()).toEqual(table);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a valid routing table'));
  });

  it('rejects a table with a candidate missing its numbers', () => {
    const broken = structuredClone(table) as unknown as {
      categories: Record<string, Record<string, unknown>[]>;
    };
    delete broken.categories.chat[0].score;
    expect(isRoutingTable(broken)).toBe(false);
  });

  it('rejects a table with an empty category', () => {
    expect(isRoutingTable({ ...table, categories: { ...table.categories, chat: [] } })).toBe(false);
  });
});
