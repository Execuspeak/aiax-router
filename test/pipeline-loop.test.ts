import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Adapter } from '../src/adapters/types.js';
import { runPipeline, type PipelineEvent } from '../src/core/pipeline.js';
import { MIN_JUDGE, PASS_MARK, reviewPanel } from '../src/core/review.js';
import type { Classification, RoutingTable } from '../src/core/types.js';

/**
 * The edges of the review loop and of the one-pass path that test/pipeline.test.ts
 * leaves open: when the loop has to stop early, how hard the round cap is, and
 * what a plain question costs when the first model falls over. Runs against the
 * shipped routing table so the path is the one a real install takes.
 */
const ROOT = join(import.meta.dirname, '..');
const TABLE = JSON.parse(readFileSync(join(ROOT, 'routing-table.json'), 'utf8')) as RoutingTable;
const PROVIDERS = ['claude', 'codex', 'grok', 'kimi'];

const REVIEW = 'You are one of five reviewers';
const REVISE = 'Reviewers found the problems listed below';
const LIGHT = 'Answer the question below properly';

let home: string;
let seen: { id: string; prompt: string }[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aiax-pipeline-loop-'));
  process.env.AIAX_ROUTER_HOME = home;
  seen = [];
});
afterEach(() => {
  delete process.env.AIAX_ROUTER_HOME;
  rmSync(home, { recursive: true, force: true });
});

/** null means the CLI fails on that prompt. */
type Script = (id: string, prompt: string) => string | null;

function fakes(script: Script): Adapter[] {
  return PROVIDERS.map((id) => ({
    id,
    displayName: id,
    binary: id,
    subscriptionName: `${id} plan`,
    detect: async () => ({ installed: true }),
    authStatus: async () => ({ loggedIn: true, loginHint: id }),
    async *run(task: string) {
      seen.push({ id, prompt: task });
      const text = script(id, task);
      if (text === null) {
        yield { type: 'error' as const, message: 'not today' };
        yield { type: 'result' as const, ok: false, text: '' };
        return;
      }
      yield { type: 'result' as const, ok: true, text };
    },
  }));
}

/** Reviewers score each round from `rounds`; the last value repeats. */
function reviewing(rounds: number[], opts: { revise?: boolean } = {}): Script {
  let calls = 0;
  return (id, prompt) => {
    if (prompt.includes(REVIEW)) {
      const score = rounds[Math.min(Math.floor(calls++ / 5), rounds.length - 1)];
      return JSON.stringify({ score, note: 'needs work', gaps: score >= 10 ? [] : ['Fix it.'] });
    }
    if (prompt.includes(REVISE)) return opts.revise === false ? null : `REVISED ${calls}`;
    return `WORK FROM ${id}`;
  };
}

const FULL: Classification = {
  category: 'chat',
  difficulty: 'easy',
  rationale: 'fixture',
  via: 'heuristic',
  weight: 'full',
};

async function run(
  task: string,
  script: Script,
  opts: Parameters<typeof runPipeline>[1] = {},
): Promise<{ lines: string[]; done: Extract<PipelineEvent, { type: 'done' }> }> {
  const events: PipelineEvent[] = [];
  for await (const ev of runPipeline(task, {
    adapters: fakes(script),
    table: TABLE,
    available: new Set(PROVIDERS),
    simple: true,
    ...opts,
  })) {
    events.push(ev);
  }
  const done = events.at(-1);
  if (!done || done.type !== 'done') throw new Error('pipeline never finished');
  const lines = events.flatMap((e) => (e.type === 'progress' ? [e.message] : []));
  return { lines, done };
}

const count = (needle: string) => seen.filter((s) => s.prompt.includes(needle)).length;

describe('review loop: when it stops', () => {
  it('stops after one round, without a fix pass, when no reviewer can be reached', async () => {
    const script: Script = (id, prompt) => (prompt.includes(REVIEW) ? null : `WORK FROM ${id}`);
    const { lines, done } = await run('explain routing', script, { classification: FULL });

    expect(done.rounds).toBe(1);
    expect(count(REVISE)).toBe(0);
    expect(done.outcome?.reviewed).toBe(false);
    expect(done.state.status).toBe('needs-work');
    expect(lines).toContain('No review agent was free just now, so nothing has checked this.');
  });

  it('stops and keeps the reviewed work when the fix pass itself fails', async () => {
    const { lines, done } = await run('explain routing', reviewing([8], { revise: false }), {
      classification: FULL,
    });

    expect(done.rounds).toBe(1);
    expect(done.outcome?.average).toBe(8);
    expect(done.answer).not.toMatch(/^REVISED/);
    expect(done.state.status).toBe('needs-work');
    expect(lines.at(-1)).toBe('That fixing pass did not work out, so this is where it stands.');
  });

  it('never runs fewer than one round, however low maxRounds is set', async () => {
    const { done } = await run('explain routing', reviewing([8]), {
      classification: FULL,
      maxRounds: 0,
    });

    expect(done.rounds).toBe(1);
    expect(count(REVIEW)).toBe(5);
    expect(count(REVISE)).toBe(0);
  });

  it('never runs more than ten rounds, however high maxRounds is set', async () => {
    // Improving every round but never passing: only the hard cap can stop it.
    const climbing = [5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.2, 9.3, 9.4];
    const { done } = await run('explain routing', reviewing(climbing), {
      classification: FULL,
      maxRounds: 99,
    });

    expect(done.rounds).toBe(10);
    expect(count(REVIEW)).toBe(50);
    expect(count(REVISE)).toBe(9);
    expect(done.outcome?.average).toBe(9.2);
    expect(done.outcome?.passed).toBe(false);
  });

  it('returns the best round, not the last one, when it runs out of rounds', async () => {
    const { done } = await run('explain routing', reviewing([7, 8, 7.5]), {
      classification: FULL,
      maxRounds: 3,
    });

    // Round 3 is the last one allowed and scored below round 2, so the work
    // round 2 approved of (the first revision) is what comes back.
    expect(done.rounds).toBe(3);
    expect(done.outcome?.average).toBe(8);
    expect(done.answer).toBe('REVISED 5');
    expect(done.state.reviewRounds.map((r) => r.average)).toEqual([7, 8, 7.5]);
  });
});

describe('review panel: the single-judge veto', () => {
  const panel = (low: number) =>
    reviewPanel({
      intent: 'Explain routing.',
      acceptanceCriteria: ['One sentence.'],
      work: 'A router picks a model.',
      category: 'chat',
      difficulty: 'easy',
      available: new Set(PROVIDERS),
      table: TABLE,
      adapters: fakes((_id, prompt) =>
        JSON.stringify({
          score: prompt.includes('Your lens is correctness') ? low : 10,
          note: 'n',
          gaps: [],
        }),
      ),
    });

  it(`fails work that averages above ${PASS_MARK} when one judge sits at ${MIN_JUDGE}`, async () => {
    const outcome = await panel(MIN_JUDGE);
    expect(outcome.average).toBeGreaterThanOrEqual(PASS_MARK);
    expect(outcome.passed).toBe(false);
  });

  it(`passes it once that judge is just above ${MIN_JUDGE}`, async () => {
    const outcome = await panel(MIN_JUDGE + 0.1);
    expect(outcome.passed).toBe(true);
  });
});

describe('a plain question: one model, one pass', () => {
  // The fakes answer the classifier with prose, so classification falls back to
  // the offline heuristic, exactly as it does when no cheap model is free.
  const answering = () => seen.filter((s) => s.prompt.includes(LIGHT));

  it('is classified light and answered once by the strongest chat model', async () => {
    const { done } = await run('What is the capital of Norway?', (id) => `ANSWER FROM ${id}`);

    const strongest = [...TABLE.categories.chat].sort((a, b) => b.score - a.score)[0];
    expect(answering().map((s) => s.id)).toEqual([strongest.provider]);
    expect(done.answer).toBe(`ANSWER FROM ${strongest.provider}`);
    expect(done.outcome).toBeNull();
    expect(done.rounds).toBe(0);
    expect(count(REVIEW)).toBe(0);
    expect(count(REVISE)).toBe(0);
  });

  it('hands the question to the next model when the first one fails, still answering once', async () => {
    const strongest = [...TABLE.categories.chat].sort((a, b) => b.score - a.score)[0];
    const { done, lines } = await run(
      'What is the capital of Norway?',
      (id, prompt) => (prompt.includes(LIGHT) && id === strongest.provider ? null : `ANSWER FROM ${id}`),
    );

    const tried = answering().map((s) => s.id);
    expect(tried).toHaveLength(2);
    expect(tried[0]).toBe(strongest.provider);
    expect(done.ok).toBe(true);
    expect(done.answer).toBe(`ANSWER FROM ${tried[1]}`);
    expect(done.state.results).toHaveLength(1);
    expect(done.state.results[0].provider).toBe(tried[1]);
    expect(lines.some((l) => l.includes('could not finish this'))).toBe(true);
    expect(count(REVIEW)).toBe(0);
  });

  it('reports failure honestly, with no review, when nobody can answer', async () => {
    const { done } = await run('What is the capital of Norway?', (id, prompt) =>
      prompt.includes(LIGHT) ? null : `ANSWER FROM ${id}`,
    );

    expect(done.ok).toBe(false);
    expect(done.answer).toBe('');
    expect(done.state.status).toBe('needs-work');
    // Failover gives up after three attempts, not one per installed tool.
    expect(answering()).toHaveLength(3);
    expect(count(REVIEW)).toBe(0);
  });
});
