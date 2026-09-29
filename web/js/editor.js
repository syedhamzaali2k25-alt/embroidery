// Small interactions for the editor mock-up.
(function () {
  const sprite = 'assets/sprite.svg';

  // Tool rail: one active tool at a time.
  const tools = document.querySelectorAll('.tool');
  tools.forEach((tool) => {
    tool.addEventListener('click', () => {
      tools.forEach((t) => t.setAttribute('aria-pressed', String(t === tool)));
    });
  });

  // Radio-style groups (stitch type, thread).
  document.querySelectorAll('[role="radiogroup"]').forEach((group) => {
    const options = group.querySelectorAll('[role="radio"]');
    options.forEach((opt) => {
      opt.addEventListener('click', () => {
        options.forEach((o) => o.setAttribute('aria-checked', String(o === opt)));
      });
    });
  });

  // Range sliders mirror their value into the matching <output>.
  document.querySelectorAll('.range').forEach((range) => {
    const out = document.getElementById(range.id + '-out');
    const update = () => {
      out.textContent = Number(range.value).toFixed(1) + ' ' + range.dataset.unit;
    };
    range.addEventListener('input', update);
    update();
  });

  // Layer visibility.
  document.querySelectorAll('.layer__eye').forEach((btn) => {
    btn.addEventListener('click', () => {
      const visible = btn.getAttribute('aria-pressed') !== 'true';
      const name = btn.closest('.layer').querySelector('.layer__name').textContent;
      btn.setAttribute('aria-pressed', String(visible));
      btn.setAttribute('aria-label', (visible ? 'Hide ' : 'Show ') + name);
      btn.querySelector('use').setAttribute('href', sprite + (visible ? '#i-eye' : '#i-eye-off'));
      document.querySelector('[data-layer="' + btn.dataset.target + '"]').classList.toggle('is-hidden', !visible);
    });
  });

  // Zoom.
  const design = document.querySelector('[data-zoom]');
  const zoomOut = document.querySelector('.zoom__value');
  let zoom = 100;
  document.querySelectorAll('[data-zoom-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      zoom = Math.min(200, Math.max(50, zoom + Number(btn.dataset.zoomStep)));
      zoomOut.textContent = zoom + '%';
      design.style.transform = 'scale(' + zoom / 100 + ')';
    });
  });
})();
