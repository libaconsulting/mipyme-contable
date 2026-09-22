// Conexión a PostgreSQL, provisto por Supabase a través de la integración
// de Hostinger. Nota técnica: el modelo de datos no cambia en nada frente
// a MySQL — UUID y DECIMAL son tipos nativos en ambos motores. Solo cambia
// el dialecto de conexión, aquí y en package.json (pg en vez de mysql2).

require('dotenv').config();
const { Sequelize } = require('sequelize');

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    dialect: 'postgres',
    dialectOptions: {
      ssl: { require: true, rejectUnauthorized: false }, // Supabase exige SSL
    },
    logging: process.env.NODE_ENV === 'development' ? console.log : false,
    define: {
      timestamps: true,
      underscored: true,
    },
  }
);

module.exports = sequelize;
