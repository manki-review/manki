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
