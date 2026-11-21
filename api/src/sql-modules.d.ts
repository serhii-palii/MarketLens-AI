// FILE: api/src/sql-modules.d.ts
// Type declaration for SQL files imported as raw text in tests.
declare module "*.sql?raw" {
  const content: string;
  export default content;
}
