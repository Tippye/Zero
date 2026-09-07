import { decidePairing, previewPairing } from './pairing-store.mjs';
import { createInterface } from 'node:readline/promises';
import postgres from 'postgres';

const [command, value, flag] = process.argv.slice(2);
if (!['approve', 'deny', 'devices', 'revoke', 'revoke-all'].includes(command)) {
  console.error(
    'Usage: node pairing.mjs approve|deny CODE [--yes] | devices | revoke SESSION_ID [--yes] | revoke-all --yes',
  );
  process.exit(1);
}
if (!process.env.DATABASE_URL)
  throw new Error('DATABASE_URL is required. Run this command inside the Zero api container.');
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
async function confirm(message) {
  if (flag === '--yes' || (command === 'revoke-all' && value === '--yes')) return;
  if (!process.stdin.isTTY)
    throw new Error('Review the request and pass --yes to confirm, or run interactively.');
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if ((await input.question(message + ' [yes/no] ')).trim().toLowerCase() !== 'yes')
      throw new Error('Cancelled');
  } finally {
    input.close();
  }
}
try {
  const [owner] = await sql`SELECT user_id FROM mail0_pairing_owner WHERE id=1`;
  if (!owner) throw new Error('Run database initialization first');
  if (command === 'approve' || command === 'deny') {
    const request = await previewPairing(sql, value);
    console.log(JSON.stringify(request, null, 2));
    await confirm(
      command === 'approve'
        ? 'Authorize this device to access your workspace?'
        : 'Deny this device?',
    );
    await decidePairing(sql, {
      code: value,
      requestId: request.requestId,
      userId: owner.user_id,
      approve: command === 'approve',
    });
    console.log(
      command === 'approve'
        ? 'Device approved. Return to the requesting device.'
        : 'Device denied.',
    );
  } else if (command === 'devices') {
    const rows =
      await sql`SELECT s.id,coalesce(d.name,'Previous device') AS name,s.created_at,s.expires_at FROM mail0_session s
      LEFT JOIN mail0_pairing_device d ON d.session_id=s.id WHERE s.user_id=${owner.user_id} AND s.expires_at>now() ORDER BY s.created_at DESC`;
    console.log(JSON.stringify(rows, null, 2));
  } else {
    await confirm(
      command === 'revoke-all'
        ? 'Sign out all devices and cancel pending approvals?'
        : 'Sign out this device?',
    );
    const rows = await sql.begin(async (tx) => {
      if (command === 'revoke-all') {
        await tx`UPDATE mail0_pairing_request SET status='denied' WHERE status IN ('pending','approved')`;
        return tx`DELETE FROM mail0_session WHERE user_id=${owner.user_id} RETURNING id`;
      }
      return tx`DELETE FROM mail0_session WHERE user_id=${owner.user_id} AND id=${value || ''} RETURNING id`;
    });
    console.log(`Revoked ${rows.length} device(s).`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
