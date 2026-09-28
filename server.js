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

/* ---------- MARGE CACHEE ---------- */
const MARKUP = Number(E.PRICE_MARKUP || 6);
const MARKUP_TYPE = E.PRICE_MARKUP_TYPE || 'flat'; // flat = +6 par produit, percent = +6 %
const withMargin = p => {
  const v = Number(p) || 0;
  return Math.round((MARKUP_TYPE === 'percent' ? v * (1 + MARKUP / 100) : v + MARKUP) * 100) / 100;
};
const priceCache = new Map();

/* ---------- EBAY ---------- */
let tok = { t: '', exp: 0 };
async function ebayToken() {
  if (tok.t && Date.now() < tok.exp) return tok.t;
  const auth = Buffer.from(`${E.EBAY_CLIENT_ID}:${E.EBAY_CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope'
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('eBay token refusé');
  tok = { t: d.access_token, exp: Date.now() + (d.expires_in - 120) * 1000 };
  return tok.t;
}
const MP = { FR: 'EBAY_FR', US: 'EBAY_US', GB: 'EBAY_GB', DE: 'EBAY_DE', ES: 'EBAY_ES', IT: 'EBAY_IT', CA: 'EBAY_CA' };
const CAT_Q = {
  Fashion: 'fashion clothing', Electronics: 'electronics gadgets', Beauty: 'beauty skincare',
  Home: 'home decor', Sports: 'sportswear fitness', Toys: 'toys', Shoes: 'sneakers shoes',
  Jewelry: 'jewelry', Accessories: 'fashion accessories'
};
const hd = u => (u || '').replace(/s-l\d+/, 's-l1600'); // image nette, pas la miniature floue

function mapItems(list, cat) {
  return (list || [])
    .filter(x => x.image?.imageUrl && Number(x.price?.value) >= 2)
    .map(x => {
      const price = withMargin(x.price.value);
      priceCache.set(x.itemId, price);
      return { id: x.itemId, name: x.title, price, image: hd(x.image.imageUrl), itemUrl: x.itemWebUrl, category: cat || '', sold: 0, shipping: '' };
    });
}
async function ebaySearch(q, n, country, cat) {
  const t = await ebayToken();
  const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + encodeURIComponent(q) + `&limit=${Math.min(n, 100)}` +
    '&filter=' + encodeURIComponent('conditions:{NEW},buyingOptions:{FIXED_PRICE}');
  const r = await fetch(url, { headers: { Authorization: `Bearer ${t}`, 'X-EBAY-C-MARKETPLACE-ID': MP[country] || 'EBAY_FR' } });
  return mapItems((await r.json()).itemSummaries, cat);
}
// Populaires (rang eBay) ET pas chers (rang prix) : on combine les deux rangs
function bestValue(items) {
  const n = items.length || 1;
  const rank = new Map([...items].sort((a, b) => a.price - b.price).map((it, i) => [it.id, i]));
  return items.map((it, i) => ({ it, s: i / n + rank.get(it.id) / n })).sort((a, b) => a.s - b.s).map(o => o.it);
}
const localCatalog = () => rd('products.json', []).map(x => { const p = withMargin(x.price); priceCache.set(x.id, p); return { ...x, price: p }; });

app.get('/api/catalog/home', async (req, res) => {
  const country = req.query.country || 'FR', cat = req.query.cat, max = Number(req.query.limit || 60);
  try {
    const one = cat && cat !== 'All';
    const cats = one ? [cat] : Object.keys(CAT_Q).slice(0, 5);
    const lists = await Promise.all(cats.map(c => ebaySearch(CAT_Q[c] || c, 40, country, c)));
    const seen = new Set();
    const items = lists.flat().filter(i => !seen.has(i.id) && seen.add(i.id));
    if (!items.length) throw new Error('vide');
    res.json({ ok: true, items: bestValue(items).slice(0, max) });
  } catch (e) {
    console.error('catalog/home:', e.message);
    res.json({ ok: true, items: localCatalog() });
  }
});
app.get('/api/catalog/search', async (req, res) => {
  try {
    const items = await ebaySearch(String(req.query.q || '').slice(0, 100), Number(req.query.limit || 60), req.query.country || 'FR');
    res.json({ ok: true, items: bestValue(items) });
  } catch (e) { console.error('search:', e.message); res.status(502).json({ error: 'Recherche indisponible' }); }
});
app.get('/api/catalog/item', async (req, res) => {
  try {
    const id = String(req.query.id || '');
    const loc = localCatalog().find(x => String(x.id) === id);
    if (loc) return res.json({ ok: true, ...loc, item: loc });
    const t = await ebayToken();
    const r = await fetch('https://api.ebay.com/buy/browse/v1/item/' + encodeURIComponent(id), {
      headers: { Authorization: `Bearer ${t}`, 'X-EBAY-C-MARKETPLACE-ID': MP[req.query.country] || 'EBAY_FR' }
    });
    const d = await r.json();
    if (!r.ok) return res.status(404).json({ error: 'Produit introuvable' });
    const price = withMargin(d.price?.value);
    priceCache.set(d.itemId, price);
    const item = {
      id: d.itemId, name: d.title, price, image: hd(d.image?.imageUrl),
      images: (d.additionalImages || []).map(i => hd(i.imageUrl)),
      description: String(d.shortDescription || d.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500),
      itemUrl: d.itemWebUrl
    };
    res.json({ ok: true, ...item, item });
  } catch (e) { res.status(502).json({ error: 'Détail indisponible' }); }
});

/* ---------- RECHERCHE VISUELLE (eBay search_by_image) ---------- */
app.post('/api/visual-search', limit('vs', 20, 3600000), async (req, res) => {
  try {
    const b64 = String(req.body.imageDataUrl || '').replace(/^data:image\/\w+;base64,/, '');
    if (b64.length < 100) return res.status(400).json({ error: 'Image invalide' });
    const t = await ebayToken();
    const r = await fetch('https://api.ebay.com/buy/browse/v1/item_summary/search_by_image?limit=40', {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', 'X-EBAY-C-MARKETPLACE-ID': MP[req.body.country] || 'EBAY_FR' },
      body: JSON.stringify({ image: b64 })
    });
    const d = await r.json();
    res.json({ ok: true, items: bestValue(mapItems(d.itemSummaries)) });
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
    const t = await ebayToken();
    const r = await fetch('https://api.ebay.com/buy/browse/v1/item/' + encodeURIComponent(id), { headers: { Authorization: `Bearer ${t}` } });
    const d = await r.json();
    if (r.ok && d.price?.value) { const p = withMargin(d.price.value); priceCache.set(id, p); return p; }
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
      items: (b.items || []).slice(0, 50).map(i => ({ id: i.id, name: i.name, qty: i.qty, itemUrl: i.itemUrl || '' })),
      status: 'pending', createdAt: new Date().toISOString()
    };
    const orders = rd('orders.json', []);
    if (!orders.some(o => o.orderId === order.orderId)) { orders.push(order); wr('orders.json', orders); }
    const c = order.customer;
    // le lien eBay part seulement ici, vers vous : jamais affiché sur le site
    telegram(`🛒 Commande ${order.orderId} (en attente de paiement)\n${c.name || ''} | ${c.email || ''} | ${c.phone || ''}\n${c.address || ''}, ${c.city || ''} ${c.zip || ''} ${c.country || ''}\n` +
      order.items.map(i => `• ${i.name} x${i.qty}\n  ${i.itemUrl}`).join('\n') + `\nTotal : €${order.total.toFixed(2)}`);
    res.json({ ok: true, orderId: order.orderId });
  } catch (e) { console.error('order:', e); res.status(500).json({ error: 'Commande impossible' }); }
});

/* ---------- FLUTTERWAVE ---------- */
const CUR = String(E.FLUTTERWAVE_CURRENCY || 'XAF').toUpperCase();
const RATE = Number(E.EUR_RATE || (['XAF', 'XOF'].includes(CUR) ? 655.957 : 1));
const toPay = eur => ['XAF', 'XOF', 'NGN', 'GHS', 'KES', 'UGX', 'TZS', 'RWF'].includes(CUR)
  ? Math.round(eur * RATE) : Math.round(eur * RATE * 100) / 100;

app.post('/api/payment/flutterwave', limit('fw', 20, 3600000), async (req, res) => {
  try {
    if (!E.FLUTTERWAVE_SECRET_KEY) return res.status(500).json({ error: 'FLUTTERWAVE_SECRET_KEY manquante sur Render' });
    const o = req.body || {}, c = o.customer || {};
    if (!okEmail(c.email)) return res.status(400).json({ error: 'Email client obligatoire' });
    if (!c.address || !c.city) return res.status(400).json({ error: 'Adresse de livraison obligatoire' });
    const eur = await serverTotal(o.items);
    if (!eur) return res.status(400).json({ error: 'Panier invalide : rechargez la page' });
    const amount = toPay(eur), orderId = String(o.orderId || `MC-${Date.now()}`).slice(0, 40);
    const r = await fetch('https://api.flutterwave.com/v3/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${E.FLUTTERWAVE_SECRET_KEY}` },
      body: JSON.stringify({
        tx_ref: orderId, amount, currency: CUR,
        redirect_url: E.FRONTEND_SUCCESS_URL || `${req.protocol}://${req.get('host')}/#confirm`,
        customer: { email: c.email, name: c.name || '', phonenumber: c.phone || '' },
        customizations: { title: 'MERCADO', description: `Commande ${orderId}` },
        meta: { address: c.address, city: c.city, zip: c.zip || '', country: c.country || '' }
      })
    });
    const d = await r.json();
    if (!r.ok || d.status !== 'success' || !d.data?.link) {
      console.error('Flutterwave:', r.status, d);
      return res.status(502).json({ error: d.message || 'Flutterwave a refusé la demande' });
    }
    res.json({ ok: true, payment_url: d.data.link, orderId, amount, currency: CUR });
  } catch (e) { console.error('flutterwave:', e); res.status(500).json({ error: 'Erreur serveur paiement' }); }
});
app.post('/api/payment/flutterwave/webhook', async (req, res) => {
  try {
    if (!E.FLW_SECRET_HASH || req.headers['verif-hash'] !== E.FLW_SECRET_HASH) return res.sendStatus(401);
    const id = req.body?.data?.id, ref = req.body?.data?.tx_ref;
    if (!id || !ref) return res.sendStatus(200);
    const v = await (await fetch(`https://api.flutterwave.com/v3/transactions/${id}/verify`, {
      headers: { Authorization: `Bearer ${E.FLUTTERWAVE_SECRET_KEY}` }
    })).json(); // on ne croit pas le webhook : on revérifie chez Flutterwave
    const t = v.data || {}, orders = rd('orders.json', []), o = orders.find(x => x.orderId === ref);
    if (o && o.status !== 'paid' && t.status === 'successful' && t.tx_ref === ref && t.currency === CUR && t.amount >= toPay(o.total) - 1) {
      o.status = 'paid'; o.paidAt = new Date().toISOString(); o.transactionId = id;
      wr('orders.json', orders);
      telegram(`✅ PAYÉ ${ref} : ${t.amount} ${t.currency}\n${o.customer.name || ''} | ${o.customer.address || ''}, ${o.customer.city || ''}`);
      if (okEmail(o.customer.email)) sendMail(o.customer.email, `Commande ${ref} confirmée`, `Merci pour votre commande MERCADO ${ref}. Paiement reçu.`);
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
    if (!seen.has(s.query)) { try { seen.set(s.query, (await ebaySearch(s.query, 1, 'FR'))[0] || localCatalog().find(x => x.name.toLowerCase().includes(s.query.toLowerCase())) || null); } catch { seen.set(s.query, null); } }
    const hit = seen.get(s.query);
    if (hit && await sendMail(s.email, `"${s.query}" est disponible sur MERCADO`, `Bonne nouvelle : ${hit.name} est disponible. ${E.PUBLIC_BASE_URL || ''}`)) sent++;
    else keep.push(s);
  }
  wr('subs.json', keep);
  res.json({ ok: true, sent });
});
app.get('/api/admin/orders', admin, (req, res) => res.json({ ok: true, orders: rd('orders.json', []).slice(-200).reverse() }));

/* ---------- IA ---------- */
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
        messages: (b.history || []).slice(-10).filter(m => m && m.content)
          .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 2000) }))
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

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res, next) => req.path.startsWith('/api/') ? next() : res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((e, req, res, next) => { console.error(e); res.status(500).json({ error: 'Erreur interne' }); });
app.listen(PORT, '0.0.0.0', () => console.log(`MERCADO port ${PORT} | marge ${MARKUP} (${MARKUP_TYPE}) | ${CUR}`));
