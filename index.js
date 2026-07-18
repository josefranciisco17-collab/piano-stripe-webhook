require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const admin = require("firebase-admin");

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  GOOGLE_APPLICATION_CREDENTIALS,
  FRONTEND_URL = "https://josefranciisco17-collab.github.io/JuniorGame",
  PORT = 3000
} = process.env;

if (!STRIPE_SECRET_KEY) {
  throw new Error("Falta STRIPE_SECRET_KEY.");
}

if (!STRIPE_WEBHOOK_SECRET) {
  throw new Error("Falta STRIPE_WEBHOOK_SECRET.");
}

if (!GOOGLE_APPLICATION_CREDENTIALS) {
  throw new Error("Falta GOOGLE_APPLICATION_CREDENTIALS.");
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault()
  });
}

const db = admin.firestore();
const stripe = new Stripe(STRIPE_SECRET_KEY);
const app = express();

const PACKAGES = Object.freeze({
  40: 2900,
  120: 8000,
  250: 14900,
  500: 27900,
  1000: 49900,
  2500: 99900
});

const allowedOrigins = new Set([
  FRONTEND_URL,
  `${FRONTEND_URL}/`,
  "http://localhost:5500",
  "http://127.0.0.1:5500"
]);

/*
 * IMPORTANTE:
 * El webhook debe recibir el cuerpo sin convertir a JSON para que Stripe
 * pueda verificar la firma.
 */
app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      console.error("Firma de webhook inválida:", error.message);
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    try {
      if (event.type === "checkout.session.completed") {
        await creditDiamonds(event);
      }

      return res.json({ received: true });
    } catch (error) {
      console.error("Error procesando webhook:", error);
      return res.status(500).json({
        error: "No se pudo procesar el pago."
      });
    }
  }
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Origen no permitido por CORS."));
    }
  })
);

app.use(express.json({ limit: "50kb" }));

app.post("/create-checkout-session", async (req, res) => {
  try {
    const uid =
      typeof req.body.uid === "string"
        ? req.body.uid.trim()
        : "";

    const diamonds = Number(req.body.diamonds);
    const productId =
      typeof req.body.productId === "string"
        ? req.body.productId.trim()
        : `diamonds-${diamonds}`;

    if (!uid) {
      return res.status(400).json({
        error: "Falta el UID del jugador."
      });
    }

    if (!Number.isInteger(diamonds) || !PACKAGES[diamonds]) {
      return res.status(400).json({
        error: "El paquete de diamantes no es válido."
      });
    }

    const userRef = db.collection("users").doc(uid);
    const userSnapshot = await userRef.get();

    if (!userSnapshot.exists) {
      return res.status(404).json({
        error: "No se encontró el perfil del jugador."
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      client_reference_id: uid,
      metadata: {
        uid,
        diamonds: String(diamonds),
        productId
      },
      payment_intent_data: {
        metadata: {
          uid,
          diamonds: String(diamonds),
          productId
        }
      },
      line_items: [
        {
          price_data: {
            currency: "mxn",
            product_data: {
              name: `${diamonds} diamantes`,
              description: "Diamantes premium para JuniorGame"
            },
            unit_amount: PACKAGES[diamonds]
          },
          quantity: 1
        }
      ],
      success_url:
        `${FRONTEND_URL}/shop.html?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:
        `${FRONTEND_URL}/shop.html?cancel=1`
    });

    return res.json({ url: session.url });
  } catch (error) {
    console.error("Error creando Checkout:", error);
    return res.status(500).json({
      error: "No se pudo iniciar el pago."
    });
  }
});

app.get("/", (_req, res) => {
  res.send("Servidor Stripe + Firestore de JuniorGame funcionando.");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

async function creditDiamonds(event) {
  const session = event.data.object;

  if (session.payment_status !== "paid") {
    console.log(
      `Sesión ${session.id} ignorada: payment_status=${session.payment_status}`
    );
    return;
  }

  const uid =
    session.metadata?.uid ||
    session.client_reference_id;

  const diamonds = Number(session.metadata?.diamonds);
  const productId =
    session.metadata?.productId ||
    `diamonds-${diamonds}`;

  if (!uid) {
    throw new Error("El pago no contiene UID.");
  }

  if (!Number.isInteger(diamonds) || !PACKAGES[diamonds]) {
    throw new Error("El pago contiene un paquete inválido.");
  }

  const eventRef =
    db.collection("stripeEvents").doc(event.id);

  const userRef =
    db.collection("users").doc(uid);

  const purchaseRef =
    userRef.collection("purchaseHistory").doc(session.id);

  await db.runTransaction(async (transaction) => {
    const [eventSnapshot, userSnapshot] = await Promise.all([
      transaction.get(eventRef),
      transaction.get(userRef)
    ]);

    if (eventSnapshot.exists) {
      console.log(`Evento ${event.id} ya procesado.`);
      return;
    }

    if (!userSnapshot.exists) {
      throw new Error(`No existe users/${uid}.`);
    }

    transaction.update(userRef, {
      diamantes: admin.firestore.FieldValue.increment(diamonds),
      ultimaCompraAt:
        admin.firestore.FieldValue.serverTimestamp()
    });

    transaction.set(purchaseRef, {
      stripeEventId: event.id,
      stripeSessionId: session.id,
      paymentIntentId: session.payment_intent || null,
      productId,
      tipo: "diamantes",
      cantidad: diamonds,
      montoTotal: session.amount_total,
      moneda: session.currency || "mxn",
      estado: "pagado",
      creadoAt:
        admin.firestore.FieldValue.serverTimestamp()
    });

    transaction.set(eventRef, {
      type: event.type,
      stripeSessionId: session.id,
      uid,
      diamonds,
      processedAt:
        admin.firestore.FieldValue.serverTimestamp()
    });
  });

  console.log(
    `${diamonds} diamantes acreditados a users/${uid}.`
  );
}

app.use((error, _req, res, _next) => {
  console.error("Error no controlado:", error);

  res.status(500).json({
    error: "Ocurrió un error interno."
  });
});

app.listen(PORT, () => {
  console.log(`Servidor iniciado en puerto ${PORT}.`);
});
