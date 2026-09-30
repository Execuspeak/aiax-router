import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyHeuristic } from '../src/core/classify.js';
import { EFFORT_BY_DIFFICULTY, select } from '../src/core/select.js';
import type {
  Candidate,
  Category,
  Classification,
  Difficulty,
  Effort,
  RoutingTable,
  Weight,
} from '../src/core/types.js';

/**
 * select() against the table that actually ships, for every category,
 * difficulty and weight. These are the rules the README promises, checked as
 * properties rather than as today's picks, so the weekly table refresh can
 * move the winners around without touching this file.
 */
const ROOT = join(import.meta.dirname, '..');
const table = JSON.parse(readFileSync(join(ROOT, 'routing-table.json'), 'utf8')) as RoutingTable;

const CATEGORIES = Object.keys(table.categories) as Category[];
const DIFFICULTIES: Difficulty[] = ['trivial', 'easy', 'medium', 'hard'];
const WEIGHTS: Weight[] = ['light', 'full'];
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh'];
const ALL = new Set(CATEGORIES.flatMap((c) => table.categories[c].map((x) => x.provider)));
const full = () => 1;

// select() honours a pinned model from config.json; never read the real one.
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aiax-select-shipped-'));
  process.env.AIAX_ROUTER_HOME = home;
});
afterEach(() => {
  delete process.env.AIAX_ROUTER_HOME;
  rmSync(home, { recursive: true, force: true });
});

function cls(category: Category, difficulty: Difficulty, weight: Weight): Classification {
  return { category, difficulty, weight, rationale: 'fixture', via: 'heuristic' };
}

/** The ROI the README describes: quality per unit of subscription spent. */
function roi(c: Candidate): number {
  return c.score / (c.tokensPerTask * Math.max(c.costWeight, 0.25));
}

const find = (category: Category, provider: string, model: string) =>
  table.categories[category].find((c) => c.provider === provider && c.model === model);

const cases = CATEGORIES.flatMap((category) =>
  DIFFICULTIES.flatMap((difficulty) =>
    WEIGHTS.map((weight) => ({ category, difficulty, weight })),
  ),
);

describe('select on the shipped table', () => {
  it.each(cases)('$weight $difficulty $category: a sound decision', ({ category, difficulty, weight }) => {
    const decision = select({
      classification: cls(category, difficulty, weight),
      table,
      available: ALL,
      headroom: full,
    });
    expect(decision).not.toBeNull();
    if (!decision) return;

    const picked = find(category, decision.provider, decision.model);
    expect(picked, 'picked a model from its own category').toBeDefined();
    if (!picked) return;

    // Effort comes from difficulty, and never exceeds what the model accepts.
    expect(EFFORTS).toContain(decision.effort);
    if (picked.maxEffort) {
      expect(EFFORTS.indexOf(decision.effort)).toBeLessThanOrEqual(EFFORTS.indexOf(picked.maxEffort));
    }
    if (weight === 'full' && !picked.maxEffort) {
      expect(decision.effort).toBe(EFFORT_BY_DIFFICULTY[difficulty]);
    }

    // Every category has something above the hard floor, so nothing is below the bar.
    expect(picked.score).toBeGreaterThanOrEqual(table.difficultyFloor[difficulty]);
    expect(decision.rationale).not.toContain('below the ideal bar');

    // Alternatives are other models, at most two, and never the pick itself.
    expect(decision.rankedAlternatives.length).toBeLessThanOrEqual(2);
    for (const alt of decision.rankedAlternatives) {
      expect(`${alt.provider}/${alt.model}`).not.toBe(`${decision.provider}/${decision.model}`);
    }

    // Shown to the user: one sentence, no em dashes (a product rule).
    expect(decision.rationale).toMatch(/\.$/);
    expect(decision.rationale).not.toContain('—');
  });

  it.each(CATEGORIES)('full work in %s goes to the best ROI that clears the floor', (category) => {
    for (const difficulty of DIFFICULTIES) {
      const decision = select({
        classification: cls(category, difficulty, 'full'),
        table,
        available: ALL,
        headroom: full,
      });
      const adequate = table.categories[category].filter(
        (c) => c.score >= table.difficultyFloor[difficulty],
      );
      const bestRoi = Math.max(...adequate.map(roi));
      const picked = find(category, decision!.provider, decision!.model)!;
      expect(roi(picked), `${difficulty} ${category}`).toBe(bestRoi);
    }
  });

  it.each(CATEGORIES)('a light question in %s goes to the strongest model there', (category) => {
    const strongest = Math.max(...table.categories[category].map((c) => c.score));
    for (const difficulty of DIFFICULTIES) {
      const decision = select({
        classification: cls(category, difficulty, 'light'),
        table,
        available: ALL,
        headroom: full,
      });
      const picked = find(category, decision!.provider, decision!.model)!;
      expect(picked.score, `${difficulty} ${category}`).toBe(strongest);
      // Nothing reviews a light answer, so it never gets the lowest effort.
      expect(decision!.effort).not.toBe('low');
    }
  });

  it('moves off the ROI winner when its provider is nearly out of quota', () => {
    for (const category of CATEGORIES) {
      const first = select({
        classification: cls(category, 'medium', 'full'),
        table,
        available: ALL,
        headroom: full,
      })!;
      const second = select({
        classification: cls(category, 'medium', 'full'),
        table,
        available: ALL,
        headroom: (p) => (p === first.provider ? 0.01 : 1),
      })!;
      expect(second.provider, category).not.toBe(first.provider);
      expect(second.rationale).not.toMatch(/quota/);
    }
  });

  it('falls back to the strongest remaining model, and says so, when none clears the bar', () => {
    // Only kimi signed in: it scores under the hard floor everywhere today, and
    // the rule holds for any provider whose best score is under the floor.
    for (const category of CATEGORIES) {
      const kimi = table.categories[category].filter((c) => c.provider === 'kimi');
      if (!kimi.length || kimi.some((c) => c.score >= table.difficultyFloor.hard)) continue;
      const decision = select({
        classification: cls(category, 'hard', 'full'),
        table,
        available: new Set(['kimi']),
        headroom: full,
      })!;
      expect(decision.provider).toBe('kimi');
      expect(decision.rationale).toContain('below the ideal bar');
    }
  });

  it('returns null when nothing in the category is signed in', () => {
    expect(
      select({
        classification: cls('coding', 'easy', 'full'),
        table,
        available: new Set(['not-a-provider']),
        headroom: full,
      }),
    ).toBeNull();
  });
});

describe('a plain question, end to end through the offline classifier', () => {
  it.each([
    'What is the capital of Norway?',
    'which laptop should I buy for travel?',
    'Hvorfor er himmelen blå?',
  ])('%s is one light pass on the strongest model', (task) => {
    const classification = classifyHeuristic(task);
    expect(classification.weight).toBe('light');

    const decision = select({ classification, table, available: ALL, headroom: full })!;
    const strongest = Math.max(...table.categories[classification.category].map((c) => c.score));
    expect(find(classification.category, decision.provider, decision.model)!.score).toBe(strongest);
    expect(decision.rationale).toContain('one pass is all it gets');
  });

  it('keeps a request with a deliverable off the light path', () => {
    const classification = classifyHeuristic('Write a blog post about routing tables');
    expect(classification.weight).toBe('full');
    const decision = select({ classification, table, available: ALL, headroom: full })!;
    expect(decision.rationale).not.toContain('one pass is all it gets');
  });
});
