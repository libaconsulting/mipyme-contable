require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const sequelize = require('./config/database');
require('./core/models'); // registra todos los modelos antes de sync()
const routes = require('./routes');
const webhooksFacturacion = require('./integrations/webhooks/proveedorTecnologicoWebhook');

const app = express();

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
  })
);
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api', routes);
app.use('/webhooks', webhooksFacturacion);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;

async function iniciar() {
  try {
    await sequelize.authenticate();
    console.log('Conexión a la base de datos establecida.');

    // En desarrollo, sincroniza el esquema. En producción usar migraciones
    // (npm run migrate) en vez de sync({ alter: true }).
    if (process.env.NODE_ENV === 'development') {
      await sequelize.sync({ alter: true });
    }

    app.listen(PORT, () => {
      console.log(`Servidor corriendo en el puerto ${PORT}`);
    });
  } catch (error) {
    console.error('No se pudo iniciar el servidor:', error);
    process.exit(1);
  }
}

iniciar();

module.exports = app;
