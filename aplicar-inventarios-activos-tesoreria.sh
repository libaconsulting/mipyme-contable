#!/bin/bash
# Ejecutar DESDE DENTRO de la carpeta mipyme-contable.
set -e

if [ ! -f "package.json" ]; then
  echo "ERROR: no se encontró package.json en esta carpeta."
  echo "Ve primero a la carpeta mipyme-contable (cd mipyme-contable) y vuelve a correr este script."
  exit 1
fi

mkdir -p src/modules/inventarios/models src/modules/inventarios/services src/modules/inventarios/controllers src/modules/inventarios/routes
mkdir -p src/modules/activosFijos/models src/modules/activosFijos/services src/modules/activosFijos/controllers src/modules/activosFijos/routes
mkdir -p src/modules/tesoreria/models src/modules/tesoreria/services src/modules/tesoreria/controllers src/modules/tesoreria/routes

cat > src/modules/inventarios/models/Producto.js << 'SCRIPTEOF'
const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

const Producto = sequelize.define('Producto', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  nombre: { type: DataTypes.STRING(150), allowNull: false },
  tipo: {
    type: DataTypes.ENUM('bien', 'servicio'),
    allowNull: false,
    defaultValue: 'bien',
  },
  unidadMedida: { type: DataTypes.STRING(20), defaultValue: 'unidad' },
  costoPromedio: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  cantidadDisponible: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
}, {
  tableName: 'productos',
});

module.exports = Producto;
SCRIPTEOF
echo "OK  src/modules/inventarios/models/Producto.js"

cat > src/modules/inventarios/models/MovimientoInventario.js << 'SCRIPTEOF'
const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Kardex simplificado: cada entrada, salida o ajuste queda registrado
// aquí, y el saldo/costo promedio vive en Producto.
const MovimientoInventario = sequelize.define('MovimientoInventario', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  productoId: { type: DataTypes.UUID, allowNull: false },
  tipo: {
    type: DataTypes.ENUM('entrada', 'salida', 'ajuste'),
    allowNull: false,
  },
  cantidad: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  costoUnitario: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  fecha: { type: DataTypes.DATEONLY, allowNull: false },
  documentoOrigen: { type: DataTypes.STRING(100) },
  observacion: { type: DataTypes.TEXT },
}, {
  tableName: 'movimientos_inventario',
});

module.exports = MovimientoInventario;
SCRIPTEOF
echo "OK  src/modules/inventarios/models/MovimientoInventario.js"

cat > src/modules/inventarios/services/inventarios.service.js << 'SCRIPTEOF'
const { v4: uuidv4 } = require('uuid');
const Producto = require('../models/Producto');
const MovimientoInventario = require('../models/MovimientoInventario');
const { contabilizarEvento } = require('../../../core/services/motorAsientos');

async function crearProducto(datos, usuario) {
  return Producto.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    nombre: datos.nombre,
    tipo: datos.tipo || 'bien',
    unidadMedida: datos.unidadMedida || 'unidad',
    costoPromedio: 0,
    cantidadDisponible: 0,
  });
}

async function listarProductos(usuario) {
  return Producto.findAll({ where: { empresaId: usuario.empresaId }, order: [['nombre', 'ASC']] });
}

async function listarMovimientos(usuario) {
  return MovimientoInventario.findAll({
    where: { empresaId: usuario.empresaId },
    order: [['fecha', 'DESC']],
  });
}

// Entrada por compra. NO dispara un evento contable propio — la compra
// (factura_compra_con_orden / sin_orden) ya debita 1435 Inventarios
// directamente. Esto solo actualiza el saldo físico y recalcula el
// costo promedio ponderado.
async function registrarEntrada(datos, usuario) {
  const producto = await Producto.findByPk(datos.productoId);
  const cantidad = Number(datos.cantidad);
  const costoUnitario = Number(datos.costoUnitario);

  const cantidadAnterior = Number(producto.cantidadDisponible);
  const costoAnterior = Number(producto.costoPromedio);
  const nuevaCantidad = cantidadAnterior + cantidad;
  const nuevoCostoPromedio =
    nuevaCantidad === 0
      ? 0
      : (cantidadAnterior * costoAnterior + cantidad * costoUnitario) / nuevaCantidad;

  await producto.update({ cantidadDisponible: nuevaCantidad, costoPromedio: nuevoCostoPromedio });

  return MovimientoInventario.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    productoId: producto.id,
    tipo: 'entrada',
    cantidad,
    costoUnitario,
    fecha: datos.fecha || new Date(),
    documentoOrigen: datos.documentoOrigen,
  });
}

// Salida por venta: SÍ dispara el costo de ventas (nivel automático),
// valorado al costo promedio vigente del producto en este momento.
async function registrarSalida(datos, usuario) {
  const producto = await Producto.findByPk(datos.productoId);
  const cantidad = Number(datos.cantidad);

  if (Number(producto.cantidadDisponible) < cantidad) {
    throw new Error(`No hay suficiente inventario de "${producto.nombre}" para esta salida.`);
  }

  const costoUnitario = Number(producto.costoPromedio);
  const valorSalida = cantidad * costoUnitario;

  await producto.update({ cantidadDisponible: Number(producto.cantidadDisponible) - cantidad });

  const movimiento = await MovimientoInventario.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    productoId: producto.id,
    tipo: 'salida',
    cantidad,
    costoUnitario,
    fecha: datos.fecha || new Date(),
    documentoOrigen: datos.documentoOrigen,
  });

  await contabilizarEvento({
    empresaId: usuario.empresaId,
    tipoEvento: 'salida_inventario_venta',
    origenModulo: 'inventarios',
    origenId: movimiento.id,
    valor: valorSalida,
  });

  return movimiento;
}

// Ajuste por faltante en toma física: nivel manual (3) — nunca se
// contabiliza solo, reconoce una pérdida y exige autorización expresa.
async function registrarAjuste(datos, usuario) {
  const producto = await Producto.findByPk(datos.productoId);
  const cantidad = Number(datos.cantidad);
  const costoUnitario = Number(producto.costoPromedio);
  const valorAjuste = cantidad * costoUnitario;

  await producto.update({ cantidadDisponible: Number(producto.cantidadDisponible) - cantidad });

  const movimiento = await MovimientoInventario.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    productoId: producto.id,
    tipo: 'ajuste',
    cantidad,
    costoUnitario,
    fecha: datos.fecha || new Date(),
    observacion: datos.observacion,
  });

  const resultado = await contabilizarEvento({
    empresaId: usuario.empresaId,
    tipoEvento: 'ajuste_inventario',
    origenModulo: 'inventarios',
    origenId: movimiento.id,
    valor: valorAjuste,
  });

  return { movimiento, contabilizacion: resultado };
}

module.exports = {
  crearProducto,
  listarProductos,
  listarMovimientos,
  registrarEntrada,
  registrarSalida,
  registrarAjuste,
};
SCRIPTEOF
echo "OK  src/modules/inventarios/services/inventarios.service.js"

cat > src/modules/inventarios/controllers/inventarios.controller.js << 'SCRIPTEOF'
const inventariosService = require('../services/inventarios.service');

async function crearProducto(req, res) {
  try {
    res.status(201).json(await inventariosService.crearProducto(req.body, req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function listarProductos(req, res) {
  try {
    res.json(await inventariosService.listarProductos(req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function listarMovimientos(req, res) {
  try {
    res.json(await inventariosService.listarMovimientos(req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function registrarEntrada(req, res) {
  try {
    res.status(201).json(await inventariosService.registrarEntrada(req.body, req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function registrarSalida(req, res) {
  try {
    res.status(201).json(await inventariosService.registrarSalida(req.body, req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function registrarAjuste(req, res) {
  try {
    res.status(201).json(await inventariosService.registrarAjuste(req.body, req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

module.exports = {
  crearProducto,
  listarProductos,
  listarMovimientos,
  registrarEntrada,
  registrarSalida,
  registrarAjuste,
};
SCRIPTEOF
echo "OK  src/modules/inventarios/controllers/inventarios.controller.js"

cat > src/modules/inventarios/routes/inventarios.routes.js << 'SCRIPTEOF'
const express = require('express');
const router = express.Router();
const c = require('../controllers/inventarios.controller');

router.get('/productos', c.listarProductos);
router.post('/productos', c.crearProducto);
router.get('/movimientos', c.listarMovimientos);
router.post('/entradas', c.registrarEntrada);
router.post('/salidas', c.registrarSalida);
router.post('/ajustes', c.registrarAjuste);

module.exports = router;
SCRIPTEOF
echo "OK  src/modules/inventarios/routes/inventarios.routes.js"

cat > src/modules/activosFijos/models/ActivoFijo.js << 'SCRIPTEOF'
const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

const ActivoFijo = sequelize.define('ActivoFijo', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  terceroId: { type: DataTypes.UUID }, // proveedor, opcional
  nombre: { type: DataTypes.STRING(150), allowNull: false },
  fechaAdquisicion: { type: DataTypes.DATEONLY, allowNull: false },
  costo: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  vidaUtilMeses: { type: DataTypes.INTEGER, allowNull: false },
  metodoDepreciacion: {
    type: DataTypes.ENUM('linea_recta'),
    allowNull: false,
    defaultValue: 'linea_recta',
  },
  valorDepreciadoAcumulado: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  estado: {
    type: DataTypes.ENUM('activo', 'dado_de_baja'),
    allowNull: false,
    defaultValue: 'activo',
  },
}, {
  tableName: 'activos_fijos',
});

module.exports = ActivoFijo;
SCRIPTEOF
echo "OK  src/modules/activosFijos/models/ActivoFijo.js"

cat > src/modules/activosFijos/services/activosFijos.service.js << 'SCRIPTEOF'
const { v4: uuidv4 } = require('uuid');
const ActivoFijo = require('../models/ActivoFijo');
const { contabilizarEvento } = require('../../../core/services/motorAsientos');

// Registrar el activo exige confirmar si se capitaliza o se gasta
// directo (nivel asistido — ver tabla de reglas de activos fijos).
async function registrarActivo(datos, usuario) {
  const activo = await ActivoFijo.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    terceroId: datos.terceroId,
    nombre: datos.nombre,
    fechaAdquisicion: datos.fechaAdquisicion || new Date(),
    costo: datos.costo,
    vidaUtilMeses: datos.vidaUtilMeses,
    valorDepreciadoAcumulado: 0,
  });

  await contabilizarEvento({
    empresaId: usuario.empresaId,
    tipoEvento: 'compra_activo_fijo',
    origenModulo: 'activosFijos',
    origenId: activo.id,
    valor: activo.costo,
    terceroId: activo.terceroId,
  });

  return activo;
}

async function listarActivos(usuario) {
  return ActivoFijo.findAll({ where: { empresaId: usuario.empresaId }, order: [['fechaAdquisicion', 'DESC']] });
}

// Llamada por src/jobs/depreciacionMensual.js (cron de hPanel) — nivel
// automático, se calcula sola cada mes sin intervención del contador.
// Línea recta: cuota = costo / vida_util_meses, hasta no superar el costo.
async function calcularDepreciacionMensual(empresaId) {
  const activos = await ActivoFijo.findAll({ where: { empresaId, estado: 'activo' } });
  const resultados = [];

  for (const activo of activos) {
    const cuota = Number(activo.costo) / activo.vidaUtilMeses;
    const acumuladoActual = Number(activo.valorDepreciadoAcumulado);
    const costo = Number(activo.costo);

    if (acumuladoActual >= costo) continue; // ya totalmente depreciado

    const cuotaAplicada = Math.min(cuota, costo - acumuladoActual);

    await activo.update({ valorDepreciadoAcumulado: acumuladoActual + cuotaAplicada });

    await contabilizarEvento({
      empresaId,
      tipoEvento: 'depreciacion_mensual',
      origenModulo: 'activosFijos',
      origenId: activo.id,
      valor: cuotaAplicada,
    });

    resultados.push({ activoId: activo.id, cuotaAplicada });
  }

  return resultados;
}

// Baja de activo: nivel manual (3) — poco frecuente, alto impacto,
// siempre requiere autorización. No contabiliza sola.
async function darDeBaja(id, usuario) {
  const activo = await ActivoFijo.findByPk(id);
  await activo.update({ estado: 'dado_de_baja' });

  const resultado = await contabilizarEvento({
    empresaId: usuario.empresaId,
    tipoEvento: 'baja_activo_fijo',
    origenModulo: 'activosFijos',
    origenId: activo.id,
    valor: Number(activo.costo) - Number(activo.valorDepreciadoAcumulado),
  });

  return { activo, contabilizacion: resultado };
}

module.exports = { registrarActivo, listarActivos, calcularDepreciacionMensual, darDeBaja };
SCRIPTEOF
echo "OK  src/modules/activosFijos/services/activosFijos.service.js"

cat > src/modules/activosFijos/controllers/activosFijos.controller.js << 'SCRIPTEOF'
const activosFijosService = require('../services/activosFijos.service');

async function registrarActivo(req, res) {
  try {
    res.status(201).json(await activosFijosService.registrarActivo(req.body, req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function listarActivos(req, res) {
  try {
    res.json(await activosFijosService.listarActivos(req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

// Endpoint manual, además del cron job, útil para pruebas.
async function depreciar(req, res) {
  try {
    res.json(await activosFijosService.calcularDepreciacionMensual(req.usuario.empresaId));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function darDeBaja(req, res) {
  try {
    res.json(await activosFijosService.darDeBaja(req.params.id, req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

module.exports = { registrarActivo, listarActivos, depreciar, darDeBaja };
SCRIPTEOF
echo "OK  src/modules/activosFijos/controllers/activosFijos.controller.js"

cat > src/modules/activosFijos/routes/activosFijos.routes.js << 'SCRIPTEOF'
const express = require('express');
const router = express.Router();
const c = require('../controllers/activosFijos.controller');

router.get('/', c.listarActivos);
router.post('/', c.registrarActivo);
router.post('/depreciar', c.depreciar);
router.post('/:id/baja', c.darDeBaja);

module.exports = router;
SCRIPTEOF
echo "OK  src/modules/activosFijos/routes/activosFijos.routes.js"

cat > src/modules/tesoreria/models/CuentaBancaria.js << 'SCRIPTEOF'
const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

const CuentaBancaria = sequelize.define('CuentaBancaria', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  banco: { type: DataTypes.STRING(100), allowNull: false },
  numero: { type: DataTypes.STRING(50), allowNull: false },
  saldoContable: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
}, {
  tableName: 'cuentas_bancarias',
});

module.exports = CuentaBancaria;
SCRIPTEOF
echo "OK  src/modules/tesoreria/models/CuentaBancaria.js"

cat > src/modules/tesoreria/models/MovimientoBancario.js << 'SCRIPTEOF'
const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// NOTA: todas las cuentas bancarias de la empresa se contabilizan hoy
// contra el mismo código de PUC (1110 Bancos) — mapear cada
// CuentaBancaria a su propia subcuenta contable queda como mejora
// pendiente para cuando haya más de una cuenta real en uso.
const MovimientoBancario = sequelize.define('MovimientoBancario', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  cuentaBancariaId: { type: DataTypes.UUID, allowNull: false },
  fecha: { type: DataTypes.DATEONLY, allowNull: false },
  valor: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  tipo: {
    type: DataTypes.ENUM('ingreso', 'egreso', 'comision'),
    allowNull: false,
  },
  descripcion: { type: DataTypes.STRING(255) },
  conciliado: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
}, {
  tableName: 'movimientos_bancarios',
});

module.exports = MovimientoBancario;
SCRIPTEOF
echo "OK  src/modules/tesoreria/models/MovimientoBancario.js"

cat > src/modules/tesoreria/services/tesoreria.service.js << 'SCRIPTEOF'
const { v4: uuidv4 } = require('uuid');
const CuentaBancaria = require('../models/CuentaBancaria');
const MovimientoBancario = require('../models/MovimientoBancario');
const { contabilizarEvento } = require('../../../core/services/motorAsientos');

async function crearCuenta(datos, usuario) {
  return CuentaBancaria.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    banco: datos.banco,
    numero: datos.numero,
    saldoContable: 0,
  });
}

async function listarCuentas(usuario) {
  return CuentaBancaria.findAll({ where: { empresaId: usuario.empresaId } });
}

// Registrar un movimiento NO lo contabiliza — queda pendiente de
// conciliar, igual que en la máquina de estados del cierre mensual
// (un movimiento sin conciliar bloquea el cierre, ver cierrePeriodo.js).
async function registrarMovimiento(datos, usuario) {
  return MovimientoBancario.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    cuentaBancariaId: datos.cuentaBancariaId,
    fecha: datos.fecha || new Date(),
    valor: datos.valor,
    tipo: datos.tipo,
    descripcion: datos.descripcion,
    conciliado: false,
  });
}

async function listarMovimientos(usuario) {
  return MovimientoBancario.findAll({
    where: { empresaId: usuario.empresaId },
    order: [['fecha', 'DESC']],
  });
}

// Conciliar: solo el tipo "comision" se contabiliza automáticamente
// (nivel 1). Ingresos y egresos ligados a pagos de facturas/nómina
// específicas todavía no cruzan contra esos documentos — por ahora
// solo quedan marcados como conciliados. Ver pendientes en el README.
async function conciliarMovimiento(id, usuario) {
  const movimiento = await MovimientoBancario.findByPk(id);

  if (movimiento.conciliado) {
    throw new Error('Este movimiento ya estaba conciliado.');
  }

  await movimiento.update({ conciliado: true });

  if (movimiento.tipo === 'comision') {
    await contabilizarEvento({
      empresaId: usuario.empresaId,
      tipoEvento: 'gasto_bancario',
      origenModulo: 'tesoreria',
      origenId: movimiento.id,
      valor: movimiento.valor,
    });
  }

  return movimiento;
}

module.exports = { crearCuenta, listarCuentas, registrarMovimiento, listarMovimientos, conciliarMovimiento };
SCRIPTEOF
echo "OK  src/modules/tesoreria/services/tesoreria.service.js"

cat > src/modules/tesoreria/controllers/tesoreria.controller.js << 'SCRIPTEOF'
const tesoreriaService = require('../services/tesoreria.service');

async function crearCuenta(req, res) {
  try {
    res.status(201).json(await tesoreriaService.crearCuenta(req.body, req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function listarCuentas(req, res) {
  try {
    res.json(await tesoreriaService.listarCuentas(req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function registrarMovimiento(req, res) {
  try {
    res.status(201).json(await tesoreriaService.registrarMovimiento(req.body, req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function listarMovimientos(req, res) {
  try {
    res.json(await tesoreriaService.listarMovimientos(req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function conciliarMovimiento(req, res) {
  try {
    res.json(await tesoreriaService.conciliarMovimiento(req.params.id, req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

module.exports = { crearCuenta, listarCuentas, registrarMovimiento, listarMovimientos, conciliarMovimiento };
SCRIPTEOF
echo "OK  src/modules/tesoreria/controllers/tesoreria.controller.js"

cat > src/modules/tesoreria/routes/tesoreria.routes.js << 'SCRIPTEOF'
const express = require('express');
const router = express.Router();
const c = require('../controllers/tesoreria.controller');

router.get('/cuentas', c.listarCuentas);
router.post('/cuentas', c.crearCuenta);
router.get('/movimientos', c.listarMovimientos);
router.post('/movimientos', c.registrarMovimiento);
router.post('/movimientos/:id/conciliar', c.conciliarMovimiento);

module.exports = router;
SCRIPTEOF
echo "OK  src/modules/tesoreria/routes/tesoreria.routes.js"

cat > src/core/models/index.js << 'SCRIPTEOF'
// Punto único donde se registran TODOS los modelos del núcleo contable.
// server.js importa este archivo antes de sincronizar la base de datos,
// así que ningún modelo se queda afuera por no estar "require"ado en
// alguna cadena de rutas activa. A medida que agreguemos modelos a los
// módulos operativos (compras, nómina, etc.), se suman aquí también.

const Empresa = require('./Empresa');
const Tercero = require('./Tercero');
const PlanCuentas = require('./PlanCuentas');
const Asiento = require('./Asiento');
const Movimiento = require('./Movimiento');
const PeriodoContable = require('./PeriodoContable');
const ReglaContabilizacion = require('./ReglaContabilizacion');
const ParametroTributario = require('./ParametroTributario');
const Usuario = require('./Usuario');
const LogAuditoria = require('./LogAuditoria');

// Modelos de módulos operativos ya construidos
const FacturaVenta = require('../../modules/ventas/models/FacturaVenta');
const Cotizacion = require('../../modules/ventas/models/Cotizacion');
const OrdenCompra = require('../../modules/compras/models/OrdenCompra');
const FacturaCompra = require('../../modules/compras/models/FacturaCompra');
const DocumentoSoporteAdquisicion = require('../../modules/compras/models/DocumentoSoporteAdquisicion');
const PeriodoNomina = require('../../modules/nomina/models/PeriodoNomina');
const NominaEmpleado = require('../../modules/nomina/models/NominaEmpleado');
const NovedadNomina = require('../../modules/nomina/models/NovedadNomina');
const Producto = require('../../modules/inventarios/models/Producto');
const MovimientoInventario = require('../../modules/inventarios/models/MovimientoInventario');
const ActivoFijo = require('../../modules/activosFijos/models/ActivoFijo');
const CuentaBancaria = require('../../modules/tesoreria/models/CuentaBancaria');
const MovimientoBancario = require('../../modules/tesoreria/models/MovimientoBancario');

module.exports = {
  Empresa,
  Tercero,
  PlanCuentas,
  Asiento,
  Movimiento,
  PeriodoContable,
  ReglaContabilizacion,
  ParametroTributario,
  Usuario,
  LogAuditoria,
  FacturaVenta,
  Cotizacion,
  OrdenCompra,
  FacturaCompra,
  DocumentoSoporteAdquisicion,
  PeriodoNomina,
  NominaEmpleado,
  NovedadNomina,
  Producto,
  MovimientoInventario,
  ActivoFijo,
  CuentaBancaria,
  MovimientoBancario,
};
SCRIPTEOF
echo "OK  src/core/models/index.js"

cat > src/routes/index.js << 'SCRIPTEOF'
const express = require('express');
const router = express.Router();

const authRoutes = require('./auth.routes');
const seedRoutes = require('./seed.routes');
const tercerosRoutes = require('./terceros.routes');
const ventasRoutes = require('../modules/ventas/routes/ventas.routes');
const comprasRoutes = require('../modules/compras/routes/compras.routes');
const nominaRoutes = require('../modules/nomina/routes/nomina.routes');
const inventariosRoutes = require('../modules/inventarios/routes/inventarios.routes');
const activosFijosRoutes = require('../modules/activosFijos/routes/activosFijos.routes');
const tesoreriaRoutes = require('../modules/tesoreria/routes/tesoreria.routes');
const { authenticate } = require('../middleware/auth');

router.use('/auth', authRoutes); // público: login y registro
router.use('/seed', seedRoutes); // el propio router exige authenticate + authorize

router.use('/terceros', authenticate, tercerosRoutes); // requiere sesión
router.use('/ventas', authenticate, ventasRoutes); // requiere sesión
router.use('/compras', authenticate, comprasRoutes); // requiere sesión
router.use('/nomina', authenticate, nominaRoutes); // requiere sesión
router.use('/inventarios', authenticate, inventariosRoutes); // requiere sesión
router.use('/activos-fijos', authenticate, activosFijosRoutes); // requiere sesión
router.use('/tesoreria', authenticate, tesoreriaRoutes); // requiere sesión

module.exports = router;
SCRIPTEOF
echo "OK  src/routes/index.js"

cat > src/core/services/seedService.js << 'SCRIPTEOF'
const { v4: uuidv4 } = require('uuid');
const Empresa = require('../models/Empresa');
const PeriodoContable = require('../models/PeriodoContable');
const PlanCuentas = require('../models/PlanCuentas');
const ReglaContabilizacion = require('../models/ReglaContabilizacion');

// Mismo id que ya usamos para crear el usuario de prueba — mantiene
// todo conectado sin tener que recrear nada de lo ya probado.
const EMPRESA_SEED_ID = '11111111-1111-1111-1111-111111111111';

// Catálogo mínimo de cuentas. Usa códigos de referencia del PUC
// (Decreto 2650) porque es lo que la mayoría del mercado colombiano
// reconoce, aunque el marco de Grupo 3 no exige este PUC específico.
const CUENTAS = [
  { codigo: '1105', nombre: 'Caja', naturaleza: 'debito', elementoNiif: 'activo' },
  { codigo: '1110', nombre: 'Bancos', naturaleza: 'debito', elementoNiif: 'activo' },
  { codigo: '1305', nombre: 'Clientes', naturaleza: 'debito', elementoNiif: 'activo' },
  { codigo: '1355', nombre: 'IVA descontable', naturaleza: 'debito', elementoNiif: 'activo' },
  { codigo: '1399', nombre: 'Deterioro acumulado de clientes', naturaleza: 'credito', elementoNiif: 'activo' },
  { codigo: '1435', nombre: 'Inventarios', naturaleza: 'debito', elementoNiif: 'activo' },
  { codigo: '1524', nombre: 'Equipo de oficina', naturaleza: 'debito', elementoNiif: 'activo' },
  { codigo: '1592', nombre: 'Depreciación acumulada', naturaleza: 'credito', elementoNiif: 'activo' },
  { codigo: '2205', nombre: 'Proveedores nacionales', naturaleza: 'credito', elementoNiif: 'pasivo' },
  { codigo: '2335', nombre: 'Costos y gastos por pagar', naturaleza: 'credito', elementoNiif: 'pasivo' },
  { codigo: '2370', nombre: 'Retenciones y aportes de nómina por pagar', naturaleza: 'credito', elementoNiif: 'pasivo' },
  { codigo: '2408', nombre: 'IVA por pagar', naturaleza: 'credito', elementoNiif: 'pasivo' },
  { codigo: '2505', nombre: 'Salarios por pagar', naturaleza: 'credito', elementoNiif: 'pasivo' },
  { codigo: '2610', nombre: 'Provisión para prestaciones sociales', naturaleza: 'credito', elementoNiif: 'pasivo' },
  { codigo: '3605', nombre: 'Utilidad del ejercicio', naturaleza: 'credito', elementoNiif: 'patrimonio' },
  { codigo: '4135', nombre: 'Comercio al por mayor y al por menor', naturaleza: 'credito', elementoNiif: 'ingreso' },
  { codigo: '5105', nombre: 'Gastos de personal', naturaleza: 'debito', elementoNiif: 'gasto' },
  { codigo: '5160', nombre: 'Depreciación', naturaleza: 'debito', elementoNiif: 'gasto' },
  { codigo: '5195', nombre: 'Diversos (administración)', naturaleza: 'debito', elementoNiif: 'gasto' },
  { codigo: '5199', nombre: 'Provisiones', naturaleza: 'debito', elementoNiif: 'gasto' },
  { codigo: '5305', nombre: 'Gastos bancarios', naturaleza: 'debito', elementoNiif: 'gasto' },
  { codigo: '6135', nombre: 'Costo de ventas', naturaleza: 'debito', elementoNiif: 'costo' },
];

// Reglas por defecto para los eventos de los seis módulos operativos
// (Ventas, Compras, Nómina, Inventarios, Activos Fijos, Tesorería).
//
// NOTA: el motor de asientos hoy solo soporta un débito y un crédito
// por evento — por eso estas reglas no discriminan IVA por separado
// (ej. la venta debería tocar también 2408 IVA por pagar). Soportar
// múltiples líneas por evento queda como mejora pendiente.
const REGLAS = [
  { eventoOrigen: 'factura_venta_credito', debito: '1305', credito: '4135', nivel: 'automatico' },
  { eventoOrigen: 'factura_venta_contado', debito: '1110', credito: '4135', nivel: 'automatico' },
  { eventoOrigen: 'factura_compra_con_orden', debito: '1435', credito: '2205', nivel: 'automatico' },
  { eventoOrigen: 'factura_compra_sin_orden', debito: '5195', credito: '2205', nivel: 'asistido' },
  { eventoOrigen: 'documento_soporte_compra', debito: '5195', credito: '2335', nivel: 'asistido' },
  { eventoOrigen: 'nomina_devengado', debito: '5105', credito: '2505', nivel: 'automatico' },
  { eventoOrigen: 'provision_prestaciones', debito: '5105', credito: '2610', nivel: 'automatico' },
  { eventoOrigen: 'salida_inventario_venta', debito: '6135', credito: '1435', nivel: 'automatico' },
  { eventoOrigen: 'ajuste_inventario', debito: '5199', credito: '1435', nivel: 'manual' },
  { eventoOrigen: 'compra_activo_fijo', debito: '1524', credito: '2205', nivel: 'asistido' },
  { eventoOrigen: 'depreciacion_mensual', debito: '5160', credito: '1592', nivel: 'automatico' },
  { eventoOrigen: 'baja_activo_fijo', debito: '1592', credito: '1524', nivel: 'manual' },
  { eventoOrigen: 'gasto_bancario', debito: '5305', credito: '1110', nivel: 'automatico' },
];

// Seguro de correr más de una vez: usa findOrCreate en cada paso, así
// que repetirlo no duplica nada, solo confirma que todo sigue en su sitio.
async function ejecutarSeed() {
  const resultado = { empresaId: null, periodoId: null, cuentas: 0, reglas: 0 };

  const [empresa] = await Empresa.findOrCreate({
    where: { id: EMPRESA_SEED_ID },
    defaults: {
      id: EMPRESA_SEED_ID,
      nit: '900123456-1',
      razonSocial: 'Empresa de prueba S.A.S.',
      regimenTributario: 'ordinario',
      responsableIva: true,
    },
  });
  resultado.empresaId = empresa.id;

  const hoy = new Date();
  const fechaInicio = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const fechaFin = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);

  const [periodo] = await PeriodoContable.findOrCreate({
    where: { empresaId: empresa.id, fechaInicio },
    defaults: {
      id: uuidv4(),
      empresaId: empresa.id,
      fechaInicio,
      fechaFin,
      estado: 'abierto',
    },
  });
  resultado.periodoId = periodo.id;

  const cuentaIdPorCodigo = {};
  for (const c of CUENTAS) {
    const [cuenta] = await PlanCuentas.findOrCreate({
      where: { empresaId: empresa.id, codigo: c.codigo },
      defaults: {
        id: uuidv4(),
        empresaId: empresa.id,
        codigo: c.codigo,
        nombre: c.nombre,
        naturaleza: c.naturaleza,
        nivel: 1,
        elementoNiif: c.elementoNiif,
      },
    });
    cuentaIdPorCodigo[c.codigo] = cuenta.id;
    resultado.cuentas += 1;
  }

  for (const r of REGLAS) {
    await ReglaContabilizacion.findOrCreate({
      where: { empresaId: empresa.id, eventoOrigen: r.eventoOrigen },
      defaults: {
        id: uuidv4(),
        empresaId: empresa.id,
        eventoOrigen: r.eventoOrigen,
        cuentaDebitoId: cuentaIdPorCodigo[r.debito],
        cuentaCreditoId: cuentaIdPorCodigo[r.credito],
        nivelAutomatizacion: r.nivel,
      },
    });
    resultado.reglas += 1;
  }

  return resultado;
}

module.exports = { ejecutarSeed, EMPRESA_SEED_ID };
SCRIPTEOF
echo "OK  src/core/services/seedService.js"

cat > src/core/services/cierrePeriodo.js << 'SCRIPTEOF'
const { v4: uuidv4 } = require('uuid');
const PeriodoContable = require('../models/PeriodoContable');
const Asiento = require('../models/Asiento');
const Movimiento = require('../models/Movimiento');
const auditoria = require('./auditoria');
const MovimientoBancario = require('../../modules/tesoreria/models/MovimientoBancario');

/**
 * Máquina de estados del cierre mensual:
 *   abierto -> en_cierre -> (bloqueado -> abierto) | cerrado_preliminar
 *           -> cerrado_certificado -> (excepcional) reabierto -> en_cierre
 */

// Paso 1: abierto -> en_cierre. Corre las validaciones y devuelve
// los pendientes encontrados (si hay alguno, el periodo NO avanza).
async function iniciarCierre(periodoContableId) {
  const pendientes = await validarPeriodo(periodoContableId);

  if (pendientes.length > 0) {
    // Se queda en "en_cierre" para que el usuario vea el detalle,
    // pero funcionalmente el periodo sigue bloqueado para cerrar.
    return { estado: 'bloqueado', pendientes };
  }

  await generarAsientoDeCierre(periodoContableId);

  const periodo = await PeriodoContable.findByPk(periodoContableId);
  await periodo.update({ estado: 'cerrado_preliminar' });

  return { estado: 'cerrado_preliminar', pendientes: [] };
}

// Validaciones bloqueantes: ver la tabla de reglas de contabilización,
// nivel 3 (requiere criterio del contador).
async function validarPeriodo(periodoContableId) {
  const pendientes = [];
  const periodo = await PeriodoContable.findByPk(periodoContableId);

  const sinConciliar = await MovimientoBancario.count({
    where: { empresaId: periodo.empresaId, conciliado: false },
  });

  if (sinConciliar > 0) {
    pendientes.push(
      `${sinConciliar} movimiento(s) bancario(s) sin conciliar. Ve a Tesorería y concílialos antes de cerrar.`
    );
  }

  // TODO: siguen pendientes de implementar:
  // - Facturas/documentos soporte en borrador sin emitir
  // - Cuadre global de débitos vs. créditos del periodo (integridad)
  // La depreciación y la provisión de prestaciones NO bloquean:
  // se calculan automáticamente si no se han corrido (nivel 1).

  return pendientes;
}

// Asiento especial que traslada el saldo de las cuentas nominales
// (ingresos, costos, gastos) contra el resultado del ejercicio.
async function generarAsientoDeCierre(periodoContableId) {
  const periodo = await PeriodoContable.findByPk(periodoContableId);

  const asiento = await Asiento.create({
    id: uuidv4(),
    empresaId: periodo.empresaId,
    periodoContableId,
    fecha: periodo.fechaFin,
    origenModulo: 'cierre_periodo',
    estado: 'contabilizado',
  });

  // TODO: calcular saldos de cuentas clase 4/5/6/7 y generar los
  // movimientos correspondientes contra la cuenta de resultado del ejercicio.

  return asiento;
}

// Paso 2: cerrado_preliminar -> cerrado_certificado.
// Solo lo puede ejecutar el rol "dueño" (representante legal) o "contador".
async function certificarCierre(periodoContableId, usuario) {
  if (!['dueño', 'contador'].includes(usuario.rol)) {
    throw new Error('Solo el dueño o el contador pueden certificar el cierre.');
  }

  const periodo = await PeriodoContable.findByPk(periodoContableId);

  if (periodo.estado !== 'cerrado_preliminar') {
    throw new Error('Solo se puede certificar un periodo en estado "cerrado_preliminar".');
  }

  await periodo.update({
    estado: 'cerrado_certificado',
    cerradoPor: usuario.id,
    fechaCertificacion: new Date(),
  });

  await auditoria.registrar({
    empresaId: periodo.empresaId,
    usuarioId: usuario.id,
    accion: 'certificacion_periodo',
    entidad: 'PeriodoContable',
    entidadId: periodo.id,
  });

  return periodo;
}

// Excepción controlada: cerrado_certificado -> reabierto -> en_cierre.
// Requiere justificación y el rol "contador" exclusivamente — ni el
// dueño ni el auxiliar pueden reabrir un periodo ya certificado.
async function reabrirPeriodo(periodoContableId, motivo, usuario) {
  if (usuario.rol !== 'contador') {
    throw new Error('Solo el rol "contador" puede reabrir un periodo certificado.');
  }

  if (!motivo || motivo.trim().length < 10) {
    throw new Error('La reapertura de un periodo certificado exige una justificación.');
  }

  const periodo = await PeriodoContable.findByPk(periodoContableId);

  if (periodo.estado !== 'cerrado_certificado') {
    throw new Error('Solo se puede reabrir un periodo en estado "cerrado_certificado".');
  }

  await periodo.update({
    estado: 'en_cierre', // vuelve a validación, no directo a "abierto"
    motivoReapertura: motivo,
  });

  await auditoria.registrar({
    empresaId: periodo.empresaId,
    usuarioId: usuario.id,
    accion: 'reapertura_periodo',
    entidad: 'PeriodoContable',
    entidadId: periodo.id,
    detalle: motivo,
  });

  return periodo;
}

module.exports = { iniciarCierre, certificarCierre, reabrirPeriodo, validarPeriodo };
SCRIPTEOF
echo "OK  src/core/services/cierrePeriodo.js"

cat > src/jobs/depreciacionMensual.js << 'SCRIPTEOF'
// Configurar en hPanel > Cron Jobs para correr el día 1 de cada mes:
//   node /home/USUARIO/mipyme-contable/src/jobs/depreciacionMensual.js
//
// Nivel de automatización 1 (automático total): no requiere intervención
// del contador, ver tabla de reglas de contabilización del módulo de
// activos fijos.

require('dotenv').config();
require('../core/models'); // registra los modelos antes de consultar
const Empresa = require('../core/models/Empresa');
const activosFijosService = require('../modules/activosFijos/services/activosFijos.service');

async function ejecutar() {
  console.log(`[${new Date().toISOString()}] Iniciando depreciación mensual...`);

  const empresas = await Empresa.findAll();
  let totalActivosDepreciados = 0;

  for (const empresa of empresas) {
    const resultados = await activosFijosService.calcularDepreciacionMensual(empresa.id);
    totalActivosDepreciados += resultados.length;
    console.log(`  Empresa ${empresa.id}: ${resultados.length} activo(s) depreciado(s).`);
  }

  console.log(`Depreciación mensual completada. Total: ${totalActivosDepreciados} activo(s).`);
  process.exit(0);
}

ejecutar().catch((error) => {
  console.error('Error en job de depreciación mensual:', error);
  process.exit(1);
});
SCRIPTEOF
echo "OK  src/jobs/depreciacionMensual.js"

cat > README.md << 'SCRIPTEOF'
# mipyme-contable

Sistema contable para microempresas colombianas (NIIF Grupo 3), pensado
para desplegarse en Hostinger (plan Business — Node.js administrado +
PostgreSQL en Supabase).

## Arquitectura

```
public/                     # Frontend mínimo: HTML + JS plano, sin build step
├── index.html                 Login + tablero con pestañas por módulo
├── style.css                  Estética de libro contable (IBM Plex, reglas horizontales)
└── app.js                     Login, consumo de la API, formulario de terceros
src/
├── server.js                 # Punto de entrada — también sirve public/ como estáticos
├── config/                   # Conexión a base de datos, variables de entorno
├── core/                     # Núcleo contable — nunca depende de la infraestructura
│   ├── models/                 Empresa, Tercero, PlanCuentas, Asiento,
│   │                           Movimiento, PeriodoContable, ReglaContabilizacion,
│   │                           ParametroTributario, Usuario, LogAuditoria
│   └── services/
│       ├── motorAsientos.js    Traduce eventos operativos en partida doble
│       ├── cierrePeriodo.js    Máquina de estados del cierre mensual
│       ├── authService.js      Login y registro de usuarios
│       ├── auditoria.js        Registro de acciones sensibles
│       └── seedService.js      Datos base: empresa, periodo, cuentas, reglas
├── modules/                  # Módulos operativos (capa transaccional) — TODOS completos
│   ├── ventas/                 Cotización → factura, patrón de referencia
│   ├── compras/                Factura recibida + documento soporte, orden de compra
│   ├── nomina/                 Periodo → empleados → liquidar → documento soporte
│   ├── inventarios/            Kardex simplificado: entradas, salidas, ajustes
│   ├── activosFijos/           Registro, depreciación mensual (cron), baja
│   └── tesoreria/               Cuentas bancarias, movimientos, conciliación
├── integrations/             # Capa adaptadora hacia proveedores acreditados
│   ├── adapters/                Interfaz única por tipo de documento
│   └── webhooks/                Recepción asíncrona de confirmaciones DIAN
├── jobs/                     # Disparados por Cron Jobs de hPanel
│   ├── depreciacionMensual.js  Implementado — recorre todas las empresas
│   └── vencimientoCotizaciones.js
├── middleware/                # authenticate + authorize por rol
└── routes/                   # Router raíz (auth, seed, terceros, y los 6 módulos)
```

## Frontend

`public/` es intencionalmente mínimo: sin framework, sin paso de
compilación, servido directo por el mismo Express (`express.static`).
Hoy es de **solo lectura** para la mayoría de módulos. El único
formulario de creación es el de terceros — el resto se sigue creando
por API (`curl` o Postman) hasta que se agreguen sus formularios.

## Principios de diseño (no romper esto)

1. **Ningún módulo operativo escribe asientos directamente.** Todo pasa
   por `motorAsientos.contabilizarEvento()`, que consulta la tabla
   `ReglaContabilizacion` de la empresa y resuelve solo el periodo
   contable vigente si no se le pasa explícito.
2. **Cotizaciones y órdenes de compra/servicio no generan asiento.**
   Solo lo hacen cuando se convierten en factura.
3. **Nunca hardcodear UVT, tarifas de retención, RST o ICA.** Viven en
   `ParametroTributario`, versionado por año gravable.
4. **La lógica del proveedor tecnológico de facturación/nómina/documento
   soporte vive únicamente en `src/integrations/adapters/`.** Cambiar de
   proveedor no debe tocar ningún módulo operativo.
5. **Un periodo `cerrado_certificado` es inmutable** salvo por el
   proceso formal de reapertura (rol Contador + justificación obligatoria).
6. **Un movimiento bancario sin conciliar bloquea el cierre del periodo**
   (ver `cierrePeriodo.validarPeriodo`).

## Puesta en marcha

```bash
cp .env.example .env      # completar credenciales de la base de datos y del proveedor tecnológico
npm install
npm run dev
```

## Despliegue en Hostinger (plan Business)

1. hPanel → Sitios web → Apps Node.js → conectar el repositorio de GitHub.
2. Base de datos: PostgreSQL vía Supabase (host, puerto, nombre, usuario y
   contraseña como `DB_*` en las variables de entorno de la app).
3. hPanel → Avanzado → Cron Jobs → programar:
   - `node src/jobs/depreciacionMensual.js` — día 1 de cada mes
   - `node src/jobs/vencimientoCotizaciones.js` — diario

## Roles y autenticación

Cuatro roles, controlados por `src/middleware/auth.js` (`authenticate` +
`authorize(...roles)`):

| Rol | Puede |
|---|---|
| `dueño` | Operar el sistema, certificar el cierre mensual |
| `contador` | Todo lo anterior + reabrir un periodo certificado |
| `auxiliar` | Registrar operaciones del día a día (ventas, compras, nómina) |
| `revisor` | Solo lectura (pendiente de aplicar en cada ruta) |

`POST /api/auth/login` y `POST /api/auth/registro` son las únicas rutas
públicas. Todas las demás requieren `Authorization: Bearer <token>`.

## Datos base (seed)

`POST /api/seed` (requiere sesión con rol `contador` o `dueño`) crea:
una empresa de prueba, el periodo contable del mes en curso, un plan de
cuentas de 22 cuentas, y 13 reglas de contabilización — una por cada
evento que disparan los seis módulos operativos. Seguro de correr más
de una vez — no duplica nada. Sin esto, `motorAsientos` no tiene con
qué contabilizar.

## Pendientes inmediatos

- [ ] Restringir `POST /api/auth/registro` a `authenticate + authorize('dueño', 'contador')` una vez exista el primer usuario de cada empresa (ver TODO en `authService.js`)
- [ ] Migraciones de Sequelize (`sequelize-cli`) para las tablas ya modeladas
- [ ] Reemplazar `FACTOR_PRESTACIONES` (21.83% fijo) en `nomina.service.js` por el cálculo exacto de cesantías, intereses, prima y vacaciones según la normativa laboral vigente y el tipo de contrato
- [ ] Integrar `NovedadNomina` con el cálculo del devengado (hoy es solo un registro informativo, no ajusta nada automáticamente)
- [ ] Tesorería: cruzar movimientos de tipo ingreso/egreso contra la factura, orden o nómina específica que pagan (hoy solo "comisión" se contabiliza sola al conciliar; el resto solo queda marcado como conciliado, sin generar el asiento de pago)
- [ ] Mapear cada `CuentaBancaria` a su propia subcuenta contable — hoy todas comparten el código 1110 Bancos
- [ ] Soportar múltiples líneas (débito/crédito) por evento en `motorAsientos` — hoy una venta no discrimina el IVA en un renglón aparte
- [ ] Implementar el mapeo real en `facturacionAdapter.js` y `documentoSoporteAdapter.js` contra el proveedor contratado
- [ ] Confirmar con el proveedor tecnológico la mecánica exacta para RECIBIR facturas de compra (RADIAN vs. notificación directa) — ver TODO en `compras.service.js`
- [ ] `GET/PATCH/DELETE` de terceros (hoy `terceros.routes.js` solo tiene crear y listar)
- [ ] Vincular `MovimientoInventario` con los ítems reales de `FacturaVenta`/`FacturaCompra` — hoy las entradas y salidas se registran manualmente por API, no automático desde una venta
- [ ] Cuadre global de débitos vs. créditos del periodo como validación bloqueante del cierre (ver TODO en `cierrePeriodo.validarPeriodo`)
- [ ] **Centros de costo**: permitir contabilidad segmentada por proyecto para empresas que manejan varios en paralelo. Hoy `Movimiento.centroCosto` es solo un campo de texto libre — falta un catálogo propio (`CentroCosto`: id, empresa_id, nombre, activo) y reportes/filtros por centro de costo en los estados financieros
- [ ] Activar Row Level Security (RLS) en las tablas de Supabase antes de manejar datos reales
- [ ] Agregar formularios de creación al frontend para el resto de módulos (hoy solo terceros tiene formulario; el resto se crea por API)
SCRIPTEOF
echo "OK  README.md"

cat > public/index.html << 'SCRIPTEOF'
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mipyme Contable</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Serif:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css">
</head>
<body>

<div id="vista-login" class="pantalla-login">
  <div class="tarjeta-login">
    <h1 class="wordmark">Mipyme Contable</h1>
    <p class="subtitulo">Sistema contable para microempresas — NIIF Grupo 3</p>
    <form id="form-login">
      <label>Correo
        <input type="email" id="login-email" required autocomplete="username">
      </label>
      <label>Contraseña
        <input type="password" id="login-password" required autocomplete="current-password">
      </label>
      <button type="submit" class="btn-primario">Entrar</button>
      <p id="login-error" class="mensaje-error" hidden></p>
    </form>
  </div>
</div>

<div id="vista-dashboard" class="app" hidden>
  <aside class="barra-lateral">
    <h1 class="wordmark">Mipyme Contable</h1>
    <nav>
      <button class="nav-item activo" data-tab="terceros">Terceros</button>
      <button class="nav-item" data-tab="cotizaciones">Cotizaciones</button>
      <button class="nav-item" data-tab="facturas-venta">Facturas de venta</button>
      <button class="nav-item" data-tab="ordenes">Órdenes de compra</button>
      <button class="nav-item" data-tab="facturas-compra">Facturas de compra</button>
      <button class="nav-item" data-tab="nomina">Nómina</button>
      <button class="nav-item" data-tab="inventarios">Inventarios</button>
      <button class="nav-item" data-tab="activos-fijos">Activos fijos</button>
      <button class="nav-item" data-tab="tesoreria">Tesorería</button>
    </nav>
    <div class="usuario-actual">
      <p id="usuario-nombre"></p>
      <p id="usuario-rol" class="rol"></p>
      <button id="btn-salir">Cerrar sesión</button>
    </div>
  </aside>

  <main class="contenido">
    <section id="panel-terceros" class="panel">
      <header class="panel-header">
        <h2>Terceros</h2>
        <button class="btn-primario" id="btn-nuevo-tercero">+ Nuevo tercero</button>
      </header>
      <form id="form-tercero" class="form-inline" hidden>
        <select id="tercero-tipo" required>
          <option value="cliente">Cliente</option>
          <option value="proveedor">Proveedor</option>
          <option value="empleado">Empleado</option>
          <option value="otro">Otro</option>
        </select>
        <input type="text" id="tercero-identificacion" placeholder="Identificación" required>
        <input type="text" id="tercero-nombre" placeholder="Nombre" required>
        <input type="email" id="tercero-email" placeholder="Correo (opcional)">
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-tercero">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-terceros"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-cotizaciones" class="panel" hidden>
      <header class="panel-header"><h2>Cotizaciones</h2></header>
      <div class="tabla-envoltorio">
        <table id="tabla-cotizaciones"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-facturas-venta" class="panel" hidden>
      <header class="panel-header"><h2>Facturas de venta</h2></header>
      <div class="tabla-envoltorio">
        <table id="tabla-facturas-venta"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-ordenes" class="panel" hidden>
      <header class="panel-header"><h2>Órdenes de compra</h2></header>
      <div class="tabla-envoltorio">
        <table id="tabla-ordenes"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-facturas-compra" class="panel" hidden>
      <header class="panel-header"><h2>Facturas de compra</h2></header>
      <div class="tabla-envoltorio">
        <table id="tabla-facturas-compra"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-nomina" class="panel" hidden>
      <header class="panel-header"><h2>Nómina</h2></header>
      <div class="tabla-envoltorio">
        <table id="tabla-nomina"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-inventarios" class="panel" hidden>
      <header class="panel-header"><h2>Inventarios</h2></header>
      <div class="tabla-envoltorio">
        <table id="tabla-productos"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-activos-fijos" class="panel" hidden>
      <header class="panel-header"><h2>Activos fijos</h2></header>
      <div class="tabla-envoltorio">
        <table id="tabla-activos"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-tesoreria" class="panel" hidden>
      <header class="panel-header"><h2>Tesorería</h2></header>
      <h3 class="subseccion">Cuentas bancarias</h3>
      <div class="tabla-envoltorio">
        <table id="tabla-cuentas"><thead></thead><tbody></tbody></table>
      </div>
      <h3 class="subseccion">Movimientos</h3>
      <div class="tabla-envoltorio">
        <table id="tabla-movimientos-bancarios"><thead></thead><tbody></tbody></table>
      </div>
    </section>
  </main>
</div>

<script src="/app.js"></script>
</body>
</html>
SCRIPTEOF
echo "OK  public/index.html"

cat > public/style.css << 'SCRIPTEOF'
:root {
  --paper: #F6F8F4;
  --surface: #FFFFFF;
  --ink: #1C2A24;
  --ink-soft: #56655C;
  --rule: #CBD6CE;
  --rule-strong: #9FAFA4;
  --accent: #2F6B4F;
  --accent-hover: #275940;
  --accent-ink: #FFFFFF;
  --danger: #A6432E;
  --warn: #B8863A;
  --font-serif: 'IBM Plex Serif', Georgia, serif;
  --font-sans: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'IBM Plex Mono', 'Courier New', monospace;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: var(--font-sans);
  color: var(--ink);
  background: var(--paper);
}

.wordmark {
  font-family: var(--font-serif);
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 0;
}

button { font-family: var(--font-sans); cursor: pointer; }

.btn-primario {
  background: var(--accent);
  color: var(--accent-ink);
  border: none;
  padding: 10px 18px;
  font-size: 14px;
  font-weight: 500;
}
.btn-primario:hover { background: var(--accent-hover); }

.btn-secundario {
  background: transparent;
  color: var(--ink-soft);
  border: 1px solid var(--rule-strong);
  padding: 10px 18px;
  font-size: 14px;
}

/* LOGIN */
.pantalla-login {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.tarjeta-login {
  width: 100%;
  max-width: 360px;
  background: var(--surface);
  border-top: 3px solid var(--accent);
  padding: 40px 32px;
}

.tarjeta-login .wordmark { font-size: 22px; margin-bottom: 4px; }

.subtitulo {
  color: var(--ink-soft);
  font-size: 13px;
  margin: 0 0 28px;
  line-height: 1.5;
}

#form-login label {
  display: block;
  font-size: 13px;
  color: var(--ink-soft);
  margin-bottom: 16px;
}

#form-login input {
  display: block;
  width: 100%;
  margin-top: 6px;
  padding: 10px 12px;
  font-family: var(--font-sans);
  font-size: 14px;
  border: 1px solid var(--rule-strong);
  background: var(--paper);
  color: var(--ink);
}

#form-login input:focus {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

#form-login .btn-primario {
  width: 100%;
  padding: 12px;
  margin-top: 8px;
}

.mensaje-error {
  color: var(--danger);
  font-size: 13px;
  margin-top: 12px;
}

/* APP SHELL */
.app {
  display: grid;
  grid-template-columns: 220px 1fr;
  min-height: 100vh;
}

.barra-lateral {
  background: var(--surface);
  border-right: 1px solid var(--rule);
  padding: 28px 20px;
  display: flex;
  flex-direction: column;
}

.barra-lateral .wordmark { font-size: 17px; margin-bottom: 28px; }

.barra-lateral nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}

.nav-item {
  text-align: left;
  background: none;
  border: none;
  border-left: 2px solid transparent;
  padding: 9px 10px;
  font-size: 14px;
  color: var(--ink-soft);
}

.nav-item:hover { color: var(--ink); background: var(--paper); }

.nav-item.activo {
  color: var(--ink);
  border-left-color: var(--accent);
  background: var(--paper);
  font-weight: 500;
}

.usuario-actual {
  border-top: 1px solid var(--rule);
  padding-top: 16px;
  margin-top: 16px;
}

.usuario-actual p { margin: 0; font-size: 13px; }
.usuario-actual .rol {
  color: var(--ink-soft);
  text-transform: capitalize;
  margin-bottom: 10px;
}

#btn-salir {
  background: none;
  border: none;
  color: var(--ink-soft);
  font-size: 13px;
  padding: 0;
  text-decoration: underline;
}

.contenido { padding: 32px 40px; max-width: 1000px; }

.panel-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 20px;
}

.panel-header h2 {
  font-family: var(--font-serif);
  font-weight: 600;
  font-size: 24px;
  margin: 0;
}

.subseccion {
  font-family: var(--font-serif);
  font-weight: 600;
  font-size: 15px;
  color: var(--ink-soft);
  margin: 24px 0 10px;
}
.subseccion:first-of-type { margin-top: 0; }

.form-inline {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
  background: var(--surface);
  border: 1px solid var(--rule);
  padding: 16px;
  margin-bottom: 20px;
}

.form-inline input, .form-inline select {
  padding: 8px 10px;
  border: 1px solid var(--rule-strong);
  font-family: var(--font-sans);
  font-size: 14px;
  background: var(--paper);
}

/* TABLAS: estilo libro contable — solo reglas horizontales */
.tabla-envoltorio {
  background: var(--surface);
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

thead th {
  text-align: left;
  font-weight: 500;
  color: var(--ink-soft);
  font-size: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--rule-strong);
  white-space: nowrap;
}

tbody td {
  padding: 12px 16px;
  border-bottom: 1px solid var(--rule);
}

tbody tr:last-child td { border-bottom: none; }

td.num, th.num {
  text-align: right;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.badge {
  display: inline-block;
  font-size: 12px;
  padding: 2px 8px;
  border: 1px solid var(--rule-strong);
  color: var(--ink-soft);
  text-transform: capitalize;
}
.badge.aceptada, .badge.aceptado, .badge.contabilizado, .badge.liquidada, .badge.aprobada, .badge.conciliado { border-color: var(--accent); color: var(--accent); }
.badge.rechazada, .badge.rechazado, .badge.objetada { border-color: var(--danger); color: var(--danger); }
.badge.pendiente, .badge.borrador, .badge.enviada, .badge.enviado { border-color: var(--warn); color: var(--warn); }

.vacio {
  padding: 32px 16px;
  color: var(--ink-soft);
  font-size: 14px;
  text-align: center;
}

@media (max-width: 720px) {
  .app { grid-template-columns: 1fr; }
  .barra-lateral {
    flex-direction: row;
    flex-wrap: wrap;
    padding: 16px;
    border-right: none;
    border-bottom: 1px solid var(--rule);
  }
  .barra-lateral nav { flex-direction: row; flex-wrap: wrap; }
  .contenido { padding: 20px; }
}
SCRIPTEOF
echo "OK  public/style.css"

cat > public/app.js << 'SCRIPTEOF'
const API = '/api';

let token = localStorage.getItem('token');
let usuario = JSON.parse(localStorage.getItem('usuario') || 'null');
let mapaTerceros = {};

const vistaLogin = document.getElementById('vista-login');
const vistaDashboard = document.getElementById('vista-dashboard');

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  if (res.status === 401) {
    cerrarSesion('Tu sesión expiró. Inicia sesión de nuevo.');
    throw new Error('No autenticado');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error inesperado');
  return data;
}

function formatoDinero(valor) {
  return Number(valor || 0).toLocaleString('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  });
}

function formatoFecha(valor) {
  if (!valor) return '—';
  return new Date(valor).toLocaleDateString('es-CO', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function nombreTercero(id) {
  return mapaTerceros[id] || id || '—';
}

function badge(estado) {
  if (!estado) return '—';
  return `<span class="badge ${estado}">${estado.replace(/_/g, ' ')}</span>`;
}

function tablaVacia(idTabla, colSpan, mensaje) {
  document.querySelector(`#${idTabla} tbody`).innerHTML =
    `<tr><td colspan="${colSpan}" class="vacio">${mensaje}</td></tr>`;
}

// --- LOGIN ---
document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  errorEl.hidden = true;

  try {
    const res = await fetch(API + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo iniciar sesión.');

    token = data.token;
    usuario = data.usuario;
    localStorage.setItem('token', token);
    localStorage.setItem('usuario', JSON.stringify(usuario));
    mostrarDashboard();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

function cerrarSesion(mensaje) {
  token = null;
  usuario = null;
  localStorage.removeItem('token');
  localStorage.removeItem('usuario');
  vistaDashboard.hidden = true;
  vistaLogin.hidden = false;
  if (mensaje) {
    const errorEl = document.getElementById('login-error');
    errorEl.textContent = mensaje;
    errorEl.hidden = false;
  }
}

document.getElementById('btn-salir').addEventListener('click', () => cerrarSesion());

// --- DASHBOARD SHELL ---
function mostrarDashboard() {
  vistaLogin.hidden = true;
  vistaDashboard.hidden = false;
  document.getElementById('usuario-nombre').textContent = usuario.nombre;
  document.getElementById('usuario-rol').textContent = usuario.rol;
  cargarTodo();
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('activo'));
    document.querySelectorAll('.panel').forEach((p) => (p.hidden = true));
    btn.classList.add('activo');
    document.getElementById('panel-' + btn.dataset.tab).hidden = false;
  });
});

// --- CARGA DE DATOS ---
async function cargarTodo() {
  try {
    const terceros = await api('/terceros');
    mapaTerceros = Object.fromEntries(terceros.map((t) => [t.id, t.nombre]));
    renderTerceros(terceros);

    const [cotizaciones, facturasVenta, ordenes, facturasCompra, periodos, productos, activos, cuentas, movBancarios] = await Promise.all([
      api('/ventas/cotizaciones'),
      api('/ventas/facturas'),
      api('/compras/ordenes'),
      api('/compras/facturas'),
      api('/nomina/periodos'),
      api('/inventarios/productos'),
      api('/activos-fijos'),
      api('/tesoreria/cuentas'),
      api('/tesoreria/movimientos'),
    ]);

    renderCotizaciones(cotizaciones);
    renderFacturasVenta(facturasVenta);
    renderOrdenes(ordenes);
    renderFacturasCompra(facturasCompra);
    renderNomina(periodos);
    renderProductos(productos);
    renderActivos(activos);
    renderCuentas(cuentas);
    renderMovimientosBancarios(movBancarios);
  } catch (err) {
    console.error(err);
  }
}

function renderTerceros(lista) {
  document.querySelector('#tabla-terceros thead').innerHTML =
    '<tr><th>Nombre</th><th>Tipo</th><th>Identificación</th><th>Correo</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-terceros', 4, 'Todavía no hay terceros. Crea el primero arriba.');
  document.querySelector('#tabla-terceros tbody').innerHTML = lista
    .map(
      (t) =>
        `<tr><td>${t.nombre}</td><td>${t.tipo}</td><td>${t.identificacion}</td><td>${t.email || '—'}</td></tr>`
    )
    .join('');
}

function renderCotizaciones(lista) {
  document.querySelector('#tabla-cotizaciones thead').innerHTML =
    '<tr><th>Fecha</th><th>Cliente</th><th>Estado</th><th class="num">Total</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-cotizaciones', 4, 'Todavía no hay cotizaciones.');
  document.querySelector('#tabla-cotizaciones tbody').innerHTML = lista
    .map(
      (c) =>
        `<tr><td>${formatoFecha(c.fecha)}</td><td>${nombreTercero(c.terceroId)}</td><td>${badge(
          c.estado
        )}</td><td class="num">${formatoDinero(c.total)}</td></tr>`
    )
    .join('');
}

function renderFacturasVenta(lista) {
  document.querySelector('#tabla-facturas-venta thead').innerHTML =
    '<tr><th>Fecha</th><th>Cliente</th><th>DIAN</th><th class="num">Total</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-facturas-venta', 4, 'Todavía no hay facturas de venta.');
  document.querySelector('#tabla-facturas-venta tbody').innerHTML = lista
    .map(
      (f) =>
        `<tr><td>${formatoFecha(f.fecha)}</td><td>${nombreTercero(f.terceroId)}</td><td>${badge(
          f.estadoSincronizacion
        )}</td><td class="num">${formatoDinero(f.total)}</td></tr>`
    )
    .join('');
}

function renderOrdenes(lista) {
  document.querySelector('#tabla-ordenes thead').innerHTML =
    '<tr><th>Fecha</th><th>Proveedor</th><th>Tipo</th><th>Estado</th><th class="num">Total</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-ordenes', 5, 'Todavía no hay órdenes de compra.');
  document.querySelector('#tabla-ordenes tbody').innerHTML = lista
    .map(
      (o) =>
        `<tr><td>${formatoFecha(o.fecha)}</td><td>${nombreTercero(o.terceroId)}</td><td>${o.tipo}</td><td>${badge(
          o.estado
        )}</td><td class="num">${formatoDinero(o.total)}</td></tr>`
    )
    .join('');
}

function renderFacturasCompra(lista) {
  document.querySelector('#tabla-facturas-compra thead').innerHTML =
    '<tr><th>Fecha</th><th>Proveedor</th><th>Conciliación</th><th class="num">Total</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-facturas-compra', 4, 'Todavía no hay facturas de compra.');
  document.querySelector('#tabla-facturas-compra tbody').innerHTML = lista
    .map(
      (f) =>
        `<tr><td>${formatoFecha(f.fecha)}</td><td>${nombreTercero(f.terceroId)}</td><td>${badge(
          f.estadoConciliacion
        )}</td><td class="num">${formatoDinero(f.total)}</td></tr>`
    )
    .join('');
}

function renderNomina(lista) {
  document.querySelector('#tabla-nomina thead').innerHTML = '<tr><th>Periodo</th><th>Estado</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-nomina', 2, 'Todavía no hay periodos de nómina.');
  document.querySelector('#tabla-nomina tbody').innerHTML = lista
    .map(
      (p) =>
        `<tr><td>${formatoFecha(p.fechaInicio)} — ${formatoFecha(p.fechaFin)}</td><td>${badge(p.estado)}</td></tr>`
    )
    .join('');
}

function renderProductos(lista) {
  document.querySelector('#tabla-productos thead').innerHTML =
    '<tr><th>Nombre</th><th>Tipo</th><th class="num">Cantidad disponible</th><th class="num">Costo promedio</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-productos', 4, 'Todavía no hay productos. Créalos por API mientras agregamos el formulario.');
  document.querySelector('#tabla-productos tbody').innerHTML = lista
    .map(
      (p) =>
        `<tr><td>${p.nombre}</td><td>${p.tipo}</td><td class="num">${Number(p.cantidadDisponible).toLocaleString('es-CO')}</td><td class="num">${formatoDinero(p.costoPromedio)}</td></tr>`
    )
    .join('');
}

function renderActivos(lista) {
  document.querySelector('#tabla-activos thead').innerHTML =
    '<tr><th>Nombre</th><th>Adquisición</th><th>Estado</th><th class="num">Costo</th><th class="num">Depreciado</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-activos', 5, 'Todavía no hay activos fijos registrados.');
  document.querySelector('#tabla-activos tbody').innerHTML = lista
    .map(
      (a) =>
        `<tr><td>${a.nombre}</td><td>${formatoFecha(a.fechaAdquisicion)}</td><td>${badge(a.estado)}</td><td class="num">${formatoDinero(a.costo)}</td><td class="num">${formatoDinero(a.valorDepreciadoAcumulado)}</td></tr>`
    )
    .join('');
}

function renderCuentas(lista) {
  document.querySelector('#tabla-cuentas thead').innerHTML = '<tr><th>Banco</th><th>Número</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-cuentas', 2, 'Todavía no hay cuentas bancarias registradas.');
  document.querySelector('#tabla-cuentas tbody').innerHTML = lista
    .map((c) => `<tr><td>${c.banco}</td><td>${c.numero}</td></tr>`)
    .join('');
}

function renderMovimientosBancarios(lista) {
  document.querySelector('#tabla-movimientos-bancarios thead').innerHTML =
    '<tr><th>Fecha</th><th>Tipo</th><th>Descripción</th><th>Conciliado</th><th class="num">Valor</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-movimientos-bancarios', 5, 'Todavía no hay movimientos bancarios registrados.');
  document.querySelector('#tabla-movimientos-bancarios tbody').innerHTML = lista
    .map(
      (m) =>
        `<tr><td>${formatoFecha(m.fecha)}</td><td>${m.tipo}</td><td>${m.descripcion || '—'}</td><td>${
          m.conciliado ? badge('conciliado') : badge('pendiente')
        }</td><td class="num">${formatoDinero(m.valor)}</td></tr>`
    )
    .join('');
}

// --- CREAR TERCERO ---
const formTercero = document.getElementById('form-tercero');

document.getElementById('btn-nuevo-tercero').addEventListener('click', () => {
  formTercero.hidden = !formTercero.hidden;
});

document.getElementById('btn-cancelar-tercero').addEventListener('click', () => {
  formTercero.hidden = true;
  formTercero.reset();
});

formTercero.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/terceros', {
      method: 'POST',
      body: JSON.stringify({
        tipo: document.getElementById('tercero-tipo').value,
        identificacion: document.getElementById('tercero-identificacion').value,
        nombre: document.getElementById('tercero-nombre').value,
        email: document.getElementById('tercero-email').value || undefined,
      }),
    });
    formTercero.reset();
    formTercero.hidden = true;
    cargarTodo();
  } catch (err) {
    alert(err.message);
  }
});

// --- INICIO ---
if (token && usuario) {
  mostrarDashboard();
}
SCRIPTEOF
echo "OK  public/app.js"

echo ""
echo "Listo. Modulos de Inventarios, Activos Fijos y Tesoreria creados/actualizados."
echo "IMPORTANTE: hay que volver a llamar POST /api/seed para cargar las 6 reglas nuevas (total 13)."
echo "Siguiente paso:"
echo "  git add ."
echo "  git commit -m \"Agregar modulos de inventarios, activos fijos y tesoreria\""
echo "  git push"
