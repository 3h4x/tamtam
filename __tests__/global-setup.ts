export default function globalSetup() {
  // Tests use PGlite via __tests__/helpers/test-db.ts and mock @/lib/db.
  // Guard: if a test accidentally imports @/lib/db before installing its mock,
  // make the connection point at an obviously-test URL rather than production.
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'postgres://tamtam_test@localhost:5432/tamtam_test';
  }
}
