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
