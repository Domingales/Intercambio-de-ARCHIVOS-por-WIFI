CREATE TABLE IF NOT EXISTS rooms (
 id TEXT PRIMARY KEY,
 owner TEXT NOT NULL,
 offer TEXT NOT NULL,
 answer TEXT,
 expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rooms_expiry ON rooms(expires);
CREATE TABLE IF NOT EXISTS rates (
 key TEXT PRIMARY KEY,
 count INTEGER NOT NULL,
 expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rates_expiry ON rates(expires);

-- Version 2.1: ejecutar también sobre la base existente. No borra tablas anteriores.
CREATE TABLE IF NOT EXISTS pin_sessions (
 id TEXT PRIMARY KEY,
 codehash TEXT NOT NULL UNIQUE,
 firstkey TEXT NOT NULL,
 secondkey TEXT,
 offer TEXT,
 answer TEXT,
 expires INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'waiting'
);
CREATE INDEX IF NOT EXISTS pin_sessions_expiry ON pin_sessions(expires);
