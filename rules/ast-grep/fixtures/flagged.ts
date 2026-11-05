import { exec, execSync } from 'child_process';
import * as cp from 'child_process';
import * as child from 'child_process';
import proc from 'node:child_process';

export function run(input: string, el: HTMLElement, list: string[], x: number, y: number) {
  eval(input); // expect: security-eval-injection
  const f = new Function('a', input); // expect: security-eval-injection
  exec(`git log ${input}`); // expect: security-shell-injection
  execSync('rm -rf ' + input); // expect: security-shell-injection
  cp.exec(`ls ${input}`, () => undefined); // expect: security-shell-injection
  require('child_process').exec(`ls ${input}`); // expect: security-shell-injection
  require('node:child_process').execSync('ls ' + input); // expect: security-shell-injection
  child.exec(`ls ${input}`); // expect: security-shell-injection
  proc.execSync(`ls ${input}`); // expect: security-shell-injection
  el.innerHTML = input; // expect: security-xss-html-sink
  el.insertAdjacentHTML('beforeend', input); // expect: security-xss-html-sink
  document.write(input); // expect: security-xss-html-sink
  const agent = { rejectUnauthorized: false }; // expect: security-tls-verification-disabled
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // expect: security-tls-verification-disabled
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = input; // expect: security-tls-verification-disabled
  list.forEach(async (item) => { await fetch(item); }); // expect: async-foreach-callback
  list.forEach(async function (item) { await fetch(item); }); // expect: async-foreach-callback
  const p = new Promise(async (resolve) => resolve(await fetch(input))); // expect: async-promise-executor
  if (x === NaN) return; // expect: nan-comparison
  y = y; // expect: self-assignment
  return [f, agent, p];
}
