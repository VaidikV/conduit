import 'dotenv/config';
import pool from './db.js';

// Fixed UUIDs so the demo curl commands are copy-pasteable.
const HELLO_ID = '11111111-1111-1111-1111-111111111111';
const HEARTBEAT_ID = '22222222-2222-2222-2222-222222222222';

async function main(): Promise<void> {
  await pool.query(
    `INSERT INTO workflows (id, name, definition)
     VALUES ($1, 'hello', $2)
     ON CONFLICT (id) DO NOTHING`,
    [HELLO_ID, JSON.stringify({ trigger: { type: 'manual' }, steps: [] })],
  );
  await pool.query(
    `INSERT INTO workflows (id, name, definition)
     VALUES ($1, 'heartbeat', $2)
     ON CONFLICT (id) DO NOTHING`,
    [HEARTBEAT_ID, JSON.stringify({ trigger: { type: 'cron', cron: '*/1 * * * *' }, steps: [] })],
  );
  console.log('[seed] workflows ready: hello (manual), heartbeat (every minute)');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
