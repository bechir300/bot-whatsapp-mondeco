// ============================================================
// MONDECO — limitation des tentatives de connexion
// lib/login-throttle.js
//
// V6.45 — Avant, 8 échecs sur un même e-mail (depuis n'importe quelles
// adresses IP) bloquaient ce compte 15 minutes, MÊME avec le bon mot de
// passe : n'importe qui pouvait empêcher indéfiniment l'administrateur ou
// un commercial de se connecter. Désormais :
// - blocage dur par couple (e-mail, adresse IP) : 8 échecs → 15 min ;
// - blocage dur par adresse IP (tous comptes) : 30 échecs → 15 min
//   (attaque d'un même poste sur plusieurs comptes) ;
// - par e-mail seul (toutes IP) : jamais de blocage, seulement un délai
//   progressif avant la vérification du mot de passe (1 s, 2 s, 4 s… 8 s
//   max) : un bon mot de passe depuis un autre poste passe toujours ;
// - les compteurs expirent 15 min après le premier échec de la fenêtre.
// ============================================================

function createLoginThrottle({
  pairMaxFailures = 8,
  ipMaxFailures = 30,
  blockMs = 15 * 60 * 1000,
  windowMs = 15 * 60 * 1000,
  emailSoftThreshold = 8,
  emailBaseDelayMs = 1000,
  emailMaxDelayMs = 8000,
  maxEntries = 20000,
  now = () => Date.now()
} = {}) {
  const entries = new Map();

  const ipKey = ip => `ip:${String(ip || 'unknown')}`;
  const pairKey = (email, ip) => `pair:${String(email || '')}|${String(ip || 'unknown')}`;
  const emailKey = email => `email:${String(email || '')}`;

  function read(key, at = now()) {
    const state = entries.get(key);
    if (!state) return { failures: 0, blockedUntil: 0, firstFailureAt: 0 };
    const expired =
      (state.blockedUntil && state.blockedUntil <= at) ||
      (!state.blockedUntil && at - state.firstFailureAt >= windowMs);
    if (expired) {
      entries.delete(key);
      return { failures: 0, blockedUntil: 0, firstFailureAt: 0 };
    }
    return state;
  }

  function bump(key, max, at) {
    const current = read(key, at);
    const failures = current.failures + 1;
    const state = {
      failures,
      firstFailureAt: current.firstFailureAt || at,
      lastFailureAt: at,
      blockedUntil: max && failures >= max ? at + blockMs : 0
    };
    // Réinsertion : l'ordre de la Map suit l'activité la plus récente.
    entries.delete(key);
    entries.set(key, state);
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value);
    }
    return state;
  }

  function emailDelayMs(failures) {
    if (failures < emailSoftThreshold) return 0;
    const steps = Math.min(16, failures - emailSoftThreshold);
    return Math.min(emailMaxDelayMs, emailBaseDelayMs * 2 ** steps);
  }

  // À appeler avant de vérifier le mot de passe.
  // { blocked, scope, retryAfterMs, delayMs, emailFailures }
  function check({ ip, email } = {}) {
    const at = now();
    const ipState = read(ipKey(ip), at);
    if (ipState.blockedUntil > at) {
      return { blocked: true, scope: 'ip', retryAfterMs: ipState.blockedUntil - at, delayMs: 0, emailFailures: 0 };
    }
    if (email) {
      const pairState = read(pairKey(email, ip), at);
      if (pairState.blockedUntil > at) {
        return { blocked: true, scope: 'pair', retryAfterMs: pairState.blockedUntil - at, delayMs: 0, emailFailures: 0 };
      }
    }
    const emailFailures = email ? read(emailKey(email), at).failures : 0;
    return { blocked: false, scope: '', retryAfterMs: 0, delayMs: emailDelayMs(emailFailures), emailFailures };
  }

  function registerFailure({ ip, email } = {}) {
    const at = now();
    const ipState = bump(ipKey(ip), ipMaxFailures, at);
    const pairState = email ? bump(pairKey(email, ip), pairMaxFailures, at) : null;
    // Jamais de blocage dur sur l'e-mail seul (max = 0).
    const emailState = email ? bump(emailKey(email), 0, at) : null;
    return {
      ipFailures: ipState.failures,
      pairFailures: pairState ? pairState.failures : 0,
      emailFailures: emailState ? emailState.failures : 0,
      blocked: Boolean(ipState.blockedUntil || pairState?.blockedUntil),
      // Vrai une seule fois, quand le compte passe en délai progressif.
      emailThrottleStarted: Boolean(emailState && emailState.failures === emailSoftThreshold)
    };
  }

  function registerSuccess({ ip, email } = {}) {
    entries.delete(ipKey(ip));
    if (email) {
      entries.delete(pairKey(email, ip));
      entries.delete(emailKey(email));
    }
  }

  function sweep() {
    const at = now();
    for (const key of [...entries.keys()]) read(key, at);
    return entries.size;
  }

  return { check, registerFailure, registerSuccess, sweep, size: () => entries.size };
}

module.exports = { createLoginThrottle };
