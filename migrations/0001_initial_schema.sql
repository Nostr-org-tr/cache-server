-- Migration: 0001_initial_schema.sql
-- Description: Initial schema for cache.nostr.org.tr with hybrid event storage and indexed tags

-- Main Events Table (Hybrid Model)
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,                       -- 64-char hex SHA-256 hash
    pubkey TEXT NOT NULL,                      -- 64-char hex secp256k1 public key
    created_at INTEGER NOT NULL,               -- Unix epoch timestamp in seconds
    kind INTEGER NOT NULL,                     -- Nostr Event Kind integer
    d_tag TEXT DEFAULT NULL,                   -- Extracted 'd' tag value for parameterized replaceable (kinds 30000-39999)
    raw_event TEXT NOT NULL,                   -- Complete canonical JSON payload of the event
    created_at_recorded INTEGER NOT NULL       -- Ingest timestamp for relay-side monitoring
);

-- Tag Indexing Table (for high-speed multi-tag NIP-01 filters like #e, #p, #t, #d, #a)
CREATE TABLE IF NOT EXISTS event_tags (
    event_id TEXT NOT NULL,
    tag_name TEXT NOT NULL,                    -- Tag identifier (e, p, t, d, a, etc.)
    tag_value TEXT NOT NULL,                   -- Indexed value
    PRIMARY KEY (event_id, tag_name, tag_value),
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_events_kind_created 
    ON events (kind, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_pubkey_kind_created 
    ON events (pubkey, kind, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_replaceable 
    ON events (pubkey, kind, d_tag, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_created 
    ON events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_tags_lookup 
    ON event_tags (tag_name, tag_value, event_id);
