# Backup and Restore

TamTam stores its SQLite database at `data/db/tamtam.db` by default. Set `TAMTAM_DB_PATH=/abs/path/to/tamtam.db` to point the app, backup route, and maintenance scripts at a different file.

## Create a Backup

Use the hot backup API while TamTam is running:

```bash
curl -X POST http://localhost:1337/api/settings/backup
```

The route writes `tamtam-YYYYMMDD-HHMM.db` next to the active database. It runs `PRAGMA integrity_check` and `PRAGMA foreign_key_check` on the live database first, then repeats those checks on the backup file before returning `200`. Any verification failure returns `500`.

After a successful backup, TamTam prunes old backup files in the same directory. When a backup is deleted, TamTam removes the whole SQLite file set for that backup: the base `.db` plus any `-wal` and `-shm` sidecars.

- `backup_retention_count` keeps the newest files, default `14`. Set it to `0` to prune all older backups after each run while still keeping the newly created backup.
- `backup_retention_weekly_count` keeps one additional older backup per week, default `8`. Weekly retention is counted from older backups; the newly created backup never consumes one of these weekly slots. Set it to `0` to disable weekly retention.

## Verify a Database

```bash
pnpm db:verify
pnpm db:verify /abs/path/to/backup.db
```

The script opens the target database read-only and exits non-zero if `integrity_check` or `foreign_key_check` reports a problem.

## Restore a Backup

```bash
pnpm db:restore /abs/path/to/tamtam-YYYYMMDD-HHMM.db
```

The restore script:

1. Verifies the backup file.
2. Copies the backup to a staging database next to the live DB, including `-wal` and `-shm` sidecars when they exist.
3. Runs pending Drizzle migrations against the staged database.
4. Verifies the staged database.
5. Stops the PM2-managed TamTam server. If `pnpm stop` fails while a live database already exists, the restore aborts before touching `tamtam.db`.
6. Atomically swaps the staged SQLite file set (`.db`, `-wal`, `-shm`) into place, keeping the prior live DB as a rollback copy until startup succeeds.
7. Verifies the restored live database and starts TamTam again with `pnpm start`.

If any step after the stop/swap boundary fails, the script restores the prior live database and attempts to restart TamTam on it before exiting non-zero. A failed `pnpm stop` is not treated as part of that boundary: with an existing live DB, the restore exits non-zero before any swap begins.

Run restore from the repo root. If `TAMTAM_DB_PATH` is set, the backup is copied to that path instead of `data/db/tamtam.db`.

## Off-Host Copies

Local backups protect against application-level mistakes, not disk loss. Copy the newest verified `tamtam-*.db` files off-host after creation. Keep the copied database file private because it contains project paths, run prompts, logs, settings, agent definitions, and pipeline state.
