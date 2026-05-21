const { createClient } = require("@supabase/supabase-js");

if (!process.env.SUPABASE_URL) {
  throw new Error("SUPABASE_URL não configurada no .env");
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY não configurada no .env");
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = { supabase };
