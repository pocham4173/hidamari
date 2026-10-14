/* A local illustration only: no account, storage, network request or real record. */
(() => {
  const trigger = document.getElementById('demo-trigger');
  const fallback = document.getElementById('demo-static');
  const result = document.getElementById('demo-result');
  const record = result && result.querySelector('.demo-result-record');
  if (!trigger || !fallback || !result || !record) return;
  trigger.addEventListener('click', () => {
    record.hidden = false;
    result.classList.add('demo-shown');
    trigger.querySelector('span').textContent = '✓ 下に共有の見本を表示';
    trigger.setAttribute('aria-expanded', 'true');
  });
  trigger.setAttribute('aria-expanded', 'false');
  fallback.hidden = true;
  trigger.hidden = false;
})();

/* Start actions stay available without JavaScript. Only enhance the mobile bar. */
(() => {
  const bar = document.querySelector('.mobile-start-bar');
  const first = document.querySelector('.hero-cta');
  const last = document.querySelector('.end-cta');
  if (!bar || !first || !last) return;
  const mobile = window.matchMedia('(max-width: 650px) and (min-height: 441px)');
  let queued = false;
  function update() {
    queued = false;
    const firstRect = first.getBoundingClientRect();
    const lastRect = last.getBoundingClientRect();
    // Show only after the first CTA has passed above the viewport.
    // Hide before the final CTA reaches the bar's space, even if partly visible.
    const lastVisible = lastRect.top < window.innerHeight && lastRect.bottom > 0;
    const show = mobile.matches && firstRect.bottom <= 0 && !lastVisible;
    // Avoid removing a focused link while the user is navigating by keyboard.
    if (!show && bar.contains(document.activeElement)) return;
    bar.hidden = !show;
  }
  function schedule() {
    if (!queued) { queued = true; window.requestAnimationFrame(update); }
  }
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('pageshow', schedule);
  window.addEventListener('load', schedule);
  bar.addEventListener('focusout', schedule);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', schedule);
  update();
})();
