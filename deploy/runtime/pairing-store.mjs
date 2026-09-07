// Shared by the API and the server-local recovery CLI. No credential is logged.
export class PairingError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export const normalizeCode = (code) => {
  const value = String(code || '')
    .toUpperCase()
    .replace(/[ -]/g, '');
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(value))
    throw new PairingError('invalid_code');
  return value;
};
export const randomSecret = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
export async function digest(value) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
export async function limit(sql, key, maximum, seconds = 600) {
  const [row] = await sql`INSERT INTO mail0_pairing_rate(key,count,expires_at)
    VALUES(${key},1,now()+${seconds}*interval '1 second') ON CONFLICT(key) DO UPDATE SET
    count=CASE WHEN mail0_pairing_rate.expires_at<=now() THEN 1 ELSE mail0_pairing_rate.count+1 END,
    expires_at=CASE WHEN mail0_pairing_rate.expires_at<=now() THEN now()+${seconds}*interval '1 second' ELSE mail0_pairing_rate.expires_at END
    RETURNING count`;
  if (row.count > maximum) throw new PairingError('rate_limited', 429);
}
export async function startPairing(sql, { origin, deviceName, mode = 'cookie' }) {
  if (!['cookie', 'native'].includes(mode)) throw new PairingError('invalid_mode');
  if (
    typeof deviceName !== 'string' ||
    !deviceName.trim() ||
    deviceName.length > 80 ||
    Array.from(deviceName).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new PairingError('invalid_device_name');
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = Array.from(
    crypto.getRandomValues(new Uint8Array(8)),
    (b) => alphabet[b % alphabet.length],
  ).join('');
  const secret = randomSecret(),
    id = crypto.randomUUID();
  const [row] =
    await sql`INSERT INTO mail0_pairing_request(id,code_hash,secret_hash,origin,device_name,mode)
    VALUES(${id},${await digest(code)},${await digest(secret)},${origin},${deviceName.trim()},${mode}) RETURNING expires_at`;
  await sql`DELETE FROM mail0_pairing_request WHERE expires_at<now()-interval '1 day'`;
  await sql`DELETE FROM mail0_pairing_rate WHERE expires_at<now()-interval '1 day'`;
  return {
    requestId: id,
    deviceSecret: secret,
    userCode: code.slice(0, 4) + '-' + code.slice(4),
    expiresAt: new Date(row.expires_at).toISOString(),
    interval: 5,
    verificationUri: origin + '/pair',
    verificationUriComplete: origin + '/pair#code=' + code.slice(0, 4) + '-' + code.slice(4),
  };
}
export async function previewPairing(sql, code) {
  const [row] =
    await sql`SELECT id AS "requestId",origin,device_name AS "deviceName",created_at AS "createdAt",expires_at AS "expiresAt",status
    FROM mail0_pairing_request WHERE code_hash=${await digest(normalizeCode(code))} AND expires_at>now() AND status='pending'`;
  if (!row) throw new PairingError('invalid_or_expired_code', 404);
  return {
    ...row,
    createdAt: new Date(row.createdAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
  };
}
export async function decidePairing(sql, { code, requestId, userId, approve }) {
  if (typeof requestId !== 'string' || !requestId || requestId.length > 64)
    throw new PairingError('invalid_request');
  const [owner] = await sql`SELECT user_id FROM mail0_pairing_owner WHERE id=1`;
  if (!owner || owner.user_id !== userId) throw new PairingError('wrong_workspace', 403);
  const [row] =
    await sql`UPDATE mail0_pairing_request SET status=${approve ? 'approved' : 'denied'},user_id=${userId}
    WHERE id=${requestId} AND code_hash=${await digest(normalizeCode(code))} AND expires_at>now() AND status='pending' RETURNING id`;
  if (!row) throw new PairingError('invalid_or_expired_code', 404);
  return { status: approve ? 'approved' : 'denied' };
}
export async function exchangePairing(sql, { requestId, deviceSecret, origin, userAgent = '' }) {
  if (
    typeof requestId !== 'string' ||
    requestId.length > 64 ||
    !/^[a-f0-9]{64}$/.test(deviceSecret || '')
  )
    throw new PairingError('invalid_device_secret');
  const hash = await digest(deviceSecret);
  return sql.begin(async (tx) => {
    const [row] =
      await tx`SELECT * FROM mail0_pairing_request WHERE id=${requestId} AND secret_hash=${hash} FOR UPDATE`;
    if (!row || row.origin !== origin) throw new PairingError('invalid_device_secret', 403);
    if (new Date(row.expires_at).getTime() <= Date.now() || row.status === 'consumed')
      throw new PairingError('expired_token', 410);
    if (row.status === 'denied') throw new PairingError('access_denied', 403);
    if (row.last_poll_at && Date.now() - new Date(row.last_poll_at).getTime() < 4000)
      return { status: 'slow_down', interval: 5 };
    await tx`UPDATE mail0_pairing_request SET last_poll_at=now() WHERE id=${row.id}`;
    if (row.status === 'pending') return { status: 'authorization_pending', interval: 5 };
    const token = randomSecret(),
      id = crypto.randomUUID();
    const [session] =
      await tx`INSERT INTO mail0_session(id,token,user_id,expires_at,created_at,updated_at,user_agent)
      VALUES(${id},${token},${row.user_id},now()+interval '30 days',now(),now(),${userAgent.slice(0, 512)}) RETURNING id,token,expires_at`;
    await tx`INSERT INTO mail0_pairing_device(session_id,name) VALUES(${id},${row.device_name})`;
    await tx`UPDATE mail0_pairing_request SET status='consumed' WHERE id=${row.id}`;
    return {
      status: 'authorized',
      mode: row.mode,
      session: { ...session, expires_at: new Date(session.expires_at).toISOString() },
    };
  });
}
