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
