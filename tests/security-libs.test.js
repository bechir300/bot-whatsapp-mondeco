// Tests V6.45 des briques de sécurité isolées : signature des webhooks
// Meta, origine des requêtes (CSRF), trust proxy, limite de connexion.
const assert = require('assert');
const crypto = require('crypto');
const {
  resolveWebhookSignaturePolicy,
  verifyMetaSignature,
  webhookSignatureDecision,
  webhookSignatureStartupMessages,
  whatsappPhoneNumberIdAccepted
} = require('../lib/webhook-signature');
const {
  evaluateRequestOrigin,
  createOriginGuard,
  createCrossSiteGetGuard,
  originGuardOptionsFromEnv,
  resolveTrustProxySetting,
  createRemoteProxyDetector
} = require('../lib/origin-guard');
const { createLoginThrottle } = require('../lib/login-throttle');

let passed = 0;
async function test(label, fn) {
  await fn();
  passed++;
  console.log('PASS', label);
}

const sign = (body, secret) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

(async () => {
  // ---------------- Signature des webhooks ----------------
  await test('signature obligatoire par défaut dès qu’un secret existe', () => {
    assert.strictEqual(resolveWebhookSignaturePolicy({ envValue: undefined, secrets: { meta: 's' } }).required, true);
    assert.strictEqual(resolveWebhookSignaturePolicy({ envValue: '', secrets: { whatsapp: 's' } }).required, true);
  });

  await test('sans aucun secret : accepté (compatibilité) avec alerte de démarrage', () => {
    const policy = resolveWebhookSignaturePolicy({ envValue: '', secrets: { meta: '', whatsapp: '' } });
    assert.strictEqual(policy.required, false);
    const messages = webhookSignatureStartupMessages(policy);
    assert.strictEqual(messages[0].level, 'error');
    assert.ok(/SÉCURITÉ/.test(messages[0].text));
  });

  await test('désactivation d’urgence explicite WEBHOOK_SIGNATURE_REQUIRED=false', () => {
    const policy = resolveWebhookSignaturePolicy({ envValue: 'false', secrets: { meta: 's' } });
    assert.strictEqual(policy.required, false);
    assert.strictEqual(webhookSignatureStartupMessages(policy)[0].level, 'warn');
    // Une signature fausse reste refusée même en désactivation d'urgence.
    assert.strictEqual(webhookSignatureDecision({ signatureValid: false, required: false }).accept, false);
  });

  await test('vérification HMAC : valide, fausse, absente, sans secret', () => {
    const body = Buffer.from('{"object":"whatsapp_business_account"}');
    assert.strictEqual(verifyMetaSignature(body, sign(body, 'secret'), 'secret'), true);
    assert.strictEqual(verifyMetaSignature(body, sign(body, 'autre'), 'secret'), false);
    assert.strictEqual(verifyMetaSignature(body, '', 'secret'), false);
    assert.strictEqual(verifyMetaSignature(undefined, sign(body, 'secret'), 'secret'), false);
    assert.strictEqual(verifyMetaSignature(body, '', ''), null);
  });

  await test('décision : canal sans secret refusé si la signature est obligatoire', () => {
    assert.deepStrictEqual(webhookSignatureDecision({ signatureValid: null, required: true }).reason, 'no_secret');
    assert.deepStrictEqual(webhookSignatureDecision({ signatureValid: null, required: false }).reason, 'unsigned');
    assert.strictEqual(webhookSignatureDecision({ signatureValid: true, required: true }).accept, true);
  });

  await test('numéro WhatsApp du webhook : obligatoire pour les messages si PHONE_NUMBER_ID est configuré', () => {
    assert.strictEqual(whatsappPhoneNumberIdAccepted({ configured: '111', incoming: '111' }), true);
    assert.strictEqual(whatsappPhoneNumberIdAccepted({ configured: '111', incoming: '222' }), false);
    assert.strictEqual(whatsappPhoneNumberIdAccepted({ configured: '111', incoming: '' }), false, 'metadata absente : ignoré');
    assert.strictEqual(whatsappPhoneNumberIdAccepted({ configured: '111', incoming: '', requirePresence: false }), true, 'échos : tolérés sans numéro');
    assert.strictEqual(whatsappPhoneNumberIdAccepted({ configured: '111', incoming: '222', requirePresence: false }), false);
    assert.strictEqual(whatsappPhoneNumberIdAccepted({ configured: '', incoming: '' }), true, 'non configuré : comportement inchangé');
  });

  // ---------------- Origine des requêtes (CSRF) ----------------
  const req = (method, headers, path = '/api/speed-cleanup') => ({ method, path, originalUrl: `/admin${path}`, headers });

  await test('origine étrangère (même site *.mondeco.tn) refusée', () => {
    const verdict = evaluateRequestOrigin(req('POST', { host: 'app.mondeco.tn', origin: 'https://evil.mondeco.tn', 'sec-fetch-site': 'same-site' }));
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual(verdict.reason, 'foreign_origin');
  });

  await test('même origine acceptée (Origin, Referer, X-Forwarded-Host, Sec-Fetch-Site)', () => {
    assert.ok(evaluateRequestOrigin(req('POST', { host: 'app.mondeco.tn', origin: 'https://app.mondeco.tn' })).ok);
    assert.ok(evaluateRequestOrigin(req('DELETE', { host: 'app.mondeco.tn', referer: 'https://app.mondeco.tn/admin' })).ok);
    assert.ok(evaluateRequestOrigin(req('PUT', { host: '127.0.0.1:3000', 'x-forwarded-host': 'app.mondeco.tn', origin: 'https://app.mondeco.tn' })).ok);
    // Proxy qui réécrit Host : le navigateur atteste lui-même la même origine.
    assert.ok(evaluateRequestOrigin(req('POST', { host: '127.0.0.1:3000', origin: 'https://app.mondeco.tn', 'sec-fetch-site': 'same-origin' })).ok);
  });

  await test('requête sans Origin ni Referer refusée sous /admin, sauf chemin exempté', () => {
    assert.strictEqual(evaluateRequestOrigin(req('POST', { host: 'app.mondeco.tn' })).reason, 'missing_origin');
    assert.ok(evaluateRequestOrigin(req('POST', { host: 'app.mondeco.tn' }, '/api/woocommerce/webhook'), { exemptPaths: ['/api/woocommerce/webhook'] }).ok);
    assert.ok(evaluateRequestOrigin(req('GET', {})).ok);
    assert.strictEqual(evaluateRequestOrigin(req('POST', { host: 'app.mondeco.tn', origin: 'null' })).ok, false);
  });

  await test('en-tête X-Mondeco-Client : accepté sans Origin (proxy qui réécrit Host), jamais si le navigateur atteste un autre site', () => {
    // Proxy qui remplace Host par 127.0.0.1 + navigateur sans Sec-Fetch-Site.
    assert.strictEqual(evaluateRequestOrigin(req('POST', { host: '127.0.0.1:3000', origin: 'https://app.mondeco.tn', 'x-mondeco-client': 'admin' })).reason, 'app_header');
    assert.ok(evaluateRequestOrigin(req('POST', { host: 'app.mondeco.tn', 'x-mondeco-client': 'admin' })).ok);
    const crossSite = evaluateRequestOrigin(req('POST', { host: 'app.mondeco.tn', origin: 'https://evil.mondeco.tn', 'sec-fetch-site': 'same-site', 'x-mondeco-client': 'admin' }));
    assert.strictEqual(crossSite.ok, false);
    assert.strictEqual(evaluateRequestOrigin(req('POST', { host: 'app.mondeco.tn', 'sec-fetch-site': 'cross-site', 'x-mondeco-client': 'admin' })).ok, false);
  });

  await test('GET de diagnostic (/test-ia) : refusé depuis un autre site, accepté en saisie directe', () => {
    const quiet = { warn() {} };
    const guard = createCrossSiteGetGuard({ logger: quiet });
    const run = headers => {
      let status = 0;
      let nextCalled = false;
      const res = { status(code) { status = code; return this; }, json() { return this; } };
      guard({ method: 'GET', path: '/test-ia', originalUrl: '/test-ia', headers }, res, () => { nextCalled = true; });
      return { status, nextCalled };
    };
    assert.deepStrictEqual(run({ 'sec-fetch-site': 'same-site' }), { status: 403, nextCalled: false });
    assert.deepStrictEqual(run({ 'sec-fetch-site': 'cross-site' }), { status: 403, nextCalled: false });
    assert.deepStrictEqual(run({ 'sec-fetch-site': 'none' }), { status: 0, nextCalled: true });
    assert.deepStrictEqual(run({}), { status: 0, nextCalled: true });
  });

  await test('ADMIN_ALLOWED_ORIGINS / PUBLIC_BASE_URL et modes report/off', () => {
    const options = originGuardOptionsFromEnv({ ADMIN_ALLOWED_ORIGINS: 'https://admin.mondeco.tn, pilotage.mondeco.tn', PUBLIC_BASE_URL: 'https://app.mondeco.tn', ADMIN_ORIGIN_CHECK: '' });
    assert.strictEqual(options.mode, 'enforce');
    assert.deepStrictEqual(options.allowedHosts, ['admin.mondeco.tn', 'pilotage.mondeco.tn', 'app.mondeco.tn']);
    assert.ok(evaluateRequestOrigin(req('POST', { host: '127.0.0.1', origin: 'https://admin.mondeco.tn' }), options).ok);
    assert.strictEqual(originGuardOptionsFromEnv({ ADMIN_ORIGIN_CHECK: 'report' }).mode, 'report');
    assert.strictEqual(originGuardOptionsFromEnv({ ADMIN_ORIGIN_CHECK: 'off' }).mode, 'off');
  });

  await test('middleware : 403 en mode enforce, passe en mode report', () => {
    const quiet = { warn() {} };
    const run = mode => {
      let status = 0;
      let nextCalled = false;
      const res = { status(code) { status = code; return this; }, json() { return this; } };
      createOriginGuard({ mode, logger: quiet })(req('POST', { host: 'a.tn', origin: 'https://b.tn' }), res, () => { nextCalled = true; });
      return { status, nextCalled };
    };
    assert.deepStrictEqual(run('enforce'), { status: 403, nextCalled: false });
    assert.deepStrictEqual(run('report'), { status: 0, nextCalled: true });
  });

  // ---------------- trust proxy ----------------
  await test('trust proxy : TRUST_PROXY_HOPS, Railway détecté, défaut loopback', () => {
    assert.strictEqual(resolveTrustProxySetting({ TRUST_PROXY_HOPS: '2' }).value, 2);
    assert.strictEqual(resolveTrustProxySetting({ TRUST_PROXY_HOPS: '0', RAILWAY_ENVIRONMENT_NAME: 'production' }).value, 0);
    assert.strictEqual(resolveTrustProxySetting({ RAILWAY_ENVIRONMENT_NAME: 'production' }).value, 1);
    assert.strictEqual(resolveTrustProxySetting({}).value, 'loopback');
  });

  await test('proxy distant sans TRUST_PROXY_HOPS : avertissement unique', () => {
    const warnings = [];
    const detector = createRemoteProxyDetector({ logger: { warn: text => warnings.push(text) } });
    detector({ headers: { 'x-forwarded-for': '198.51.100.7' }, socket: { remoteAddress: '127.0.0.1' } }, {}, () => {});
    assert.strictEqual(warnings.length, 0, 'Nginx local : pas d’alerte');
    detector({ headers: { 'x-forwarded-for': '198.51.100.7' }, socket: { remoteAddress: '10.0.0.5' } }, {}, () => {});
    detector({ headers: { 'x-forwarded-for': '198.51.100.8' }, socket: { remoteAddress: '10.0.0.5' } }, {}, () => {});
    assert.strictEqual(warnings.length, 1);
    assert.ok(/TRUST_PROXY_HOPS=1/.test(warnings[0]));
  });

  // ---------------- Limite de connexion ----------------
  let clock = Date.parse('2026-11-11T10:00:00Z');
  const throttle = createLoginThrottle({ now: () => clock });

  await test('échecs depuis 8 IP différentes : le compte n’est jamais bloqué (délai seulement)', () => {
    for (let i = 1; i <= 8; i++) {
      assert.strictEqual(throttle.check({ ip: `203.0.113.${i}`, email: 'admin@mondeco.tn' }).blocked, false);
      throttle.registerFailure({ ip: `203.0.113.${i}`, email: 'admin@mondeco.tn' });
    }
    const fresh = throttle.check({ ip: '198.51.100.77', email: 'admin@mondeco.tn' });
    assert.strictEqual(fresh.blocked, false, 'le vrai titulaire peut se connecter depuis son poste');
    assert.strictEqual(fresh.delayMs, 1000);
    for (let i = 0; i < 40; i++) throttle.registerFailure({ ip: `192.0.2.${i}`, email: 'admin@mondeco.tn' });
    const later = throttle.check({ ip: '198.51.100.77', email: 'admin@mondeco.tn' });
    assert.strictEqual(later.blocked, false);
    assert.strictEqual(later.delayMs, 8000, 'délai plafonné');
  });

  await test('8 échecs depuis la même IP sur le même compte : couple bloqué 15 min', () => {
    for (let i = 0; i < 8; i++) throttle.registerFailure({ ip: '203.0.113.50', email: 'coma@mondeco.tn' });
    const same = throttle.check({ ip: '203.0.113.50', email: 'coma@mondeco.tn' });
    assert.strictEqual(same.blocked, true);
    assert.strictEqual(same.scope, 'pair');
    assert.strictEqual(throttle.check({ ip: '203.0.113.51', email: 'coma@mondeco.tn' }).blocked, false);
    assert.strictEqual(throttle.check({ ip: '203.0.113.50', email: 'comb@mondeco.tn' }).blocked, false);
    clock += 15 * 60 * 1000 + 1;
    assert.strictEqual(throttle.check({ ip: '203.0.113.50', email: 'coma@mondeco.tn' }).blocked, false, 'blocage levé après 15 min');
  });

  await test('30 échecs d’une même IP sur des comptes variés : IP bloquée', () => {
    for (let i = 0; i < 30; i++) throttle.registerFailure({ ip: '203.0.113.99', email: `user${i}@mondeco.tn` });
    const verdict = throttle.check({ ip: '203.0.113.99', email: 'autre@mondeco.tn' });
    assert.strictEqual(verdict.blocked, true);
    assert.strictEqual(verdict.scope, 'ip');
  });

  await test('les compteurs expirent après la fenêtre et un succès les remet à zéro', () => {
    throttle.registerFailure({ ip: '203.0.113.7', email: 'x@mondeco.tn' });
    clock += 15 * 60 * 1000 + 1;
    throttle.sweep();
    assert.strictEqual(throttle.check({ ip: '203.0.113.7', email: 'x@mondeco.tn' }).emailFailures, 0);
    for (let i = 0; i < 9; i++) throttle.registerFailure({ ip: `10.1.1.${i}`, email: 'y@mondeco.tn' });
    assert.ok(throttle.check({ ip: '10.9.9.9', email: 'y@mondeco.tn' }).delayMs > 0);
    throttle.registerSuccess({ ip: '10.9.9.9', email: 'y@mondeco.tn' });
    assert.strictEqual(throttle.check({ ip: '10.9.9.9', email: 'y@mondeco.tn' }).delayMs, 0);
  });

  await test('mémoire bornée face à une pulvérisation d’e-mails', () => {
    const small = createLoginThrottle({ maxEntries: 100 });
    for (let i = 0; i < 1000; i++) small.registerFailure({ ip: `10.0.${i % 250}.1`, email: `spray${i}@x.tn` });
    assert.ok(small.size() <= 100);
  });

  console.log(`ALL ${passed} SECURITY LIB TESTS PASSED`);
})().catch(error => {
  console.error('FAIL', error);
  process.exit(1);
});
