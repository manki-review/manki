import { LLMClient, NotStartedError } from './providers';
import { digestOf } from './utils';

/** The model calls up to the judge's answer, in the order a round makes them. The finders' own calls are in `FinderReplay`. */
const STORED_CALLS = ['translate', 'dedup', 'judge'] as const;
type StoredCall = typeof STORED_CALLS[number];

/** A call's answer, with a digest of each part of its input by name. A call that failed has no answer. */
interface StoredAnswer {
  input: Record<string, string>;
  answer?: unknown;
}

/** A call between the judge's answer and the vote. A round makes any number of each, partly at the same time. */
type StoredCheckCall = 'refutation' | 'second refutation' | 'origin check' | 'second origin check' | 'sweep' | 'sweep dedup' | 'sweep judge';

/** One such call, with a digest of what it is about, by which a replay finds it. */
interface StoredCheck extends StoredAnswer {
  call: StoredCheckCall;
  target: string;
}

/** The answers of one round. A call the round did not make is `null`. `checks` is unset in a report of a ref that did not store them. */
export type StoredAnswers = Record<StoredCall, StoredAnswer | null> & { checks?: StoredCheck[] };

/** The last stage whose stored answers a replay keeps. */
export type ReplayLevel = 'judge' | 'refuter';

/** Whether `answers` says of every call up to `level` what the round got from it. A check without an answer failed in the round. */
export function holdsEveryCall(answers: StoredAnswers | undefined, level: ReplayLevel = 'judge'): answers is StoredAnswers {
  if (level === 'refuter' && !answers?.checks?.every(check => check.input && check.target)) return false;
  return !!answers && STORED_CALLS.every(call => answers[call] === null || !!answers[call]?.input) && (!answers.judge || answers.judge.answer !== undefined);
}

/** A stored answer that does not fit the call it would replace. Its message names the parts of the input, never their content. */
export class StoredAnswerError extends Error {}

const digests = (parts: Record<string, unknown>): Record<string, string> => Object.fromEntries(Object.entries(parts).map(([name, value]) => [name, digestOf(value ?? null)]));

const differing = (a: Record<string, string>, b: Record<string, string>): string[] => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(name => a[name] !== b[name]);

/** Keeps the answers of a round's calls, or gives those of `stored` up to `level` in place of making the calls. */
export class AnswerStore {
  readonly answers: StoredAnswers & { checks: StoredCheck[] } = { translate: null, dedup: null, judge: null, checks: [] };
  private readonly storedChecks?: StoredCheck[];
  private refused?: StoredAnswerError;

  constructor(private readonly stored?: StoredAnswers, level: ReplayLevel = 'judge') {
    if (level === 'refuter') this.storedChecks = [...stored?.checks ?? []];
  }

  /** Returns the answer of `live`, or the stored one, which must come from the same input `parts`. */
  async ask<T>(call: StoredCall, parts: Record<string, unknown>, live: () => Promise<T>): Promise<T> {
    const input = digests(parts);
    if (!this.stored) {
      this.answers[call] = { input };
      const answer = await live();
      this.answers[call] = { input, answer: structuredClone(answer) };
      return answer;
    }
    const kept = this.stored[call];
    const differs = kept ? differing(input, kept.input) : [];
    if (!kept || differs.length > 0) {
      this.refused = new StoredAnswerError(kept ? `The stored ${call} answer does not fit, since its input differs in: ${differs.join(', ')}.` : `The stored round made no ${call} call, and this one needs its answer.`);
      throw this.refused;
    }
    this.answers[call] = kept;
    if (kept.answer === undefined) throw new Error(`The ${call} call of the stored round failed`);
    return structuredClone(kept.answer) as T;
  }

  /** Returns the answer of `live`, or that of the stored call about the same `target`, which must come from the same input `parts`. */
  async askCheck<T>(call: StoredCheckCall, about: unknown, parts: Record<string, unknown>, live: () => Promise<T>): Promise<T> {
    const [target, input] = [digestOf(about ?? null), digests(parts)];
    if (!this.storedChecks) {
      const check: StoredCheck = { call, target, input };
      this.answers.checks.push(check);
      try {
        const answer = await live();
        check.answer = structuredClone(answer);
        return answer;
      } catch (error) {
        if (error instanceof NotStartedError) this.answers.checks.splice(this.answers.checks.indexOf(check), 1);
        throw error;
      }
    }
    const same = this.storedChecks.filter(check => check.call === call && check.target === target);
    const kept = same.find(check => differing(input, check.input).length === 0);
    if (!kept) {
      this.refused = new StoredAnswerError(same.length > 0
        ? `The stored ${call} answer does not fit, since its input differs in: ${differing(input, same[0].input).join(', ')}.`
        : `The stored round made no such ${call} call, and this one needs its answer.`);
      throw this.refused;
    }
    this.storedChecks.splice(this.storedChecks.indexOf(kept), 1);
    this.answers.checks.push(kept);
    if (kept.answer === undefined) throw new Error(`The ${call} call of the stored round failed`);
    return structuredClone(kept.answer) as T;
  }

  /** Returns `client` with its calls answered through `ask`, or through `askCheck` for a call a round can make more than once. */
  wrap(client: LLMClient, call: StoredCall | 'sweep dedup', model: string): LLMClient {
    return {
      ...client,
      sendMessage: async (system, message, options) => {
        const parts = { 'system prompt': system, message, effort: options?.effort, model };
        const live = () => client.sendMessage(system, message, options).then(reply => reply.content);
        return { content: call === 'sweep dedup' ? await this.askCheck(call, system, parts, live) : await this.ask(call, parts, live) };
      },
    };
  }

  /** Throws the refusal of an earlier `ask`, for a caller that takes a failed call as no answer. */
  check(): void {
    if (this.refused) throw this.refused;
  }
}
