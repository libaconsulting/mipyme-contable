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
