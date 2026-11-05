import { execFile, execFileSync } from 'child_process';

export function run(input: string, el: HTMLElement, list: string[], x: number, y: number, re: RegExp) {
  execFile('git', ['log', input]);
  execFileSync('rm', ['-rf', input]);
  re.exec(input);
  re.exec(`${input}b`);
  re.exec('^' + input);
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
  el.innerHTML = '<p>static</p>';
  el.textContent = input;
  const agent = { rejectUnauthorized: true };
  list.forEach((item) => console.log(item));
  const p = new Promise((resolve) => resolve(input));
  if (Number.isNaN(x)) return;
  y = x;
  return [agent, p];
}
