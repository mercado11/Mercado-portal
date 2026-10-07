require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const E = process.env;
const PORT = E.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const F = n => path.join(DATA_DIR, n);
const rd = (n, d) => { try { return JSON.parse(fs.readFileSync(F(n), 'utf8')); } catch { return d; } };
const wr = (n, d) => fs.writeFileSync(F(n), JSON.stringify(d, null, 2));

app.set('trust proxy', 1);
app.use(cors({ origin: E.CORS_ORIGIN && E.CORS_ORIGIN !== '*' ? E.CORS_ORIGIN.split(',') : true }));
app.use(express.json({ limit: '8mb' })); // photos de la recherche visuelle

/* ---------- utilitaires ---------- */
const hits = new Map();
const limit = (key, max, ms) => (req, res, next) => {
  const k = key + req.ip, now = Date.now();
  const a = (hits.get(k) || []).filter(t => now - t < ms);
  if (a.length >= max) return res.status(429).json({ error: 'Trop de demandes, réessayez plus tard' });
  a.push(now); hits.set(k, a); next();
};
const admin = (req, res, next) =>
  E.ADMIN_KEY && req.headers['x-admin-key'] === E.ADMIN_KEY ? next() : res.status(401).json({ error: 'Non autorisé' });
const okEmail = e => /^\S+@\S+\.\S+$/.test(e || '');
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- MARGE CACHEE ---------- */
const MARKUP = Number(E.PRICE_MARKUP || 5); // utilisé seulement pour products.json (secours local)
const MARKUP_TYPE = E.PRICE_MARKUP_TYPE || 'flat'; // (secours local seulement) flat = +N par produit, percent = +N %
const withMargin = p => {
  const v = Number(p) || 0;
  return Math.round((MARKUP_TYPE === 'percent' ? v * (1 + MARKUP / 100) : v + MARKUP) * 100) / 100;
};
const priceCache = new Map();

/* ---------- CJ DROPSHIPPING ---------- */
// Les prix CJ sont en USD : on convertit en EUR (USD_EUR_RATE sur Render, ex. 0.92)
const USD_EUR = Number(E.USD_EUR_RATE || 0.92);
const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';
const num = v => { const m = String(v ?? '').match(/\d+(\.\d+)?/); return m ? Number(m[0]) : 0; }; // "2.5 -- 4" => 2.5
const toEur = usd => num(usd) * USD_EUR;
const MARGIN_USD = Number(E.PRICE_MARKUP_USD || 5); // marge fixe : +5 $ sur chaque produit CJ
const sellEur = usd => Math.round((num(usd) + MARGIN_USD) * USD_EUR * 100) / 100; // (prix CJ en $ + 5 $) converti en €
const cjLink = pid => `https://cjdropshipping.com/product/-p-${pid}.html`;
const stripHtml = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const imgList = v => {
  if (Array.isArray(v)) return v;
  try { const a = JSON.parse(v); if (Array.isArray(a)) return a; } catch {}
  return v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : [];
};

// Token CJ : valable ~15 jours, et CJ limite fortement les demandes de token => on le garde sur disque
let cjTok = rd('cj_token.json', { t: '', exp: 0 });
async function cjToken(force) {
  if (!force && cjTok.t && Date.now() < cjTok.exp) return cjTok.t;
  if (!E.CJ_API_KEY) throw new Error('CJ_API_KEY manquante');
  const r = await fetch(`${CJ_BASE}/authentication/getAccessToken`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: E.CJ_API_KEY })
  });
  const d = await r.json();
  if (!d.result || !d.data?.accessToken) throw new Error('CJ token refusé: ' + (d.message || r.status));
  const exp = d.data.accessTokenExpiryDate ? new Date(d.data.accessTokenExpiryDate).getTime() : Date.now() + 14 * 86400000;
  cjTok = { t: d.data.accessToken, exp: exp - 3600000 };
  wr('cj_token.json', cjTok);
  return cjTok.t;
}

// CJ (compte gratuit) = environ 1 requête/seconde : file d'attente + cache 10 min
let cjChain = Promise.resolve();
const cjCache = new Map();
function cjGet(pathAndQuery) {
  const hit = cjCache.get(pathAndQuery);
  if (hit && Date.now() - hit.at < 600000) return Promise.resolve(hit.d);
  const job = cjChain.then(async () => {
    let refresh = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const t = await cjToken(refresh); refresh = false;
      const r = await fetch(CJ_BASE + pathAndQuery, { headers: { 'CJ-Access-Token': t } });
      const d = await r.json().catch(() => ({}));
      await sleep(1200);
      if (r.status === 429 || d.code === 1600200) { await sleep(2500); continue; } // trop de requêtes
      if (d.code === 1600001) { refresh = true; continue; } // token invalide : on en redemande un
      if (!d.result) throw new Error('CJ: ' + (d.message || r.status));
      cjCache.set(pathAndQuery, { at: Date.now(), d });
      if (cjCache.size > 300) cjCache.delete(cjCache.keys().next().value);
      return d;
    }
    throw new Error('CJ indisponible');
  });
  cjChain = job.catch(() => {});
  return job;
}

const CAT_Q = {
  Fashion: 'fashion clothing', Electronics: 'electronics gadgets', Beauty: 'beauty skincare',
  Home: 'home decor', Sports: 'sportswear fitness', Toys: 'toys', Shoes: 'sneakers shoes',
  Jewelry: 'jewelry', Accessories: 'fashion accessories',
  Watches: 'watch', Phones: 'phone case', Computers: 'laptop accessories', Fitness: 'fitness', Automotive: 'car accessories'
};

function mapCJ(list, cat) {
  return (list || [])
    .filter(x => x.pid && x.productImage && num(x.sellPrice) >= Number(E.MIN_CJ_PRICE_USD || 0.5))
    .map(x => {
      const price = sellEur(x.sellPrice);
      priceCache.set(x.pid, price);
      return {
        id: x.pid, name: stripHtml(x.productNameEn || x.productName) || 'Produit MERCADO', price,
        image: imgList(x.productImage)[0] || x.productImage,
        itemUrl: cjLink(x.pid), category: cat || x.categoryName || '', sold: 0, shipping: ''
      };
    });
}
async function cjSearch(q, n, cat, page = 1) {
  const d = await cjGet(`/product/list?pageNum=${page}&pageSize=${Math.min(Math.max(n, 1), 100)}&productNameEn=${encodeURIComponent(q)}`);
  return mapCJ(d.data?.list, cat);
}
// Mots-clés de secours : si une catégorie a moins de 20 produits, on cherche avec ces mots (puis page 2)
const CAT_ALT = {
  Fashion: ['dress', 't-shirt', 'women clothing', 'men clothing'], Electronics: ['bluetooth', 'earphone', 'charger', 'smart'],
  Beauty: ['makeup', 'skin care', 'hair'], Home: ['kitchen', 'organizer', 'led light'], Sports: ['sport', 'yoga', 'running'],
  Toys: ['kids toy', 'puzzle', 'doll'], Watches: ['smart watch', 'wristwatch', 'watch band'], Phones: ['phone holder', 'phone charger', 'phone cable'],
  Computers: ['keyboard', 'mouse', 'usb'], Fitness: ['resistance band', 'gym', 'dumbbell'], Automotive: ['car', 'car charger', 'car seat']
};
const MIN_PER_CAT = Number(E.MIN_PRODUCTS_PER_CATEGORY || 20);
async function cjCategory(c) {
  const terms = [CAT_Q[c] || c, ...(CAT_ALT[c] || [])], seen = new Map();
  for (const term of terms) {
    for (const page of [1, 2]) {
      try { for (const it of await cjSearch(term, 100, c, page)) if (!seen.has(it.id)) seen.set(it.id, it); } catch (e) { console.error('cat', c, e.message); }
      if (seen.size >= MIN_PER_CAT * 3 && page === 1) break; // assez de choix pour trier
    }
    if (seen.size >= MIN_PER_CAT * 3) break;
  }
  return cheapestFirst([...seen.values()]);
}
// Moins chers d'abord (accueil et catégories)
const cheapestFirst = items => [...items].sort((a, b) => a.price - b.price);
// Populaires ET pas chers : on combine les deux rangs
function bestValue(items) {
  const n = items.length || 1;
  const rank = new Map([...items].sort((a, b) => a.price - b.price).map((it, i) => [it.id, i]));
  return items.map((it, i) => ({ it, s: i / n + rank.get(it.id) / n })).sort((a, b) => a.s - b.s).map(o => o.it);
}
const localCatalog = () => rd('products.json', []).map(x => { const p = withMargin(x.price); priceCache.set(x.id, p); return { ...x, price: p }; });

app.get('/api/catalog/home', async (req, res) => {
  const cat = req.query.cat, max = Number(req.query.limit || 60);
  try {
    const one = cat && cat !== 'All';
    const cats = one ? [cat] : Object.keys(CAT_Q).slice(0, 5);
    const lists = [];
    for (const c of cats) { const l = await cjCategory(c); lists.push(one ? l : l.slice(0, Math.max(MIN_PER_CAT, 40))); } // une catégorie après l'autre (limite CJ)
    const seen = new Set();
    const items = lists.flat().filter(i => !seen.has(i.id) && seen.add(i.id));
    if (!items.length) throw new Error('vide');
    res.json({ ok: true, items: cheapestFirst(items).slice(0, max) }); // les moins chers d'abord
  } catch (e) {
    console.error('catalog/home:', e.message);
    res.json({ ok: true, items: localCatalog() });
  }
});
app.get('/api/catalog/search', async (req, res) => {
  try {
    const items = await cjSearch(String(req.query.q || '').slice(0, 100), Number(req.query.limit || 60));
    res.json({ ok: true, items: bestValue(items) });
  } catch (e) { console.error('search:', e.message); res.status(502).json({ error: 'Recherche indisponible' }); }
});
async function cjDetail(pid) {
  const d = (await cjGet('/product/query?pid=' + encodeURIComponent(pid))).data;
  if (!d || !d.pid) return null;
  const variants = (d.variants || []).map(v => ({ vid: v.vid, name: v.variantNameEn || v.variantKey || '', price: toEur(v.variantSellPrice) }));
  const base = num(d.sellPrice) || Math.min(...variants.map(v => v.price / USD_EUR).filter(Boolean), Infinity);
  const price = isFinite(base) && base > 0 ? sellEur(base) : 0;
  priceCache.set(d.pid, price);
  const images = imgList(d.productImage);
  return {
    id: d.pid, name: stripHtml(d.productNameEn || d.productName), price, image: images[0] || '', img: images[0] || '',
    images, description: stripHtml(d.description).slice(0, 1500), itemUrl: cjLink(d.pid),
    variants: variants.map(v => ({ vid: v.vid, name: v.name }))
  };
}
app.get('/api/catalog/item', async (req, res) => {
  try {
    const id = String(req.query.id || req.query.itemId || ''); // le site envoie itemId
    const loc = localCatalog().find(x => String(x.id) === id);
    if (loc) return res.json({ ok: true, ...loc, item: loc });
    const item = await cjDetail(id);
    if (!item) return res.status(404).json({ error: 'Produit introuvable' });
    res.json({ ok: true, ...item, item });
  } catch (e) { console.error('item:', e.message); res.status(502).json({ error: 'Détail indisponible' }); }
});

/* ---------- RECHERCHE VISUELLE (CJ n'a pas de recherche par image :
   Claude décrit la photo en mots-clés, puis on cherche chez CJ) ---------- */
app.post('/api/visual-search', limit('vs', 20, 3600000), async (req, res) => {
  try {
    const m = String(req.body.imageDataUrl || '').match(/^data:(image\/\w+);base64,(.+)$/);
    if (!m || m[2].length < 100) return res.status(400).json({ error: 'Image invalide' });
    if (!E.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'Recherche visuelle non configurée' });
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': E.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: E.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: 60,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
          { type: 'text', text: 'Give 2 to 4 English keywords (max 5 words total) to search this product on an online shop. Reply with the keywords only.' }
        ] }]
      })
    });
    const kw = String((await r.json()).content?.[0]?.text || '').replace(/[^\w\s-]/g, ' ').trim().slice(0, 80);
    if (!kw) return res.status(502).json({ error: 'Image non reconnue' });
    res.json({ ok: true, query: kw, items: bestValue(await cjSearch(kw, 40)) });
  } catch (e) { console.error('visual:', e.message); res.status(502).json({ error: 'Recherche visuelle indisponible' }); }
});

/* ---------- TRADUCTION (DeepL ou Google) ---------- */
const trCache = new Map();
async function translate(texts, target) {
  const tgt = String(target).toLowerCase();
  if (E.DEEPL_API_KEY) {
    const host = E.DEEPL_API_KEY.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
    const lang = { en: 'EN-US', pt: 'PT-PT', zh: 'ZH' }[tgt] || tgt.toUpperCase();
    const out = [];
    for (let i = 0; i < texts.length; i += 40) {
      const r = await fetch(`https://${host}/v2/translate`, {
        method: 'POST',
        headers: { Authorization: `DeepL-Auth-Key ${E.DEEPL_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: texts.slice(i, i + 40), target_lang: lang, source_lang: 'FR', tag_handling: 'html' })
      });
      const d = await r.json();
      if (!d.translations) throw new Error('DeepL');
      out.push(...d.translations.map(x => x.text));
    }
    return out;
  }
  if (E.GOOGLE_TRANSLATE_API_KEY) {
    const r = await fetch('https://translation.googleapis.com/language/translate/v2?key=' + E.GOOGLE_TRANSLATE_API_KEY, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: texts, target: tgt, source: 'fr', format: 'html' })
    });
    const d = await r.json();
    if (!d.data) throw new Error('Google');
    return d.data.translations.map(x => x.translatedText);
  }
  throw new Error('Aucune clé de traduction');
}
app.post('/api/translate', limit('tr', 30, 3600000), async (req, res) => {
  try {
    const texts = (req.body.texts || []).map(String).slice(0, 400), target = String(req.body.target || '').slice(0, 8);
    const key = target + crypto.createHash('md5').update(texts.join('|')).digest('hex');
    if (!trCache.has(key)) trCache.set(key, await translate(texts, target));
    res.json({ translations: trCache.get(key) });
  } catch (e) { res.status(503).json({ error: 'Traduction indisponible' }); }
});

/* ---------- EMAIL + TELEGRAM ---------- */
async function sendMail(to, subject, text, html) {
  if (!E.RESEND_API_KEY) return false;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${E.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: E.RESEND_FROM || 'MERCADO <onboarding@resend.dev>', to: [to], subject, text, ...(html ? { html } : {}) })
  });
  if (!r.ok) console.error('Resend:', r.status, await r.text());
  return r.ok;
}
async function telegram(text) {
  if (!E.TELEGRAM_BOT_TOKEN || !E.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${E.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: E.TELEGRAM_CHAT_ID, text: String(text).slice(0, 4000) })
    });
  } catch (e) { console.error('Telegram:', e.message); }
}

const codes = new Map();
app.post('/api/email/send', limit('es', 8, 3600000), async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!okEmail(email)) return res.status(400).json({ error: 'Email invalide' });
  const code = String(crypto.randomInt(1000, 10000)); // 4 chiffres : le site attend 4 cases
  codes.set(email, { code, exp: Date.now() + 600000, tries: 0 });
  const ok = await sendMail(email, 'Code de vérification MERCADO', `Votre code MERCADO : ${code}\nIl expire dans 10 minutes.`);
  if (!ok) console.log(`[TEST] code pour ${email}: ${code}`);
  res.json({ ok: true, test: !ok });
});
app.post('/api/email/verify', limit('ev', 30, 3600000), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), s = codes.get(email);
  if (!s || Date.now() > s.exp) return res.status(400).json({ verified: false, error: 'Code expiré' });
  if (++s.tries > 5) { codes.delete(email); return res.status(429).json({ verified: false, error: 'Trop d’essais' }); }
  if (s.code !== String(req.body.code || '').trim()) return res.status(400).json({ verified: false, error: 'Code incorrect' });
  codes.delete(email);
  res.json({ verified: true });
});

/* ---------- COMMANDES ---------- */
async function refreshPrice(id) {
  const loc = localCatalog().find(x => String(x.id) === String(id));
  if (loc) return loc.price;
  try {
    const d = await cjDetail(id);
    if (d && d.price) return d.price;
  } catch (e) { console.error('refreshPrice:', e.message); }
  return null;
}
async function serverTotal(items) { // le prix vient du serveur, jamais du navigateur
  let t = 0;
  for (const i of items || []) {
    let p = priceCache.get(i.id);
    if (p == null) p = await refreshPrice(i.id);
    if (p == null) return null;
    t += p * Math.max(1, Math.min(99, Number(i.qty) || 1));
  }
  return t > 0 ? t : null;
}
app.post('/api/order', limit('od', 30, 3600000), async (req, res) => {
  try {
    const b = req.body || {};
    const order = {
      orderId: String(b.orderId || `MC-${Date.now()}`).slice(0, 40),
      customer: b.customer || {}, total: (await serverTotal(b.items)) ?? 0,
      items: (b.items || []).slice(0, 50).map(i => ({ id: i.id, name: i.name, qty: i.qty, itemUrl: i.itemUrl || cjLink(i.id) })),
      status: 'pending', createdAt: new Date().toISOString()
    };
    const orders = rd('orders.json', []);
    if (!orders.some(o => o.orderId === order.orderId)) { orders.push(order); wr('orders.json', orders); }
    const c = order.customer;
    // le lien CJ part seulement ici, vers vous : jamais affiché sur le site
    telegram(`${TAG}🛒 Commande ${order.orderId} (en attente de paiement)\n${c.name || ''} | ${c.email || ''} | ${c.phone || ''}\n${c.address || ''}, ${c.city || ''} ${c.zip || ''} ${c.country || ''}\n` +
      order.items.map(i => `• ${i.name} x${i.qty}\n  CJ pid: ${i.id}\n  ${i.itemUrl}`).join('\n') + `\nTotal : €${order.total.toFixed(2)}`);
    res.json({ ok: true, orderId: order.orderId });
  } catch (e) { console.error('order:', e); res.status(500).json({ error: 'Commande impossible' }); }
});

/* ---------- CAMERPAY ---------- */
const CUR = String(E.CAMERPAY_CURRENCY || 'XAF').toUpperCase();
const TEST_MODE = String(E.CAMERPAY_MODE || 'test').toLowerCase() !== 'live'; // test par défaut : mettre CAMERPAY_MODE=live pour la production
const TAG = TEST_MODE ? '🧪 TEST (ne pas commander chez CJ)\n' : '';
const RATE = Number(E.EUR_RATE || 655.957); // 1 EUR = 655,957 XAF
const toPay = eur => Math.round(eur * RATE); // XAF : pas de décimales
const CP_BASE = (E.CAMERPAY_BASE_URL || 'https://camerpay.biz/api').replace(/\/$/, '');
const CP_INIT = E.CAMERPAY_INITIATE_PATH || '/payments/initiate';   // à vérifier dans camerpay.biz/docs
const CP_STATUS = E.CAMERPAY_STATUS_PATH || '/payments/{id}/status'; // à vérifier dans camerpay.biz/docs
const cpHeaders = () => ({ 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${E.CAMERPAY_TOKEN}` });
const publicBase = req => (E.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

// L'ancienne route /flutterwave reste active pour que index.html fonctionne sans modification
app.post(['/api/payment/camerpay', '/api/payment/flutterwave'], limit('cp', 20, 3600000), async (req, res) => {
  try {
    if (!E.CAMERPAY_TOKEN) return res.status(503).json({ code: 'payment_pending', error: 'Paiement bientôt disponible' }); // site en attente de l'API CamerPay
    const o = req.body || {}, c = o.customer || {};
    if (!okEmail(c.email)) return res.status(400).json({ error: 'Email client obligatoire' });
    if (!c.address || !c.city) return res.status(400).json({ error: 'Adresse de livraison obligatoire' });
    const eur = await serverTotal(o.items);
    if (!eur) return res.status(400).json({ error: 'Panier invalide : rechargez la page' });
    const amount = toPay(eur), orderId = String(o.orderId || `MC-${Date.now()}`).slice(0, 40);
    const body = {
      amount, currency: CUR,
      customer_phone: String(c.phone || '').replace(/\s+/g, ''), customer_email: c.email,
      merchant_invoice_id: orderId,
      merchant_callback_url: `${publicBase(req)}/api/payment/camerpay/webhook`,
      merchant_return_url: E.FRONTEND_SUCCESS_URL || `${publicBase(req)}/#confirm`
    };
    if (E.CAMERPAY_METHOD) body.payment_method = E.CAMERPAY_METHOD; // vide = le client choisit sur la page CamerPay
    const r = await fetch(CP_BASE + CP_INIT, { method: 'POST', headers: cpHeaders(), body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    const url = d.pay_url || d.data?.pay_url;
    if (!r.ok || !url) {
      console.error('CamerPay:', r.status, d);
      return res.status(502).json({ error: d.message || d.error || `CamerPay a refusé la demande (${r.status})` });
    }
    const uuid = d.uuid || d.transaction_uuid || d.transaction?.uuid || d.data?.uuid || d.data?.transaction?.uuid || '';
    const txs = rd('camerpay_tx.json', {});
    txs[orderId] = { uuid, amount, at: Date.now() }; // montant calculé par le serveur, jamais par le navigateur
    wr('camerpay_tx.json', txs);
    res.json({ ok: true, payment_url: url, orderId, amount, currency: CUR });
  } catch (e) { console.error('camerpay:', e); res.status(500).json({ error: 'Erreur serveur paiement' }); }
});
const PAID_STATUS = new Set(['completed', 'success', 'successful', 'paid']);
// On ne croit pas le webhook : on revérifie le statut directement chez CamerPay
app.post('/api/payment/camerpay/webhook', async (req, res) => {
  try {
    const ev = req.body || {};
    const ref = ev.merchant_invoice_id || ev.transaction?.merchant_invoice_id || ev.data?.merchant_invoice_id;
    if (!ref) return res.sendStatus(200);
    const known = rd('camerpay_tx.json', {})[ref];
    const uuid = known?.uuid || ev.uuid || ev.transaction_uuid || ev.transaction?.uuid || ev.data?.uuid;
    if (!uuid) return res.sendStatus(200);
    const sr = await fetch(CP_BASE + CP_STATUS.replace('{id}', encodeURIComponent(uuid)), { headers: cpHeaders() });
    const sd = await sr.json().catch(() => ({}));
    const t = sd.transaction || sd.data?.transaction || sd.data || sd;
    const orders = rd('orders.json', []), o = orders.find(x => x.orderId === ref);
    const expected = known?.amount ?? (o ? toPay(o.total) : 0);
    const amountOk = t.amount == null || Number(t.amount) >= expected - 1;
    const curOk = !t.currency || String(t.currency).toUpperCase() === CUR;
    if (sr.ok && PAID_STATUS.has(String(t.status).toLowerCase()) && amountOk && curOk && (!o || o.status !== 'paid')) {
      if (o) { o.status = 'paid'; o.paidAt = new Date().toISOString(); o.transactionId = uuid; wr('orders.json', orders); }
      const cu = o?.customer || {};
      telegram(`${TAG}✅ PAYÉ ${ref} : ${t.amount ?? expected} ${CUR}\n${cu.name || ''} | ${cu.address || ''}, ${cu.city || ''}`);
      if (okEmail(cu.email)) sendMail(cu.email, `Commande ${ref} confirmée`, `Merci pour votre commande MERCADO ${ref}. Paiement reçu.`);
    }
    res.sendStatus(200);
  } catch (e) { console.error('webhook:', e); res.sendStatus(500); }
});

/* ---------- AVIS (format exact attendu par le site) ---------- */
app.get('/api/reviews', (req, res) => {
  const pid = String(req.query.productId || '');
  res.json({ ok: true, reviews: rd('reviews.json', []).filter(r => r.productId === pid).slice(-50).reverse().map(({ productId, ...r }) => r) });
});
app.post('/api/reviews', limit('rv', 10, 3600000), (req, res) => {
  const b = req.body || {}, pid = String(b.productId || '').slice(0, 100), text = String(b.text || '').trim().slice(0, 1000);
  if (!pid || !text) return res.status(400).json({ error: 'Avis incomplet' });
  const name = String(b.name || 'Client').slice(0, 40);
  const all = rd('reviews.json', []);
  all.push({ productId: pid, name, initial: name[0]?.toUpperCase() || 'C', stars: Math.max(1, Math.min(5, Number(b.stars) || 5)),
    date: new Date().toLocaleDateString('fr-FR'), text, variant: String(b.variant || '').slice(0, 60) });
  wr('reviews.json', all.slice(-3000));
  res.json({ ok: true });
});

/* ---------- PRODUIT CONSULTE -> RAPPEL EMAIL ---------- */
app.post('/api/track-view', limit('tv', 120, 3600000), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), p = req.body.product || {};
  if (!okEmail(email) || !p.id) return res.json({ ok: true });
  const v = rd('views.json', []);
  if (!v.some(x => x.email === email && x.product.id === p.id))
    v.push({ email, at: Date.now(), reminded: false, product: { id: p.id, name: String(p.name || '').slice(0, 150), price: p.price, img: p.img } });
  wr('views.json', v.slice(-5000));
  res.json({ ok: true });
});
async function runReminders() {
  const delay = Number(E.REMINDER_DELAY_HOURS || 24) * 3600000, base = E.PUBLIC_BASE_URL || '';
  const v = rd('views.json', []), orders = rd('orders.json', []);
  let sent = 0;
  for (const x of v) {
    if (x.reminded || Date.now() - x.at < delay) continue;
    x.reminded = true; // un seul rappel par produit
    if (orders.some(o => (o.customer?.email || '').toLowerCase() === x.email && new Date(o.createdAt) > x.at)) continue;
    const p = x.product;
    const html = `<div style="font-family:Arial;max-width:420px"><h2>Vous avez consulté ce produit</h2>${p.img ? `<img src="${esc(p.img)}" width="300" alt="">` : ''}<p>${esc(p.name)}<br><b>€${Number(p.price || 0).toFixed(2)}</b></p><a href="${esc(base)}" style="background:#FF6B00;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Revoir le produit</a></div>`;
    if (await sendMail(x.email, 'Vous avez récemment consulté ce produit', `${p.name} : ${base}`, html)) sent++;
  }
  wr('views.json', v);
  return sent;
}
setInterval(() => runReminders().catch(e => console.error('reminders:', e.message)), 30 * 60000);
app.post('/api/admin/run-reminders', admin, async (req, res) => res.json({ ok: true, sent: await runReminders() }));

/* ---------- ALERTES "PRODUIT DISPONIBLE" ---------- */
app.post('/api/notify/subscribe', limit('ns', 10, 3600000), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), q = String(req.body.query || '').slice(0, 100).trim();
  if (!okEmail(email) || !q) return res.status(400).json({ error: 'Email ou recherche invalide' });
  const s = rd('subs.json', []);
  if (!s.some(x => x.email === email && x.query === q)) { s.push({ email, query: q, at: Date.now() }); wr('subs.json', s.slice(-5000)); }
  telegram(`🔔 Alerte demandée : "${q}" (${email})`);
  res.json({ ok: true });
});
app.post('/api/admin/notify-broadcast', admin, async (req, res) => {
  const subs = rd('subs.json', []), keep = [], seen = new Map();
  let sent = 0;
  for (const s of subs) {
    if (!seen.has(s.query)) { try { seen.set(s.query, (await cjSearch(s.query, 1))[0] || localCatalog().find(x => x.name.toLowerCase().includes(s.query.toLowerCase())) || null); } catch { seen.set(s.query, null); } }
    const hit = seen.get(s.query);
    if (hit && await sendMail(s.email, `"${s.query}" est disponible sur MERCADO`, `Bonne nouvelle : ${hit.name} est disponible. ${E.PUBLIC_BASE_URL || ''}`)) sent++;
    else keep.push(s);
  }
  wr('subs.json', keep);
  res.json({ ok: true, sent });
});
app.get('/api/admin/orders', admin, (req, res) => res.json({ ok: true, orders: rd('orders.json', []).slice(-200).reverse() }));

/* ---------- IA ---------- */
function aiMessages(b) {
  const out = [];
  for (const m of (b.history || []).slice(-10)) {
    if (!m || !m.content) continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user', content = String(m.content).slice(0, 2000);
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += '\n' + content; // pas deux rôles identiques de suite
    else out.push({ role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift(); // doit commencer par l'utilisateur
  if (!out.length || out[out.length - 1].role !== 'user') out.push({ role: 'user', content: String(b.question || '...').slice(0, 2000) });
  return out;
}
app.post('/api/ai', limit('ai', 40, 3600000), async (req, res) => {
  if (!E.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'IA non configurée' });
  try {
    const b = req.body || {};
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': E.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: E.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: 600,
        system: "Tu es MERCADO AI, l'assistant d'une boutique en ligne. Réponds brièvement, dans la langue du client. Produit ouvert : " + JSON.stringify(b.product || null).slice(0, 800),
        messages: aiMessages(b)
      })
    });
    const answer = (await r.json()).content?.[0]?.text;
    answer ? res.json({ answer }) : res.status(502).json({ error: 'Pas de réponse' });
  } catch (e) { res.status(502).json({ error: 'IA indisponible' }); }
});
app.post('/api/ai-log', limit('al', 60, 3600000), (req, res) => {
  const q = String(req.body.question || '').slice(0, 300);
  if (q) telegram(`💬 Question MERCADO AI : ${q}${req.body.product?.name ? `\n(produit : ${req.body.product.name})` : ''}`); // sans email client
  res.json({ ok: true });
});

/* ---------- TAUX DE CHANGE (affichage des prix dans la devise du pays) ---------- */
// Base EUR. Taux de secours approximatifs (modifiables) ; les taux réels sont récupérés
// automatiquement (open.er-api.com, sans clé) et gardés 12 h. Le franc CFA est fixe (parité avec l'euro).
const FALLBACK_RATES = { EUR: 1, XAF: 655.957, XOF: 655.957, USD: 1.08, GBP: 0.85, JPY: 165, CNY: 7.8, GHS: 16, CAD: 1.48, AUD: 1.65, NZD: 1.78, SGD: 1.45, HKD: 8.4, MXN: 21 };
let ratesCache = { at: 0, rates: { ...FALLBACK_RATES } };
async function getRates() {
  if (Date.now() - ratesCache.at < 12 * 3600000) return ratesCache.rates;
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/EUR');
    const d = await r.json();
    if (d && d.rates) {
      const live = {};
      for (const k of Object.keys(FALLBACK_RATES)) live[k] = Number(d.rates[k]) || FALLBACK_RATES[k];
      live.EUR = 1; live.XAF = 655.957; live.XOF = 655.957; // parité fixe
      ratesCache = { at: Date.now(), rates: live };
    } else ratesCache.at = Date.now() - 11 * 3600000; // réessaie dans 1 h
  } catch (e) { console.error('rates:', e.message); ratesCache.at = Date.now() - 11 * 3600000; }
  return ratesCache.rates;
}
app.get('/api/rates', async (req, res) => res.json({ ok: true, base: 'EUR', rates: await getRates() }));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res, next) => req.path.startsWith('/api/') ? next() : res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((e, req, res, next) => { console.error(e); res.status(500).json({ error: 'Erreur interne' }); });
app.listen(PORT, '0.0.0.0', () => console.log(`MERCADO port ${PORT} | marge ${MARKUP} (${MARKUP_TYPE}) | ${CUR} | CamerPay ${TEST_MODE ? 'TEST' : 'LIVE'}`));
