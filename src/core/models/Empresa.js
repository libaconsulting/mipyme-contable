const { DataTypes } = require('sequelize');
const sequelize = require('../../config/database');

// Raíz del modelo multi-tenant: toda entidad del sistema cuelga de empresa_id.
const Empresa = sequelize.define('Empresa', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  nit: { type: DataTypes.STRING(20), allowNull: false, unique: true },
  razonSocial: { type: DataTypes.STRING(150), allowNull: false },
  // 'especial' = Régimen Tributario Especial (ESAL, cooperativas,
  // fundaciones) — tiene tarifa de renta propia, distinta de ordinario y RST.
  regimenTributario: {
    type: DataTypes.ENUM('ordinario', 'rst', 'especial'),
    allowNull: false,
    defaultValue: 'ordinario',
  },
  responsableIva: { type: DataTypes.BOOLEAN, defaultValue: false },
  resolucionFacturacion: { type: DataTypes.STRING(50) },
  periodoFiscalActualId: { type: DataTypes.UUID },

  email: { type: DataTypes.STRING(150) },
  telefono: { type: DataTypes.STRING(30) },
  direccion: { type: DataTypes.STRING(255) },
  departamento: { type: DataTypes.STRING(100) },
  municipio: { type: DataTypes.STRING(100) },

  representanteLegalNombre: { type: DataTypes.STRING(150) },
  representanteLegalDocumento: { type: DataTypes.STRING(20) },

  // Código CIIU — de él depende la tarifa de ICA aplicable y el grupo
  // tarifario si la empresa está en RST. No se valida contra un
  // catálogo oficial todavía, es texto libre.
  actividadEconomicaCiiu: { type: DataTypes.STRING(10) },
  matriculaMercantil: { type: DataTypes.STRING(30) },

  // Se guarda como data URI (base64) directo en la base de datos, no
  // como archivo en disco — en el hosting de Node de Hostinger un
  // archivo subido podría perderse en un redeploy; así no depende de
  // eso. Para un logo (normalmente unos pocos KB) es una solución
  // simple y suficiente; si algún día se suben imágenes mucho más
  // pesadas, esto debería moverse a almacenamiento de archivos real.
  logoBase64: { type: DataTypes.TEXT },
}, {
  tableName: 'empresas',
});

module.exports = Empresa;
