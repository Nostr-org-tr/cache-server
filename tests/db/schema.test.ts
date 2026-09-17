import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Database Schema Migration', () => {
  it('should have a valid 0001_initial_schema.sql file', () => {
    const migrationPath = path.resolve(__dirname, '../../migrations/0001_initial_schema.sql');
    expect(fs.existsSync(migrationPath)).toBe(true);

    const sqlContent = fs.readFileSync(migrationPath, 'utf8');

    // Verify events table and essential columns
    expect(sqlContent).toContain('CREATE TABLE IF NOT EXISTS events');
    expect(sqlContent).toContain('id TEXT PRIMARY KEY');
    expect(sqlContent).toContain('pubkey TEXT NOT NULL');
    expect(sqlContent).toContain('created_at INTEGER NOT NULL');
    expect(sqlContent).toContain('kind INTEGER NOT NULL');
    expect(sqlContent).toContain('d_tag TEXT DEFAULT NULL');
    expect(sqlContent).toContain('raw_event TEXT NOT NULL');
    expect(sqlContent).toContain('created_at_recorded INTEGER NOT NULL');

    // Verify event_tags table
    expect(sqlContent).toContain('CREATE TABLE IF NOT EXISTS event_tags');
    expect(sqlContent).toContain('PRIMARY KEY (event_id, tag_name, tag_value)');
    expect(sqlContent).toContain('FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE');

    // Verify indexes
    expect(sqlContent).toContain('CREATE INDEX IF NOT EXISTS idx_events_kind_created');
    expect(sqlContent).toContain('CREATE INDEX IF NOT EXISTS idx_events_pubkey_kind_created');
    expect(sqlContent).toContain('CREATE INDEX IF NOT EXISTS idx_events_replaceable');
    expect(sqlContent).toContain('CREATE INDEX IF NOT EXISTS idx_events_created');
    expect(sqlContent).toContain('CREATE INDEX IF NOT EXISTS idx_event_tags_lookup');
  });
});
