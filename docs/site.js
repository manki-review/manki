const root = document.documentElement;
const themeButtons = document.querySelectorAll('.toggle button');

function showTheme(theme) {
  root.dataset.theme = theme;
  themeButtons.forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.t === theme)));
}

themeButtons.forEach(btn => btn.addEventListener('click', () => showTheme(btn.dataset.t)));
showTheme(root.dataset.theme);

document.querySelectorAll('[data-copy]').forEach(btn => {
  btn.addEventListener('click', () => {
    const el = document.querySelector(btn.dataset.copy);
    if (!el) return;
    navigator.clipboard.writeText(el.textContent).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 2000);
    }).catch(() => {
      btn.textContent = 'Failed';
      setTimeout(() => btn.textContent = 'Copy', 2000);
    });
  });
});
