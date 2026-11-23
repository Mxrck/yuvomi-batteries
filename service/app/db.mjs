// Data layer of the batteries sidecar: opening the SQLite file and its migrations.
// The domain rules live in places.mjs; this file owns the schema, including the triggers
// that keep "Σ places = total" true whatever path writes to the database.
import { DatabaseSync } from 'node:sqlite';

// Each entry upgrades user_version N → N+1. Never edit a released migration: append a new one.
const MIGRATIONS = [
  // 1 — initial schema
  `
  CREATE TABLE pools (
    id            INTEGER PRIMARY KEY,
    kind          TEXT NOT NULL,              -- AA | AAA | C | D | 9V | CR2032 | ...
    brand         TEXT NOT NULL,
    product_line  TEXT,                       -- Max | Lithium | Recharge | Eneloop | NULL
    capacity_mah  INTEGER CHECK (capacity_mah IS NULL OR capacity_mah > 0),
    total         INTEGER NOT NULL CHECK (total >= 0),
    notes         TEXT,
    archived_at   TEXT,
    created_at    TEXT NOT NULL
  );

  -- NULLs never collide in a plain UNIQUE, and "duracell " must equal "Duracell".
  CREATE UNIQUE INDEX pools_identity
    ON pools (lower(trim(kind)), lower(trim(brand)), lower(trim(IFNULL(product_line, ''))),
              IFNULL(capacity_mah, 0))
    WHERE archived_at IS NULL;

  -- One row = some batteries of one pool in one place. A place (slug) may hold several pools.
  CREATE TABLE allocations (
    id                 INTEGER PRIMARY KEY,
    pool_id            INTEGER NOT NULL REFERENCES pools(id),
    kind               TEXT NOT NULL CHECK (kind IN ('device', 'charger', 'drawer', 'missing')),
    label              TEXT NOT NULL,
    slug               TEXT NOT NULL,
    quantity           INTEGER NOT NULL CHECK (quantity > 0),
    placed_on          TEXT NOT NULL,         -- YYYY-MM-DD, calendar of the household time zone
    checked_on         TEXT,                  -- "siguen aquí" (v1.1)
    notes              TEXT,
    closed_on          TEXT,                  -- NULL = active
    closed_reason      TEXT CHECK (closed_reason IN ('moved', 'discarded')),
    request_id         TEXT,                  -- request that created the row (traceability only)
    created_by_user_id INTEGER,
    created_by_name    TEXT,
    created_at         TEXT NOT NULL,
    CHECK ((closed_on IS NULL) = (closed_reason IS NULL))
  );

  -- Sin ubicar is kept by the server, one active row per pool at most.
  CREATE UNIQUE INDEX one_missing_per_pool ON allocations (pool_id)
    WHERE kind = 'missing' AND closed_on IS NULL;
  -- One active row per pool and place: moving into a place adds to that row.
  CREATE UNIQUE INDEX by_pool_place ON allocations (pool_id, slug) WHERE closed_on IS NULL;

  CREATE TABLE movements (
    id             INTEGER PRIMARY KEY,
    pool_id        INTEGER NOT NULL,
    allocation_id  INTEGER,
    action         TEXT NOT NULL,   -- pool_created | pool_adjusted | pool_archived | placed |
                                    -- moved | changed | found | discarded
    quantity       INTEGER,
    from_label     TEXT,
    to_label       TEXT,
    from_slug      TEXT,
    to_slug        TEXT,
    detail         TEXT,            -- JSON
    actor_user_id  INTEGER,
    actor_name     TEXT,
    via            TEXT NOT NULL CHECK (via IN ('ui', 'mcp')),
    request_id     TEXT,
    created_at     TEXT NOT NULL
  );
  CREATE INDEX movements_from_slug ON movements (from_slug);
  CREATE INDEX movements_to_slug ON movements (to_slug);

  -- Idempotency: one row per request_id with the payload it came with and the result it got.
  CREATE TABLE requests (
    request_id  TEXT PRIMARY KEY,
    operation   TEXT NOT NULL,
    payload     TEXT NOT NULL,
    result      TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );

  -- Invariant in the database: active non-missing places never exceed the pool total.
  -- (Sin ubicar is total − Σ, so it is excluded from the sum and from the check.)
  CREATE TRIGGER trg_alloc_guard_ins BEFORE INSERT ON allocations
  WHEN NEW.closed_on IS NULL AND NEW.kind <> 'missing' BEGIN
    SELECT RAISE(ABORT, 'stock_exceeded') WHERE NEW.quantity >
      (SELECT total FROM pools WHERE id = NEW.pool_id) -
      (SELECT IFNULL(SUM(quantity), 0) FROM allocations
        WHERE pool_id = NEW.pool_id AND closed_on IS NULL AND kind <> 'missing');
  END;

  CREATE TRIGGER trg_alloc_guard_upd BEFORE UPDATE OF quantity, kind, pool_id, closed_on ON allocations
  WHEN NEW.closed_on IS NULL AND NEW.kind <> 'missing' BEGIN
    SELECT RAISE(ABORT, 'stock_exceeded') WHERE NEW.quantity >
      (SELECT total FROM pools WHERE id = NEW.pool_id) -
      (SELECT IFNULL(SUM(quantity), 0) FROM allocations
        WHERE pool_id = NEW.pool_id AND closed_on IS NULL AND kind <> 'missing' AND id <> OLD.id);
  END;

  CREATE TRIGGER trg_pool_total_guard BEFORE UPDATE OF total ON pools BEGIN
    SELECT RAISE(ABORT, 'stock_exceeded') WHERE NEW.total <
      (SELECT IFNULL(SUM(quantity), 0) FROM allocations
        WHERE pool_id = NEW.id AND closed_on IS NULL AND kind <> 'missing');
  END;
  `,

  // 2 — movements.via also accepts 'api' (REST with a Bearer token). SQLite cannot alter a CHECK,
  // so the table is rebuilt with its rows and indexes.
  `
  CREATE TABLE movements_v2 (
    id             INTEGER PRIMARY KEY,
    pool_id        INTEGER NOT NULL,
    allocation_id  INTEGER,
    action         TEXT NOT NULL,
    quantity       INTEGER,
    from_label     TEXT,
    to_label       TEXT,
    from_slug      TEXT,
    to_slug        TEXT,
    detail         TEXT,
    actor_user_id  INTEGER,
    actor_name     TEXT,
    via            TEXT NOT NULL CHECK (via IN ('ui', 'mcp', 'api')),
    request_id     TEXT,
    created_at     TEXT NOT NULL
  );
  INSERT INTO movements_v2 (id, pool_id, allocation_id, action, quantity, from_label, to_label, from_slug, to_slug,
                            detail, actor_user_id, actor_name, via, request_id, created_at)
    SELECT id, pool_id, allocation_id, action, quantity, from_label, to_label, from_slug, to_slug,
           detail, actor_user_id, actor_name, via, request_id, created_at FROM movements;
  DROP TABLE movements;
  ALTER TABLE movements_v2 RENAME TO movements;
  CREATE INDEX movements_from_slug ON movements (from_slug);
  CREATE INDEX movements_to_slug ON movements (to_slug);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function migrate(db) {
  let version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > SCHEMA_VERSION) {
    throw new Error(`database schema ${version} is newer than this service (${SCHEMA_VERSION})`);
  }
  while (version < SCHEMA_VERSION) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[version]);
      version += 1;
      db.exec(`PRAGMA user_version = ${version}`); // PRAGMA takes no bound parameters
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  return db;
}

// Folds the WAL back into the main file so a plain file copy (Umbrel backup) is complete.
export function closeDb(db) {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}
