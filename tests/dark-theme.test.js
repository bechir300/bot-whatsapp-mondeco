// Tests du générateur de mode sombre (scripts/build-dark-theme.js).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseColor, darkBackground, darkText, convertRule, parseBlocks, render } = require('../scripts/build-dark-theme');

let passed = 0;
function test(label, fn) { fn(); passed++; console.log('PASS', label); }

const lightness = c => {
  const [r, g, b] = c.rgb.map(v => v / 255);
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
};

test('fond blanc → surface sombre ; bouton rouge inchangé', () => {
  assert.ok(lightness(darkBackground(parseColor('#ffffff'))) < 0.15);
  assert.deepStrictEqual(darkBackground(parseColor('#D7262E')).rgb, parseColor('#D7262E').rgb);
});

test('texte foncé → clair en gardant la teinte (vert reste vert)', () => {
  const green = darkText(parseColor('#2F6B45'), false);
  assert.ok(lightness(green) > 0.6);
  assert.ok(green.rgb[1] > green.rgb[0] && green.rgb[1] > green.rgb[2]);
  assert.deepStrictEqual(darkText(parseColor('#ffffff'), false).rgb, [255, 255, 255]);
});

test('règle : préfixe, priorité d’origine conservée, navigation ignorée', () => {
  const out = convertRule({ selector: '.card, .sidebar .x', body: 'background:#fff;color:#221C17;padding:4px' });
  assert.ok(out.startsWith('html[data-theme="dark"] .card{'));
  assert.ok(!out.includes('.sidebar'));
  assert.ok(!out.includes('!important'));
  assert.ok(!out.includes('padding'));
  const important = convertRule({ selector: '.a', body: 'background:#fff !important' });
  assert.ok(important.includes('!important'));
  assert.strictEqual(convertRule({ selector: '.b', body: 'background:var(--panel)' }), '');
});

test('@media conservé', () => {
  const blocks = parseBlocks('@media (max-width:600px){.a{color:#111}} .b{color:#222}');
  assert.strictEqual(blocks[0].at, '@media (max-width:600px)');
  assert.strictEqual(blocks[0].children[0].selector, '.a');
});

test('Admin.html : mode sombre à jour (sinon lancer npm run build:dark)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'Admin.html'), 'utf8');
  assert.ok(render(html).html === html, 'Le CSS a changé : lancez npm run build:dark puis validez Admin.html.');
});

console.log(`${passed} test(s) mode sombre OK`);
