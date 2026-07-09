const express = require("express");

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Piano Stripe Webhook funcionando");
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`Servidor iniciado en el puerto ${PORT}`);
});
