// Keep the public entry point identical locally and in CI. This runner creates
// and drops only its own isolated database; it never resets the application DB.
import './run-audit-sql-tests.mjs';
