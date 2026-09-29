// Filter chips on the home screen.
(function () {
  const chips = document.querySelectorAll('.filters .chip');
  const designs = document.querySelectorAll('.design');
  const empty = document.querySelector('.designs__empty');
  const statusFor = { All: null, Drafts: 'draft', Exported: 'exported' };

  chips.forEach((chip) => {
    chip.addEventListener('click', () => {
      chips.forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
      const status = statusFor[chip.textContent.trim()];
      let shown = 0;
      designs.forEach((d) => {
        const match = !status || d.dataset.status === status;
        d.hidden = !match;
        if (match) shown++;
      });
      empty.hidden = shown > 0;
    });
  });
})();
