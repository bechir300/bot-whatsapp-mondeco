// V6.46 — Tests du paquet « front Inbox » (Admin.html) : les VRAIES
// fonctions d'Admin.html sont extraites et exécutées dans un contexte vm
// (Admin.html n'est pas un module), puis la route produit d'Admin.js
// (« Pas un doublon », retour à la valeur du site) est testée sur le vrai
// serveur démarré avec un DATA_DIR temporaire.
// Couvre : libellés lisibles sous les bulles (plus de « ai_reply »), menu
// « ⋯ » au lieu du bouton rouge, badge « IA en pause » identique à
// lib/messaging-rules.js, accusés de réception (✓, ✓✓, vu, non délivré,
// jamais de retour en arrière), fusion du fil sans perdre l'historique
// chargé, fenêtre WhatsApp en direct, bulle d'alertes par conversation
// (plafond 99+), pas de rejeu des alertes anciennes au login, alerte des
// commerciaux pour la file commune, brouillon d'un envoi échoué gardé
// dans SA conversation, badges produits échappés.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const { conversationAiPauseReason } = require('../lib/messaging-rules');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'Admin.html'), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

let passed = 0;
async function test(label, fn) {
  await fn();
  passed++;
  console.log('PASS', label);
}

function extractFunction(source, name) {
  const match = new RegExp(`(?:async\\s+)?function ${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`Fonction introuvable : ${name}`);
  let i = source.indexOf('(', match.index);
  for (let parens = 0; i < source.length; i++) {
    if (source[i] === '(') parens++;
    if (source[i] === ')' && --parens === 0) break;
  }
  for (let depth = 0, j = source.indexOf('{', i); j < source.length; j++) {
    if (source[j] === '{') depth++;
    if (source[j] === '}' && --depth === 0) return source.slice(match.index, j + 1);
  }
  throw new Error(`Fonction non terminée : ${name}`);
}

function extractStatement(source, startText) {
  const start = source.indexOf(startText);
  if (start < 0) throw new Error(`Déclaration introuvable : ${startText}`);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    if (ch === '}' || ch === ')' || ch === ']') depth--;
    if (ch === ';' && depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Déclaration non terminée : ${startText}`);
}

// Élément DOM minimal (suffisant pour les fonctions testées).
function fakeElement(props = {}) {
  return {
    value: '', innerHTML: '', textContent: '', dataset: {}, style: { setProperty() {} },
    classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, contains(c) { return this._set.has(c); }, toggle(c, on) { if (on === undefined ? !this._set.has(c) : on) this._set.add(c); else this._set.delete(c); } },
    addEventListener() {}, querySelector() { return fakeElement(); }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, height: 0, width: 0 }; },
    ...props
  };
}

function createContext(extra = {}) {
  const elements = {};
  const context = vm.createContext({
    console: { log() {}, debug() {}, warn() {}, error() {} },
    String, Number, Array, Object, RegExp, JSON, Date, Set, Map, Math, Intl, Promise, Boolean, Error,
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: fn => fn(),
    elements,
    document: {
      visibilityState: 'visible',
      body: fakeElement(),
      getElementById: id => elements[id] || null,
      querySelector: () => null,
      querySelectorAll: () => []
    },
    window: { matchMedia: () => ({ matches: true }), innerWidth: 1440, innerHeight: 900, addEventListener() {} },
    localStorage: { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = String(v); } },
    currentUser: { role: 'admin', id: 'u-admin' },
    selectedConversationContact: '',
    selectedConversationData: null,
    ...extra
  });
  return context;
}

function load(context, names, prelude = '') {
  vm.runInContext(`${prelude}\n${names.map(name => extractFunction(html, name)).join('\n')}`, context);
  return context;
}

const BASIC = ['escapeHtml', 'jsArg', 'formatDate', 'formatShortTime', 'formatElapsedSince', 'conversationChannel', 'channelDisplayName'];

(async () => {
  // ================= Libellés et menu des messages =================
  await test('libellés lisibles : plus de code brut (ai_reply…) sous les bulles', async () => {
    const ctx = load(createContext(), ['actionLabel', 'threadMetaLabel'], extractStatement(html, 'const THREAD_META_GENERIC_ACTIONS'));
    for (const code of ['ai_reply', 'ai_product_card', 'ad_quick_reply', 'ai_bulk_unread_response', 'outside_hours_message', 'facebook_inbound_recovered', 'review_request_sent']) {
      const label = ctx.actionLabel(code);
      assert.ok(label && label !== code && !/_/.test(label), `${code} → ${label}`);
    }
    assert.strictEqual(ctx.actionLabel('code_inconnu_xyz'), '');
    assert.strictEqual(ctx.threadMetaLabel('incoming', { action: 'ai_reply', incoming: 'Bonjour', reply: 'Bonjour !' }), 'Message client');
    assert.strictEqual(ctx.threadMetaLabel('outgoing', { action: 'ai_reply', reply: 'x' }), 'Réponse IA');
    assert.strictEqual(ctx.threadMetaLabel('outgoing', { action: 'ai_product_card', reply: 'x' }), 'Fiche produit envoyée');
    assert.strictEqual(ctx.threadMetaLabel('outgoing', { action: 'commercial_reply', reply: 'x' }, { commercial: true }), 'Réponse commerciale');
    assert.strictEqual(ctx.threadMetaLabel('incoming', { action: 'ai_error_no_reply', incoming: 'Bonjour' }), 'Message client · Erreur IA — sans réponse');
  });

  await test('bulle : menu « ⋯ » discret (droits inchangés), aucun code brut, texte échappé', async () => {
    const ctx = createContext({ currentUser: { role: 'commercial', id: 'c1' }, selectedConversationData: { access: { assignedToMe: false } } });
    load(ctx, [...BASIC, 'actionLabel', 'threadMetaLabel', 'conversationEntryAttachments', 'renderThreadMessage'],
      `${extractStatement(html, 'const THREAD_META_GENERIC_ACTIONS')}\nfunction renderConversationAttachment(){return '';}`);
    const entry = { time: '2026-11-11T20:00:00Z', incoming: '<img src=x onerror=1>Prix ?', reply: 'Réponse', action: 'ai_reply', purgeKeys: { incoming: 'k1', reply: 'k2' } };
    const commercialNotAssigned = ctx.renderThreadMessage('incoming', entry.incoming, entry, false);
    assert.ok(!commercialNotAssigned.includes('ai_reply'));
    assert.ok(!commercialNotAssigned.includes('inbox-message-delete'));
    assert.ok(commercialNotAssigned.includes('Message client'));
    assert.ok(!commercialNotAssigned.includes('<img src=x'));
    assert.ok(/data-hide-key=""/.test(commercialNotAssigned), 'commercial non affecté : pas de masquage');
    ctx.currentUser = { role: 'admin', id: 'a1' };
    const admin = ctx.renderThreadMessage('outgoing', entry.reply, entry, false);
    assert.ok(admin.includes('data-msg-menu="1"') && admin.includes('data-hide-key="k2"'));
    assert.ok(admin.includes('Réponse IA'));
    const hidden = ctx.renderThreadMessage('incoming', 'Message masqué', { ...entry, softDeleted: { incoming: { id: 'del-1' }, keys: { incoming: 'orig' } } }, false);
    assert.ok(hidden.includes('data-restore-id="del-1"') && hidden.includes('data-purge-key="orig"') && hidden.includes('data-hide-key=""'));
  });

  // ================= Pause IA =================
  await test('« IA en pause » : même règle que lib/messaging-rules.js (pausedUntil, commercialAttention)', async () => {
    const ctx = load(createContext(), ['conversationAiPausedForUi', 'conversationAiPauseInfo']);
    const now = Date.now();
    const variants = [];
    for (const manualTakeover of [undefined, false, true]) {
      for (const humanPaused of [undefined, false, true]) {
        for (const pausedUntil of [undefined, '', 'pas une date', new Date(now - 60000).toISOString(), new Date(now + 3600000).toISOString()]) {
          for (const commercialAttention of [false, true]) variants.push({ manualTakeover, humanPaused, pausedUntil, commercialAttention, imageNeedsCommercial: commercialAttention });
        }
      }
    }
    for (const state of variants) {
      assert.strictEqual(ctx.conversationAiPausedForUi(state), Boolean(conversationAiPauseReason(state, Date.now())), JSON.stringify(state));
      const info = ctx.conversationAiPauseInfo(state);
      assert.strictEqual(Boolean(info), Boolean(conversationAiPauseReason(state, Date.now())));
      if (info) assert.strictEqual(info.reason, conversationAiPauseReason(state, Date.now()));
    }
    // Cas de la capture : commercialAttention seul = IA active (alerte à part).
    assert.strictEqual(ctx.conversationAiPausedForUi({ commercialAttention: true, humanPaused: false }), false);
  });

  // ================= Accusés de réception =================
  await test('accusés : ✓ envoyé, ✓✓ distribué, vu, non délivré ; le « vu » ne recule jamais', async () => {
    const ctx = load(createContext(), [...BASIC, 'conversationReceiptStatus'], 'const conversationReadWatermarks = new Map(); const RECEIPT_CLOCK_TOLERANCE_MS = 3000;');
    const t = minutes => new Date(Date.now() - minutes * 60000).toISOString();
    assert.strictEqual(ctx.conversationReceiptStatus('c0', {}), null);
    assert.strictEqual(ctx.conversationReceiptStatus('c1', { lastBotAt: t(10) }).kind, 'sent');
    assert.strictEqual(ctx.conversationReceiptStatus('c1', { lastBotAt: t(10), lastDeliveredAt: t(9) }).kind, 'delivered');
    assert.strictEqual(ctx.conversationReceiptStatus('c1', { lastBotAt: t(10), lastDeliveredAt: t(9), lastReadByCustomerAt: t(8) }).kind, 'seen');
    // Statut « read » ancien reçu en retard : reste « vu ».
    assert.strictEqual(ctx.conversationReceiptStatus('c1', { lastBotAt: t(10), lastDeliveredAt: t(9), lastReadByCustomerAt: t(40) }).kind, 'seen');
    // Nouveau message après la lecture : redevient « envoyé ».
    assert.strictEqual(ctx.conversationReceiptStatus('c1', { lastBotAt: t(2), lastReadByCustomerAt: t(8) }).kind, 'sent');
    const failed = ctx.conversationReceiptStatus('c2', { lastHumanAt: t(10), lastDeliveryFailedAt: t(9), lastDeliveryFailure: { code: '131026', title: 'Message undeliverable' } });
    assert.strictEqual(failed.kind, 'failed');
    assert.ok(failed.text.includes('131026'));
    // Échec ancien puis nouvel envoi distribué : plus d'alerte.
    assert.strictEqual(ctx.conversationReceiptStatus('c2', { lastHumanAt: t(3), lastDeliveredAt: t(2), lastDeliveryFailedAt: t(9) }).kind, 'delivered');
  });

  // ================= Fil : fusion sans perte d'historique =================
  await test('rafraîchissement du fil : historique chargé conservé, nouveaux messages ajoutés, trou détecté', async () => {
    const ctx = load(createContext(), ['conversationUiTimeMs', 'conversationEntryIdentity', 'mergeConversationTail']);
    const at = i => new Date(Date.UTC(2026, 10, 11, 10, i)).toISOString();
    const current = Array.from({ length: 240 }, (_, i) => ({ message_id: `m${i}`, direction: 'inbound_outbound', time: at(i), incoming: `n°${i}`, reply: '' }));
    const latest = current.slice(-30).map(entry => ({ ...entry }));
    latest[latest.length - 1] = { ...latest[latest.length - 1], reply: 'réponse ajoutée' };
    latest.push({ message_id: 'm240', direction: 'incoming', time: at(240), incoming: 'nouveau' });
    const merged = ctx.mergeConversationTail(current, latest.slice(-31));
    assert.strictEqual(merged.gap, false);
    assert.strictEqual(merged.entries.length, 241);
    assert.strictEqual(merged.entries[0].incoming, 'n°0', 'les messages anciens chargés restent');
    assert.strictEqual(merged.entries[239].reply, 'réponse ajoutée', 'entrée mise à jour remplacée, pas dupliquée');
    assert.strictEqual(merged.entries[240].incoming, 'nouveau');
    const gap = ctx.mergeConversationTail(current.slice(0, 100), latest);
    assert.strictEqual(gap.gap, true);
    assert.strictEqual(ctx.mergeConversationTail([], latest).entries.length, latest.length);
  });

  // ================= Fenêtre WhatsApp en direct =================
  await test('fenêtre WhatsApp : temps restant calculé en direct, fermeture détectée sans le serveur', async () => {
    const ctx = load(createContext(), ['escapeHtml', 'formatWhatsAppWindowRemaining', 'whatsappWindowRemainingMs', 'whatsappWindowIsExpired', 'whatsappWindowStatusText', 'whatsappWindowStatusHtml']);
    const open = { applicable: true, known: true, expired: false, remainingMs: 109333, expiresAt: new Date(Date.now() + 2 * 3600000 + 5 * 60000).toISOString() };
    assert.ok(ctx.whatsappWindowStatusText(open).includes('2 h'), ctx.whatsappWindowStatusText(open));
    const closedLocally = { ...open, expiresAt: new Date(Date.now() - 1000).toISOString() };
    assert.strictEqual(ctx.whatsappWindowIsExpired(closedLocally), true, 'remainingMs figé ignoré');
    assert.strictEqual(ctx.whatsappWindowStatusHtml({ whatsappWindow: closedLocally }), '');
    assert.ok(ctx.whatsappWindowStatusText({ ...open, expiresAt: new Date(Date.now() + 20000).toISOString() }).includes('moins d’1 min'));
    assert.strictEqual(ctx.whatsappWindowIsExpired({ applicable: true, known: false }), false);
    assert.strictEqual(ctx.whatsappWindowIsExpired({ applicable: false, expired: true }), false);
  });

  // ================= Bulle d'alertes =================
  await test('bulle : une entrée par conversation, retirée à l’ouverture, compteur plafonné à 99+', async () => {
    const container = fakeElement({ querySelector: () => fakeElement() });
    const ctx = createContext();
    ctx.elements.mondecoBubbleContainer = container;
    ctx.elements.mondecoSingleBubble = fakeElement();
    ctx.ResizeObserver = undefined;
    load(ctx, ['escapeHtml', 'floatingBubbleKey', 'showFloatingBubble', 'dismissFloatingBubbleContact', 'updateFloatingBubbleLayout', 'floatingBubbleIdentity', 'renderMondecoBubble', 'openFloatingBubbleItem'],
      'var mondecoBubbleItems = new Map(); var floatingBubbleResizeObserver = null;');
    for (let i = 0; i < 10; i++) ctx.showFloatingBubble({ id: `n${i}`, kind: 'message', contact: '21655000001', profileName: 'Sana', preview: `msg ${i}` });
    assert.strictEqual(ctx.mondecoBubbleItems.size, 1, 'dix messages du même client = une entrée');
    assert.ok(!/mondeco-bubble-count/.test(container.innerHTML));
    for (let i = 0; i < 150; i++) ctx.showFloatingBubble({ id: `x${i}`, kind: 'message', contact: `2165600${String(i).padStart(4, '0')}`, preview: 'x' });
    assert.ok(container.innerHTML.includes('>99+<'), 'plafond 99+');
    ctx.dismissFloatingBubbleContact('21655000001');
    assert.strictEqual(ctx.mondecoBubbleItems.size, 150);
    ctx.showFloatingBubble({ kind: 'report', id: 'r' });
    assert.strictEqual(ctx.mondecoBubbleItems.size, 150, 'rapport quotidien : pas de bulle');
  });

  // ================= Alertes au login et file commune =================
  function pollContext({ cursor, response, role = 'admin', pendingBefore = null }) {
    const calls = { urls: [], single: [], summary: [], bubbles: [], lists: 0 };
    const ctx = createContext({
      currentUser: { role, id: 'u1' },
      API: '/admin/api',
      BACKGROUND_REQUEST_TIMEOUT_MS: 15000,
      conversationNotificationCursor: cursor,
      conversationNotificationUnread: 0,
      interactionPendingCounts: { messages: 0 },
      lastPendingMessagesCount: pendingBefore,
      lastNewPendingAlerts: undefined,
      notificationSeenIds: new Set(),
      inboxInteractionMode: 'messages',
      conversationSendInProgress: false,
      apiFetch: async url => { calls.urls.push(url); return response; },
      updateNotificationBadges() {},
      seenTaskNotificationIds: () => new Set(),
      rememberTaskNotification() {},
      showFloatingBubble: event => calls.bubbles.push(event),
      showClientBrowserNotification: event => calls.single.push(event),
      showClientBrowserNotificationSummary: events => calls.summary.push(events),
      loadSocialComments: async () => {},
      loadConversations: async () => { calls.lists++; },
      softRefreshSelectedConversation() {},
      loadNotificationPanel: async () => {}
    });
    ctx.elements.notificationPanelBackdrop = fakeElement({ classList: { contains: () => true } });
    ctx.elements['page-conversations'] = fakeElement();
    ctx.elements['page-conversations'].classList.add('active');
    load(ctx, ['pollCommercialNotificationsOnce'], 'const NOTIFICATION_REPLAY_MAX_AGE_MS = 10 * 60 * 1000;');
    return { ctx, calls };
  }

  await test('login du matin : aucune relecture des 400 alertes de la nuit, un seul résumé sans son', async () => {
    const nightEvents = Array.from({ length: 400 }, (_, i) => ({ id: `n${i}`, kind: 'message', contact: `c${i % 140}` }));
    const { ctx, calls } = pollContext({ cursor: new Date(Date.now() - 11 * 3600e3).toISOString(), response: { events: nightEvents, pendingCounts: { messages: 37 }, serverTime: new Date().toISOString() } });
    await ctx.pollCommercialNotificationsOnce();
    assert.ok(!calls.urls[0].includes('since='), 'pas de relecture');
    assert.strictEqual(calls.single.length + calls.summary.length, 0, 'aucune notification système');
    assert.strictEqual(calls.bubbles.length, 1);
    assert.strictEqual(calls.bubbles[0].kind, 'summary');
    assert.strictEqual(calls.bubbles[0].count, 37);
    assert.ok(Date.now() - Date.parse(ctx.conversationNotificationCursor) < 5000, 'curseur remis à l’heure du serveur');
  });

  await test('lot d’alertes : une seule notification système pour plusieurs messages', async () => {
    const { ctx, calls } = pollContext({ cursor: new Date(Date.now() - 5000).toISOString(), pendingBefore: 3, response: { events: [{ id: 'a', kind: 'message', contact: 'c1' }, { id: 'b', kind: 'message', contact: 'c2' }, { id: 'c', kind: 'message', contact: 'c1' }], pendingCounts: { messages: 5 }, serverTime: new Date().toISOString() } });
    await ctx.pollCommercialNotificationsOnce();
    assert.ok(calls.urls[0].includes('since='));
    assert.strictEqual(calls.single.length, 0);
    assert.strictEqual(calls.summary.length, 1);
    assert.strictEqual(calls.summary[0].length, 3);
    assert.strictEqual(calls.lists, 1, 'liste rafraîchie en arrière-plan');
  });

  await test('commercial : nouvelle conversation de la file commune signalée (liste comparée), pas celle d’un collègue', async () => {
    const ctx = createContext({ currentUser: { role: 'commercial', id: 'amel' } });
    const shown = [];
    ctx.showFloatingBubble = event => shown.push(event);
    ctx.showClientBrowserNotification = event => shown.push({ notif: event.contact });
    ctx.showClientBrowserNotificationSummary = events => shown.push({ summary: events.length });
    ctx.elements['page-conversations'] = fakeElement();
    load(ctx, [...BASIC, 'conversationDisplayName', 'conversationExternalContact', 'notifyNewPendingConversations'], 'var knownPendingConversationContacts = null;');
    assert.strictEqual(ctx.notifyNewPendingConversations([{ contact: 'a', pendingReply: true }], { background: false }), null);
    const events = ctx.notifyNewPendingConversations([
      { contact: 'a', pendingReply: true },
      { contact: 'b', pendingReply: true, profileName: 'Nouveau client' },
      { contact: 'c', pendingReply: true, assignedUserId: 'autre-commercial' },
      { contact: 'd', pendingReply: true, assignedUserId: 'amel' }
    ], { background: true });
    assert.strictEqual(JSON.stringify(events.map(event => event.contact)), JSON.stringify(['b', 'd']));
    assert.ok(shown.some(item => item.summary === 2));
    // Un administrateur reçoit déjà les alertes serveur : pas de doublon.
    ctx.currentUser = { role: 'admin', id: 'x' };
    assert.strictEqual(ctx.notifyNewPendingConversations([{ contact: 'e', pendingReply: true }], { background: true }).length, 0);
  });

  // ================= Envoi échoué =================
  await test('envoi échoué : le texte revient dans SA conversation, jamais dans celle ouverte entre-temps', async () => {
    const field = fakeElement({ value: '' });
    const composer = fakeElement({ dataset: { contact: 'B' } });
    const ctx = createContext({ selectedConversationContact: 'B', autoResizeConversationComposer() {}, syncConversationPrimaryAction() {} });
    ctx.elements.conversationQuickReply = field;
    ctx.elements.commercialComposer = composer;
    load(ctx, ['restoreFailedSendText', 'saveConversationDraft', 'stashComposerDraft', 'restoreComposerDraft'], 'var conversationDrafts = new Map();');
    ctx.restoreFailedSendText('A', 'Devis Bianca 3 290 DT');
    assert.strictEqual(field.value, '', 'rien dans la conversation B');
    assert.strictEqual(ctx.conversationDrafts.get('A'), 'Devis Bianca 3 290 DT');
    // Retour sur A : le brouillon est restauré.
    ctx.selectedConversationContact = 'A';
    composer.dataset.contact = 'A';
    assert.strictEqual(ctx.restoreComposerDraft('A'), true);
    assert.strictEqual(field.value, 'Devis Bianca 3 290 DT');
    // Même conversation, nouveau texte tapé entre-temps : rien n'est écrasé.
    field.value = 'Autre message';
    ctx.restoreFailedSendText('A', 'Devis Bianca 3 290 DT');
    assert.strictEqual(field.value, 'Devis Bianca 3 290 DT\nAutre message');
    // Changement de conversation : le texte en cours est gardé pour A.
    ctx.stashComposerDraft();
    assert.strictEqual(ctx.conversationDrafts.get('A'), 'Devis Bianca 3 290 DT\nAutre message');
  });

  // ================= Badges produits =================
  await test('produits : badges « Géré par le site », correction et doublon, données échappées', async () => {
    const ctx = load(createContext(), ['escapeHtml', 'formatDate', 'productIsSiteManaged', 'productOverrideFields', 'productCatalogBadgesHtml'], extractStatement(html, 'const PRODUCT_OVERRIDE_FIELD_LABELS'));
    const site = ctx.productCatalogBadgesHtml({ id: 'w1', syncSource: 'woocommerce', woocommerceId: 69317, overrides: { composition: { value: 'x', by: '<b>Admin</b>' }, price: { value: '1' } } });
    assert.ok(site.includes('Géré par le site') && site.includes('#69317'));
    assert.ok(site.includes('data-product-action="revert-override"') && site.includes('data-field="composition"'));
    assert.ok(!site.includes('data-field="price"'), 'seuls les champs figeables');
    assert.ok(!site.includes('<b>Admin</b>'));
    const dup = ctx.productCatalogBadgesHtml({ id: '"><img src=x>', duplicateOfWooId: 69317, duplicateOfName: '<script>x</script>', duplicateConfidence: 'possible' });
    assert.ok(dup.includes('Doublon possible') && dup.includes('Pas un doublon'));
    assert.ok(!dup.includes('<script>') && !dup.includes('"><img'));
    assert.strictEqual(ctx.productCatalogBadgesHtml({ id: 'm', name: 'Manuel' }), '');
  });

  // ================= Route produit (vrai serveur) =================
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mondeco-front-'));
  const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.unref(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(dataDir, 'products.json'), JSON.stringify([
    { id: 'woo-bianca', name: 'Chambre à Coucher Bianca', category: 'Chambres', price: '3290', image: 'https://mondeco.tn/bianca.jpg', composition: 'Lit 160, armoire', active: true, syncSource: 'woocommerce', woocommerceId: 69317, overrides: { composition: { value: 'Lit 160, armoire', by: 'Admin', at: '2026-11-10T10:00:00Z', source: 'admin-product-form' } } },
    { id: 'man-bianca', name: 'Chambre Bianca', category: 'Chambres', price: '2800', image: 'https://mondeco.tn/b.jpg', active: true, duplicateOfWooId: 69317, duplicateOfName: 'Chambre à Coucher Bianca', duplicateConfidence: 'high', duplicateFlaggedAt: '2026-11-11T10:00:00Z' },
    { id: 'man-lit', name: 'Lit Bianca', category: 'Chambres', price: '1500', image: 'https://mondeco.tn/l.jpg', active: true, duplicateOfWooId: 69317, duplicateOfName: 'Chambre à Coucher Bianca', duplicateConfidence: 'possible' }
  ], null, 2));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), NODE_ENV: 'development', ADMIN_EMAIL: 'admin@mondeco.tn', ADMIN_PASSWORD: 'Test-Password-1234', VERIFY_TOKEN: 'x', META_APP_SECRET: 'x', WHATSAPP_TOKEN: '', GEMINI_API_KEY: '', GROQ_API_KEY: '', WOOCOMMERCE_SYNC_ENABLED: 'false', ADMIN_ORIGIN_CHECK: '', PUBLIC_BASE_URL: '', LOG_FORMAT: 'text' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  child.stdout.on('data', chunk => { serverLog += chunk; });
  child.stderr.on('data', chunk => { serverLog += chunk; });
  const cleanup = () => { try { child.kill('SIGKILL'); } catch {} try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} };
  const request = (method, urlPath, { body, cookie = '', headers = {} } = {}) => fetch(`${base}${urlPath}`, { method, body, headers: { origin: base, 'X-Mondeco-Client': 'admin', ...(cookie ? { cookie } : {}), ...headers } });
  const readProducts = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'products.json'), 'utf8'));

  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try { up = (await fetch(`${base}/health`)).status === 200; } catch { await wait(250); }
    }
    assert.ok(up, `Le serveur n'a pas démarré :\n${serverLog.slice(-2000)}`);
    const loginRes = await request('POST', '/admin/login', { body: JSON.stringify({ email: 'admin@mondeco.tn', password: 'Test-Password-1234' }), headers: { 'content-type': 'application/json' } });
    assert.strictEqual(loginRes.status, 200);
    const cookie = String(loginRes.headers.get('set-cookie') || '').split(';')[0];

    await test('route produit : un PUT sans le champ ne touche pas au repérage des doublons (compatibilité)', async () => {
      const form = new FormData();
      form.append('price', '2850');
      const res = await request('PUT', '/admin/api/products/man-lit', { body: form, cookie });
      assert.strictEqual(res.status, 200, await res.text());
      const product = readProducts().find(item => item.id === 'man-lit');
      assert.strictEqual(product.duplicateOfWooId, 69317);
      assert.strictEqual(product.notDuplicateOfWoo, undefined);
    });

    await test('route produit : « Pas un doublon » enregistre notDuplicateOfWoo et retire le signalement', async () => {
      const form = new FormData();
      form.append('notDuplicateOfWoo', 'true');
      const res = await request('PUT', '/admin/api/products/man-bianca', { body: form, cookie });
      assert.strictEqual(res.status, 200, await res.text());
      const product = readProducts().find(item => item.id === 'man-bianca');
      assert.strictEqual(product.notDuplicateOfWoo, true);
      for (const key of ['duplicateOfWooId', 'duplicateOfName', 'duplicateConfidence', 'duplicateFlaggedAt']) assert.strictEqual(product[key], undefined, key);
      assert.strictEqual(product.price, '2800', 'le reste de la fiche est inchangé');
    });

    await test('route produit : « Revenir à la valeur du site » retire la correction (champ vidé)', async () => {
      const form = new FormData();
      form.append('composition', '');
      const res = await request('PUT', '/admin/api/products/woo-bianca', { body: form, cookie });
      assert.strictEqual(res.status, 200, await res.text());
      const product = readProducts().find(item => item.id === 'woo-bianca');
      assert.strictEqual(product.overrides, undefined);
      assert.strictEqual(product.syncSource, 'woocommerce');
      assert.strictEqual(product.price, '3290');
    });

    console.log(`ALL ${passed} ADMIN INBOX FRONTEND TESTS PASSED`);
  } catch (error) {
    console.error('FAIL', error);
    console.error('--- Fin du journal serveur ---\n' + serverLog.slice(-3000));
    cleanup();
    process.exit(1);
  }
  cleanup();
  process.exit(0);
})().catch(error => {
  console.error('FAIL', error);
  process.exit(1);
});
