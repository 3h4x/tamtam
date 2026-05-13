export default function globalSetup() {
  // Guard against accidentally running tests against the production Postgres DB.
  // Tests that need a real DB connection should set DATABASE_URL themselves.
  // Most tests use createTestDb() (in-memory better-sqlite3) and mock @/lib/db.
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'postgres://tamtam_test@localhost:5432/tamtam_test';
  }
}
