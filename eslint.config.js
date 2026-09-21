// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    // The Edge Function entry point runs on Deno (npm: imports); its logic is in handler.ts, which is linted.
    ignores: ["dist/*", "example/*", ".expo/*", "supabase/functions/*/index.ts"],
  }
]);
