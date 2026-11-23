// End-to-end run of the batteries page against the dev instance, as a browser does it:
// signs in with the admin jar, adds stock, puts batteries in a device through the form, checks
// the breakdown, the implicit prefill, the read-only page of a member and a hostile label.
// Usage: node scripts/browser/flow.mjs   (scripts/dev-setup.sh and docker-compose.dev.yml first)
import { withBrowser } from './cdp.mjs';

const DEV = new URL('.', import.meta.url).pathname + '../../.dev';
let failed = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'ok' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failed += 1;
};

await withBrowser(`${DEV}/jars/admin.jar`, async (admin) => {
  console.log('— admin —');
  await admin.goto('/m/batteries');
  await admin.waitFor("document.querySelector('.batteries')");
  ok(true, 'page renders under /m/batteries');
  ok((await admin.text('h1')) === 'Pilas', 'title in Spanish', await admin.text('h1'));

  // 1. stock sheet: add the AAA Duracell pool through the real form
  await admin.click('[data-action="stock-new"]');
  await admin.waitFor("document.querySelector('form[data-form=\"stock\"]')");
  await admin.fill('form[data-form="stock"]', { kind: 'AAA', brand: 'Duracell', product_line: 'Recharge', total: '24' });
  await admin.submit('form[data-form="stock"]');
  await admin.waitFor("document.querySelectorAll('.batteries-pool').length === 1");
  ok(/24 = 0 en aparatos · 0 en cargador · 0 en cajón · 24 sin ubicar/.test(await admin.text('.batteries-pool')), 'pool line shows the breakdown', (await admin.text('.batteries-pool') || '').replace(/\n/g, ' | '));

  // 2. put 3 in a device through the form; the implicit template fills a repeat use later
  await admin.click('[data-action="place"]');
  await admin.waitFor("document.querySelector('form[data-form=\"place\"]')");
  await admin.fill('form[data-form="place"]', { label: 'Tren Thomas de Ángel', quantity: '3' });
  await admin.submit('form[data-form="place"]');
  await admin.waitFor("document.querySelectorAll('.batteries-card').length === 1");
  const cardText = (await admin.text('.batteries-card')).replace(/\n/g, ' | ');
  ok(/3 × AAA Duracell Recharge/.test(cardText) && /puestas hoy/.test(cardText), 'place card with age', cardText);
  ok(/3 en aparatos/.test(await admin.text('.batteries-pool')), 'breakdown updated to 3 in devices');

  // 3. the browser itself made the sidecar calls (proof the page works through the proxy)
  ok(admin.requests.some((r) => r.startsWith('POST /api/extensions/batteries/pools')), 'browser POSTed to the sidecar', admin.requests.join(', '));
  ok(admin.errors.length === 0, 'no console errors', admin.errors.join(' ;; '));

  // 4. ?lugar=<slug> highlights the card (the QR of v1.1)
  const trenSlug = await admin.evaluate("document.querySelector('.batteries-card')?.dataset.slug");
  await admin.goto(`/m/batteries?lugar=${trenSlug}`);
  await admin.waitFor("document.querySelector('.batteries-card--focus')");
  ok(true, `?lugar= highlights the place card (${trenSlug})`);

  // 5. a hostile label comes out as text
  await admin.click('[data-action="place"]');
  await admin.waitFor("document.querySelector('form[data-form=\"place\"]')");
  await admin.fill('form[data-form="place"]', { label: '<img src=x onerror=window.__xss=1>', quantity: '1' });
  await admin.submit('form[data-form="place"]');
  await admin.waitFor("document.querySelectorAll('.batteries-card').length === 2");
  ok(await admin.evaluate('window.__xss === undefined'), 'script in a label did not run');
  ok(await admin.evaluate("document.body.innerHTML.includes('&lt;img') || document.body.innerText.includes('<img src=x')"), 'hostile label shown as text');

  // 6. read-only member: everything visible, no write buttons, hint shown
  await withBrowser(`${DEV}/jars/angel.jar`, async (angel) => {
    console.log('— angel (read) —');
    await angel.goto('/m/batteries');
    await angel.waitFor("document.querySelector('.batteries')");
    ok(await angel.evaluate("!!document.querySelector('.batteries-readonly')"), 'read-only hint shown');
    const cards = await angel.evaluate("document.querySelectorAll('.batteries-card').length");
    const buttons = await angel.evaluate("[...document.querySelectorAll('.batteries [data-action]')].map(b => b.dataset.action).join(',')");
    ok(buttons.split(',').filter(Boolean).every((a) => a === 'history') && buttons.split(',').length === cards, 'member sees only history', buttons);
    ok(/24 = 4 en aparatos · 0 en cargador · 0 en cajón · 20 sin ubicar/.test(await angel.text('.batteries-pool')), 'member sees the stock line');
    ok(angel.errors.length === 0, 'no console errors for the member', angel.errors.join(' ;; '));
  });
});

console.log(failed ? `\n${failed} FAILED` : '\nall ok');
process.exit(failed ? 1 : 0);
