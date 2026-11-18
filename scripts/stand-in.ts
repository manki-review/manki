/**
 * The stand-in endpoint the CLI checks run a CLI against, on localhost. It records every request the CLI sends it,
 * and acts as the CLI's proxy for every other host, which it records and refuses, so no request leaves the machine. A
 * connection that ignores the proxy settings is not seen.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';

export type Json = Record<string, unknown>;

/** What the stand-in saw of one CLI run. */
export interface StandInRun {
  /** The model requests the CLI sent it. */
  bodies: Json[];
  /** The other hosts the CLI asked it to reach as a proxy. */
  hosts: string[];
  /** The paths of every request the CLI sent the stand-in itself. */
  paths: string[];
  /** The `Authorization` headers of those requests. */
  keys: string[];
  /** The planted commands that ran, each by the name of the flag file it creates. */
  ran: string[];
}

export function newRun(): StandInRun {
  return { bodies: [], hosts: [], paths: [], keys: [], ran: [] };
}

export const sent = (run: StandInRun, text: string): boolean => JSON.stringify(run.bodies).includes(text);

/** A part of a runner's own setup planted in its home, and how a run shows that it reached the CLI. */
export interface PlantedItem {
  what: string;
  /** Only a run on a login, not on an endpoint key, can show it. */
  login?: true;
  found: (run: StandInRun) => boolean;
}

/** Returns each planted part of `items` that reached the CLI `cli` in the run `label`. */
export function plantedProblems(label: string, cli: string, items: PlantedItem[], run: StandInRun): string[] {
  return items.filter(item => item.found(run)).map(item => `${label}: the runner's ${item.what} reached ${cli}`);
}

/**
 * Returns each part of `items` that the run `label`, on the runner's own home, should have shown and did not. Such a
 * part could no longer fail the check, as when a new version of the CLI `cli` reads it from elsewhere.
 */
export function controlProblems(label: string, cli: string, items: PlantedItem[], run: StandInRun, login = false): string[] {
  return items.filter(item => !!item.login === login && !item.found(run))
    .map(item => `${label}: the runner's ${item.what} no longer reaches ${cli} from the runner's own home, so the check cannot see it`);
}

/** Returns each host but `allowedHosts` that the run `label` tried to reach, once. */
export function hostProblems(label: string, run: StandInRun, allowedHosts: string[] = []): string[] {
  return [...new Set(run.hosts)].filter(host => !allowedHosts.includes(host)).map(host => `${label}: tried to reach ${host}`);
}

/** Returns one server-sent event of `type` with `data`. */
export function sse(type: string, data: Json): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

/** Answers one request the CLI sent the stand-in itself, whose body is `raw`. */
export type Answer = (req: IncomingMessage, raw: string, res: ServerResponse) => void;

/** Starts the stand-in, which records what it sees in `run` and answers the CLI's own requests with `answer`. */
export function startStandIn(run: StandInRun, answer: Answer): Promise<{ url: string; close: () => void }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
    req.on('end', () => {
      // A plain HTTP request through a proxy names the whole URL, a request to the stand-in only the path.
      if (req.url && !req.url.startsWith('/')) {
        run.hosts.push(new URL(req.url).host);
        res.writeHead(404).end();
        return;
      }
      run.paths.push(req.url ?? '');
      run.keys.push(req.headers.authorization ?? '');
      answer(req, raw, res);
    });
  });
  // The CLI sends every other host through this server as its proxy, and the tunnel is refused.
  server.on('connect', (req: IncomingMessage, socket) => {
    run.hosts.push(String(req.url));
    socket.destroy();
  });
  return new Promise(done => server.listen(0, '127.0.0.1', () => done({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() })));
}
