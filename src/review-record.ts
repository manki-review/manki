import { gunzipSync, gzipSync } from 'zlib';

import type { ApprovalRecord, FindingFingerprintEntry, ReplyDecision, ReplyRecord, RoundContext } from './types';
import { COMMENT_MARKER, linesBelow, ownMarker, redactSecretsDeep, sanitizeHtmlCommentJson, sanitizeTokens } from './utils';

/** Opens a round record, plain or compressed. */
const RECORD_OPENER = '<!-- manki-context';
/** Larger than any real record, so a crafted compressed one can't exhaust memory. */
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

/**
 * Returns the round context as a hidden HTML comment: plain JSON when it fits in `room`
 * characters, otherwise gzip compressed and base64 encoded.
 */
export function formatReviewRecord(context: RoundContext, room: number = Infinity): string {
  const json = reviewRecordJson(context);
  const plain = `<!-- manki-context: ${sanitizeHtmlCommentJson(json)} -->`;
  if (plain.length <= room) return plain;
  return `<!-- manki-context-gzip: ${gzipSync(json).toString('base64')} -->`;
}

/** Returns the round context gzip compressed and base64 encoded, as a compressed round record holds it. */
export function compressReviewRecord(context: RoundContext): string {
  return gzipSync(reviewRecordJson(context)).toString('base64');
}

function reviewRecordJson(context: RoundContext): string {
  return recordJson(context.judge.threadEvaluations?.length === 0
    ? { ...context, judge: { ...context.judge, threadEvaluations: undefined } }
    : context);
}

/** Returns a reply-handler run's record as a hidden HTML comment. */
export function formatReplyRecord(record: ReplyRecord): string {
  return `<!-- manki-reply-record: ${sanitizeHtmlCommentJson(recordJson(record))} -->`;
}

/** Returns a review state check's approval decision as a hidden HTML comment. */
export function formatApprovalRecord(record: ApprovalRecord): string {
  return `<!-- manki-approval-record: ${sanitizeHtmlCommentJson(recordJson(record))} -->`;
}

/**
 * Returns the JSON text of the approval record in a review or comment body. Manki writes it last, so an earlier one is
 * quoted text. An approval review writes it below `COMMENT_MARKER`. A notice has no such line.
 */
export function extractApprovalRecords(body: string): string[] {
  const last = ownMarker(body, '<!-- manki-approval-record: ', COMMENT_MARKER);
  return last ? [last] : [];
}

/**
 * Returns the JSON text of the reply record in a comment body. Every reply writes it below `COMMENT_MARKER`, so a body
 * without that line holds none, and a record above the line is quoted text.
 */
export function extractReplyRecords(body: string): string[] {
  const last = body.includes(`\n${COMMENT_MARKER}`) ? ownMarker(body, '<!-- manki-reply-record: ', COMMENT_MARKER) : undefined;
  return last ? [last] : [];
}

/** What a reply record says happened to the thread when Manki accepted a reply of the PR author or of someone with write access. Any other value settles nothing. */
const SETTLING_FATES: ReadonlySet<string> = new Set(['resolves', 'already_resolved']);

/**
 * Returns the decision in the reply record of `body`, one of Manki's own thread replies, when that answer settled the
 * finding. A record that cannot be read, or one whose thread stayed open, settles nothing.
 */
export function settlingDecision(body: string): ReplyDecision | undefined {
  return settlingRecord(body)?.decision;
}

/** Returns the id of the developer's comment that the reply record of `body` answers, when that answer settled the finding. */
export function settledReplyId(body: string): number | undefined {
  const answers = settlingRecord(body)?.answers;
  return typeof answers === 'number' ? answers : undefined;
}

/**
 * Returns the lines of the PR that the settling answer in `body` cited for the statements it checked, each as
 * `path:line` or `path:start-end`, and leaves out a related repo's line. It returns nothing when the answer checked no
 * statement, when it left a statement of the reply unchecked or dropped, or when one of its statements cites no line
 * of the PR, such as one that rests on a search or on the PR description, since a push anywhere can change what that
 * statement rests on.
 */
export function settlingPlaces(body: string): string[] | undefined {
  const record = settlingRecord(body);
  if (record?.uncheckedStatements || record?.droppedStatements) return undefined;
  const own = (record?.statements ?? []).map(s => (s.places ?? []).filter(at => at.split(':').length === 2));
  return own.length > 0 && own.every(places => places.length > 0) ? own.flat() : undefined;
}

function settlingRecord(body: string): (Partial<ReplyRecord> & { decision: ReplyDecision }) | undefined {
  const [text] = extractReplyRecords(body);
  if (!text) return undefined;
  try {
    const record = JSON.parse(text) as Partial<ReplyRecord> | null;
    return record?.decision && SETTLING_FATES.has(record.decision.thread) ? { ...record, decision: record.decision } : undefined;
  } catch {
    return undefined;
  }
}

export const FIXED_MARKER_OPENER = '<!-- manki-fixed:';

/** Marks Manki's reply that confirms a fix on `commitSha`, so a thread gets one such reply per head. */
export function fixedMarker(commitSha: string): string {
  return `${FIXED_MARKER_OPENER}${commitSha} -->`;
}

export const ROUND_REPLY_OPENER = '<!-- manki-round-reply:';

/** Marks a reply in which the review of `commitSha` finds a thread not fixed. */
export function roundReplyMarker(commitSha: string): string {
  return `${ROUND_REPLY_OPENER}${commitSha} -->`;
}

/** Serializes a record with secrets and tokens redacted, since nothing that scans posted text can see inside a compressed one. */
function recordJson(record: object): string {
  return sanitizeTokens(JSON.stringify(redactSecretsDeep(record)));
}

/**
 * Returns `context` without its per-file and per-finding diagnostics, the units of the change and the finders' lines for
 * them, keeping what later rounds read:
 * the findings, thread evaluations, verdict and counts. With `keepTraces`, the raw findings keep their titles, locations,
 * severities and reviewers, and the uses outside the diff keep only names and locations, so a missed defect can still be
 * traced. `meta.omitted` names each field it left out, and `meta.compacted` each field it shortened.
 */
function omitBulkyDiagnostics(context: RoundContext, keepTraces: boolean): RoundContext {
  const { perFile: _perFile, excludedFiles: _excludedFiles, binarySkipped: _binarySkipped, ...diff } = context.diff;
  const { rawFindings, ...reviewersWithLines } = context.reviewers;
  // The units of the change and each finder's lines for them are diagnostics too.
  const unitLines = reviewersWithLines.agentMetrics?.some(m => m.units) ? true : undefined;
  const reviewers = unitLines ? { ...reviewersWithLines, agentMetrics: reviewersWithLines.agentMetrics!.map(({ units: _units, ...metric }) => metric) } : reviewersWithLines;
  const { dropped: _dropped, ...judge } = context.judge;
  const { duplicateMatches: _duplicateMatches, staticSignalMatches: _staticSignalMatches, ...dedup } = context.dedup;
  const uses = context.usesOutsideDiff;
  const traces: Array<[string, unknown]> = [['reviewers.rawFindings', rawFindings], ['usesOutsideDiff', uses]];
  const present: Array<[string, unknown]> = [
    ['diff.perFile', context.diff.perFile], ['diff.excludedFiles', context.diff.excludedFiles], ['diff.binarySkipped', context.diff.binarySkipped],
    ['judge.dropped', context.judge.dropped],
    ['dedup.duplicateMatches', context.dedup.duplicateMatches], ['dedup.staticSignalMatches', context.dedup.staticSignalMatches],
    ['recap.reclassifiedPriors', context.recap?.reclassifiedPriors],
    ['units', context.units], ['reviewers.agentMetrics.units', unitLines],
    ...(keepTraces ? [] : traces),
  ];
  const named = (fields: Array<[string, unknown]>) => fields.filter(([, value]) => value !== undefined).map(([field]) => field);
  const compacted = keepTraces ? named(traces) : [];
  return {
    ...context,
    units: undefined,
    usesOutsideDiff: keepTraces && uses ? { ...uses, ...(uses.types && { types: uses.types.map(t => t.match(/^(.+?:\d+):/)?.[1] ?? t) }) } : undefined,
    meta: { ...context.meta, omitted: named(present), ...(compacted.length > 0 && { compacted }) },
    diff,
    reviewers: keepTraces && rawFindings
      ? { ...reviewers, rawFindings: rawFindings.map(({ title, file, line, severity, reviewers: by }) => ({ title, file, line, severity, reviewers: by })) }
      : reviewers,
    judge,
    dedup,
    ...(context.recap && { recap: { ...context.recap, reclassifiedPriors: undefined } }),
  };
}

/** A part of a round record and the record without it, `undefined` when the record has no such part. */
type RecordCut = [field: string, cut: (context: RoundContext) => RoundContext | undefined];

/** Returns `context` with `strip` applied to each finding it records, or `undefined` when no finding `has` the part it strips. */
function withEntriesCut(context: RoundContext, has: (e: FindingFingerprintEntry) => boolean, strip: (e: FindingFingerprintEntry) => FindingFingerprintEntry): RoundContext | undefined {
  const { entries, unposted, carried } = context.findings;
  if (![...entries, ...unposted ?? [], ...carried ?? []].some(has)) return undefined;
  const cut = (list: FindingFingerprintEntry[]): FindingFingerprintEntry[] => list.map(strip);
  return { ...context, findings: { ...context.findings, entries: cut(entries), ...(unposted && { unposted: cut(unposted) }), ...(carried && { carried: cut(carried) }) } };
}

/** Returns `context` with `field` left out of each finding it records, or `undefined` when no finding has it. */
function withoutEntryField(context: RoundContext, field: 'judgeNotes' | 'refutation' | 'pairRefutation' | 'suggestedFix' | 'evidence'): RoundContext | undefined {
  return withEntriesCut(context, e => e[field] !== undefined, e => ({ ...e, [field]: undefined }));
}

/** Returns `context` without the `fixedElsewhere` line of each origin answer, which no later round reads, or `undefined` when no answer has one. */
function withoutFixedElsewhere(context: RoundContext): RoundContext | undefined {
  return withEntriesCut(context, e => !!e.originCheck?.answers.some(a => a.fixedElsewhere), e => (e.originCheck
    ? { ...e, originCheck: { ...e.originCheck, answers: e.originCheck.answers.map(a => ({ ...a, fixedElsewhere: undefined })) } }
    : e));
}

function withoutSection(key: 'relatedWork' | 'sweeps' | 'staticAnalysis' | 'dependencySources' | 'instructions' | 'slicing' | 'tokenService'
  | 'runner' | 'notStarted' | 'recap' | 'output' | 'comparisons' | 'prClaims' | 'fixes' | 'secondReads' | 'relatedRepos'): RecordCut {
  return [key, c => (c[key] === undefined ? undefined : { ...c, [key]: undefined })];
}

/**
 * The parts a record that is still too large without its diagnostics leaves out, in this order. No later round reads
 * the parts up to `output`. Without `findings.unposted`, a warning left out with `low_importance` is rated again. The
 * parts from `comparisons` to `models.fallbacks` are read only to reuse an attempt, and a cut record is never reused.
 */
const RECORD_CUTS: RecordCut[] = [
  ['usage.llmCalls', c => c.usage.llmCalls && { ...c, usage: { ...c.usage, llmCalls: undefined } }],
  ['findings.entries.judgeNotes', c => withoutEntryField(c, 'judgeNotes')],
  ['memory.suppressed', c => c.memory.suppressed && { ...c, memory: { ...c.memory, suppressed: undefined } }],
  ...(['relatedWork', 'sweeps', 'staticAnalysis', 'dependencySources', 'instructions', 'slicing', 'tokenService', 'runner', 'notStarted', 'recap', 'output'] as const).map(withoutSection),
  ['findings.unposted', c => c.findings.unposted && { ...c, findings: { ...c.findings, unposted: undefined } }],
  ...(['comparisons', 'prClaims', 'fixes', 'secondReads', 'relatedRepos'] as const).map(withoutSection),
  ['reviewers.agentMetrics', c => c.reviewers.agentMetrics && { ...c, reviewers: { ...c.reviewers, agentMetrics: undefined } }],
  ['models.fallbacks', c => c.models.fallbacks && { ...c, models: { ...c.models, fallbacks: undefined } }],
  ['findings.entries.refutation', c => withoutEntryField(c, 'refutation')],
  ['findings.entries.pairRefutation', c => withoutEntryField(c, 'pairRefutation')],
  ['findings.entries.suggestedFix', c => withoutEntryField(c, 'suggestedFix')],
  ['findings.entries.evidence', c => withoutEntryField(c, 'evidence')],
  ['findings.entries.originCheck.fixedElsewhere', withoutFixedElsewhere],
];

/**
 * Returns ever smaller forms of `context` for a record too large for the review. The first two are `omitBulkyDiagnostics`
 * with and without traces, and each later one also leaves out the next part of `RECORD_CUTS` the record has. The last
 * keeps what later rounds need to follow findings and threads: the meta, each finding with its fingerprint, grade,
 * thread and the description a finding without a thread is listed again with, and the judge's thread evaluations. It
 * also keeps each finding's `originCheck`, which stays small since a round makes at most `MAX_ORIGIN_CHECKS`, without
 * the `fixedElsewhere` lines no later round reads. It loses each finding's refuter checks, proposed fix and evidence, so
 * a later round checks such a finding again and its own-proposal check does not see the fix. `meta.omitted` names every
 * part a form left out.
 */
export function* smallerRecords(context: RoundContext): Generator<RoundContext> {
  yield omitBulkyDiagnostics(context, true);
  let cut = omitBulkyDiagnostics(context, false);
  yield cut;
  for (const [field, drop] of RECORD_CUTS) {
    const next = drop(cut);
    if (!next) continue;
    cut = { ...next, meta: { ...next.meta, omitted: [...next.meta.omitted ?? [], field] } };
    yield cut;
  }
}

/** Whether `body` carries a round record. */
export function hasReviewRecord(body: string): boolean {
  return ownMarker(body, RECORD_OPENER) !== undefined;
}

/**
 * Whether Manki itself wrote the flag `marker` in `body`: on a line of its own below the last line that starts with
 * `anchor`, or anywhere when no line does. The text above the anchor quotes code and model text, which can hold a
 * marker. The anchor is the round record in a review body and `COMMENT_MARKER` in a thread reply.
 */
export function hasOwnMarker(body: string, marker: string, anchor = RECORD_OPENER): boolean {
  return linesBelow(body, anchor).some(l => l.trimEnd() === marker);
}

/**
 * Returns the JSON text of the round record in a review body, decompressed when needed, or the
 * error when it can't be decoded. Manki writes the record last, so only the last record
 * counts: an earlier one is quoted text.
 */
export function extractReviewRecords(body: string): { records: string[]; errors: string[] } {
  const last = ownMarker(body, RECORD_OPENER);
  if (last === undefined) return { records: [], errors: [] };
  if (last.startsWith(': ')) return { records: [last.slice(2)], errors: [] };
  try {
    if (!/^-gzip: [A-Za-z0-9+/=]+$/.test(last)) throw new Error('not a round record');
    return { records: [gunzipSync(Buffer.from(last.slice('-gzip: '.length), 'base64'), { maxOutputLength: MAX_RECORD_BYTES }).toString('utf-8')], errors: [] };
  } catch (error) {
    return { records: [], errors: [error instanceof Error ? error.message : String(error)] };
  }
}
