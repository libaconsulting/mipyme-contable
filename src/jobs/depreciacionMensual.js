// Configurar en hPanel > Cron Jobs para correr el día 1 de cada mes:
//   node /home/USUARIO/mipyme-contable/src/jobs/depreciacionMensual.js
//
// Nivel de automatización 1 (automático total): no requiere intervención
// del contador, ver tabla de reglas de contabilización del módulo de
// activos fijos.

const { contabilizarEvento } = require('../core/services/motorAsientos');
// const ActivoFijo = require('../modules/activosFijos/models/ActivoFijo');

async function ejecutar() {
  console.log(`[${new Date().toISOString()}] Iniciando depreciación mensual...`);

  // TODO:
  // 1. Traer todos los ActivoFijo activos de todas las empresas
  // 2. Calcular cuota mensual = costo / (vida_util_meses)
  // 3. Por cada activo, llamar contabilizarEvento({ tipoEvento: 'depreciacion_mensual', ... })

  console.log('Depreciación mensual completada.');
  process.exit(0);
}

ejecutar().catch((error) => {
  console.error('Error en job de depreciación mensual:', error);
  process.exit(1);
});
