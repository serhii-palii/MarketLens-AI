// FILE: api/src/worker.ts
// Worker entry point exposing the HTTP handler.
import { app } from "./api-routes";

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
