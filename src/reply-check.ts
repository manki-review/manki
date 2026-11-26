import * as core from '@actions/core';
import type { getOctokit } from '@actions/github';

import { RunCancelledError } from './abort';
import { addedLines, changesNextTo, listedFilesDiff, oldLineOf, parsePRDiff, replacementOf } from './diff';
import { inline, MAX_COMPARE_FILES, sanitizeMarkdown, UnknownChange } from './github';
import { extractJSON } from './json';
import { findLines } from './mcp-server';
import { sanitizeLogOutput } from './providers';
import { AGAINST_HEADING, namedPullRequests, STATEMENTS_HEADING } from './recap';
import { isDiffLocation, locationFile, locationLines, shownLines } from './refute';
import { fetchedRelatedRepos } from './related-repos';
import { parseProof } from './review';
import { leadingRelatedCitation, MAX_QUOTED_RANGE } from './static-signals';
import { DiffFile, ParsedDiff, RelatedRepoTools, ReplyStatementRecord, UncheckedReason } from './types';
import { redactSecrets, safeTruncate, sanitizeTokens } from './utils';

type Octokit = ReturnType<typeof getOctokit>;

const REPLY_OUTCOMES = ['Fixed', 'FixedElsewhere', 'Withdrawn', 'Agreed', 'Kept', 'Unverified'] as const;
type AnswerOutcome = typeof REPLY_OUTCOMES[number];

/** How many statements of one reply Manki checks and lists. */
export const MAX_REPLY_STATEMENTS = 5;
const MAX_PLACES = 3;
const MAX_QUOTE_CHARS = 160;
/** The shortest and longest text Manki searches for, or looks up in the PR description. */
export const MIN_TERM_CHARS = 3;
export const MAX_TERM_CHARS = 200;

const UNREADABLE_ANSWER = 'I could not check this reply.';
const NO_FIXING_PR = 'The reply names no other pull request of this repository that I could check.';

const UNKNOWN_CHANGES: Record<UnknownChange, string> = {
  not_descendant: 'This branch was rebased or force pushed since the finding was posted, so I cannot tell which lines changed.',
  unreadable: 'I could not read what this PR changed since the finding was posted.',
};

/** Why no line can show a fix after a rebase. */
const REBASED_ANSWER = 'This branch was rebased or force pushed since the finding was posted, so a reply can\'t settle it.';

/**
 * Returns the model's text of an unsettled answer with a lead-in when it opens with an outcome word, such as "Fixed by the guard", which the
 * readers of a reply would take as its outcome. `answer` must be the sanitized text, since sanitizing can uncover the word.
 */
export function withoutOutcomeOpener(answer: string): string {
  return /^(?:fixed|agreed|withdrawn|kept|unverified|confirmed)\b/i.test(answer.replace(/^[^A-Za-z0-9]+/, '')) ? `My reading: ${answer}` : answer;
}

/**
 * Returns the line that leads an answer that settles nothing: the bold state, then `why`. The state asks a maintainer to
 * decide, and to resolve the thread when it is open. A resolved thread that holds nothing gets no ask.
 */
export function unsettledLead(thread: ThreadState, why = ''): string {
  const state = thread === 'resolved' ? 'Not settled by this reply.' : `Not settled yet: a maintainer should decide${thread === 'open' ? ' and resolve this thread' : ''}.`;
  return `**${state}**${why && ` ${why}`}`;
}

/**
 * Returns the line that leads an unproven "Fixed": the bold state, then why no line counts the fix. Only an open thread
 * whose file a review reads hears of the next review. An open guarded thread gets no ask, since the note below the answer
 * names who closes it.
 */
function unsettledAnswer(scope: FixScope, thread: ThreadState): string {
  const { rebased, guarded, reviewable } = scope;
  const why = unprovenFix(scope, thread);
  if (thread === 'open' && reviewable) return `**Not settled yet: the next review ${rebased ? '' : 'after a push '}checks the fix.** ${why}`;
  return guarded && thread === 'open' ? `**Not settled yet.** ${why}` : unsettledLead(thread, why);
}

/** How many raw proof entries of the model the reply record keeps, and how much of each. */
const MAX_CITED_ENTRIES = 10;
const MAX_CITED_CHARS = 200;

/**
 * How an answer leaves its thread: `open`, or `resolved` and holding nothing. `undefined` when it stays resolved and still
 * holds something, or was not read, as on a merged or closed PR.
 */
export type ThreadState = 'open' | 'resolved' | undefined;

/** Where a reply counts a fix of its finding. */
export interface FixScope {
  /** The finding's file and the files it cited, whose change `changedSincePosted` holds. */
  files: readonly string[];
  /** Whether a review reads the thread's file: it is tied to one, and `closed_paths` does not close that file. */
  reviewable: boolean;
  /** Why the change there is not known. Unset when it is. */
  unknown?: UnknownChange;
  /** Set on an open PR whose branch was rebased or force pushed since the finding was posted. */
  rebased?: true;
  /** The commit of the round that still found the thread open, when the change counts from there. */
  openOn?: string;
  /** Whether the thread is a blocking or security one. What clears it is said apart from this answer. */
  guarded: boolean;
}

/**
 * Returns the sentences that follow the state of an unproven "Fixed": where a reply counts a fix, or why no line could
 * count, and on an open thread a review reads that is not guarded what the next review reads.
 */
function unprovenFix({ files, reviewable, unknown, rebased, openOn, guarded }: FixScope, thread: ThreadState): string {
  const since = openOn ? `since the review of ${inline(openOn.slice(0, 7))} still found this open` : 'since this was posted';
  const where = files.length === 0 ? 'This finding is not tied to a file, so a reply cannot show a fix.'
    : rebased ? REBASED_ANSWER
      : unknown ? UNKNOWN_CHANGES[unknown]
        : `I could not point to a line this PR changed in ${files.map(inline).join(', ')} ${since}. A reply counts a fix only there.`;
  return thread === 'open' && reviewable && !guarded && !rebased ? `${where} The next review after a push checks the whole push, also other files.` : where;
}

/** What the reply's cited lines and searches are checked against. */
export interface ReplySources {
  /** The checkout of the PR head, when the reply had one. */
  workspace?: string;
  /** The related repos the reply's tools could read. Only a repo they fetched counts. */
  related?: RelatedRepoTools;
  /** The configured related repos, by `owner/name`. A line cited in one is never read as a line of the PR. */
  relatedNames: readonly string[];
  /** The PR's diff. Without a checkout, only a line inside it counts as a line of the PR. */
  diff?: ParsedDiff;
  /** The PR's description as fetched for this reply. Unset when it could not be read. */
  description?: string;
  /** The PR's repository as `owner/name`. Without it, a reply names no pull request that fixes the finding. */
  repo?: string;
  /** The PR's own number, which never fixes its finding elsewhere. */
  pr?: number;
  /** What an unproven "Fixed" says about where a reply counts one. */
  fixScope?: FixScope;
  /**
   * What the PR changed since the thread was posted, in the finding's file and the files it cited, by `readChangesSince`.
   * A "Fixed" counts only when its proof cites a line one of these adds. Unset when that change could not be read.
   */
  changedSincePosted?: readonly DiffFile[];
}

/** What Manki's own look at the PR description showed: the text it holds, or the text it does not hold in any letter case. */
type DescriptionCheck = { holds: string } | { lacks: string };

/** A search Manki ran itself and that found no line. */
interface EmptySearch {
  term: string;
  /** `owner/name` of the related repo searched. Unset for the PR's repository. */
  repo?: string;
  /** The paths the related repo is limited to, so the search saw only those. */
  paths?: string[];
  /** Files the search left out: binary ones and ones over the size limit. */
  skipped: number;
}

/** One statement of the developer's reply, as Manki checked it. */
export interface CheckedStatement {
  /** The developer's words, with whitespace collapsed. */
  quote: string;
  status: ReplyStatementRecord['status'];
  /** The lines the status rests on, each one checked to exist. */
  places: string[];
  search?: EmptySearch;
  /** Set when the status rests on the PR description instead of a line or a search of the code. */
  description?: DescriptionCheck;
  why?: UncheckedReason;
  /** The term of a search that found a line or text of the PR description, or the repo a search could not read, for the reason shown. */
  detail?: string;
}

export interface CheckedReply {
  /**
   * The answer as "Outcome. text", which is what the reply handler goes on with. An `unsettled` answer is the model's own
   * text, which `withoutOutcomeOpener` has to check once it is sanitized.
   */
  text: string;
  /**
   * Set for an answer that settles nothing, whose `text` names no outcome. Returns the line that goes above it, which says
   * who decides on the thread as the answer leaves it. The readers of the reply take it as "Unverified."
   */
  unsettled?: (thread: ThreadState) => string;
  /** The outcome `text` opens with. */
  outcome: AnswerOutcome;
  /** The outcome the model gave before the checks. Unset when its answer could not be read. */
  modelOutcome?: AnswerOutcome;
  /** Whether the developer's reply needs an answer of its own, by the model. Only an explicit no from a readable answer is false. */
  needsAnswer: boolean;
  /** The entries of the model's proof as it gave them, at most `MAX_CITED_ENTRIES`, each redacted and cut. */
  cited: string[];
  /** The answer without its outcome. Empty when the model's answer could not be read. */
  answer: string;
  /** The lines of the PR's own repository in the answer's proof that exist. */
  proof: string[];
  /**
   * The pull request the developer's reply names and the model says fixes the finding. `text` then says that this is not
   * confirmed, until `checkFixedElsewhere` confirms it.
   */
  fixedIn?: number;
  statements: CheckedStatement[];
  /** Statements of the reply past `MAX_REPLY_STATEMENTS`, which were not checked. */
  unchecked: number;
  /** Entries whose quote is not in the developer's reply, or repeats an earlier one. They are not shown. */
  dropped: number;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Returns the lines of the new file that `file` adds, and the lines right before and after each removal. */
function changedLineNumbers(file: DiffFile): Set<number> {
  const lines = new Set(addedLines(file).keys());
  for (const hunk of file.hunks) {
    let next = hunk.newStart;
    for (const content of hunk.content.split('\n')) {
      if (content.startsWith('\\')) continue;
      if (!content.startsWith('-')) next++;
      else lines.add(next - 1).add(next);
    }
  }
  return lines;
}

/**
 * Whether `location` cites a line that one of `changed` adds, or a line right next to code it removes. A range over
 * `MAX_QUOTED_RANGE` lines counts only when every line in it is such a line, since a wide range holds an unrelated
 * change as easily as a fix.
 */
export function citesChangedLine(location: string, changed: readonly DiffFile[] = []): boolean {
  const file = changed.find(f => f.path === locationFile(location));
  if (!file) return false;
  const [start, end] = locationLines(location);
  const cited = [...changedLineNumbers(file)].filter(line => line >= start && line <= end).length;
  return end - start + 1 <= MAX_QUOTED_RANGE ? cited > 0 : cited === end - start + 1;
}

/**
 * Returns the lines of `cited` that exist: `own` in the PR's checkout, `related` in a related checkout the reply
 * fetched. Without a checkout, a line of the PR counts only inside the diff, and no related line counts.
 */
function shownPlaces(cited: unknown, sources: ReplySources): { own: string[]; related: string[] } {
  if (sources.workspace) {
    const { proof, relatedProof } = shownLines(cited, sources.workspace, sources.related);
    return { own: proof, related: relatedProof };
  }
  return { own: ownCitations(cited, sources.relatedNames, undefined).filter(location => isDiffLocation(location, sources.diff)), related: [] };
}

/** Returns the locations `cited` names in the PR's repository. An entry that starts with a related repo's line is not one. */
function ownCitations(cited: unknown, relatedNames: readonly string[], workspace: string | undefined): string[] {
  return parseProof(Array.isArray(cited) ? cited.filter(entry => typeof entry !== 'string' || !leadingRelatedCitation(entry, relatedNames)) : cited, workspace);
}

/** Returns why no line of `cited` could be shown to exist. */
function unshownReason(cited: unknown, sources: ReplySources): { why: UncheckedReason; detail?: string } {
  const related = Array.isArray(cited) ? cited.flatMap(entry => (typeof entry === 'string' ? leadingRelatedCitation(entry, sources.relatedNames) ?? [] : [])) : [];
  if (related.length === 0 && ownCitations(cited, sources.relatedNames, sources.workspace).length === 0) return { why: 'no_line' };
  // Without a checkout only a line inside the diff can be read, so whether the others exist is unknown.
  if (!sources.workspace) return { why: 'no_checkout' };
  const fetched = sources.related ? fetchedRelatedRepos(sources.related.stateDir) : new Map<string, string>();
  const unfetched = related.find(citation => !fetched.has(citation.repo));
  return unfetched ? { why: 'not_fetched', detail: unfetched.repo } : { why: 'no_line' };
}

/**
 * Searches for `term` as plain text, ignoring case, in the PR's checkout, or in the related checkout `repo`. Returns the search when it
 * found no line and saw every file it could reach. Anything else returns why the search confirms nothing.
 */
function emptySearch(term: string, repo: unknown, sources: ReplySources): EmptySearch | { why: UncheckedReason; detail?: string } {
  const text = term.trim();
  if (text.length < MIN_TERM_CHARS || text.length > MAX_TERM_CHARS || /[\r\n]/.test(text)) return { why: 'search_term' };
  const named = typeof repo === 'string' && repo ? repo : undefined;
  if (named && !sources.relatedNames.includes(named)) return { why: 'not_related' };
  if (!sources.workspace) return { why: 'no_checkout' };
  const configured = named ? sources.related?.repos.find(r => r.repo === named) : undefined;
  const root = named ? sources.related && fetchedRelatedRepos(sources.related.stateDir).get(named) : sources.workspace;
  if (!root) return { why: 'not_fetched', detail: named };
  let found;
  try {
    found = findLines(root, { text, maxResults: 1, ignoreCase: true });
  } catch {
    return { why: 'search_failed' };
  }
  if (found.matches.length > 0) return { why: 'search_found', detail: text };
  if (found.cut) return { why: 'search_cut' };
  return { term: text, ...(configured && { repo: configured.repo }), ...(configured?.paths && { paths: configured.paths }), skipped: found.skipped };
}

/**
 * Checks a statement about the PR description against `description`, the text as fetched. `absent` is text the
 * statement says is gone, and counts when the description does not hold it, ignoring case. `cited` is text the
 * statement rests on, and counts when the description holds it. Both compare with whitespace collapsed.
 */
function checkDescription(cited: string, absent: string, description: string | undefined): DescriptionCheck | { why: UncheckedReason; detail?: string } {
  if (description === undefined) return { why: 'description_unread' };
  const body = collapse(description);
  const inLimits = (text: string) => text.length >= MIN_TERM_CHARS && text.length <= MAX_TERM_CHARS;
  if (absent) {
    if (!inLimits(absent)) return { why: 'search_term' };
    return body.toLowerCase().includes(absent.toLowerCase()) ? { why: 'description_found', detail: absent } : { lacks: absent };
  }
  return inLimits(cited) && body.includes(cited) ? { holds: cited } : { why: 'description_text' };
}

function checkStatement(entry: Record<string, unknown>, quote: string, sources: ReplySources): CheckedStatement {
  const status = entry.status;
  if (status === 'confirmed' || status === 'contradicted') {
    const text = (value: unknown) => (typeof value === 'string' ? collapse(value) : '');
    const absent = status === 'confirmed' ? text(entry.description_search) : '';
    const cited = text(entry.description);
    // The PR author wrote the description, so only Manki's own look at the fetched text decides a statement about it.
    if (absent || cited) {
      const shown = checkDescription(cited, absent, sources.description);
      return 'why' in shown ? { quote, status: 'not_checkable', places: [], ...shown } : { quote, status, places: [], description: shown };
    }
  }
  // A statement that something exists nowhere has no line to cite, so the search alone decides it, and Manki runs it.
  if (status === 'confirmed' && typeof entry.search === 'string' && entry.search.trim()) {
    const search = emptySearch(entry.search, entry.repo, sources);
    return 'term' in search ? { quote, status: 'confirmed', places: [], search } : { quote, status: 'not_checkable', places: [], ...search };
  }
  if (status === 'confirmed' || status === 'contradicted') {
    const { own, related } = shownPlaces(entry.places, sources);
    const places = [...own, ...related].slice(0, MAX_PLACES);
    return places.length > 0 ? { quote, status, places } : { quote, status: 'not_checkable', places: [], ...unshownReason(entry.places, sources) };
  }
  // The model may say that the description was not shown, which counts only when Manki could not read it.
  const why = entry.why === 'outside_code' || entry.why === 'not_reachable' ? entry.why
    : entry.why === 'description_unread' && sources.description === undefined ? entry.why : 'no_line';
  return { quote, status: 'not_checkable', places: [], why };
}

/**
 * Reads the model's structured answer to `developerReply` and checks it in code. Returns the answer as plain
 * "Outcome. text", or for an "Unverified." the model's text with the line that leads it, and the statements whose quote
 * is in `developerReply`.
 *
 * An outcome can only become "Unverified.", never anything else: when the answer is not the JSON asked for, when a
 * "Withdrawn" has no line of the PR's own repository in `proof`, and when a "Fixed" cites no line there that
 * `changedSincePosted` adds. A "FixedElsewhere" is "Unverified." too, with `fixedIn` set when `developerReply` names that
 * pull request, for `checkFixedElsewhere` to confirm. No statement's status changes the outcome.
 */
export function checkReply(content: string, developerReply: string, sources: ReplySources): CheckedReply {
  const unreadable: CheckedReply = { text: '', unsettled: thread => unsettledLead(thread, UNREADABLE_ANSWER), outcome: 'Unverified', needsAnswer: true, cited: [], answer: '', proof: [], statements: [], unchecked: 0, dropped: 0 };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(extractJSON(content, 'object')) as Record<string, unknown>;
  } catch {
    return unreadable;
  }
  const outcome = REPLY_OUTCOMES.find(o => o === parsed.outcome);
  const answer = typeof parsed.answer === 'string' ? parsed.answer.trim().replace(/^\**(?:Fixed|FixedElsewhere|Withdrawn|Agreed|Kept|Unverified)\.\**\s*/, '') : '';
  if (!outcome || !answer) return unreadable;

  const said = collapse(developerReply);
  const entries = (Array.isArray(parsed.statements) ? parsed.statements : []).filter((e): e is Record<string, unknown> => !!e && typeof e === 'object');
  const quoted = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    const quote = typeof entry.quote === 'string' ? collapse(entry.quote) : '';
    if (quote && said.includes(quote) && !quoted.has(quote)) quoted.set(quote, entry);
  }
  const statements = [...quoted].slice(0, MAX_REPLY_STATEMENTS).map(([quote, entry]) => checkStatement(entry, quote, sources));

  const { own } = shownPlaces(parsed.proof, sources);
  // A fix is a change, so only a line the PR changed since the thread was posted can show one.
  const unproven = outcome === 'Withdrawn' ? own.length === 0 : outcome === 'Fixed' && !own.some(at => citesChangedLine(at, sources.changedSincePosted));
  // Only a pull request the developer's own words name is checked, so the model cannot pick one.
  const fixedIn = outcome === 'FixedElsewhere' && sources.repo && typeof parsed.fixed_in === 'number' && parsed.fixed_in !== sources.pr && namedPullRequests(developerReply, sources.repo).includes(parsed.fixed_in)
    ? parsed.fixed_in : undefined;
  // A fix in another pull request stays unconfirmed until `checkFixedElsewhere` confirms it.
  const settled: AnswerOutcome = unproven || outcome === 'FixedElsewhere' ? 'Unverified' : outcome;
  const why = unproven ? `I could not point to a line of this repository that shows ${outcome === 'Fixed' ? 'the fix' : 'the finding is wrong'}.`
    : outcome === 'FixedElsewhere' ? NO_FIXING_PR : '';
  const fixScope = unproven && outcome === 'Fixed' ? sources.fixScope : undefined;
  return {
    text: settled === 'Unverified' ? answer : `${settled}. ${answer}`,
    ...(settled === 'Unverified' && { unsettled: (thread: ThreadState) => fixScope ? unsettledAnswer(fixScope, thread) : unsettledLead(thread, why) }),
    outcome: settled,
    modelOutcome: outcome,
    needsAnswer: parsed.needs_answer !== false,
    cited: rawEntries(parsed.proof),
    answer,
    proof: own,
    ...(fixedIn !== undefined && { fixedIn }),
    statements,
    unchecked: Math.max(0, quoted.size - MAX_REPLY_STATEMENTS),
    dropped: entries.length - quoted.size,
  };
}

/** Returns the model's proof entries for the record. Each one is redacted before it is cut, since a cut secret matches no pattern. */
function rawEntries(proof: unknown): string[] {
  const entries: unknown[] = Array.isArray(proof) ? proof : proof === undefined || proof === null ? [] : [proof];
  return entries.slice(0, MAX_CITED_ENTRIES)
    .map(entry => safeTruncate(redactSecrets(sanitizeTokens(typeof entry === 'string' ? entry : JSON.stringify(entry))), MAX_CITED_CHARS));
}

const UNCHECKED_REASONS: Record<UncheckedReason, (detail: string) => string> = {
  outside_code: () => 'the review model says code cannot show it',
  not_reachable: () => 'the review model could not read the code that would show it',
  no_line: () => 'no cited line was found in the code that was read',
  search_term: () => `a search needs one line of ${MIN_TERM_CHARS} to ${MAX_TERM_CHARS} characters`,
  not_related: () => 'the repository to search is not a configured related repository',
  not_fetched: repo => `${inline(repo)} was not fetched`,
  no_checkout: () => 'this run had no checkout to read',
  search_failed: () => 'the search failed',
  search_found: term => `a search for ${inline(term)} found a line`,
  search_cut: () => 'the search did not reach every file',
  description_unread: () => 'the PR description could not be read',
  description_text: () => `the PR description does not hold a cited text of ${MIN_TERM_CHARS} to ${MAX_TERM_CHARS} characters`,
  description_found: term => `the PR description holds ${inline(term)}, ignoring case`,
};

/** Returns the developer's words for display: cut after the check that they are in the reply, with the cut marked. */
function shownQuote(quote: string): string {
  const cut = [...quote].slice(0, MAX_QUOTE_CHARS).join('');
  return `"${sanitizeMarkdown(cut.length < quote.length ? `${cut.trimEnd()}…` : quote)}"`;
}

/** Says what a search covered. It reads as what Manki searched, never as whether the developer is right. */
function searchLine({ term, repo, paths, skipped }: EmptySearch): string {
  const scope = [
    ...(paths ? [`only ${paths.map(inline).join(', ')} of that repository is fetched`] : []),
    ...(skipped > 0 ? [`${skipped} ${skipped === 1 ? 'file' : 'files'} not searched: binary or over 1 MB`] : []),
  ];
  return `No line of ${repo ? inline(repo) : 'this repository'} holds ${inline(term)}, ignoring case${scope.length > 0 ? ` (${scope.join(', ')})` : ''}`;
}

/** Says what Manki's look at the PR description showed. It reads as what the description holds, never as whether the developer is right. */
function descriptionLine(shown: DescriptionCheck, status: CheckedStatement['status']): string {
  return 'lacks' in shown
    ? `The PR description does not hold ${inline(shown.lacks)}, ignoring case`
    : `The PR description holds ${inline(shown.holds)}, cited ${status === 'confirmed' ? 'for' : 'against'} it`;
}

function statementLine(s: CheckedStatement): string {
  const what = s.description ? descriptionLine(s.description, s.status)
    : s.search ? searchLine(s.search)
    : s.status === 'not_checkable' ? `Not checked, ${UNCHECKED_REASONS[s.why ?? 'outside_code'](s.detail ?? '')}`
      : `${s.places.length === 1 ? 'Line' : 'Lines'} cited ${s.status === 'confirmed' ? 'for' : 'against'} it ${s.places.length === 1 ? 'exists' : 'exist'} at ${s.places.map(inline).join(', ')}`;
  return `- ${what}: ${shownQuote(s.quote)}`;
}

/** Returns the list of checked statements, or `undefined` when the reply listed none. */
export function statementList({ statements, unchecked }: CheckedReply): string | undefined {
  if (statements.length === 0) return undefined;
  const lines = statements.map(statementLine);
  const more = unchecked > 0 ? [`- ${unchecked} more ${unchecked === 1 ? 'statement' : 'statements'} not checked: a reply gets at most ${MAX_REPLY_STATEMENTS}.`] : [];
  return [STATEMENTS_HEADING, ...lines, ...more].join('\n');
}

/**
 * Returns the sentence below the list: what the checks covered. With `blocks`, the finding keeps blocking after this
 * answer, or its thread could not be read, and the sentence leaves the decision to a maintainer. It never says that a
 * finding is cleared, settled or wrong.
 */
export function statementSummary({ statements, unchecked }: CheckedReply, blocks: boolean): string {
  const contradicted = statements.find(s => s.status === 'contradicted');
  const open = unchecked > 0 || statements.some(s => s.status === 'not_checkable');
  const checks = contradicted ? `I cited ${contradicted.description ? 'text of the PR description' : 'a line'} against at least one of these statements.`
    : open ? 'I could not check every one of these statements.'
      : 'Each line says what I checked, not that the statement is right.';
  if (!blocks) return checks;
  return `${checks} ${open ? 'A maintainer has to judge the unchecked ones, and what the statements mean for this finding.' : 'What they mean for this finding is for a maintainer to decide.'}`;
}

/** Says how many statements were checked, how many of those have something cited against them, and how many were not checked. */
function foldSummary({ statements, unchecked }: CheckedReply): string {
  const count = (status: CheckedStatement['status']): number => statements.filter(s => s.status === status).length;
  const against = count('contradicted');
  const open = count('not_checkable') + unchecked;
  const checked = count('confirmed') + against;
  const named = (n: number): string => `${n} ${n === 1 ? 'statement' : 'statements'}`;
  if (checked === 0) return `${named(open)} not checked`;
  return [`${named(checked)} checked`, ...(against ? [`evidence cited against ${against}`] : []), ...(open ? [`${open} not checked`] : [])].join(', ');
}

/**
 * Returns the `statementList` in a closed fold as Manki posts it below the answer, each part a paragraph of its own, or
 * nothing when the reply listed none. A statement Manki cited something against also shows above the fold. The `statementSummary` is in the fold too,
 * unless it leaves something to a maintainer, as with `blocks`. `withoutStatementFold` reads it back.
 */
export function statementFold(checked: CheckedReply, blocks: boolean): string[] {
  const list = statementList(checked);
  if (!list) return [];
  const against = checked.statements.filter(s => s.status === 'contradicted').map(statementLine);
  const summary = statementSummary(checked, blocks);
  return [
    ...(against.length > 0 ? [[AGAINST_HEADING, ...against].join('\n')] : []),
    `<details>\n<summary>${foldSummary(checked)}</summary>\n\n${blocks ? list : `${list}\n\n${summary}`}\n\n</details>`,
    ...(blocks ? [summary] : []),
  ];
}

/** Returns what the reply record keeps of the checked statements: no words of the developer, no search term and no text of the PR description. */
export function statementRecords({ statements }: CheckedReply): ReplyStatementRecord[] {
  return statements.map(s => ({
    status: s.status,
    ...(s.places.length > 0 && { places: s.places }),
    ...(s.search && { searched: s.search.repo ?? 'pr' }),
    ...(s.description && { description: 'lacks' in s.description ? 'absent' as const : 'held' as const }),
    ...(s.why && { why: s.why }),
  }));
}

/** What `checkFixedElsewhere` reads and asks about another pull request's fix of a finding. */
export interface ElsewhereSources {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  /** The finding's file and line at this PR's head, or at `postedOn` when given. */
  file: string;
  line: number | undefined;
  /** The commit `line` is a line of, when it may not be this PR's head, such as the commit a detached thread was posted on. */
  postedOn?: string;
  /** The other files the finding cited as evidence. */
  evidenceFiles: readonly string[];
  /** Checks out `commit` of the repository for the tools, or returns `undefined` when it cannot. Absent without tools. */
  checkout?: (commit: string) => Promise<string | undefined>;
  /**
   * Asks the model whether the finding is fixed in `workspace`, the checkout of GitHub's merge of this PR that holds the
   * fix, given `diff`: what pull request `pr` changes in the finding's files. Returns the model's answer.
   */
  ask: (workspace: string, diff: string, pr: number, lines: [number, number]) => Promise<string>;
}

/** A fix in pull request `pr`, merged into this PR's base `base`, that Manki confirmed in the code of GitHub's merge of this PR. */
export interface ConfirmedElsewhere {
  pr: number;
  base: string;
  /** The model's answer on the code that shows the fix, without its outcome. */
  answer: string;
}

/**
 * Why `checkFixedElsewhere` confirmed nothing. With `retry`, when to reply again, since the same claim can pass then,
 * such as once the pull request is merged. Without it, only a maintainer can settle the thread.
 */
export interface UnconfirmedElsewhere {
  why: string;
  retry?: string;
}

/** The outcome of `checkFixedElsewhere`. */
export type ElsewhereCheck = ConfirmedElsewhere | UnconfirmedElsewhere;

const RETRY_SOON = 'in a few minutes';

/** Returns a handler for a failed lookup that logs why `what` failed and gives `undefined`. */
function logFailure(what: string) {
  return (error: unknown): undefined => {
    core.warning(`Failed to ${what}: ${sanitizeLogOutput(String((error as Error)?.message ?? error))}`);
    return undefined;
  };
}

/** Whether `commit` holds `ancestor`, or `undefined` when the lookup fails. */
async function holds(octokit: Octokit, owner: string, repo: string, ancestor: string, commit: string): Promise<boolean | undefined> {
  return octokit.rest.repos.compareCommits({ owner, repo, base: ancestor, head: commit, per_page: 1 })
    .then(({ data }) => data.status === 'ahead' || data.status === 'identical')
    .catch(logFailure(`compare ${ancestor} with ${commit}`));
}

/**
 * Returns the line at this PR's head `head` that line `line` of the finding's file at `s.postedOn` became, or why that
 * line is not certain. Only a line the PR left as it was since then maps.
 */
async function lineAtHead(s: ElsewhereSources, line: number, head: string): Promise<number | UnconfirmedElsewhere> {
  if (!s.postedOn || s.postedOn === head) return line;
  const place = inline(`${s.file}:${line}`);
  const since = await s.octokit.rest.repos.compareCommits({ owner: s.owner, repo: s.repo, base: s.postedOn, head }).then(r => r.data)
    .catch(logFailure(`compare ${s.postedOn} with this PR's head`));
  if (!since) return { why: `where ${place} is at this PR's head could not be read`, retry: RETRY_SOON };
  // After a force push the head may not hold the commit, and the comparison then runs from another base.
  if (since.status !== 'ahead' && since.status !== 'identical') return { why: `this PR's head no longer holds the commit this finding was posted on, so where ${place} is now is not certain` };
  const files = since.files ?? [];
  const change = files.find(f => f.filename === s.file || f.previous_filename === s.file);
  if (!change && files.length >= MAX_COMPARE_FILES) return { why: `GitHub lists only ${MAX_COMPARE_FILES} of the files this PR changed since this finding was posted, so where ${place} is now is not certain` };
  if (!change) return line;
  const diff = change.status === 'modified' ? parsePRDiff(listedFilesDiff([change])).files[0] : undefined;
  return (diff && oldLineOf(diff, line, 'old')) ?? { why: `this PR changed ${place} or its file since this finding was posted, so where the line is now is not certain` };
}

/** Returns every file pull request `pr` changes, by GitHub's list, `'cut'` when GitHub lists fewer, or `undefined` when the list fails. */
async function everyListedFile(s: ElsewhereSources, pr: number, changedFiles: number) {
  const listed = await s.octokit.paginate(s.octokit.rest.pulls.listFiles, { owner: s.owner, repo: s.repo, pull_number: pr, per_page: 100 }).catch(logFailure(`list the files of #${pr}`));
  return listed && listed.length < changedFiles ? 'cut' as const : listed;
}

/**
 * Checks the claim that pull request `pr` of the same repository fixes the finding. Only code merged into the default
 * branch confirms a fix, since the author of an open pull request, or of a stacked PR's base branch, can put any code
 * there. Confirms the fix only when all of this holds: this PR's base is the repository's default branch, `pr` is another
 * pull request merged into it, GitHub's merge of this PR into its base holds this PR's head and `pr`'s merge while this
 * PR's head does not, `pr` changes the finding's file or a file the finding cited, `pr`'s own diff replaces the finding's
 * line at its place on the base, the lines that replace it in that merge are the lines `pr`'s diff put there, and the
 * model with tools on that merge answers Fixed citing only those lines. A line from `postedOn` counts only where this PR
 * has left it as it was since then. Returns why otherwise, and when to reply again for a reason that can pass later.
 * The other pull request's title and description are never read. A confirmation only answers the reply: this PR's own
 * code still has the defect.
 */
export async function checkFixedElsewhere(pr: number, s: ElsewhereSources): Promise<ElsewhereCheck> {
  if (pr === s.prNumber) return { why: 'it names this pull request' };
  if (!s.file) return { why: 'this finding is not tied to a file' };
  if (!s.line) return { why: 'this finding names no line' };
  if (!s.checkout) return { why: 'this reply runs without repository tools' };
  const { octokit, owner, repo } = s;
  const read = await Promise.all([
    octokit.rest.repos.get({ owner, repo }),
    octokit.rest.pulls.get({ owner, repo, pull_number: s.prNumber }),
    octokit.rest.pulls.get({ owner, repo, pull_number: pr }).catch((error: unknown) => {
      if ((error as { status?: number }).status === 404) return 'missing' as const;
      throw error;
    }),
  ]).catch(logFailure(`read the repository, this PR or #${pr}`));
  if (!read) return { why: `#${pr} or this PR could not be read`, retry: RETRY_SOON };
  if (read[2] === 'missing') return { why: `#${pr} is not a pull request in this repository` };
  const [{ data: { default_branch: trunk } }, { data: own }, { data: other }] = [read[0], read[1], read[2]];
  // Anyone who may push to another base, such as the branch of a stacked PR, can merge any code into it unreviewed.
  if (own.base.ref !== trunk) return { why: `this PR's base ${inline(own.base.ref)} is not the default branch ${inline(trunk)}` };
  if (other.base.ref !== trunk) return { why: `#${pr} targets ${inline(other.base.ref)}, not the default branch ${inline(trunk)}` };
  if (other.state === 'open') return { why: `#${pr} is not merged yet`, retry: `once #${pr} is merged into ${inline(own.base.ref)}` };
  if (!other.merged) return { why: `#${pr} is closed without being merged` };
  const merge = own.merge_commit_sha;
  const fix = other.merge_commit_sha;
  const sinceHead = merge ? await octokit.rest.repos.compareCommits({ owner, repo, base: own.head.sha, head: merge }).then(r => r.data).catch(logFailure(`compare this PR's head with its merge ${merge}`)) : undefined;
  if (!fix || !sinceHead || sinceHead.status !== 'ahead' || !await holds(octokit, owner, repo, fix, merge!)) {
    return { why: `GitHub's merge of this PR into its base does not hold #${pr} yet`, retry: `${RETRY_SOON}, once this PR merges cleanly with ${inline(own.base.ref)}` };
  }
  const inHead = await holds(octokit, owner, repo, fix, own.head.sha);
  if (inHead === undefined) return { why: `whether this PR's head holds #${pr} could not be read`, retry: RETRY_SOON };
  if (inHead) return { why: `this PR's head already holds #${pr}, so #${pr} cannot be what fixes it` };
  const line = await lineAtHead(s, s.line, own.head.sha);
  if (typeof line !== 'number') return line;
  const [ownFiles, otherFiles] = await Promise.all([everyListedFile(s, s.prNumber, own.changed_files), everyListedFile(s, pr, other.changed_files)]);
  if (ownFiles === 'cut' || otherFiles === 'cut') return { why: `GitHub does not list every file this PR and #${pr} change` };
  if (!ownFiles || !otherFiles) return { why: `the files this PR and #${pr} change could not be read`, retry: RETRY_SOON };
  // A file this PR renamed has its old name on the base, which is where the other pull request changed it.
  const baseName = (path: string) => ownFiles.find(f => f.filename === path)?.previous_filename ?? path;
  const cited = [s.file, ...s.evidenceFiles].flatMap(path => [path, baseName(path)]);
  const covered = otherFiles.filter(f => cited.includes(f.filename) || (!!f.previous_filename && cited.includes(f.previous_filename)));
  if (covered.length === 0) return { why: `#${pr} changes none of the files this finding cites` };
  const place = inline(`${s.file}:${line}`);
  const file = inline(s.file);
  // What the merge changes against this PR's head, which holds the defect: the finding's line has to be among the lines it replaces.
  const sinceHeadFiles = sinceHead.files ?? [];
  const headChange = sinceHeadFiles.find(f => (f.previous_filename ?? f.filename) === s.file);
  if (!headChange && sinceHeadFiles.length >= MAX_COMPARE_FILES) return { why: `GitHub lists only ${MAX_COMPARE_FILES} of the files the merge with #${pr} changes, so it does not show ${file}` };
  const findingFile = headChange && parsePRDiff(listedFilesDiff([headChange])).files[0];
  if (headChange && !findingFile) return { why: `GitHub shows no lines of the change the merge with #${pr} makes to ${file}` };
  if (findingFile?.changeType === 'deleted') return { why: `the merge with #${pr} deletes ${file}` };
  const merged = findingFile && replacementOf(findingFile, line);
  if (!merged) {
    const beside = findingFile && changesNextTo(findingFile, line);
    return { why: beside ? `the merge with #${pr} changes only the lines next to ${place}, and the check needs ${place} itself replaced` : `the merge with #${pr} leaves ${place} as it is` };
  }
  // The merge holds every change on the base since this PR branched, so only a line `pr`'s own diff replaced, with the
  // lines it put there still in place, credits `pr`. A file this PR only renamed keeps its lines where they are.
  const ownFile = ownFiles.find(f => f.filename === s.file && !(f.status === 'renamed' && f.changes === 0));
  const ownDiff = ownFile && parsePRDiff(listedFilesDiff([ownFile])).files[0];
  if (ownFile && !ownDiff) return { why: `GitHub shows no lines of this PR's change to ${file}` };
  const baseLine = ownDiff ? oldLineOf(ownDiff, line) : line;
  const otherFile = otherFiles.find(f => (f.previous_filename ?? f.filename) === baseName(s.file));
  const otherDiff = otherFile && parsePRDiff(listedFilesDiff([otherFile])).files[0];
  if (otherFile && !otherDiff) return { why: `GitHub shows no lines of the change #${pr} makes to ${file}` };
  const byPr = otherDiff && baseLine !== undefined ? replacementOf(otherDiff, baseLine) : undefined;
  // `pr`'s diff counts lines from its own merge base, where PRs merged between the two bases may have moved the line.
  const moved = `#${pr}'s diff does not replace ${place}, but it counts lines from #${pr}'s own base, so whether #${pr} replaces the line is not certain`;
  if (!byPr) return { why: otherDiff && baseLine !== undefined ? moved : `#${pr} does not replace ${place}` };
  const linesOf = (diff: DiffFile, [first, last]: [number, number]) => {
    const added = addedLines(diff);
    return Array.from({ length: Math.max(0, last - first + 1) }, (_, k) => added.get(first + k));
  };
  if (linesOf(findingFile, merged).join('\n') !== linesOf(otherDiff!, byPr).join('\n')) {
    return { why: `the code that replaced ${place} is not the code #${pr} put there, so a later change may have made the fix` };
  }
  // No cited line can sit among lines that do not exist, so a fix that only removes the line cannot be shown.
  if (merged[1] < merged[0]) return { why: `#${pr} only removes ${place}, and the check needs a line #${pr} put in its place` };
  const workspace = await s.checkout(merge!);
  if (!workspace) return { why: `the merge with #${pr} could not be checked out`, retry: RETRY_SOON };
  let answer: string;
  try {
    answer = await s.ask(workspace, listedFilesDiff(covered), pr, merged);
  } catch (error) {
    if (error instanceof RunCancelledError) throw error;
    logFailure(`check the merge with #${pr}`)(error);
    return { why: `the check of the merge with #${pr} failed`, retry: RETRY_SOON };
  }
  const checked = checkReply(answer, '', { workspace, relatedNames: [], changedSincePosted: [findingFile] });
  // Every cited line has to be one of the lines `pr` put in place of the finding's line.
  const onPrLines = (at: string): boolean => {
    const [start, end] = locationLines(at);
    return locationFile(at) === findingFile.path && start >= merged[0] && end <= merged[1] && start <= end;
  };
  const proven = checked.outcome === 'Fixed' && checked.proof.length > 0 && checked.proof.every(onPrLines);
  if (!proven) return { why: `the check of the merge with #${pr} did not show the defect gone on the lines #${pr} put there` };
  return { pr, base: own.base.ref, answer: checked.answer };
}

/**
 * Returns the answer to a reply whose `fixedIn` `checkFixedElsewhere` checked: the line Manki leads it with, and the text
 * below it. When `result` confirms the fix, the lead opens with "Confirmed:" and the text is the check's own answer.
 * Otherwise the lead says why the fix is not confirmed, and the readers of the reply take the answer as "Unverified.".
 * Without `result`, the finding is neither a blocker nor a security finding, so nothing checked `fixedIn`. None of these
 * settles the thread, since this PR's own code still has the defect.
 */
export function fixedElsewhereText(checked: CheckedReply, result?: ElsewhereCheck, thread?: ThreadState): { lead: string; text: string } {
  const pr = checked.fixedIn!;
  if (!result) return { lead: `**Not settled: I did not check #${pr}.** I check a fix in another pull request only for a blocker or a security finding, so this thread stays as it is.`, text: checked.answer };
  if ('answer' in result) {
    const base = inline(result.base);
    return {
      lead: `**Confirmed: #${result.pr} fixes this in ${base}, not in this PR, so this thread stays as it is.** #${result.pr}, merged into ${base}, replaced the cited line. Update this branch with ${base}, and the next review checks the fix here.`,
      text: result.answer,
    };
  }
  const lead = result.retry
    ? `**Not settled yet: reply again ${result.retry}.** I could not check #${pr} yet: ${result.why}. This thread stays as it is.`
    : unsettledLead(thread, `I could not confirm that #${pr} fixes this finding: ${result.why}.`);
  return { lead, text: checked.answer };
}
