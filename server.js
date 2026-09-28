require('dotenv').config();

const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();

const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');

const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const VIEWS_FILE = path.join(DATA_DIR, 'views.json');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function ensureJsonFile(file, defaultValue) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(defaultValue, null, 2));
  }
}

ensureJsonFile(ORDERS_FILE, []);
ensureJsonFile(VIEWS_FILE, {});
ensureJsonFile(REVIEWS_FILE, []);

app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json({
  limit: '2mb'
}));

app.use(express.urlencoded({
  extended: true
}));

/* =========================================================
   HELPERS
========================================================= */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error('Erreur lecture JSON:', file, error.message);
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(
    file,
    JSON.stringify(data, null, 2),
    'utf8'
  );
}

function generateOrderId() {
  return `MERCADO-${Date.now()}-${crypto
    .randomBytes(4)
    .toString('hex')
    .toUpperCase()}`;
}

function getBaseUrl(req) {
  return (
    process.env.FRONTEND_SUCCESS_URL ||
    process.env.PUBLIC_BASE_URL ||
    `${req.protocol}://${req.get('host')}/`
  );
}

function normalizeAmount(value) {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  return amount;
}

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'Mercado',
    time: new Date().toISOString()
  });
});

/* =========================================================
   EMAIL
========================================================= */

let transporter = null;

if (
  process.env.SMTP_HOST &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASS
) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE) === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

const emailCodes = new Map();

app.post('/api/email/send', async (req, res) => {
  try {
    const email = String(req.body.email || '')
      .trim()
      .toLowerCase();

    if (!email || !email.includes('@')) {
      return res.status(400).json({
        error: 'Email invalide'
      });
    }

    const code = String(
      Math.floor(100000 + Math.random() * 900000)
    );

    emailCodes.set(email, {
      code,
      expiresAt: Date.now() + 10 * 60 * 1000
    });

    if (!transporter) {
      console.log(`[MERCADO TEST] Code email pour ${email}: ${code}`);

      return res.json({
        ok: true,
        test: true,
        message: 'Code généré en mode test'
      });
    }

    await transporter.sendMail({
      from:
        process.env.SMTP_FROM ||
        process.env.SMTP_USER,
      to: email,
      subject: 'Code de vérification MERCADO',
      text:
        `Votre code de vérification MERCADO est : ${code}\n\n` +
        `Ce code expire dans 10 minutes.`
    });

    res.json({
      ok: true,
      message: 'Code envoyé'
    });

  } catch (error) {
    console.error('email/send:', error);

    res.status(500).json({
      error: 'Impossible d’envoyer le code'
    });
  }
});

app.post('/api/email/verify', (req, res) => {
  const email = String(req.body.email || '')
    .trim()
    .toLowerCase();

  const code = String(req.body.code || '').trim();

  const saved = emailCodes.get(email);

  if (!saved) {
    return res.status(400).json({
      verified: false,
      error: 'Code introuvable ou expiré'
    });
  }

  if (Date.now() > saved.expiresAt) {
    emailCodes.delete(email);

    return res.status(400).json({
      verified: false,
      error: 'Code expiré'
    });
  }

  if (saved.code !== code) {
    return res.status(400).json({
      verified: false,
      error: 'Code incorrect'
    });
  }

  emailCodes.delete(email);

  res.json({
    verified: true
  });
});

/* =========================================================
   ORDERS
========================================================= */

app.post('/api/order', async (req, res) => {
  try {
    const order = req.body || {};

    const orders = readJson(ORDERS_FILE, []);

    const orderId =
      order.orderId ||
      generateOrderId();

    const savedOrder = {
      ...order,
      orderId,
      status: order.status || 'pending',
      createdAt:
        order.createdAt ||
        new Date().toISOString()
    };

    orders.push(savedOrder);

    writeJson(ORDERS_FILE, orders);

    if (transporter && savedOrder.customer?.email) {
      try {
        await transporter.sendMail({
          from:
            process.env.SMTP_FROM ||
            process.env.SMTP_USER,

          to: savedOrder.customer.email,

          subject:
            `Confirmation de commande ${orderId}`,

          text:
            `Merci pour votre commande MERCADO.\n\n` +
            `Numéro de commande : ${orderId}\n` +
            `Montant : ${savedOrder.total || 0} ${process.env.FLUTTERWAVE_CURRENCY || 'XAF'}`
        });
      } catch (mailError) {
        console.error(
          'Erreur email commande:',
          mailError.message
        );
      }
    }

    if (process.env.ADMIN_EMAIL && transporter) {
      try {
        await transporter.sendMail({
          from:
            process.env.SMTP_FROM ||
            process.env.SMTP_USER,

          to: process.env.ADMIN_EMAIL,

          subject:
            `Nouvelle commande MERCADO ${orderId}`,

          text: JSON.stringify(
            savedOrder,
            null,
            2
          )
        });
      } catch (mailError) {
        console.error(
          'Erreur email admin:',
          mailError.message
        );
      }
    }

    res.json({
      ok: true,
      orderId
    });

  } catch (error) {
    console.error('/api/order:', error);

    res.status(500).json({
      error: 'Impossible d’enregistrer la commande'
    });
  }
});

/* =========================================================
   FLUTTERWAVE - CREATE PAYMENT
========================================================= */

app.post('/api/payment/flutterwave', async (req, res) => {
  try {
    const secretKey =
      process.env.FLUTTERWAVE_SECRET_KEY;

    if (!secretKey) {
      return res.status(500).json({
        error:
          'FLUTTERWAVE_SECRET_KEY n’est pas configurée'
      });
    }

    const order = req.body || {};

    const customer = order.customer || {};

    const email = String(
      customer.email ||
      order.email ||
      ''
    ).trim();

    const name = String(
      customer.name ||
      order.name ||
      ''
    ).trim();

    const phone = String(
      customer.phone ||
      customer.phonenumber ||
      order.phone ||
      ''
    ).trim();

    if (!email || !email.includes('@')) {
      return res.status(400).json({
        error: 'Email client obligatoire'
      });
    }

    /*
     * IMPORTANT :
     * Pour le mode Test, le montant vient ici de la
     * commande envoyée par Mercado.
     *
     * Avant le passage en production, il faudra
     * recalculer ce montant côté serveur à partir
     * des produits réellement disponibles.
     */
    let amount = normalizeAmount(order.total);

    if (!amount) {
      return res.status(400).json({
        error: 'Montant invalide'
      });
    }

    const currency =
      String(
        process.env.FLUTTERWAVE_CURRENCY || 'XAF'
      ).toUpperCase();

    /*
     * XAF est une devise sans décimales pour notre
     * utilisation ici.
     */
    const zeroDecimalCurrencies = [
      'XAF',
      'XOF',
      'NGN',
      'GHS',
      'KES',
      'UGX',
      'TZS',
      'RWF',
      'MWK',
      'ZMW'
    ];

    if (
      zeroDecimalCurrencies.includes(currency)
    ) {
      amount = Math.round(amount);
    }

    const orderId =
      order.orderId ||
      generateOrderId();

    const redirectUrl =
      getBaseUrl(req);

    const payload = {
      tx_ref: orderId,

      amount,

      currency,

      redirect_url: redirectUrl,

      customer: {
        email,
        name,
        phonenumber: phone
      },

      customizations: {
        title: 'MERCADO',
        description:
          `Paiement de la commande ${orderId}`
      },

      configuration: {
        session_duration: 30,
        max_retry_attempt: 5
      },

      meta: {
        mercado_order_id: orderId,

        address:
          order.address ||
          order.customer?.address ||
          '',

        city:
          order.city ||
          order.customer?.city ||
          '',

        zip:
          order.zip ||
          order.customer?.zip ||
          '',

        country:
          order.country ||
          order.customer?.country ||
          'CM'
      }
    };

    console.log(
      'Création paiement Flutterwave:',
      {
        orderId,
        amount,
        currency,
        email
      }
    );

    const response = await fetch(
      'https://api.flutterwave.com/v3/payments',
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${secretKey}`
        },

        body: JSON.stringify(payload)
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error(
        'Flutterwave HTTP error:',
        response.status,
        data
      );

      return res.status(502).json({
        error:
          data?.message ||
          'Flutterwave a refusé la demande'
      });
    }

    if (
      data?.status !== 'success' ||
      !data?.data?.link
    ) {
      console.error(
        'Réponse Flutterwave invalide:',
        data
      );

      return res.status(502).json({
        error:
          data?.message ||
          'Flutterwave n’a pas fourni de lien de paiement'
      });
    }

    /*
     * On sauvegarde également la référence avant
     * de rediriger le client.
     */
    const orders = readJson(
      ORDERS_FILE,
      []
    );

    const index = orders.findIndex(
      item =>
        String(item.orderId) ===
        String(orderId)
    );

    if (index >= 0) {
      orders[index] = {
        ...orders[index],
        flutterwave: {
          tx_ref: orderId,
          amount,
          currency,
          paymentUrl: data.data.link,
          status: 'created'
        }
      };

      writeJson(
        ORDERS_FILE,
        orders
      );
    }

    return res.json({
      ok: true,
      payment_url: data.data.link,
      orderId,
      amount,
      currency
    });

  } catch (error) {
    console.error(
      'flutterwave:',
      error
    );

    return res.status(500).json({
      error:
        error.message ||
        'Erreur serveur Flutterwave'
    });
  }
});

/* =========================================================
   FLUTTERWAVE WEBHOOK
========================================================= */

app.post(
  '/api/payment/flutterwave/webhook',
  (req, res) => {

    try {
      const signature =
        req.headers['verif-hash'];

      const secretHash =
        process.env.FLW_SECRET_HASH;

      if (
        !secretHash ||
        !signature ||
        signature !== secretHash
      ) {
        return res.sendStatus(401);
      }

      const data = req.body || {};

      const txRef =
        data?.data?.tx_ref;

      const transactionId =
        data?.data?.id;

      console.log(
        'Flutterwave webhook reçu:',
        {
          txRef,
          transactionId
        }
      );

      if (txRef) {
        const orders =
          readJson(
            ORDERS_FILE,
            []
          );

        const index =
          orders.findIndex(
            order =>
              String(order.orderId) ===
              String(txRef)
          );

        if (index >= 0) {
          orders[index] = {
            ...orders[index],

            flutterwave: {
              ...(orders[index].flutterwave || {}),

              transactionId,
              tx_ref: txRef,

              webhookReceivedAt:
                new Date().toISOString(),

              status:
                data?.data?.status ||
                'completed'
            }
          };

          writeJson(
            ORDERS_FILE,
            orders
          );
        }
      }

      return res.sendStatus(200);

    } catch (error) {
      console.error(
        'Webhook Flutterwave:',
        error
      );

      return res.sendStatus(500);
    }
  }
);

/* =========================================================
   REVIEWS
========================================================= */

app.get('/api/reviews', (req, res) => {
  const reviews =
    readJson(
      REVIEWS_FILE,
      []
    );

  res.json({
    ok: true,
    reviews
  });
});

app.post('/api/reviews', (req, res) => {
  try {
    const review = req.body || {};

    const reviews =
      readJson(
        REVIEWS_FILE,
        []
      );

    reviews.push({
      ...review,

      id:
        review.id ||
        crypto.randomUUID(),

      createdAt:
        new Date().toISOString()
    });

    writeJson(
      REVIEWS_FILE,
      reviews
    );

    res.json({
      ok: true
    });

  } catch (error) {
    console.error(
      '/api/reviews:',
      error
    );

    res.status(500).json({
      error: 'Erreur avis'
    });
  }
});

/* =========================================================
   VIEWS
========================================================= */

app.post('/api/views', (req, res) => {
  try {
    const productId =
      String(
        req.body.productId || ''
      ).trim();

    if (!productId) {
      return res.status(400).json({
        error: 'productId obligatoire'
      });
    }

    const views =
      readJson(
        VIEWS_FILE,
        {}
      );

    views[productId] =
      Number(views[productId] || 0) + 1;

    writeJson(
      VIEWS_FILE,
      views
    );

    res.json({
      ok: true,
      views: views[productId]
    });

  } catch (error) {
    console.error(
      '/api/views:',
      error
    );

    res.status(500).json({
      error: 'Erreur vues'
    });
  }
});

app.get('/api/views/:productId', (req, res) => {
  const views =
    readJson(
      VIEWS_FILE,
      {}
    );

  const productId =
    String(req.params.productId);

  res.json({
    ok: true,
    views:
      Number(
        views[productId] || 0
      )
  });
});

/* =========================================================
   STATIC MERCADO
========================================================= */

app.use(
  express.static(
    PUBLIC_DIR
  )
);

/*
 * Toutes les routes non API retournent
 * index.html pour le frontend Mercado.
 */
app.get('*', (req, res, next) => {
  if (
    req.path.startsWith('/api/')
  ) {
    return next();
  }

  res.sendFile(
    path.join(
      PUBLIC_DIR,
      'index.html'
    )
  );
});

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (error, req, res, next) => {
    console.error(
      'Erreur serveur:',
      error
    );

    res.status(500).json({
      error:
        'Erreur interne du serveur'
    });
  }
);

/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log('');
    console.log('=================================');
    console.log('       MERCADO SERVER');
    console.log('=================================');
    console.log(`Port: ${PORT}`);
    console.log(
      `Flutterwave: ${
        process.env.FLUTTERWAVE_SECRET_KEY
          ? 'CONFIGURÉ'
          : 'NON CONFIGURÉ'
      }`
    );
    console.log(
      `Currency: ${
        process.env.FLUTTERWAVE_CURRENCY ||
        'XAF'
      }`
    );
    console.log('=================================');
    console.log('');
  }
);
