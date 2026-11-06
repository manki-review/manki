import { readFileSync } from 'fs';
import { join } from 'path';

import { aggregate, renderReport } from './fix-rate-report';

describe('fix-rate report', () => {
  it('sums the fix-rate lines into one table per dimension and skips lines that are not JSON', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const lines = readFileSync(join(__dirname, 'fixtures', 'fix-rate.jsonl'), 'utf-8').split('\n');

    expect(renderReport(aggregate(lines))).toBe([
      '## By severity',
      '',
      '| severity | posted | fixed | dismissed | untouched | fixed % | dismissed % |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
      '| warning | 5 | 1 | 3 | 1 | 20% | 60% |',
      '| blocker | 1 | 1 | 0 | 0 | 100% | 0% |',
      '',
      '## By specialist',
      '',
      '| specialist | posted | fixed | dismissed | untouched | fixed % | dismissed % |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
      '| Security | 3 | 2 | 1 | 0 | 67% | 33% |',
      '| Style | 3 | 0 | 2 | 1 | 0% | 67% |',
      '',
      '## By confidence',
      '',
      '| confidence | posted | fixed | dismissed | untouched | fixed % | dismissed % |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
      '| low | 3 | 0 | 2 | 1 | 0% | 67% |',
      '| high | 1 | 1 | 0 | 0 | 100% | 0% |',
      '',
      '## By toolEvidence',
      '',
      '| toolEvidence | posted | fixed | dismissed | untouched | fixed % | dismissed % |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
      '| none | 3 | 0 | 2 | 1 | 0% | 67% |',
      '| confirmed | 1 | 1 | 0 | 0 | 100% | 0% |',
      '',
      '## By category',
      '',
      '| category | posted | fixed | dismissed | untouched | fixed % | dismissed % |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
      '| unknown | 3 | 0 | 2 | 1 | 0% | 67% |',
      '| correctness | 1 | 1 | 0 | 0 | 100% | 0% |',
      '',
      '## By effort',
      '',
      '| effort | posted | fixed | dismissed | untouched | fixed % | dismissed % |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
      '| unknown | 3 | 0 | 2 | 1 | 0% | 67% |',
      '| quick | 1 | 1 | 0 | 0 | 100% | 0% |',
      '',
      '## By hadEvidence',
      '',
      '| hadEvidence | posted | fixed | dismissed | untouched | fixed % | dismissed % |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
      '| unknown | 3 | 0 | 2 | 1 | 0% | 67% |',
      '| true | 1 | 1 | 0 | 0 | 100% | 0% |',
      '',
      '## By judgeChecked',
      '',
      '| judgeChecked | posted | fixed | dismissed | untouched | fixed % | dismissed % |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
      '| unknown | 3 | 0 | 2 | 1 | 0% | 67% |',
      '| true | 1 | 1 | 0 | 0 | 100% | 0% |',
      '',
    ].join('\n'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not JSON'));
    errorSpy.mockRestore();
  });

  it('says so when a dimension has no data', () => {
    expect(renderReport(aggregate(['{"pr":1,"counts":[]}']))).toContain('## By confidence\n\n| confidence | posted | fixed | dismissed | untouched | fixed % | dismissed % |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n\nNo data.');
  });
});
