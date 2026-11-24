import type { LLMClient } from './providers';
import { digestOf } from './utils';

/** The model calls that shape what the refuter gets, in the order a round makes them. The finders' own calls are in `FinderReplay`. */
const STORED_CALLS = ['translate', 'dedup', 'judge'] as const;
type StoredCall = typeof STORED_CALLS[number];

/** A call's answer, with a digest of each part of its input by name. A call that failed has no answer. */
interface StoredAnswer {
  input: Record<string, string>;
  answer?: unknown;
}

/** The answers of one round. A call the round did not make is `null`. */
export type StoredAnswers = Record<StoredCall, StoredAnswer | null>;

/** Whether `answers` says of every call what the round got from it. */
export function holdsEveryCall(answers: StoredAnswers | undefined): answers is StoredAnswers {
  return !!answers && STORED_CALLS.every(call => answers[call] === null || !!answers[call]?.input) && (!answers.judge || answers.judge.answer !== undefined);
}

/** A stored answer that does not fit the call it would replace. Its message names the parts of the input, never their content. */
export class StoredAnswerError extends Error {}

/** Keeps the answers of a round's `STORED_CALLS`, or gives those of `stored` in place of making the calls. */
export class AnswerStore {
  readonly answers: StoredAnswers = { translate: null, dedup: null, judge: null };
  private refused?: StoredAnswerError;

  constructor(private readonly stored?: StoredAnswers) {}

  /** Returns the answer of `live`, or the stored one, which must come from the same input `parts`. */
  async ask<T>(call: StoredCall, parts: Record<string, unknown>, live: () => Promise<T>): Promise<T> {
    const input = Object.fromEntries(Object.entries(parts).map(([name, value]) => [name, digestOf(value ?? null)]));
    if (!this.stored) {
      this.answers[call] = { input };
      const answer = await live();
      this.answers[call] = { input, answer: structuredClone(answer) };
      return answer;
    }
    const kept = this.stored[call];
    const differs = kept ? [...new Set([...Object.keys(input), ...Object.keys(kept.input)])].filter(name => input[name] !== kept.input[name]) : [];
    if (!kept || differs.length > 0) {
      this.refused = new StoredAnswerError(kept ? `The stored ${call} answer does not fit, since its input differs in: ${differs.join(', ')}.` : `The stored round made no ${call} call, and this one needs its answer.`);
      throw this.refused;
    }
    this.answers[call] = kept;
    if (kept.answer === undefined) throw new Error(`The ${call} call of the stored round failed`);
    return structuredClone(kept.answer) as T;
  }

  /** Returns `client` with its one call answered through `ask`. */
  wrap(client: LLMClient, call: StoredCall, model: string): LLMClient {
    return {
      ...client,
      sendMessage: async (system, message, options) => ({
        content: await this.ask(call, { 'system prompt': system, message, effort: options?.effort, model }, () => client.sendMessage(system, message, options).then(reply => reply.content)),
      }),
    };
  }

  /** Throws the refusal of an earlier `ask`, for a caller that takes a failed call as no answer. */
  check(): void {
    if (this.refused) throw this.refused;
  }
}
