import { describe, it, expect } from 'vitest';
import { parseClientMessage, parseRelayMessage } from '../../src/protocol/parser';
import {
  formatClosedMessage,
  formatCountMessage,
  formatEoseMessage,
  formatEventMessage,
  formatNoticeMessage,
  formatOkMessage,
} from '../../src/protocol/formatter';
import type { NostrEvent } from '../../src/types/nostr';

describe('Nostr Message Parser & Formatter', () => {
  const dummyEvent: NostrEvent = {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: 1700000000,
    kind: 1,
    tags: [['e', 'c'.repeat(64)]],
    content: 'Hello Nostr',
    sig: 'd'.repeat(128),
  };

  describe('Client Message Parser', () => {
    it('parses valid REQ message with single and multiple filters', () => {
      const rawSingle = JSON.stringify(['REQ', 'sub-1', { kinds: [1, 0], limit: 50 }]);
      const parsedSingle = parseClientMessage(rawSingle);
      expect(parsedSingle.ok).toBe(true);
      if (parsedSingle.ok) {
        expect(parsedSingle.value[0]).toBe('REQ');
        expect(parsedSingle.value[1]).toBe('sub-1');
        expect(parsedSingle.value[2]).toEqual({ kinds: [1, 0], limit: 50 });
      }

      const rawMulti = JSON.stringify([
        'REQ',
        'sub-2',
        { authors: ['a'.repeat(64)] },
        { '#e': ['b'.repeat(64)] },
      ]);
      const parsedMulti = parseClientMessage(rawMulti);
      expect(parsedMulti.ok).toBe(true);
      if (parsedMulti.ok) {
        expect(parsedMulti.value.length).toBe(4);
      }
    });

    it('parses valid EVENT message', () => {
      const raw = JSON.stringify(['EVENT', dummyEvent]);
      const parsed = parseClientMessage(raw);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value[0]).toBe('EVENT');
        expect(parsed.value[1]).toEqual(dummyEvent);
      }
    });

    it('parses valid CLOSE message', () => {
      const raw = JSON.stringify(['CLOSE', 'sub-123']);
      const parsed = parseClientMessage(raw);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value).toEqual(['CLOSE', 'sub-123']);
      }
    });

    it('parses valid COUNT message', () => {
      const raw = JSON.stringify(['COUNT', 'count-sub', { kinds: [1] }]);
      const parsed = parseClientMessage(raw);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value[0]).toBe('COUNT');
        expect(parsed.value[1]).toBe('count-sub');
      }
    });

    it('rejects invalid JSON syntax', () => {
      const result = parseClientMessage('{ invalid json }');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Invalid JSON');
      }
    });

    it('rejects unsupported message verbs', () => {
      const result = parseClientMessage(JSON.stringify(['UNKNOWN_VERB', 'test']));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Unsupported message verb');
      }
    });

    it('rejects REQ with empty or non-string subscription ID', () => {
      const result1 = parseClientMessage(JSON.stringify(['REQ', '', {}]));
      expect(result1.ok).toBe(false);

      const result2 = parseClientMessage(JSON.stringify(['REQ', 123, {}]));
      expect(result2.ok).toBe(false);
    });

    it('rejects REQ with invalid filter structure', () => {
      const result = parseClientMessage(JSON.stringify(['REQ', 'sub-1', { kinds: ['invalid_kind'] }]));
      expect(result.ok).toBe(false);
    });
  });

  describe('Relay Message Parser', () => {
    it('parses EVENT, OK, EOSE, CLOSED, NOTICE, COUNT relay messages', () => {
      const eventMsg = parseRelayMessage(JSON.stringify(['EVENT', 'sub-1', dummyEvent]));
      expect(eventMsg.ok).toBe(true);

      const okMsg = parseRelayMessage(JSON.stringify(['OK', dummyEvent.id, true, 'saved']));
      expect(okMsg.ok).toBe(true);

      const eoseMsg = parseRelayMessage(JSON.stringify(['EOSE', 'sub-1']));
      expect(eoseMsg.ok).toBe(true);

      const closedMsg = parseRelayMessage(JSON.stringify(['CLOSED', 'sub-1', 'auth-required: please sign in']));
      expect(closedMsg.ok).toBe(true);

      const noticeMsg = parseRelayMessage(JSON.stringify(['NOTICE', 'Rate limit exceeded']));
      expect(noticeMsg.ok).toBe(true);

      const countMsg = parseRelayMessage(JSON.stringify(['COUNT', 'sub-1', { count: 42 }]));
      expect(countMsg.ok).toBe(true);
    });
  });

  describe('Relay Message Formatters', () => {
    it('correctly formats all outbound relay message strings', () => {
      expect(formatEventMessage('sub-1', dummyEvent)).toBe(JSON.stringify(['EVENT', 'sub-1', dummyEvent]));
      expect(formatOkMessage(dummyEvent.id, true, 'saved')).toBe(
        JSON.stringify(['OK', dummyEvent.id, true, 'saved'])
      );
      expect(formatEoseMessage('sub-1')).toBe(JSON.stringify(['EOSE', 'sub-1']));
      expect(formatClosedMessage('sub-1', 'rate-limited')).toBe(
        JSON.stringify(['CLOSED', 'sub-1', 'rate-limited'])
      );
      expect(formatNoticeMessage('hello')).toBe(JSON.stringify(['NOTICE', 'hello']));
      expect(formatCountMessage('sub-1', 100)).toBe(JSON.stringify(['COUNT', 'sub-1', { count: 100 }]));
    });
  });
});
