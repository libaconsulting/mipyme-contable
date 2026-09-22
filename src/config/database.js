// Conexión a MySQL/MariaDB (Hostinger Business - hPanel > Bases de datos MySQL)
// Nota técnica: usamos MySQL en vez de PostgreSQL porque es el motor nativo
// del plan Business de Hostinger. Los UUID se guardan como CHAR(36); los
// valores monetarios como DECIMAL(15,2), sin pérdida de precisión.

require('dotenv').config();
const { Sequelize } = require('sequelize');

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    dialect: 'mysql',
    logging: process.env.NODE_ENV === 'development' ? console.log : false,
    define: {
      // Todas las tablas versionan created_at / updated_at automáticamente
      timestamps: true,
      underscored: true,
    },
  }
);

module.exports = sequelize;
