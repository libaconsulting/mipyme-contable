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
  { codigo: '2365', nombre: 'Retención en la fuente por pagar', naturaleza: 'credito', elementoNiif: 'pasivo' },
  { codigo: '2367', nombre: 'Impuesto a las ventas retenido (ReteIVA) por pagar', naturaleza: 'credito', elementoNiif: 'pasivo' },
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
  { eventoOrigen: 'salida_inventario_venta', debito: '6135', credito: '1435', nivel: 'automatico' },
  { eventoOrigen: 'ajuste_inventario', debito: '5199', credito: '1435', nivel: 'manual' },
  { eventoOrigen: 'compra_activo_fijo', debito: '1524', credito: '2205', nivel: 'asistido' },
  { eventoOrigen: 'depreciacion_mensual', debito: '5160', credito: '1592', nivel: 'automatico' },
  { eventoOrigen: 'baja_activo_fijo', debito: '1592', credito: '1524', nivel: 'manual' },
  { eventoOrigen: 'gasto_bancario', debito: '5305', credito: '1110', nivel: 'automatico' },
];

// Periodo del mes en curso + catálogo de cuentas + reglas por defecto de UNA
// empresa. Seguro de correr más de una vez: usa findOrCreate en cada paso.
async function sembrarCuentasReglasYPeriodo(empresaId) {
  const resultado = { periodoId: null, cuentas: 0, reglas: 0 };

  const hoy = new Date();
  const fechaInicio = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const fechaFin = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);

  const [periodo] = await PeriodoContable.findOrCreate({
    where: { empresaId, fechaInicio },
    defaults: {
      id: uuidv4(),
      empresaId,
      fechaInicio,
      fechaFin,
      estado: 'abierto',
    },
  });
  resultado.periodoId = periodo.id;

  const cuentaIdPorCodigo = {};
  for (const c of CUENTAS) {
    const [cuenta] = await PlanCuentas.findOrCreate({
      where: { empresaId, codigo: c.codigo },
      defaults: {
        id: uuidv4(),
        empresaId,
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
      where: { empresaId, eventoOrigen: r.eventoOrigen },
      defaults: {
        id: uuidv4(),
        empresaId,
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

// Seguro de correr más de una vez: usa findOrCreate en cada paso, así
// que repetirlo no duplica nada, solo confirma que todo sigue en su sitio.
async function ejecutarSeed() {
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

  const base = await sembrarCuentasReglasYPeriodo(empresa.id);
  return { empresaId: empresa.id, ...base };
}

// Las empresas que se crean desde el registro nacen sin plan de cuentas, sin
// reglas y sin periodo. Esta función les deja lo mínimo para contabilizar,
// SOLO si la empresa no tiene ninguna cuenta (nunca pisa un plan ya armado).
// Si ya tiene plan pero no hay periodo abierto, crea el del mes en curso.
// Devuelve { creado, detalle } para poder avisarle al usuario.
async function aprovisionarContabilidadBase(empresaId) {
  const totalCuentas = await PlanCuentas.count({ where: { empresaId } });
  if (totalCuentas === 0) {
    const r = await sembrarCuentasReglasYPeriodo(empresaId);
    return { creado: true, detalle: `${r.cuentas} cuentas, ${r.reglas} reglas y el periodo del mes en curso` };
  }

  const abiertos = await PeriodoContable.count({ where: { empresaId, estado: 'abierto' } });
  if (abiertos === 0) {
    const hoy = new Date();
    const fechaInicio = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    const fechaFin = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);
    const [, nuevo] = await PeriodoContable.findOrCreate({
      where: { empresaId, fechaInicio },
      defaults: { id: uuidv4(), empresaId, fechaInicio, fechaFin, estado: 'abierto' },
    });
    if (nuevo) return { creado: true, detalle: 'el periodo contable del mes en curso' };
  }
  return { creado: false, detalle: '' };
}

module.exports = { ejecutarSeed, aprovisionarContabilidadBase, EMPRESA_SEED_ID, CUENTAS };
