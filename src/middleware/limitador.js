// Limitador de intentos en memoria (sin dependencias): sirve para frenar fuerza bruta en el login y el
// registro de empresas. La cuenta vive en el proceso: si el servidor se reinicia, se reinicia con él.
// Es suficiente para un solo proceso de Node (hosting administrado); con varios procesos habría que
// moverlo a la base de datos o a Redis.
function crearLimitador({ ventanaMs, max }) {
  const intentos = new Map(); // clave -> { cuenta, desde }

  function vigente(clave, ahora) {
    const x = intentos.get(clave);
    if (!x) return null;
    if (ahora - x.desde >= ventanaMs) {
      intentos.delete(clave);
      return null;
    }
    return x;
  }

  function limpiar(ahora) {
    if (intentos.size < 5000) return;
    for (const [k, x] of intentos) if (ahora - x.desde >= ventanaMs) intentos.delete(k);
  }

  return {
    // ¿Todavía puede intentar? No consume un intento.
    permitido(clave, ahora = Date.now()) {
      const x = vigente(clave, ahora);
      return !x || x.cuenta < max;
    },
    // Cuenta un intento (fallido, o simplemente hecho).
    registrar(clave, ahora = Date.now()) {
      limpiar(ahora);
      const x = vigente(clave, ahora);
      if (x) x.cuenta += 1;
      else intentos.set(clave, { cuenta: 1, desde: ahora });
    },
    reiniciar(clave) {
      intentos.delete(clave);
    },
    // Minutos que faltan para que se libere la clave.
    minutosRestantes(clave, ahora = Date.now()) {
      const x = vigente(clave, ahora);
      return x ? Math.max(1, Math.ceil((x.desde + ventanaMs - ahora) / 60000)) : 0;
    },
  };
}

// Middleware: cuenta CADA petición por IP y responde 429 al pasar el máximo.
function porIp(limitador, mensaje) {
  return (req, res, next) => {
    const clave = req.ip || 'sin-ip';
    if (!limitador.permitido(clave)) {
      return res.status(429).json({ error: `${mensaje || 'Demasiados intentos.'} Intenta de nuevo en ${limitador.minutosRestantes(clave)} minuto(s).` });
    }
    limitador.registrar(clave);
    next();
  };
}

module.exports = { crearLimitador, porIp };
