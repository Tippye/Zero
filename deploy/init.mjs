import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const url = new URL(process.argv[2] || 'http://localhost:8080');
if (
  !['http:', 'https:'].includes(url.protocol) ||
  url.username ||
  url.password ||
  url.pathname !== '/' ||
  url.search ||
  url.hash
)
  throw new Error('Provide an HTTP(S) origin without a path or credentials');
const secret = () => randomBytes(32).toString('hex');
await writeFile(
  new URL('./.env', import.meta.url),
  `# Keep this file private and back it up with the database and bridge volume.\nPUBLIC_URL=${url.origin}\nAUTH_ORIGINS=${url.origin}\nHTTP_BIND=127.0.0.1\nHTTP_PORT=${url.protocol === 'http:' ? url.port || '80' : '8080'}\nHTTPS_BIND=127.0.0.1\nHTTPS_PORT=${url.protocol === 'https:' ? url.port || '443' : '8443'}\nPOSTGRES_PASSWORD=${secret()}\nBETTER_AUTH_SECRET=${secret()}\nREDIS_TOKEN=${secret()}\nBRIDGE_SECRET=${secret()}\nBRIDGE_ENCRYPTION_KEY=${secret()}\nBRIDGE_ALLOWED_MAIL_HOSTS=\nGOOGLE_CLIENT_ID=\nGOOGLE_CLIENT_SECRET=\n`,
  { mode: 0o600, flag: 'wx' },
);
console.log(
  'Created deploy/.env. Start Compose, open the login page, then approve its pairing code from the server terminal.',
);
