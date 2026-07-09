const express = require("express");
const Stripe = require("stripe");
const admin = require("firebase-admin");

const app = express();

admin.initializeApp({
  projectId: process.env.FIREBASE_PROJECT_ID
});

const db = admin.firestore();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_TEMP");

const PRICE_TO_COINS = {
  4000: 50,
  8000: 100,
  10000: 250,
  25000: 600,
  35000: 900,
  65000: 1500,
  120000: 3000,
  180000: 4500,
  300000: 8000,
  380000: 10000,
  550000: 15000,
  700000: 20000,
  1500000: 50000,
  2500000: 100000,
  5000000: 250000
};

app.post("/", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const sig = req.headers["stripe-signature"];
    const event = Stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const uid = session.client_reference_id;
      const amount = session.amount_total;

      if (!uid) {
        console.log("Pago sin UID");
        return res.sendStatus(200);
      }

      const coins = PRICE_TO_COINS[amount];

      if (!coins) {
        console.log("Monto no reconocido:", amount);
        return res.sendStatus(200);
      }

      await db.collection("users").doc(uid).set(
        {
          coins: admin.firestore.FieldValue.increment(coins)
        },
        { merge: true }
      );

      console.log(`Se agregaron ${coins} coins al usuario ${uid}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

app.get("/", (req, res) => {
  res.send("Stripe webhook activo");
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
