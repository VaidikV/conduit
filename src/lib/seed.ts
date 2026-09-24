import 'dotenv/config';
import pool from './db.js';

// Fixed UUIDs so the demo curl commands are copy-pasteable.
const HELLO_ID = '11111111-1111-1111-1111-111111111111';
const HEARTBEAT_ID = '22222222-2222-2222-2222-222222222222';
const PING_ID = '33333333-3333-3333-3333-333333333333';

async function upsert(id: string, name: string, definition: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO workflows (id, name, definition)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [id, name, JSON.stringify(definition)],
  );
}

async function main(): Promise<void> {
  await upsert(HELLO_ID, 'hello', {
    version: 1,
    trigger: { type: 'manual' },
    steps: [],
  });
  await upsert(HEARTBEAT_ID, 'heartbeat', {
    version: 1,
    trigger: { type: 'cron', cron: '*/1 * * * *' },
    steps: [],
  });
  // Point the URL at your own receiver: the local one in scripts/receiver.mjs,
  // or a webhook.site URL. The worker POSTs here and records the response.
  await upsert(PING_ID, 'webhook-ping', {
    version: 1,
    trigger: { type: 'cron', cron: '*/5 * * * *' },
    steps: [
      {
        id: 'ping',
        type: 'http_request',
        config: {
          method: 'POST',
          url: 'http://localhost:4567/hook',
          body: { hello: 'conduit' },
        },
      },
    ],
  });
  console.log('[seed] workflows ready: hello (manual), heartbeat (every minute), webhook-ping (every 5 min)');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
