import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { request } from 'http';
import { Socket } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { connect } from 'tls';

import { makeCertificate, newRun, startStandIn } from './stand-in';

/** Opens a proxy tunnel to `host` through the stand-in at `url`, and resolves with its socket, or null when refused. */
function tunnel(url: string, host: string): Promise<Socket | null> {
  const { hostname, port } = new URL(url);
  return new Promise(done => {
    const req = request({ host: hostname, port, method: 'CONNECT', path: host });
    req.on('connect', (_res, socket) => done(socket));
    req.on('error', () => done(null));
    req.end();
  });
}

describe('startStandIn', () => {
  it('serves a listed host over TLS with the certificate it made, and records and refuses any other', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'manki-stand-in-'));
    const run = newRun();
    const { served, ca } = makeCertificate(dir, ['served.example']);
    const standIn = await startStandIn(run, (_req, raw, res) => res.end(`ok ${raw}`), served);
    try {
      const socket = await tunnel(standIn.url, 'served.example:443');
      const reply = await new Promise<string>((done, fail) => {
        const tls = connect({ socket: socket!, servername: 'served.example', ca: readFileSync(ca) }, () => {
          tls.end('POST /v1/check HTTP/1.1\r\nHost: served.example\r\nAuthorization: Bearer key\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi');
        });
        let text = '';
        tls.on('data', (data: Buffer) => { text += data.toString(); });
        tls.on('end', () => done(text));
        tls.on('error', fail);
      });
      expect(reply).toMatch(/ok hi$/);
      expect(await tunnel(standIn.url, 'other.example:443')).toBeNull();
      expect(run).toMatchObject({ paths: ['https://served.example/v1/check'], keys: ['Bearer key'], hosts: ['other.example:443'] });
    } finally {
      standIn.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
