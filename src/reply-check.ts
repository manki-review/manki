import { inline, sanitizeMarkdown } from './github';
import { extractJSON } from './json';
import { findLines } from './mcp-server';
import { isDiffLocation, shownLines } from './refute';
import { fetchedRelatedRepos } from './related-repos';
import { parseProof } from './review';
import { leadingRelatedCitation } from './static-signals';
import { ParsedDiff, RelatedRepoTools, ReplyStatementRecord, UncheckedReason } from './types';

const REPLY_OUTCOMES = ['Fixed', 'Withdrawn', 'Agreed', 'Kept', 'Unverified'] as const;
type AnswerOutcome = typeof REPLY_OUTCOMES[number];

/** How many statements of one reply Manki checks and lists. */
export const MAX_REPLY_STATEMENTS = 5;
const MAX_PLACES = 3;
const MAX_QUOTE_CHARS = 160;
const MIN_TERM_CHARS = 3;
const MAX_TERM_CHARS = 200;

const UNREADABLE_ANSWER = 'Unverified. I could not check this reply, so a maintainer should decide and resolve this thread.';
const UNPROVEN_OUTCOME = 'I could not point to a line of this repository that shows it, so a maintainer should decide and resolve this thread.';

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
}

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
  why?: UncheckedReason;
  /** The term of a search that found a line, or the repo a search could not read, for the reason shown. */
  detail?: string;
}

export interface CheckedReply {
  /** The answer as "Outcome. text", which is what the reply handler goes on with. */
  text: string;
  statements: CheckedStatement[];
  /** Statements of the reply past `MAX_REPLY_STATEMENTS`, which were not checked. */
  unchecked: number;
  /** Entries whose quote is not in the developer's reply, or repeats an earlier one. They are not shown. */
  dropped: number;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function citesRelated(cited: unknown, names: readonly string[]): boolean {
  return Array.isArray(cited) && cited.some(entry => typeof entry === 'string' && !!leadingRelatedCitation(entry, names));
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
  return { own: ownCitations(cited, sources.relatedNames).filter(location => isDiffLocation(location, sources.diff)), related: [] };
}

/** Returns the locations `cited` names in the PR's repository. An entry that starts with a related repo's line is not one. */
function ownCitations(cited: unknown, relatedNames: readonly string[]): string[] {
  return parseProof(Array.isArray(cited) ? cited.filter(entry => typeof entry !== 'string' || !leadingRelatedCitation(entry, relatedNames)) : cited);
}

/** Returns why no line of `cited` could be shown to exist. */
function unshownReason(cited: unknown, sources: ReplySources): { why: UncheckedReason; detail?: string } {
  const related = Array.isArray(cited) ? cited.flatMap(entry => (typeof entry === 'string' ? leadingRelatedCitation(entry, sources.relatedNames) ?? [] : [])) : [];
  if (related.length === 0 && ownCitations(cited, sources.relatedNames).length === 0) return { why: 'no_line' };
  // Without a checkout only a line inside the diff can be read, so whether the others exist is unknown.
  if (!sources.workspace) return { why: 'no_checkout' };
  const fetched = sources.related ? fetchedRelatedRepos(sources.related.stateDir) : new Map<string, string>();
  const unfetched = related.find(citation => !fetched.has(citation.repo));
  return unfetched ? { why: 'not_fetched', detail: unfetched.repo } : { why: 'no_line' };
}

/**
 * Searches for `term` as plain text in the PR's checkout, or in the related checkout `repo`. Returns the search when it
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
    found = findLines(root, { text, maxResults: 1 });
  } catch {
    return { why: 'search_failed' };
  }
  if (found.matches.length > 0) return { why: 'search_found', detail: text };
  if (found.cut) return { why: 'search_cut' };
  return { term: text, ...(configured && { repo: configured.repo }), ...(configured?.paths && { paths: configured.paths }), skipped: found.skipped };
}

function checkStatement(entry: Record<string, unknown>, quote: string, sources: ReplySources): CheckedStatement {
  const status = entry.status;
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
  const why = entry.why === 'outside_code' || entry.why === 'not_reachable' ? entry.why : 'no_line';
  return { quote, status: 'not_checkable', places: [], why };
}

/**
 * Reads the model's structured answer to `developerReply` and checks it in code. Returns the answer as plain
 * "Outcome. text", with the statements whose quote is in `developerReply`.
 *
 * An outcome can only become "Unverified.", never anything else: when the answer is not the JSON asked for, when a
 * "Withdrawn" has no line of the PR's own repository in `proof`, and when a "Fixed" cites a related repo there and no
 * line of the PR's own. No statement's status changes the outcome.
 */
export function checkReply(content: string, developerReply: string, sources: ReplySources): CheckedReply {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(extractJSON(content, 'object')) as Record<string, unknown>;
  } catch {
    return { text: UNREADABLE_ANSWER, statements: [], unchecked: 0, dropped: 0 };
  }
  const outcome = REPLY_OUTCOMES.find(o => o === parsed.outcome);
  const answer = typeof parsed.answer === 'string' ? parsed.answer.trim().replace(/^\**(?:Fixed|Withdrawn|Agreed|Kept|Unverified)\.\**\s*/, '') : '';
  if (!outcome || !answer) return { text: UNREADABLE_ANSWER, statements: [], unchecked: 0, dropped: 0 };

  const said = collapse(developerReply);
  const entries = (Array.isArray(parsed.statements) ? parsed.statements : []).filter((e): e is Record<string, unknown> => !!e && typeof e === 'object');
  const quoted = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    const quote = typeof entry.quote === 'string' ? collapse(entry.quote) : '';
    if (quote && said.includes(quote) && !quoted.has(quote)) quoted.set(quote, entry);
  }
  const statements = [...quoted].slice(0, MAX_REPLY_STATEMENTS).map(([quote, entry]) => checkStatement(entry, quote, sources));

  const { own } = shownPlaces(parsed.proof, sources);
  const unproven = own.length === 0 && (outcome === 'Withdrawn' || (outcome === 'Fixed' && citesRelated(parsed.proof, sources.relatedNames)));
  const settled: AnswerOutcome = unproven ? 'Unverified' : outcome;
  return {
    text: `${settled}. ${answer}${unproven ? ` ${UNPROVEN_OUTCOME}` : ''}`,
    statements,
    unchecked: Math.max(0, quoted.size - MAX_REPLY_STATEMENTS),
    dropped: entries.length - quoted.size,
  };
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
  return `Searched ${inline(term)} in ${repo ? inline(repo) : 'this repository'}, no line found${scope.length > 0 ? ` (${scope.join(', ')})` : ''}`;
}

/** Returns the list of checked statements as Manki posts it below the answer, or `undefined` when the reply listed none. */
export function statementList({ statements, unchecked }: CheckedReply): string | undefined {
  if (statements.length === 0) return undefined;
  const lines = statements.map(s => {
    const what = s.search ? searchLine(s.search)
      : s.status === 'not_checkable' ? `Not checked, ${UNCHECKED_REASONS[s.why ?? 'outside_code'](s.detail ?? '')}`
        : `${s.status === 'confirmed' ? 'Confirmed' : 'Contradicted'} at ${s.places.map(inline).join(', ')}`;
    return `- ${what}: ${shownQuote(s.quote)}`;
  });
  const more = unchecked > 0 ? [`- ${unchecked} more ${unchecked === 1 ? 'statement' : 'statements'} not checked: a reply gets at most ${MAX_REPLY_STATEMENTS}.`] : [];
  return ['**Statements of this reply, checked in the code:**', ...lines, ...more].join('\n');
}

/**
 * Returns the sentence below the list: what the checks covered. With `blocks`, the finding keeps blocking after this
 * answer, or its thread could not be read, and the sentence leaves the decision to a maintainer. It never says that a
 * finding is cleared, settled or wrong.
 */
export function statementSummary({ statements, unchecked }: CheckedReply, blocks: boolean): string {
  const contradicted = statements.some(s => s.status === 'contradicted');
  const open = unchecked > 0 || statements.some(s => s.status === 'not_checkable');
  const checks = contradicted ? 'The code contradicts at least one of these statements.'
    : open ? 'I could not check every one of these statements.'
      : 'I checked each of these statements as listed.';
  if (!blocks) return checks;
  return `${checks} ${open ? 'A maintainer has to judge the unchecked ones, and what the statements mean for this finding.' : 'What they mean for this finding is for a maintainer to decide.'}`;
}

/** Returns what the reply record keeps of the checked statements: no words of the developer and no search term. */
export function statementRecords({ statements }: CheckedReply): ReplyStatementRecord[] {
  return statements.map(s => ({
    status: s.status,
    ...(s.places.length > 0 && { places: s.places }),
    ...(s.search && { searched: s.search.repo ?? 'pr' }),
    ...(s.why && { why: s.why }),
  }));
}
