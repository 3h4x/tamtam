# Backup and Restore

TamTam stores its data in the Postgres database referenced by `DATABASE_URL`. Backups are produced via `pg_dump --format=custom` and named `tamtam-YYYYMMDD-HHMM.pgdump`, written to `data/db/` by default (override with `TAMTAM_BACKUP_DIR`).

## Create a Backup

Use the hot backup API while TamTam is running:

```bash
curl -X POST http://localhost:1337/api/settings/backup
```

The route shells out to `pg_dump --format=custom --file=<dir>/tamtam-YYYYMMDD-HHMM.pgdump` against the active `DATABASE_URL`. Connection details are passed through libpq environment variables so passworded TCP URLs such as the local Docker default work without prompting. Any non-zero `pg_dump` exit returns `500`.

After a successful backup, TamTam prunes old backup files in the same directory:

- `backup_retention_count` keeps the newest files, default `14`. Set it to `0` to prune all older backups after each run while still keeping the newly created backup.
- `backup_retention_weekly_count` keeps one additional older backup per week, default `8`. Weekly retention is counted from older backups; the newly created backup never consumes one of these weekly slots. Set it to `0` to disable weekly retention.

## Verify the Live Database

```bash
pnpm db:verify
pnpm db:verify postgres://user@host:5432/dbname
```

The script connects with `pg.Client`, checks that the `vector` extension is present, and counts public tables. Exits non-zero on any error.

To verify a backup file without touching the live database:

```bash
node scripts/db-verify.js --backup /abs/path/to/tamtam-YYYYMMDD-HHMM.pgdump
```

## Restore a Backup

```bash
DATABASE_URL=postgres://user@host:5432/tamtam pnpm db:restore /abs/path/to/tamtam-YYYYMMDD-HHMM.pgdump
```

The restore script:

1. Stops the PM2-managed TamTam server (best-effort).
2. Runs `pg_restore --clean --if-exists --no-owner <backup>` using the connection details from `DATABASE_URL`.
3. Re-verifies the live database with `node scripts/db-verify.js`.
4. Restarts TamTam with `pnpm start`.

`pg_restore --clean --if-exists --no-owner` drops and recreates objects before reloading, so the target database does not need to be empty.

## Off-Host Copies

Local backups protect against application-level mistakes, not disk loss. Copy the newest verified `tamtam-*.pgdump` files off-host after creation. Keep the copied dump file private because it contains project paths, run prompts, logs, settings, agent definitions, and pipeline state.
