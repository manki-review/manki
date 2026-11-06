import { parseSettingsBlock, renderSettingsBlock, SETTINGS_MARKER, SettingsView, stripSettingsBlock, withSettingsBlock } from './settings';

const view: SettingsView = {
  lastReviewed: 'abc1234def',
  head: 'def5678abc',
  status: 'review running',
  boxes: new Set(['force', 'pause', 'deeper', 'full', 'cancel']),
  ticked: new Set(['pause', 'draft']),
};

describe('settings block', () => {
  it('renders the status line, the applicable boxes in a fixed order and the marker last', () => {
    expect(renderSettingsBlock(view)).toBe([
      '---',
      'Last reviewed `abc1234` · head `def5678` · review running',
      '- [x] Pause automatic reviews <!-- manki-box:pause -->',
      '- [ ] Full review <!-- manki-box:full -->',
      '- [ ] Deeper review <!-- manki-box:deeper -->',
      '- [ ] Cancel this review <!-- manki-box:cancel -->',
      '- [ ] Force review <!-- manki-box:force -->',
      SETTINGS_MARKER,
    ].join('\n'));
    expect(renderSettingsBlock({ head: 'def5678', status: 'up to date', boxes: new Set(['draft']), ticked: new Set() }))
      .toBe(`---\nNot reviewed yet · head \`def5678\` · up to date\n- [ ] Review this draft <!-- manki-box:draft -->\n${SETTINGS_MARKER}`);
  });

  it('reads back what it renders at the end of a body, with any hidden marker appended after it', () => {
    const body = withSettingsBlock('**Review started**\n\n<!-- manki-bot -->', view);
    expect(parseSettingsBlock(body)).toEqual({
      lastReviewed: 'abc1234', head: 'def5678', status: 'review running',
      boxes: new Set(['pause', 'full', 'deeper', 'cancel', 'force']), ticked: new Set(['pause']),
    });
    const answered = `${body}\n<!-- manki-answered:42 -->`;
    expect(parseSettingsBlock(answered)?.status).toBe('review running');
    expect(stripSettingsBlock(answered)).toBe('**Review started**\n\n<!-- manki-bot -->\n<!-- manki-answered:42 -->');
    expect(stripSettingsBlock(body)).toBe('**Review started**\n\n<!-- manki-bot -->');
  });

  it('reads a tick a person made, and ignores boxes it does not know', () => {
    const body = withSettingsBlock('Text', view)
      .replace('- [ ] Full review', '- [X] Full review')
      .replace(SETTINGS_MARKER, `- [x] Something else <!-- manki-box:other -->\n${SETTINGS_MARKER}`);
    const parsed = parseSettingsBlock(body);
    expect(parsed?.ticked).toEqual(new Set(['pause', 'full']));
    expect(parsed?.boxes.has('full')).toBe(true);
    expect([...(parsed?.boxes ?? [])]).not.toContain('other');
  });

  it('finds no block in a body without one, or with the marker quoted in the middle', () => {
    expect(parseSettingsBlock('**Review complete**\n\n<!-- manki-bot -->')).toBeUndefined();
    expect(parseSettingsBlock(`${renderSettingsBlock(view)}\n\nMore text`)).toBeUndefined();
    expect(stripSettingsBlock('No block')).toBe('No block');
    expect(withSettingsBlock('Body', undefined)).toBe('Body');
  });
});
