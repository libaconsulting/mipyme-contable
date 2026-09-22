// Este archivo NO es parte de la arquitectura real de la aplicación.
// Existe únicamente porque el flujo de conexión de Hostinger con Supabase
// lo requiere para inyectar automáticamente las variables de entorno de
// la base de datos. Nuestra app se conecta a través de
// src/config/database.js con Sequelize, no desde aquí.
//
// Una vez confirmemos qué variables de entorno quedaron cargadas en
// Hostinger, este archivo se puede eliminar sin ningún impacto.

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;
