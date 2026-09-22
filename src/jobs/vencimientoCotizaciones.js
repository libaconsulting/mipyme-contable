// Configurar en hPanel > Cron Jobs para correr diario:
//   node /home/USUARIO/mipyme-contable/src/jobs/vencimientoCotizaciones.js

const { Op } = require('sequelize');
const Cotizacion = require('../modules/ventas/models/Cotizacion');

async function ejecutar() {
  console.log(`[${new Date().toISOString()}] Revisando cotizaciones vencidas...`);

  const [afectadas] = await Cotizacion.update(
    { estado: 'expirada' },
    {
      where: {
        estado: 'enviada',
        fechaVencimiento: { [Op.lt]: new Date() },
      },
    }
  );

  console.log(`${afectadas} cotización(es) marcada(s) como expiradas.`);
  process.exit(0);
}

ejecutar().catch((error) => {
  console.error('Error en job de vencimiento de cotizaciones:', error);
  process.exit(1);
});
