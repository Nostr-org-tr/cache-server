-- Migration: 0003_vector_indexing.sql
-- Adds vector indexing tracking column to events table to facilitate background cron backfills and sync

ALTER TABLE events ADD COLUMN vector_indexed INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_events_vector_indexed ON events(vector_indexed, kind) WHERE vector_indexed = 0;
