export function View({ html, items }) {
  items.forEach(async item => { await save(item); }); // expect: async-foreach-callback
  eval(html); // expect: security-eval-injection
  return <div title="x">{items.length}</div>;
}
