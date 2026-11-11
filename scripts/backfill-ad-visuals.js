#!/usr/bin/env node
// ============================================================
// MONDECO — rattrapage des visuels de publicités (cartes « publicité
// d'origine » sans image, avec une vidéo, ou avec l'image d'une AUTRE pub)
// scripts/backfill-ad-visuals.js
//
// V6.45 — SIMULATION PAR DÉFAUT : rien n'est téléchargé ni écrit.
//
//   DATA_DIR=/data node scripts/backfill-ad-visuals.js
//       Simulation : classement des conversations, publicités concernées,
//       liens Meta encore valides, ce qui serait fait.
//   DATA_DIR=/data node scripts/backfill-ad-visuals.js --apply
//       Télécharge UN visuel par publicité (conversation-media/ad-visual-*).
//       Ne modifie aucune conversation : sans risque serveur démarré. Les
//       cartes se réparent ensuite d'elles-mêmes à l'ouverture (route
//       POST /admin/api/conversations/:contact/ad-visual/refresh, qui
//       retrouve ce fichier sans rien télécharger).
//   DATA_DIR=/data node scripts/backfill-ad-visuals.js --apply --write-states
//       Met aussi à jour les conversations (SQLite + conversation-state.json).
//       SERVEUR ARRÊTÉ UNIQUEMENT : un serveur démarré réécrirait ses
//       propres données par-dessus.
//
// Options : --limit=N (publicités traitées), --verbose.
// Variables : META_ADS_TOKEN (optionnel, token avec ads_read : visuel de la
// créative via l'API Graph — la plupart des liens Meta enregistrés ont
// expiré), META_API_VERSION (v26.0 par défaut).
//
// Sources des liens : état de la conversation (mediaUrl…), sauvegarde
// backups/conversation-state-avant-allegement-*.json (raw.thumbnail_url,
// raw.image_url…, écrite avant l'allègement V6.37.2) et journaux
// conversation-events/*.jsonl (ad_referral). Les liens expirés (paramètre
// oe) sont ignorés.
// ============================================================

const fs = require('fs');
const path = require('path');
const {
  adRecordKey,
  adReferralMediaFields,
  adVisualCandidates,
  metaUrlExpired,
  slimConversationState
} = require('../lib/ad-referral');
const {
  assessAdVisual,
  basenameFromMediaUrl,
  downloadAdVisual,
  fetchGraphAdImageUrls,
  findAdVisualFile,
  saveAdVisualFile,
  writeFileAtomic
} = require('../lib/ad-visual');

function clean(value) {
  return String(value ?? '').trim();
}

function parseArgs(argv) {
  const options = { apply: false, writeStates: false, limit: Infinity, verbose: false };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--write-states') options.writeStates = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg.startsWith('--limit=')) options.limit = Math.max(1, Number(arg.slice(8)) || Infinity);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Option inconnue : ${arg}`);
  }
  if (options.writeStates && !options.apply) throw new Error('--write-states exige --apply.');
  return options;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8') || '{}');
  } catch {
    return null;
  }
}

function openDatabase(dataDir, readonly) {
  const dbPath = path.join(dataDir, 'mondeco.db');
  if (!fs.existsSync(dbPath)) return null;
  try {
    const Database = require('better-sqlite3');
    return new Database(dbPath, { readonly, fileMustExist: true });
  } catch {
    return null;
  }
}

// États : SQLite (écrit en premier par le serveur) sinon conversation-state.json.
function loadStates(dataDir, db) {
  if (db) {
    try {
      const states = {};
      for (const row of db.prepare('SELECT contact, data FROM conversation_states').iterate()) {
        try { states[row.contact] = JSON.parse(row.data); } catch {}
      }
      if (Object.keys(states).length) return { states, source: 'sqlite' };
    } catch {}
  }
  const parsed = readJsonFile(path.join(dataDir, 'conversation-state.json'));
  return { states: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}, source: 'json' };
}

// Liens issus d'un referral (brut) ou d'un adReferral (normalisé).
function urlsFromAd(ad) {
  if (!ad || typeof ad !== 'object') return [];
  const fromRaw = ad.raw && typeof ad.raw === 'object' ? adReferralMediaFields(ad.raw) : {};
  return [
    ...adVisualCandidates({ ...fromRaw }),
    ...adVisualCandidates(ad)
  ];
}

function addCandidates(map, key, candidates) {
  if (!key || !candidates.length) return;
  const list = map.get(key) || [];
  for (const candidate of candidates) {
    if (!list.some(item => item.url === candidate.url)) list.push(candidate);
  }
  map.set(key, list);
}

// Nom de fichier V6.22–V6.44 : whatsapp-source-ad-<messageId nettoyé>-ad-0.<ext>
function legacyStemForMessageId(messageId) {
  return `${clean(messageId)}-ad`.replace(/[^a-zA-Z0-9_-]/g, '').slice(-70);
}

function scanEvents(dataDir, candidatesByKey, log) {
  const eventsDir = path.join(dataDir, 'conversation-events');
  const adKeyByLegacyStem = new Map();
  let files = [];
  try { files = fs.readdirSync(eventsDir).filter(name => name.endsWith('.jsonl')).sort(); } catch { return adKeyByLegacyStem; }
  for (const name of files) {
    let lines = [];
    try { lines = fs.readFileSync(path.join(eventsDir, name), 'utf8').split(/\r?\n/); } catch { continue; }
    for (const line of lines) {
      if (!line || !line.includes('ad_referral')) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const ad = entry?.ad_referral;
      const key = adRecordKey(ad);
      if (!key) continue;
      addCandidates(candidatesByKey, key, urlsFromAd(ad));
      const messageId = clean(entry?.message_id);
      if (messageId && !adKeyByLegacyStem.has(legacyStemForMessageId(messageId))) {
        adKeyByLegacyStem.set(legacyStemForMessageId(messageId), key);
      }
    }
  }
  log(`Journaux conversation-events lus : ${files.length} fichier(s).`);
  return adKeyByLegacyStem;
}

function scanSlimBackups(dataDir, candidatesByKey, log) {
  const backupsDir = path.join(dataDir, 'backups');
  let files = [];
  try { files = fs.readdirSync(backupsDir).filter(name => /^conversation-state-avant-allegement-.*\.json$/.test(name)); } catch { return; }
  for (const name of files) {
    const parsed = readJsonFile(path.join(backupsDir, name));
    if (!parsed || typeof parsed !== 'object') continue;
    for (const state of Object.values(parsed)) {
      const ad = state?.adReferral;
      addCandidates(candidatesByKey, adRecordKey(ad), urlsFromAd(ad));
    }
  }
  if (files.length) log(`Sauvegardes avant allègement lues : ${files.length}.`);
}

// V6.45 — Image enregistrée sous une AUTRE pub (bug corrigé en V6.45) : le
// fichier ancien format porte l'ID du message qui l'a téléchargé ; si ce
// message venait d'une autre pub que la pub actuelle, l'image est fausse.
function legacyVisualIsStale(ad, adKeyByLegacyStem) {
  if (clean(ad?.storedMediaKey)) return false;
  const filename = basenameFromMediaUrl(ad?.storedMediaUrl);
  const match = filename.match(/^whatsapp-source-ad-(.+)-0\.[a-z0-9]+$/i);
  if (!match) return false;
  const keyAtDownload = adKeyByLegacyStem.get(match[1]);
  return Boolean(keyAtDownload) && keyAtDownload !== adRecordKey(ad);
}

async function runBackfill({
  dataDir,
  apply = false,
  writeStates = false,
  limit = Infinity,
  verbose = false,
  adsToken = clean(process.env.META_ADS_TOKEN),
  graphVersion = clean(process.env.META_API_VERSION) || 'v26.0',
  fetchImpl = fetch,
  now = () => Date.now(),
  log = message => console.log(message)
} = {}) {
  if (!dataDir) throw new Error('DATA_DIR manquant.');
  const mediaDir = path.join(dataDir, 'conversation-media');
  const fileExists = filename => fs.existsSync(path.join(mediaDir, filename));
  const db = openDatabase(dataDir, !writeStates);
  const { states, source } = loadStates(dataDir, db);

  log(`Mode : ${apply ? (writeStates ? 'APPLICATION (fichiers + conversations)' : 'APPLICATION (fichiers uniquement)') : 'SIMULATION (aucune écriture, aucun téléchargement)'}`);
  log(`États lus depuis ${source} : ${Object.keys(states).length} conversation(s).`);
  if (writeStates) log('⚠️ --write-states : le serveur doit être ARRÊTÉ pendant cette opération.');

  const candidatesByKey = new Map();
  const adKeyByLegacyStem = scanEvents(dataDir, candidatesByKey, log);
  scanSlimBackups(dataDir, candidatesByKey, log);

  const summary = {
    conversationsWithAd: 0,
    categories: {},
    ads: 0,
    adsResolved: 0,
    adsUnresolved: 0,
    conversationsUpdated: 0,
    downloads: 0,
    bySource: {}
  };
  const groups = new Map();

  for (const [contact, state] of Object.entries(states)) {
    const ad = state?.adReferral;
    if (!ad || typeof ad !== 'object') continue;
    summary.conversationsWithAd++;
    const assessment = assessAdVisual(state, fileExists);
    let category = assessment.status;
    if (category === 'ok' && legacyVisualIsStale(ad, adKeyByLegacyStem)) category = 'stale_other_ad';
    summary.categories[category] = (summary.categories[category] || 0) + 1;
    if (category === 'ok' || !assessment.key) continue;
    const sourceAd = clean(state?.sourceContext?.type) === 'ad' && adRecordKey(state?.sourceContext?.ad) === assessment.key
      ? state.sourceContext.ad
      : {};
    addCandidates(candidatesByKey, assessment.key, urlsFromAd({ ...sourceAd, ...ad }));
    const group = groups.get(assessment.key) || { key: assessment.key, headline: clean(ad.productHint || ad.headline), ad, contacts: [] };
    group.contacts.push(contact);
    groups.set(assessment.key, group);
  }

  log(`Conversations issues d'une publicité : ${summary.conversationsWithAd}`);
  log(`Classement : ${JSON.stringify(summary.categories)}`);
  log(`Publicités à rattraper : ${groups.size}`);

  // Visuels vérifiés déjà présents (autre conversation de la même pub).
  const verifiedByKey = new Map();
  for (const state of Object.values(states)) {
    const ad = state?.adReferral;
    const key = adRecordKey(ad);
    if (!key || clean(ad?.storedMediaKey) !== key || clean(ad?.storedMediaType || 'image') !== 'image') continue;
    const filename = basenameFromMediaUrl(ad.storedMediaUrl);
    if (filename && fileExists(filename) && !verifiedByKey.has(key)) {
      verifiedByKey.set(key, { url: clean(ad.storedMediaUrl), type: 'image', filename });
    }
  }

  const updates = new Map();
  let processed = 0;
  for (const group of [...groups.values()].sort((a, b) => b.contacts.length - a.contacts.length)) {
    if (processed >= limit) break;
    processed++;
    summary.ads++;
    const candidates = (candidatesByKey.get(group.key) || []).filter(item => item.type === 'image');
    const valid = candidates.filter(item => !metaUrlExpired(item.url, now()));
    let visual = null;
    let origin = '';

    const existingFile = findAdVisualFile(mediaDir, group.key, { allowVideo: false });
    if (existingFile) { visual = existingFile; origin = 'fichier_existant'; }
    else if (verifiedByKey.has(group.key)) { visual = verifiedByKey.get(group.key); origin = 'autre_conversation'; }

    if (!visual && apply) {
      const tryUrls = async (urls, label) => {
        for (const url of urls) {
          try {
            const { buffer, sniffed } = await downloadAdVisual(url, { fetchImpl, allowVideo: false });
            summary.downloads++;
            return { saved: saveAdVisualFile({ mediaDir, adKey: group.key, buffer, sniffed }), label };
          } catch (error) {
            if (verbose) log(`   ✗ ${label} : ${error.message}`);
          }
        }
        return null;
      };
      let result = await tryUrls(valid.map(item => item.url), 'lien_meta');
      if (!result && adsToken) {
        try {
          const graphUrls = await fetchGraphAdImageUrls(group.ad, { adsToken, graphVersion, fetchImpl });
          result = await tryUrls(graphUrls, 'api_graph');
        } catch (error) {
          if (verbose) log(`   ✗ API Graph : ${error.message}`);
        }
      }
      if (result) { visual = result.saved; origin = result.label; }
    }

    const line = `• ${group.headline || '(sans titre)'} [${group.key}] — ${group.contacts.length} conversation(s), ${valid.length}/${candidates.length} lien(s) valide(s)`;
    if (visual) {
      summary.adsResolved++;
      summary.bySource[origin] = (summary.bySource[origin] || 0) + 1;
      log(`${line} → ${origin}`);
      for (const contact of group.contacts) updates.set(contact, { key: group.key, visual });
    } else {
      summary.adsUnresolved++;
      const hint = apply
        ? 'aucun visuel récupérable'
        : (valid.length ? 'serait téléchargé (lien Meta)' : (adsToken ? 'serait cherché via l’API Graph' : 'aucun lien valide (configurer META_ADS_TOKEN)'));
      log(`${line} → ${hint}`);
    }
  }

  if (writeStates && updates.size) {
    const jsonPath = path.join(dataDir, 'conversation-state.json');
    const json = readJsonFile(jsonPath);
    const upsert = db
      ? db.prepare(`INSERT INTO conversation_states (contact, data, updated_at) VALUES (@contact, @data, @updated_at)
          ON CONFLICT(contact) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
      : null;
    const updatedAt = now();
    const write = (contact, { key, visual }) => {
      const state = (db && states[contact]) || json?.[contact] || states[contact];
      const ad = state?.adReferral;
      if (!ad || adRecordKey(ad) !== key) return null;
      const nextAd = { ...ad, adKey: clean(ad.adKey) || key, storedMediaUrl: visual.url, storedMediaType: visual.type || 'image', storedMediaKey: key };
      delete nextAd.mediaFetchError;
      delete nextAd.mediaFetchFailedAt;
      return slimConversationState({ ...state, adReferral: nextAd });
    };
    const transaction = db ? db.transaction(entries => {
      for (const [contact, data] of entries) upsert.run({ contact, data: JSON.stringify(data), updated_at: updatedAt });
    }) : null;
    const written = [];
    for (const [contact, update] of updates) {
      const next = write(contact, update);
      if (!next) continue;
      written.push([contact, next]);
      if (json && typeof json === 'object' && json[contact]) json[contact] = { ...json[contact], adReferral: next.adReferral };
    }
    if (transaction) transaction(written);
    if (json && typeof json === 'object') writeFileAtomic(jsonPath, Buffer.from(JSON.stringify(json)));
    summary.conversationsUpdated = written.length;
    log(`Conversations mises à jour : ${written.length}.`);
  } else if (apply && updates.size) {
    log(`${updates.size} conversation(s) se répareront à l'ouverture (fichier ad-visual-* présent).`);
  }

  try { db?.close(); } catch {}
  log(`Résumé : ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = { runBackfill, parseArgs, legacyStemForMessageId };

if (require.main === module) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(2);
  }
  if (options.help) {
    console.log('Usage : DATA_DIR=/data node scripts/backfill-ad-visuals.js [--apply [--write-states]] [--limit=N] [--verbose]');
    process.exit(0);
  }
  const dataDir = clean(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH) || path.join(__dirname, '..');
  runBackfill({ ...options, dataDir })
    .then(() => process.exit(0))
    .catch(error => {
      console.error('❌ Rattrapage des visuels de publicités :', error.message);
      process.exit(1);
    });
}
