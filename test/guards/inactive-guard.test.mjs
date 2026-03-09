import test from 'node:test';
import assert from 'node:assert/strict';
import { checkBeforeInactivate } from '../../lib/guards/inactive-guard.mjs';

test('inactive guard uses current market_links schema column', async () => {
  let capturedSql = '';
  const db = {
    async query(sql, params) {
      capturedSql = sql;
      assert.deepEqual(params, [[101, 202]]);
      return { rows: [] };
    },
  };

  await checkBeforeInactivate(db, [101, 202]);

  assert.match(capturedSql, /ml\.provider_market_id\s*=\s*pm\.id/i);
  assert.doesNotMatch(capturedSql, /primary_market_id|secondary_market_id/i);
});

test('inactive guard blocks when linked/snapshotted rows exist', async () => {
  const db = {
    async query() {
      return { rows: [{ id: 333, snapshots: '1', links: '1' }] };
    },
  };

  await assert.rejects(
    () => checkBeforeInactivate(db, [333]),
    /Cannot inactivate 1 markets/,
  );
});
