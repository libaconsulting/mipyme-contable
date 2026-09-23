#!/bin/bash
# Ejecutar DESDE DENTRO de la carpeta mipyme-contable.
set -e

if [ ! -f "package.json" ]; then
  echo "ERROR: no se encontró package.json en esta carpeta."
  echo "Ve primero a la carpeta mipyme-contable (cd mipyme-contable) y vuelve a correr este script."
  exit 1
fi

mkdir -p src/modules/nomina/models src/modules/nomina/services \
  src/modules/nomina/controllers src/modules/nomina/routes

cat > src/modules/nomina/models/PeriodoNomina.js << 'EOF'
const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Un periodo de nómina agrupa los registros de NominaEmpleado que se
// liquidan y emiten juntos. borrador -> liquidada -> pagada (el pago
// en sí depende del módulo de Tesorería, todavía no construido).
const PeriodoNomina = sequelize.define('PeriodoNomina', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  fechaInicio: { type: DataTypes.DATEONLY, allowNull: false },
  fechaFin: { type: DataTypes.DATEONLY, allowNull: false },
  estado: {
    type: DataTypes.ENUM('borrador', 'liquidada', 'pagada'),
    allowNull: false,
    defaultValue: 'borrador',
  },
}, {
  tableName: 'periodos_nomina',
});

module.exports = PeriodoNomina;
EOF
echo "OK  src/modules/nomina/models/PeriodoNomina.js"

cat > src/modules/nomina/models/NominaEmpleado.js << 'EOF'
const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// El renglón de nómina de UN empleado dentro de un periodo. Igual que
// FacturaVenta, nosotros EMITIMOS el documento soporte de nómina ante
// el proveedor tecnológico — por eso lleva los mismos campos de
// integración (estadoSincronizacion, cufe, xmlUrl).
const NominaEmpleado = sequelize.define('NominaEmpleado', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  periodoNominaId: { type: DataTypes.UUID, allowNull: false },
  empleadoId: { type: DataTypes.UUID, allowNull: false }, // Tercero con tipo='empleado'
  devengado: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  deducciones: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  netoPagar: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  proveedorTecnologicoId: { type: DataTypes.UUID },
  idTransaccionExterna: { type: DataTypes.STRING(100) },
  cufe: { type: DataTypes.STRING(100) },
  estadoSincronizacion: {
    type: DataTypes.ENUM('pendiente', 'enviado', 'aceptado', 'rechazado'),
    defaultValue: 'pendiente',
  },
  xmlUrl: { type: DataTypes.STRING(255) },
}, {
  tableName: 'nomina_empleados',
});

module.exports = NominaEmpleado;
EOF
echo "OK  src/modules/nomina/models/NominaEmpleado.js"

cat > src/modules/nomina/models/NovedadNomina.js << 'EOF'
const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Registro simple de novedades (incapacidad, vacaciones, licencia).
// TODO: todavía no ajusta automáticamente el devengado calculado en
// NominaEmpleado — por ahora es solo trazabilidad/consulta manual.
const NovedadNomina = sequelize.define('NovedadNomina', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  empleadoId: { type: DataTypes.UUID, allowNull: false },
  tipo: {
    type: DataTypes.ENUM('incapacidad', 'vacaciones', 'licencia', 'otro'),
    allowNull: false,
  },
  fechaInicio: { type: DataTypes.DATEONLY, allowNull: false },
  fechaFin: { type: DataTypes.DATEONLY, allowNull: false },
  observacion: { type: DataTypes.TEXT },
}, {
  tableName: 'novedades_nomina',
});

module.exports = NovedadNomina;
EOF
echo "OK  src/modules/nomina/models/NovedadNomina.js"

cat > src/integrations/adapters/nominaAdapter.js << 'EOF'
// Interfaz única hacia el proveedor tecnológico para EMITIR el
// documento soporte de nómina electrónica. Mismo patrón que
// facturacionAdapter.js y documentoSoporteAdapter.js.

require('dotenv').config();

async function emitirNomina(nominaEmpleado) {
  // TODO: mapear "nominaEmpleado" al formato que exige la API del
  // proveedor contratado (usar NOMINA_API_URL / NOMINA_API_KEY del .env)
  // y hacer el POST real.
  return { idTransaccionExterna: `PENDIENTE-${nominaEmpleado.id}` };
}

module.exports = { emitirNomina };
EOF
echo "OK  src/integrations/adapters/nominaAdapter.js"

cat > src/modules/nomina/services/nomina.service.js << 'EOF'
const { v4: uuidv4 } = require('uuid');
const PeriodoNomina = require('../models/PeriodoNomina');
const NominaEmpleado = require('../models/NominaEmpleado');
const NovedadNomina = require('../models/NovedadNomina');
const nominaAdapter = require('../../../integrations/adapters/nominaAdapter');
const { contabilizarEvento } = require('../../../core/services/motorAsientos');

// Factor simplificado de prestaciones sociales sobre el devengado
// (cesantías 8.33% + intereses cesantías 1% + prima 8.33% + vacaciones
// 4.17% ≈ 21.83%). Es una aproximación para el MVP — antes de usarse
// con datos reales hay que reemplazarla por el cálculo exacto según la
// normativa laboral vigente, que además varía según el tipo de contrato.
const FACTOR_PRESTACIONES = 0.2183;

async function crearPeriodoNomina(datos, usuario) {
  const periodo = await PeriodoNomina.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    fechaInicio: datos.fechaInicio,
    fechaFin: datos.fechaFin,
    estado: 'borrador',
  });
  return periodo;
}

async function agregarEmpleadoANomina(periodoNominaId, datos, usuario) {
  const devengado = Number(datos.devengado);
  const deducciones = Number(datos.deducciones || 0);

  const nomina = await NominaEmpleado.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    periodoNominaId,
    empleadoId: datos.empleadoId,
    devengado,
    deducciones,
    netoPagar: devengado - deducciones,
    estadoSincronizacion: 'pendiente',
  });
  return nomina;
}

// Cierra el periodo (ya no se pueden agregar más empleados) y emite el
// documento soporte de nómina de cada empleado ante el proveedor
// tecnológico. El motor de asientos se dispara solo cuando llega la
// confirmación de cada uno (ver confirmarNominaEmitida).
async function liquidarPeriodo(periodoNominaId, usuario) {
  const periodo = await PeriodoNomina.findByPk(periodoNominaId);

  if (periodo.estado !== 'borrador') {
    throw new Error('Solo se puede liquidar un periodo en estado "borrador".');
  }

  const registros = await NominaEmpleado.findAll({ where: { periodoNominaId } });

  if (registros.length === 0) {
    throw new Error('El periodo no tiene empleados agregados.');
  }

  for (const registro of registros) {
    const respuesta = await nominaAdapter.emitirNomina(registro);
    await registro.update({
      idTransaccionExterna: respuesta.idTransaccionExterna,
      estadoSincronizacion: 'enviado',
    });
  }

  await periodo.update({ estado: 'liquidada' });

  return periodo;
}

// Llamado desde el webhook cuando el proveedor confirma que la DIAN
// validó el documento soporte de nómina de un empleado específico.
// Contabiliza el devengado Y la provisión de prestaciones sociales del
// mismo empleado, en dos eventos separados.
async function confirmarNominaEmitida(nominaEmpleadoId, datosProveedor) {
  const registro = await NominaEmpleado.findByPk(nominaEmpleadoId);

  await registro.update({
    estadoSincronizacion: 'aceptado',
    cufe: datosProveedor.cufe,
    xmlUrl: datosProveedor.xmlUrl,
  });

  await contabilizarEvento({
    empresaId: registro.empresaId,
    tipoEvento: 'nomina_devengado',
    origenModulo: 'nomina',
    origenId: registro.id,
    valor: registro.devengado,
    terceroId: registro.empleadoId,
  });

  await contabilizarEvento({
    empresaId: registro.empresaId,
    tipoEvento: 'provision_prestaciones',
    origenModulo: 'nomina',
    origenId: registro.id,
    valor: Number(registro.devengado) * FACTOR_PRESTACIONES,
    terceroId: registro.empleadoId,
  });

  return registro;
}

async function registrarNovedad(datos, usuario) {
  const novedad = await NovedadNomina.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    empleadoId: datos.empleadoId,
    tipo: datos.tipo,
    fechaInicio: datos.fechaInicio,
    fechaFin: datos.fechaFin,
    observacion: datos.observacion,
  });
  return novedad;
}

module.exports = {
  crearPeriodoNomina,
  agregarEmpleadoANomina,
  liquidarPeriodo,
  confirmarNominaEmitida,
  registrarNovedad,
};
EOF
echo "OK  src/modules/nomina/services/nomina.service.js"

cat > src/modules/nomina/controllers/nomina.controller.js << 'EOF'
const nominaService = require('../services/nomina.service');

async function crearPeriodo(req, res) {
  try {
    const periodo = await nominaService.crearPeriodoNomina(req.body, req.usuario);
    res.status(201).json(periodo);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function agregarEmpleado(req, res) {
  try {
    const nomina = await nominaService.agregarEmpleadoANomina(
      req.params.periodoId,
      req.body,
      req.usuario
    );
    res.status(201).json(nomina);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function liquidar(req, res) {
  try {
    const periodo = await nominaService.liquidarPeriodo(req.params.periodoId, req.usuario);
    res.json(periodo);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function crearNovedad(req, res) {
  try {
    const novedad = await nominaService.registrarNovedad(req.body, req.usuario);
    res.status(201).json(novedad);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

module.exports = { crearPeriodo, agregarEmpleado, liquidar, crearNovedad };
EOF
echo "OK  src/modules/nomina/controllers/nomina.controller.js"

cat > src/modules/nomina/routes/nomina.routes.js << 'EOF'
const express = require('express');
const router = express.Router();
const nominaController = require('../controllers/nomina.controller');

// POST /api/nomina/periodos
router.post('/periodos', nominaController.crearPeriodo);

// POST /api/nomina/periodos/:periodoId/empleados
router.post('/periodos/:periodoId/empleados', nominaController.agregarEmpleado);

// POST /api/nomina/periodos/:periodoId/liquidar
router.post('/periodos/:periodoId/liquidar', nominaController.liquidar);

// POST /api/nomina/novedades
router.post('/novedades', nominaController.crearNovedad);

module.exports = router;
EOF
echo "OK  src/modules/nomina/routes/nomina.routes.js"

cat > src/integrations/webhooks/proveedorTecnologicoWebhook.js << 'EOF'
const express = require('express');
const router = express.Router();
const ventasService = require('../../modules/ventas/services/ventas.service');
const comprasService = require('../../modules/compras/services/compras.service');
const nominaService = require('../../modules/nomina/services/nomina.service');

// El proveedor tecnológico llama esta URL cuando la DIAN valida (o rechaza)
// el documento. No requiere procesos en segundo plano: es una petición
// HTTP entrante normal, que corre perfectamente en hosting administrado.
//
// POST /webhooks/facturacion
router.post('/facturacion', async (req, res) => {
  try {
    const { facturaId, estado, cufe, xmlUrl, pdfUrl } = req.body;

    if (estado === 'aceptada') {
      await ventasService.confirmarFacturaAceptada(facturaId, { cufe, xmlUrl, pdfUrl });
    }
    // TODO: manejar estado === 'rechazada' (notificar al usuario, no contabilizar)

    res.status(200).json({ recibido: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// El proveedor tecnológico (o RADIAN) avisa cuando llega una factura de
// un proveedor a nuestro nombre. Ver el TODO en compras.service.js sobre
// la mecánica exacta de recepción, pendiente de confirmar con el
// proveedor que se contrate.
//
// POST /webhooks/compras
router.post('/compras', async (req, res) => {
  try {
    await comprasService.registrarFacturaRecibida(req.body);
    res.status(200).json({ recibido: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Confirmación de que la DIAN validó un documento soporte que NOSOTROS
// emitimos (compra a proveedor no obligado a facturar).
//
// POST /webhooks/documento-soporte
router.post('/documento-soporte', async (req, res) => {
  try {
    const { documentoId, estado, cufe, xmlUrl } = req.body;

    if (estado === 'aceptado') {
      await comprasService.confirmarDocumentoSoporteEmitido(documentoId, { cufe, xmlUrl });
    }

    res.status(200).json({ recibido: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Confirmación de que la DIAN validó el documento soporte de nómina de
// un empleado específico.
//
// POST /webhooks/nomina
router.post('/nomina', async (req, res) => {
  try {
    const { nominaEmpleadoId, estado, cufe, xmlUrl } = req.body;

    if (estado === 'aceptado') {
      await nominaService.confirmarNominaEmitida(nominaEmpleadoId, { cufe, xmlUrl });
    }

    res.status(200).json({ recibido: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
EOF
echo "OK  src/integrations/webhooks/proveedorTecnologicoWebhook.js"

cat > src/core/models/index.js << 'EOF'
// Punto único donde se registran TODOS los modelos del núcleo contable.
// server.js importa este archivo antes de sincronizar la base de datos,
// así que ningún modelo se queda afuera por no estar "require"ado en
// alguna cadena de rutas activa. A medida que agreguemos modelos a los
// módulos operativos (activos fijos, tesorería), se suman aquí también.

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
};
EOF
echo "OK  src/core/models/index.js"

cat > src/routes/index.js << 'EOF'
const express = require('express');
const router = express.Router();

const authRoutes = require('./auth.routes');
const seedRoutes = require('./seed.routes');
const tercerosRoutes = require('./terceros.routes');
const ventasRoutes = require('../modules/ventas/routes/ventas.routes');
const comprasRoutes = require('../modules/compras/routes/compras.routes');
const nominaRoutes = require('../modules/nomina/routes/nomina.routes');
const { authenticate } = require('../middleware/auth');

router.use('/auth', authRoutes); // público: login y registro
router.use('/seed', seedRoutes); // el propio router exige authenticate + authorize

router.use('/terceros', authenticate, tercerosRoutes); // requiere sesión
router.use('/ventas', authenticate, ventasRoutes); // requiere sesión
router.use('/compras', authenticate, comprasRoutes); // requiere sesión
router.use('/nomina', authenticate, nominaRoutes); // requiere sesión

// TODO: montar aquí las rutas de inventarios, activosFijos y tesoreria
// siguiendo el mismo patrón (todas protegidas con authenticate).

module.exports = router;
EOF
echo "OK  src/routes/index.js"

cat > src/core/services/seedService.js << 'EOF'
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

// Reglas por defecto para los eventos que Ventas, Compras y Nómina ya
// disparan (ver la tabla de niveles de automatización que definimos).
// A medida que se construyan Activos Fijos y Tesorería, se agregan más
// reglas aquí siguiendo el mismo patrón.
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
EOF
echo "OK  src/core/services/seedService.js"

echo ""
echo "Listo. Módulo de Nómina creado/actualizado."
echo "IMPORTANTE: hay que volver a llamar POST /api/seed para que se"
echo "carguen las 2 reglas nuevas (nomina_devengado y provision_prestaciones)."
echo "Siguiente paso:"
echo "  git add ."
echo "  git commit -m \"Agregar modulo de nomina\""
echo "  git push"
