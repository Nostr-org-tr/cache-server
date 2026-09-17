-- Migration: 0002_gc_indexes.sql
-- Description: Performance indexes for rolling expiration garbage collection (GC)

CREATE INDEX IF NOT EXISTS idx_events_kind_recorded 
    ON events (kind, created_at_recorded ASC);

CREATE INDEX IF NOT EXISTS idx_events_recorded 
    ON events (created_at_recorded ASC);
