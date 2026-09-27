/**
 * MERCADO — Backend
 * -----------------------------------------------------------------
 * Ce serveur fournit tous les endpoints déjà attendus par
 * mercado.html (MERCADO_CONFIG). Aucune clé API n'est écrite ici :
 * tout vient des variables d'environnement Render (voir .env.example).
 *
 * Endpoints :
 *   POST /api/email/send            { email }
 *   POST /api/email/verify          { email, code }
 *   POST /api/order                 { orderId, items, customer, paymentMethod, total }
 *   POST /api/payment/flutterwave   { orderId, total, ... }
 *   POST /api/notify/subscribe      { email, query }
 *   POST /api/admin/notify-broadcast (protégé par ADMIN_KEY) { query, product }
 *   GET  /api/catalog/home?country=&lang=      (eBay marketplace selon le pays)
 *   GET  /api/catalog/search?q=&country=&lang=
 *   POST /api/ai                    { question, history, product, country, language }
 *   POST /api/translate             { target, texts: [...] }
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '2mb' }));

// ---------------------------------------------------------------
// Sert le site (public/index.html) directement depuis ce serveur.
// Comme ça un seul dépôt GitHub + un seul service Render suffit :
// pas besoin de Netlify. Le dossier public/ doit contenir
// index.html (= mercado.html renommé) à la racine du repo.
// ---------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res) => {
    // Même logique que le fichier _headers Netlify : évite que les
    // clients voient une vieille version mise en cache du site.
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const SUBSCRIBERS_FILE = path.join(DATA_DIR, 'subscribers.json');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');
const CODES_FILE = path.join(DATA_DIR, 'verification-codes.json');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/* =====================================================
   EMAIL — Resend en priorité (API simple, sans SMTP), avec
   repli sur SMTP classique si RESEND_API_KEY n'est pas défini.
===================================================== */

function getTransport() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE) === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

async function sendEmail(to, subject, html) {

  if (process.env.RESEND_API_KEY) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'MERCADO <onboarding@resend.dev>',
        to,
        subject,
        html
      })
    });

    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.message || `Échec envoi Resend (${r.status})`);
    }
    return;
  }

  const transport = getTransport();
  if (!transport) throw new Error('Aucun service email configuré (RESEND_API_KEY ou SMTP_* manquant)');
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to, subject, html
  });
}

/* =====================================================
   CODE DE VÉRIFICATION EMAIL — 4 chiffres (en mémoire, expire 10 min)
===================================================== */

/* =====================================================
   CODE DE VÉRIFICATION EMAIL — 4 chiffres, expire 10 min.
   Stocké dans un fichier (pas juste en mémoire) pour survivre
   à un redémarrage du serveur Render entre l'envoi du code et
   sa saisie par le client — sinon un code pourtant correct
   pouvait être refusé après une simple mise en veille du service.
===================================================== */

app.post('/api/email/send', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'email invalide' });

    const code = String(Math.floor(1000 + Math.random() * 9000));
    const codes = readJSON(CODES_FILE, {});
    codes[email] = { code, expires: Date.now() + 10 * 60 * 1000 };
    writeJSON(CODES_FILE, codes);

    await sendEmail(
      email,
      'Votre code de vérification MERCADO',
      `<p>Votre code de vérification MERCADO est :</p>
       <h2 style="letter-spacing:6px">${code}</h2>
       <p>Ce code expire dans 10 minutes.</p>`
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('email/send', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/email/verify', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();

  const codes = readJSON(CODES_FILE, {});
  const entry = codes[email];
  if (!entry || entry.expires < Date.now()) {
    return res.json({ verified: false, reason: 'expired_or_missing' });
  }
  const ok = entry.code === code;
  if (ok) {
    delete codes[email];
    writeJSON(CODES_FILE, codes);
  }
  res.json({ verified: ok });
});

/* =====================================================
   COMMANDE -> NOTIFICATION ADMIN (Messenger en priorité,
   WhatsApp en repli si Messenger n'est pas configuré)
   + photo + lien caché
===================================================== */

function buildOrderMessage(order) {
  const lines = [];
  lines.push(`🛒 Nouvelle commande MERCADO`);
  lines.push(`Commande : ${order.orderId}`);
  lines.push(`Paiement : ${order.paymentMethod}`);
  lines.push(`Total : €${Number(order.total || 0).toFixed(2)}`);
  lines.push('');
  (order.items || []).forEach((it, i) => {
    lines.push(`Produit ${i + 1} : ${it.name}`);
    lines.push(`Prix : €${Number(it.price || 0).toFixed(2)} x${it.qty || 1}`);
    if (it.desc) lines.push(`Description : ${it.desc}`);
    if (it.itemUrl) lines.push(`Lien source : ${it.itemUrl}`);
    lines.push('');
  });
  const c = order.customer || {};
  lines.push(`Client : ${c.name || '—'}`);
  lines.push(`Email : ${c.email || '—'}`);
  lines.push(`Téléphone : ${c.phone || '—'}`);
  lines.push(`Adresse : ${c.address || '—'}, ${c.city || ''} ${c.zip || ''} (${c.country || ''})`);
  return lines.join('\n');
}

// Envoie un message + éventuellement une image à l'admin (vous).
// Priorité : Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID) —
// le plus simple et le plus fiable à mettre en place.
// Repli 1 : Facebook Messenger (FB_PAGE_ACCESS_TOKEN + FB_ADMIN_PSID).
// Repli 2 : WhatsApp via Twilio (TWILIO_*). Sinon : juste un log serveur.
async function sendAdminMessage(text, imageUrl) {

  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    try {
      const base = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

      if (imageUrl) {
        // Photo avec légende si elle tient dans la limite Telegram (1024
        // caractères), sinon photo + message texte séparé juste après.
        if (text.length <= 1000) {
          const r = await fetch(`${base}/sendPhoto`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: process.env.TELEGRAM_CHAT_ID,
              photo: imageUrl,
              caption: text
            })
          });
          const data = await r.json();
          if (!data.ok) throw new Error(data.description || 'erreur Telegram');
          return { sent: true, channel: 'telegram' };
        }

        await fetch(`${base}/sendPhoto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, photo: imageUrl })
        });
      }

      const r = await fetch(`${base}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text })
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.description || 'erreur Telegram');

      return { sent: true, channel: 'telegram' };
    } catch (e) {
      console.error('telegram send', e.message);
      // on tente Messenger/WhatsApp en repli si configurés
    }
  }

  if (process.env.FB_PAGE_ACCESS_TOKEN && process.env.FB_ADMIN_PSID) {
    try {
      const base = `https://graph.facebook.com/v19.0/me/messages?access_token=${process.env.FB_PAGE_ACCESS_TOKEN}`;

      if (imageUrl) {
        await fetch(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: { id: process.env.FB_ADMIN_PSID },
            message: { attachment: { type: 'image', payload: { url: imageUrl, is_reusable: true } } }
          })
        });
      }

      const r = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: process.env.FB_ADMIN_PSID },
          message: { text }
        })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || 'erreur Messenger');

      return { sent: true, channel: 'messenger' };
    } catch (e) {
      console.error('messenger send', e.message);
      // on tente WhatsApp en repli si configuré
    }
  }

  if (process.env.TWILIO_ACCOUNT_SID) {
    try {
      const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const payload = {
        from: process.env.TWILIO_WHATSAPP_FROM,
        to: process.env.WHATSAPP_TO,
        body: text
      };
      if (imageUrl) payload.mediaUrl = [imageUrl];
      await twilio.messages.create(payload);
      return { sent: true, channel: 'whatsapp' };
    } catch (e) {
      console.error('whatsapp send', e.message);
    }
  }

  console.log('[Aucun canal admin configuré] message qui aurait été envoyé :\n', text);
  return { sent: false, reason: 'no_channel_configured' };
}

app.post('/api/order', async (req, res) => {
  try {
    const order = req.body;
    if (!order || !order.orderId) return res.status(400).json({ error: 'commande invalide' });

    const firstImg = (order.items || []).find(it => it.img)?.img;
    const result = await sendAdminMessage(buildOrderMessage(order), firstImg);

    // Email de confirmation au client, si un email est fourni
    if (order.customer && order.customer.email && (process.env.RESEND_API_KEY || getTransport())) {
      sendEmail(
        order.customer.email,
        `Confirmation de commande ${order.orderId} — MERCADO`,
        `<p>Merci pour votre commande sur MERCADO.</p>
         <p>Référence : <b>${order.orderId}</b></p>
         <p>Total : €${Number(order.total || 0).toFixed(2)}</p>`
      ).catch(e => console.error('email confirmation', e.message));
    }

    // On marque les produits comme achetés pour ne plus jamais
    // envoyer de rappel "vous avez consulté ce produit..." dessus.
    if (order.customer?.email && Array.isArray(order.items)) {
      const email = order.customer.email.trim().toLowerCase();
      const views = readJSON(VIEWS_FILE, []);
      let changed = false;
      order.items.forEach(it => {
        const v = views.find(x => x.email === email && x.product.id === it.id);
        if (v && !v.reminded) { v.reminded = true; v.remindedAt = 'purchased'; changed = true; }
      });
      if (changed) writeJSON(VIEWS_FILE, views);
    }

    res.json({ ok: true, notification: result });
  } catch (e) {
    console.error('order', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* =====================================================
   PAIEMENT — FLUTTERWAVE (carte, mobile money, virement)
   Flutterwave est licencié par la BEAC pour opérer au Cameroun.
   Utilise le "Standard Checkout" : Flutterwave héberge la page
   de paiement (carte + mobile money + virement local selon le
   pays du client), gère tout automatiquement sans code
   supplémentaire côté site. Le montant est calculé par le
   serveur à partir du panier — le client ne peut pas le modifier.
   L'argent est réglé sur le compte Flutterwave du titulaire, en
   XAF pour un compte camerounais, puis viré vers son compte
   bancaire (Afriland First Bank), jamais vers un wallet crypto.
   Utilisez une clé FLWSECK_TEST-... pour tester sans vrai argent
   (voir developer.flutterwave.com/docs/testing pour les cartes
   de test), puis remplacez par FLWSECK-... (Live) pour le réel.
===================================================== */

app.post('/api/payment/flutterwave', async (req, res) => {
  try {
    if (!process.env.FLUTTERWAVE_SECRET_KEY) {
      return res.status(500).json({ error: 'Flutterwave non configuré' });
    }
    const order = req.body;
    let amount = Number(order.total || 0);
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Montant invalide' });
    }
    const currency = process.env.FLUTTERWAVE_CURRENCY || 'XAF';
    // XAF (et quelques autres devises) n'ont pas de centimes : un montant
    // avec virgule peut être refusé par Flutterwave. On arrondit.
    const ZERO_DECIMAL_CURRENCIES = ['XAF', 'XOF', 'XPF', 'CVE', 'DJF', 'GNF', 'RWF', 'UGX', 'VUV', 'KMF'];
    if (ZERO_DECIMAL_CURRENCIES.includes(currency)) amount = Math.round(amount);

    const r = await fetch('https://api.flutterwave.com/v3/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`
      },
      body: JSON.stringify({
        tx_ref: order.orderId || `mercado-${Date.now()}`,
        amount: amount,
        currency: currency,
        redirect_url: process.env.FRONTEND_SUCCESS_URL || process.env.PUBLIC_BASE_URL || '',
        customer: {
          email: order.customer?.email || order.email || '',
          name: order.customer?.name || order.name || '',
          phonenumber: order.customer?.phone || order.phone || ''
        },
        customizations: {
          title: 'MERCADO',
          description: `Commande ${order.orderId || ''}`
        }
      })
    });

    const data = await r.json();
    if (!r.ok || data.status !== 'success') {
      return res.status(500).json({ error: data.message || 'Erreur Flutterwave' });
    }

    res.json({ ok: true, payment_url: data.data.link });
  } catch (e) {
    console.error('flutterwave', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Flutterwave appelle cette URL pour confirmer le paiement (webhook serveur
// à serveur). Configurez la même valeur dans FLW_SECRET_HASH (env) et dans
// le dashboard Flutterwave → Settings → Webhooks, pour vérifier que l'appel
// vient bien de Flutterwave et pas d'un imposteur.
app.post('/api/payment/flutterwave/webhook', (req, res) => {
  const signature = req.headers['verif-hash'];
  if (!signature || signature !== process.env.FLW_SECRET_HASH) {
    return res.sendStatus(401);
  }
  console.log('Flutterwave webhook reçu:', req.body?.data?.tx_ref);
  // TODO: marquer la commande correspondante (tx_ref) comme payée.
  res.sendStatus(200);
});

/* =====================================================
   RAPPEL "VOUS AVEZ RÉCEMMENT CONSULTÉ CE PRODUIT"
   Le client accepte implicitement en renseignant son email sur
   le site — pensez à ajouter une case à cocher de consentement
   si vous voulez être irréprochable niveau RGPD.
   Un seul rappel par (email, produit), envoyé après un délai
   configurable (par défaut 24h) s'il n'a pas déjà commandé.
===================================================== */

const VIEWS_FILE = path.join(DATA_DIR, 'product-views.json');

app.post('/api/track-view', (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const product = req.body.product;
    if (!email || !email.includes('@') || !product?.id) {
      return res.status(400).json({ error: 'email ou produit invalide' });
    }

    const views = readJSON(VIEWS_FILE, []);

    // Pas de doublon pour la même paire (email, produit) : on
    // rafraîchit juste la date de dernière consultation.
    const existing = views.find(v => v.email === email && v.product.id === product.id);
    if (existing) {
      existing.viewedAt = new Date().toISOString();
    } else {
      views.push({
        email,
        product,
        viewedAt: new Date().toISOString(),
        reminded: false
      });
    }

    writeJSON(VIEWS_FILE, views.slice(-500)); // limite simple

    res.json({ ok: true });
  } catch (e) {
    console.error('track-view', e.message);
    res.status(500).json({ error: e.message });
  }
});

function reminderEmailHtml(product, viewedAt) {
  const hoursAgo = Math.round((Date.now() - new Date(viewedAt).getTime()) / 3600000);
  const whenText = hoursAgo >= 48
    ? `il y a ${Math.round(hoursAgo / 24)} jours`
    : hoursAgo >= 2
      ? `il y a ${hoursAgo} heures`
      : "récemment";

  return `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
      <p style="font-size:16px">Hey 👋 vous avez consulté ce produit sur MERCADO ${whenText} :</p>
      ${product.img ? `<img src="${product.img}" alt="${product.name}" style="width:100%;border-radius:12px;margin:12px 0">` : ''}
      <h2 style="margin:0 0 4px">${product.name}</h2>
      <p style="font-size:18px;color:#FF6B00;margin:0 0 16px">€${Number(product.price || 0).toFixed(2)}</p>
      <p>Il est toujours disponible — si vous hésitiez encore, c'est le moment idéal pour le commander avant qu'il ne parte.</p>
      ${product.itemUrl ? `<a href="${product.itemUrl}" style="display:inline-block;background:#FF6B00;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Revoir ce produit</a>` : ''}
      <p style="font-size:12px;color:#888;margin-top:24px">Vous recevez cet email parce que vous avez renseigné votre adresse sur MERCADO. Ce rappel ne sera envoyé qu'une seule fois pour ce produit.</p>
    </div>
  `;
}

async function runViewReminders() {
  const delayHours = Number(process.env.REMINDER_DELAY_HOURS || 24);
  const views = readJSON(VIEWS_FILE, []);
  const now = Date.now();
  let changed = false;

  for (const v of views) {
    if (v.reminded) continue;
    const ageHours = (now - new Date(v.viewedAt).getTime()) / 3600000;
    if (ageHours < delayHours) continue;

    try {
      await sendEmail(
        v.email,
        `Toujours intéressé(e) par ${v.product.name} ?`,
        reminderEmailHtml(v.product, v.viewedAt)
      );
      v.reminded = true;
      v.remindedAt = new Date().toISOString();
      changed = true;
      console.log(`Rappel envoyé à ${v.email} pour ${v.product.name}`);
    } catch (e) {
      console.error('reminder email failed', v.email, e.message);
    }
  }

  if (changed) writeJSON(VIEWS_FILE, views);
}

// Vérifie toutes les 30 minutes s'il y a des rappels à envoyer.
// (Sur le plan gratuit Render, le service peut se mettre en veille :
// le prochain passage se fera dès qu'une requête réveille le service.)
setInterval(() => {
  if (process.env.RESEND_API_KEY || process.env.SMTP_HOST) {
    runViewReminders().catch(e => console.error('runViewReminders', e.message));
  }
}, 30 * 60 * 1000);

// Déclenchement manuel (pour tester tout de suite, ou pour un cron
// externe gratuit comme cron-job.org qui appelle cette URL toutes les
// 30 min — utile si le service Render s'endort et que personne ne
// visite le site entre-temps). Protégé par la même clé admin.
app.post('/api/admin/run-reminders', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'non autorisé' });
  }
  try {
    await runViewReminders();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =====================================================
   NOTIFICATIONS "PRODUIT DISPONIBLE"
===================================================== */

app.post('/api/notify/subscribe', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const query = String(req.body.query || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'email invalide' });

  const subs = readJSON(SUBSCRIBERS_FILE, []);
  subs.push({ email, query, date: new Date().toISOString() });
  writeJSON(SUBSCRIBERS_FILE, subs);

  res.json({ ok: true });
});

// Admin : à appeler (depuis un script, Postman, etc.) quand un produit
// recherché redevient disponible, pour prévenir les abonnés concernés.
app.post('/api/admin/notify-broadcast', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'non autorisé' });
  }
  const { query, product } = req.body;
  const subs = readJSON(SUBSCRIBERS_FILE, []);
  const q = String(query || '').trim().toLowerCase();

  const matches = subs.filter(s => !q || s.query.includes(q) || q.includes(s.query));

  let sent = 0;
  for (const s of matches) {
    try {
      await sendEmail(
        s.email,
        `Disponible maintenant sur MERCADO : ${product?.name || query}`,
        `<p>Le produit que vous recherchiez est maintenant disponible sur MERCADO.</p>
         <p><b>${product?.name || ''}</b></p>
         <p>${product?.desc || ''}</p>`
      );
      sent++;
    } catch (e) { console.error('broadcast email', e.message); }
  }

  res.json({ ok: true, notified: sent, totalMatches: matches.length });
});

/* =====================================================
   CATALOGUE — eBay Browse API par pays, avec repli local
   -> Le pays choisi par le client détermine la marketplace
      eBay interrogée (donc la langue et les produits
      réellement proposés changent avec le pays). Si
      EBAY_CLIENT_ID/SECRET ne sont pas configurés, on retombe
      sur data/products.json (mode démo).
   -> Le champ interne "ebayLink" (s'il existe dans
      products.json) n'est jamais renvoyé : seul "itemUrl"
      (public, déjà utilisé par le bouton "Acheter sur eBay")
      l'est.
===================================================== */

// Pays -> { marketplace eBay, code langue eBay, devise }
const EBAY_MARKETPLACES = {
  US: { id: 'EBAY_US', lang: 'en-US', currency: 'USD' },
  GB: { id: 'EBAY_GB', lang: 'en-GB', currency: 'GBP' },
  IE: { id: 'EBAY_IE', lang: 'en-GB', currency: 'EUR' },
  AU: { id: 'EBAY_AU', lang: 'en-AU', currency: 'AUD' },
  FR: { id: 'EBAY_FR', lang: 'fr-FR', currency: 'EUR' },
  BE: { id: 'EBAY_FR', lang: 'fr-FR', currency: 'EUR' },
  CH: { id: 'EBAY_CH', lang: 'fr-CH', currency: 'CHF' },
  DE: { id: 'EBAY_DE', lang: 'de-DE', currency: 'EUR' },
  AT: { id: 'EBAY_AT', lang: 'de-AT', currency: 'EUR' },
  ES: { id: 'EBAY_ES', lang: 'es-ES', currency: 'EUR' },
  IT: { id: 'EBAY_IT', lang: 'it-IT', currency: 'EUR' },
  NL: { id: 'EBAY_NL', lang: 'nl-NL', currency: 'EUR' },
  PL: { id: 'EBAY_PL', lang: 'pl-PL', currency: 'PLN' },
  CA: { id: 'EBAY_ENCA', lang: 'en-CA', currency: 'CAD' },
  HK: { id: 'EBAY_HK', lang: 'en-HK', currency: 'HKD' },
  IN: { id: 'EBAY_IN', lang: 'en-IN', currency: 'INR' },
  MY: { id: 'EBAY_MY', lang: 'en-MY', currency: 'MYR' },
  PH: { id: 'EBAY_PH', lang: 'en-PH', currency: 'PHP' },
  SG: { id: 'EBAY_SG', lang: 'en-SG', currency: 'SGD' }
  // Tout pays absent de cette liste (ex. CM, SN, CI, JP, CN, NZ...)
  // retombe sur EBAY_US par défaut ci-dessous — eBay livre la
  // plupart de ces pays via le programme d'expédition internationale,
  // et la traduction de l'interface reste gérée séparément par
  // /api/translate.
};

function marketplaceFor(country) {
  return EBAY_MARKETPLACES[String(country || '').toUpperCase()] || EBAY_MARKETPLACES.US;
}

let ebayToken = { value: null, expires: 0 };

async function getEbayToken() {
  if (ebayToken.value && ebayToken.expires > Date.now()) return ebayToken.value;

  const creds = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString('base64');

  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${creds}`
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope'
    })
  });

  const data = await r.json();
  if (!r.ok) throw new Error(data.error_description || 'Échec authentification eBay');

  ebayToken = { value: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  return ebayToken.value;
}

async function ebaySearch(query, country, limit, sort) {
  const mk = marketplaceFor(country);
  const token = await getEbayToken();

  const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
  url.searchParams.set('q', query || 'bestsellers');
  url.searchParams.set('limit', String(limit || 48));
  if (sort) url.searchParams.set('sort', sort);

  const r = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': mk.id,
      'Accept-Language': mk.lang
    }
  });

  const data = await r.json();
  if (!r.ok) throw new Error(data.errors?.[0]?.message || 'Échec recherche eBay');

  return (data.itemSummaries || []).map(it => ({
    id: it.itemId,
    name: it.title,
    category: it.categories?.[0]?.categoryName || 'General',
    price: withMarkup(it.price?.value),
    rating: null,
    sold: null,
    image: it.image?.imageUrl || it.thumbnailImages?.[0]?.imageUrl || '',
    description: it.shortDescription || it.title,
    itemUrl: it.itemWebUrl,
    shipping: it.shippingOptions?.[0]?.shippingCostType || ''
  }));
}

// Marge ajoutée sur chaque produit avant affichage/vente sur MERCADO.
// Réglable via l'env var PRICE_MARKUP (par défaut 6).
function withMarkup(price) {
  const markup = Number(process.env.PRICE_MARKUP ?? 6);
  return Math.round((Number(price || 0) + markup) * 100) / 100;
}

function publicProduct(p) {
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    price: withMarkup(p.price),
    rating: p.rating,
    sold: p.sold,
    image: p.image,
    description: p.description,
    itemUrl: p.itemUrl, // lien affilié public, ouvert volontairement par l'utilisateur
    shipping: p.shipping
  };
}

async function localCatalog(query) {
  const products = readJSON(PRODUCTS_FILE, []);
  const q = String(query || '').trim().toLowerCase();
  return products
    .filter(p => !q || (p.name + ' ' + p.category).toLowerCase().includes(q))
    .map(publicProduct);
}

// Détail d'un item eBay, avec la vraie note moyenne / nombre d'avis
// quand eBay les fournit (uniquement pour les produits catalogués
// avec un EPID — l'API eBay Browse ne renvoie pas le texte des avis,
// seulement la note agrégée : reviewRating.averageRating / reviewCount).
app.get('/api/catalog/item', async (req, res) => {
  try {
    if (!process.env.EBAY_CLIENT_ID) {
      return res.status(500).json({ error: 'eBay non configuré' });
    }
    const itemId = req.query.itemId;
    if (!itemId) return res.status(400).json({ error: 'itemId manquant' });

    const mk = marketplaceFor(req.query.country);
    const token = await getEbayToken();

    const r = await fetch(
      `https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(itemId)}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': mk.id,
          'Accept-Language': mk.lang
        }
      }
    );
    const data = await r.json();
    if (!r.ok) return res.status(500).json({ error: data.errors?.[0]?.message || 'Échec détail eBay' });

    // Renvoie aussi le produit complet (avec la marge +6€ appliquée),
    // pas seulement la note. Sert à ouvrir un produit partagé
    // directement sur MERCADO (jamais un lien vers eBay).
    res.json({
      id: itemId,
      name: data.title || '',
      price: withMarkup(data.price?.value),
      img: data.image?.imageUrl || data.thumbnailImages?.[0]?.imageUrl || '',
      description: data.shortDescription || data.description || '',
      rating: data.reviewRating?.averageRating ? Number(data.reviewRating.averageRating) : null,
      reviewCount: data.reviewRating?.reviewCount ? Number(data.reviewRating.reviewCount) : null,
      sold: data.estimatedAvailabilities?.[0]?.estimatedSoldQuantity ?? null,
      // itemUrl voyage uniquement en interne : le frontend ne l'affiche
      // et ne le partage jamais nulle part (voir shareableProductLink()
      // côté site) — il sert seulement à VOUS l'envoyer par Telegram
      // au moment d'une commande, pour que vous puissiez livrer le
      // produit exact.
      itemUrl: data.itemWebUrl || ''
    });
  } catch (e) {
    console.error('catalog/item', e.message);
    res.status(500).json({ error: e.message });
  }
});

// eBay renvoie SES PROPRES noms de catégories (ex. "Cell Phones &
// Accessories"), qui ne correspondent jamais aux catégories du site
// ("Phones", "Electronics"...). On force donc la bonne catégorie
// nous-mêmes, à partir du terme de recherche utilisé pour la trouver.
const CATEGORY_QUERIES = {
  Electronics: 'electronics gadget',
  Fashion: 'fashion clothing',
  Home: 'home decor',
  Phones: 'smartphone phone case',
  Computers: 'laptop computer accessories',
  Fitness: 'fitness equipment',
  Sports: 'sports equipment',
  Watches: 'watch',
  Beauty: 'beauty cosmetics',
  Automotive: 'car accessories',
  Toys: 'toys'
};
const HOME_CATEGORIES = Object.keys(CATEGORY_QUERIES);

app.get('/api/catalog/home', async (req, res) => {
  const limit = Number(req.query.limit) || 200;
  const cat = req.query.cat && req.query.cat !== 'All' ? req.query.cat : null;
  try {
    if (process.env.EBAY_CLIENT_ID) {

      // Une catégorie précise est demandée : on combine les meilleurs
      // résultats (pertinence eBay = équivalent le plus proche de
      // "tendance") avec les moins chers. UNIQUEMENT de vrais produits
      // eBay — pas de complément avec le catalogue local fait à la main.
      if (cat && CATEGORY_QUERIES[cat]) {
        const [bestBatch, cheapBatch] = await Promise.all([
          ebaySearch(CATEGORY_QUERIES[cat], req.query.country, 20).catch(() => []),
          ebaySearch(CATEGORY_QUERIES[cat], req.query.country, 20, 'price').catch(() => [])
        ]);
        let items = [];
        const seen = new Set();
        const maxLen = Math.max(bestBatch.length, cheapBatch.length);
        for (let i = 0; i < maxLen; i++) {
          if (bestBatch[i] && !seen.has(bestBatch[i].id)) { items.push(bestBatch[i]); seen.add(bestBatch[i].id); }
          if (cheapBatch[i] && !seen.has(cheapBatch[i].id)) { items.push(cheapBatch[i]); seen.add(cheapBatch[i].id); }
        }
        items = items.slice(0, Math.min(limit, 200)).map(it => ({ ...it, category: cat }));
        // Si eBay est totalement injoignable (clé invalide, panne), on
        // affiche le catalogue local en dernier recours plutôt qu'une
        // page vide — mais jamais mélangé à de vrais résultats eBay.
        if (!items.length) {
          return res.json({ items: (await localCatalog('')).filter(p => p.category === cat) });
        }
        return res.json({ items });
      }

      // "Tout" : on ramène un lot de CHAQUE catégorie (mix meilleurs +
      // moins chers), pour que chaque filtre du site ait vraiment des
      // produits derrière lui.
      const perCat = Math.max(10, Math.ceil(limit / HOME_CATEGORIES.length / 2));
      const batches = await Promise.all(
        HOME_CATEGORIES.map(async c => {
          const [bestBatch, cheapBatch] = await Promise.all([
            ebaySearch(CATEGORY_QUERIES[c], req.query.country, perCat).catch(() => []),
            ebaySearch(CATEGORY_QUERIES[c], req.query.country, perCat, 'price').catch(() => [])
          ]);
          let items = [];
          const seen = new Set();
          const maxLen = Math.max(bestBatch.length, cheapBatch.length);
          for (let i = 0; i < maxLen; i++) {
            if (bestBatch[i] && !seen.has(bestBatch[i].id)) { items.push(bestBatch[i]); seen.add(bestBatch[i].id); }
            if (cheapBatch[i] && !seen.has(cheapBatch[i].id)) { items.push(cheapBatch[i]); seen.add(cheapBatch[i].id); }
          }
          return items.map(it => ({ ...it, category: c }));
        })
      );
      let items = batches.flat();
      // mélange pour ne pas afficher les catégories groupées par bloc
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
      if (!items.length) {
        return res.json({ items: (await localCatalog('')).slice(0, limit) });
      }
      return res.json({ items: items.slice(0, limit) });
    }
    res.json({ items: (await localCatalog('')).slice(0, limit) });
  } catch (e) {
    console.error('catalog/home', e.message);
    res.json({ items: (await localCatalog('')).slice(0, limit) });
  }
});

app.get('/api/catalog/search', async (req, res) => {
  const limit = Number(req.query.limit) || 48;
  const q = req.query.q || '';
  try {
    if (process.env.EBAY_CLIENT_ID) {
      const items = await ebaySearch(q, req.query.country, limit);
      return res.json({ items });
    }
    res.json({ items: (await localCatalog(q)).slice(0, limit) });
  } catch (e) {
    console.error('catalog/search', e.message);
    res.json({ items: (await localCatalog(q)).slice(0, limit) });
  }
});

/* =====================================================
   AVIS CLIENTS — vrais avis, persistés par produit, partagés
   entre tous les visiteurs (pas de compte requis pour lire ;
   un avis est simplement horodaté et associé au productId).
===================================================== */

app.get('/api/reviews', (req, res) => {
  const productId = String(req.query.productId || '');
  if (!productId) return res.status(400).json({ error: 'productId manquant' });

  const all = readJSON(REVIEWS_FILE, {});
  res.json({ reviews: all[productId] || [] });
});

app.post('/api/reviews', (req, res) => {
  const { productId, name, stars, text, initial, variant } = req.body;
  if (!productId || !text || !stars) {
    return res.status(400).json({ error: 'productId, stars et text sont requis' });
  }

  const all = readJSON(REVIEWS_FILE, {});
  if (!all[productId]) all[productId] = [];

  all[productId].unshift({
    name: name || 'Client MERCADO',
    initial: initial || (name ? name[0] : 'M'),
    stars: Math.max(1, Math.min(5, Number(stars))),
    date: new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }),
    text: String(text).slice(0, 1000),
    variant: variant || ''
  });

  all[productId] = all[productId].slice(0, 200); // on garde les 200 plus récents par produit
  writeJSON(REVIEWS_FILE, all);

  res.json({ ok: true });
});

/* =====================================================
   RECHERCHE PAR PHOTO — eBay "search by image"
   Utilise la même app eBay (EBAY_CLIENT_ID/SECRET) que le
   catalogue. Sans ces clés, renvoie une erreur claire au
   lieu d'échouer silencieusement.
===================================================== */

app.post('/api/visual-search', async (req, res) => {
  try {
    if (!process.env.EBAY_CLIENT_ID) {
      return res.status(500).json({ error: 'Recherche par photo non configurée (EBAY_CLIENT_ID manquant)' });
    }

    const { imageDataUrl, country } = req.body;
    if (!imageDataUrl) return res.status(400).json({ error: 'image manquante' });

    const base64 = String(imageDataUrl).split(',').pop();
    const mk = marketplaceFor(country);
    const token = await getEbayToken();

    const r = await fetch(
      'https://api.ebay.com/buy/browse/v1/item_summary/search_by_image?limit=24',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': mk.id,
          'Accept-Language': mk.lang
        },
        body: JSON.stringify({ image: base64 })
      }
    );

    const data = await r.json();
    if (!r.ok) {
      console.error('visual-search (ebay error)', JSON.stringify(data));
      return res.status(500).json({ error: data.errors?.[0]?.message || 'erreur recherche par image' });
    }

    const items = (data.itemSummaries || []).map(it => ({
      id: it.itemId,
      name: it.title,
      category: it.categories?.[0]?.categoryName || 'General',
      price: withMarkup(it.price?.value),
      rating: null,
      sold: null,
      image: it.image?.imageUrl || it.thumbnailImages?.[0]?.imageUrl || '',
      description: it.shortDescription || it.title,
      itemUrl: it.itemWebUrl,
      shipping: it.shippingOptions?.[0]?.shippingCostType || ''
    }));

    res.json({ items });
  } catch (e) {
    console.error('visual-search', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* =====================================================
   JOURNAL DES QUESTIONS IA
   Le client ne voit jamais que l'IA générale n'est pas
   connectée — mais chaque question posée en mode local est
   silencieusement enregistrée (+ notifiée sur Messenger/
   WhatsApp si configuré) pour que vous restiez informé de ce
   que demandent vos clients.
===================================================== */

const AI_LOG_FILE = path.join(DATA_DIR, 'ai-questions.json');

app.post('/api/ai-log', async (req, res) => {
  try {
    const { question, product, customer, country, language } = req.body;
    if (!question) return res.status(400).json({ error: 'question manquante' });

    const entry = {
      question,
      product: product ? { name: product.name, price: product.price } : null,
      customer: customer || null,
      country: country || null,
      language: language || null,
      date: new Date().toISOString()
    };

    const logs = readJSON(AI_LOG_FILE, []);
    logs.push(entry);
    writeJSON(AI_LOG_FILE, logs);

    const lines = [
      `💬 Question client (IA MERCADO)`,
      `Question : ${question}`,
      product ? `Produit consulté : ${product.name}` : '',
      customer?.email ? `Email client : ${customer.email}` : '',
      `Pays : ${country || '—'}`
    ].filter(Boolean);

    sendAdminMessage(lines.join('\n')).catch(() => {});

    res.json({ ok: true });
  } catch (e) {
    console.error('ai-log', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* =====================================================
   IA — MERCADO AI ("mini assistant" type Meta AI)
   Répond aux questions sur un produit / une commande MERCADO
   ET aux questions générales, comme un assistant classique.
   Utilise l'API Anthropic (Claude) via ANTHROPIC_API_KEY.
===================================================== */

app.post('/api/ai', async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'AI non configuré (ANTHROPIC_API_KEY manquant)' });
    }

    const { question, history = [], product, quantity, country, language } = req.body;
    if (!question || !String(question).trim()) {
      return res.status(400).json({ error: 'question manquante' });
    }

    // "Mini toi" : un vrai assistant généraliste, pas un script figé.
    // Il répond pleinement à toute question (site ou non), avec du
    // raisonnement, de la nuance, et sans se limiter à un format rigide.
    const system = `Tu es MERCADO AI, l'assistant conversationnel intégré au site e-commerce MERCADO.
Tu te comportes comme un assistant généraliste compétent et réfléchi (dans l'esprit de Claude) :
tu réponds vraiment à la question posée, avec le niveau de détail et de nuance qu'elle mérite,
tu raisonnes étape par étape quand c'est utile, tu es honnête sur ce que tu ne sais pas, et tu
n'inventes jamais un fait, un prix, un stock ou un délai qui n'est pas fourni ci-dessous.

Tu réponds dans la langue "${language || 'fr'}", sauf si la question est explicitement posée
dans une autre langue — dans ce cas, réponds dans la langue de la question.

Tu peux traiter :
1) Des questions sur MERCADO (produit affiché, prix, livraison, paiement, commande, le site).
2) N'importe quelle question générale, totalement indépendante de MERCADO — traite-la comme
   le ferait un assistant généraliste normal, sans forcer de lien avec le shopping.

${product ? `Produit actuellement consulté par le client :\n${JSON.stringify({
  name: product.name, price: product.price, rating: product.rating,
  sold: product.sold, desc: product.desc, quantity
})}` : "Aucun produit n'est ouvert actuellement — ne réponds pas comme si un produit était affiché."}
Pays du client : ${country || 'inconnu'}.`;

    const messages = [
      ...history
        .filter(h => (h.role === 'user' || h.role === 'assistant') && h.content)
        .map(h => ({ role: h.role, content: String(h.content) }))
    ];
    if (!messages.length || messages[messages.length - 1].role !== 'user' ||
        messages[messages.length - 1].content !== question) {
      messages.push({ role: 'user', content: String(question) });
    }

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
        max_tokens: 1200,
        system,
        messages
      })
    });

    const data = await r.json();

    if (!r.ok) {
      console.error('ai (anthropic error)', JSON.stringify(data));
      return res.status(500).json({ error: data.error?.message || 'erreur IA' });
    }

    const answer = (data.content || []).map(b => b.text || '').join('\n').trim();
    res.json({ answer: answer || "Je n'ai pas de réponse pour le moment." });
  } catch (e) {
    console.error('ai', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* =====================================================
   TRADUCTION — utilisée par mercado.html pour les langues
   qui n'ont pas de dictionnaire statique intégré.
===================================================== */

app.post('/api/translate', async (req, res) => {
  try {
    const { target, texts } = req.body;
    if (!Array.isArray(texts) || !target) {
      return res.status(400).json({ error: 'target et texts[] requis' });
    }

    if (process.env.DEEPL_API_KEY) {
      const params = new URLSearchParams();
      texts.forEach(t => params.append('text', t));
      params.append('target_lang', target.toUpperCase());

      const r = await fetch('https://api-free.deepl.com/v2/translate', {
        method: 'POST',
        headers: {
          'Authorization': `DeepL-Auth-Key ${process.env.DEEPL_API_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || 'erreur DeepL');

      return res.json({ translations: data.translations.map(t => t.text) });
    }

    if (process.env.GOOGLE_TRANSLATE_API_KEY) {
      const r = await fetch(
        `https://translation.googleapis.com/language/translate/v2?key=${process.env.GOOGLE_TRANSLATE_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: texts, target, format: 'html' })
        }
      );
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || 'erreur Google Translate');

      return res.json({ translations: data.data.translations.map(t => t.translatedText) });
    }

    return res.status(500).json({ error: 'Aucune API de traduction configurée (DEEPL_API_KEY ou GOOGLE_TRANSLATE_API_KEY)' });
  } catch (e) {
    console.error('translate', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* =====================================================
   START
===================================================== */

const PORT = process.env.PORT || 10000;
// Toute route non-API renvoie index.html (nécessaire pour que le
// site s'ouvre bien quand quelqu'un visite l'URL Render directement).
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => console.log(`MERCADO backend démarré sur le port ${PORT}`));
