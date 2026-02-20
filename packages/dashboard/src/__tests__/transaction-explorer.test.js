import { describe, it, expect } from 'vitest';
import { isHeartbeatEntry } from '../components/TransactionExplorer';

describe('TransactionExplorer heartbeat filter', () => {
  it('detects PING/PONG heartbeat entries case-insensitively', () => {
    expect(isHeartbeatEntry({ type: 'PING' })).toBe(true);
    expect(isHeartbeatEntry({ type: 'pong' })).toBe(true);
    expect(isHeartbeatEntry({ type: 'BidSubmitted' })).toBe(false);
  });
});

