// FILE: api/src/ambient-types.d.ts
// Type declarations for secret bindings and for SQL files imported as raw text in tests.

// Secret bindings are set outside wrangler.jsonc (local .dev.vars file or deployed Worker secrets).
interface Env {
  OWNER_ACCESS_KEY: string;
  SESSION_SECRET: string;
}

declare module "*.sql?raw" {
  const content: string;
  export default content;
}
