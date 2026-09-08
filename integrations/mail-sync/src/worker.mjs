import postgres from 'postgres';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { defaults,imapEntry,errorCode } from './model.mjs';
import { upsert,prune } from './store.mjs';
import { resourceLimits } from './limits.mjs';
import { GoogleSync } from './google.mjs';
export async function bridge(config,ownerId,action,input={}) {
  const r=await fetch(new URL('/rpc',config.IMAP_BRIDGE_URL),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.IMAP_BRIDGE_SECRET},body:JSON.stringify({ownerId,action,input}),signal:AbortSignal.timeout(action==='sync.snapshot'?120000:5000)});
  const b=await r.json();if(!r.ok)throw Object.assign(new Error('Bridge request failed'),{status:r.status,code:b.error?.code});return b.result;
}
export async function discover(sql,config) {
  await sql`DELETE FROM mail0_mail_translations t WHERE t.created_at<=now()-coalesce((SELECT max_age_days FROM mail0_sync_settings s WHERE s.user_id=t.user_id),90)*interval '1 day'`;
  const oauth=await sql`SELECT user_id,id AS account_id,provider_id AS provider,email,coalesce(name,email) AS name FROM mail0_connection WHERE provider_id='google' AND refresh_token IS NOT NULL`;
  for(const a of oauth) await register(sql,a);
  await sql`DELETE FROM mail0_sync_accounts s WHERE provider='google' AND NOT EXISTS(SELECT 1 FROM mail0_connection c WHERE c.id=s.account_id AND c.user_id=s.user_id AND c.refresh_token IS NOT NULL)`;
  if(config.IMAP_BRIDGE_URL) for(const user of await sql`SELECT id FROM mail0_user`) {
    try {
      const accounts=await bridge(config,user.id,'accounts.list');
      for(const a of accounts) await register(sql,{user_id:user.id,account_id:a.id,email:a.email,name:a.name || a.email,provider:'imap'});
      await sql`DELETE FROM mail0_sync_accounts WHERE user_id=${user.id} AND provider='imap' AND NOT(account_id=ANY(${accounts.map(a=>a.id)}::text[]))`;
    } catch { /* Never remove cached accounts because the bridge is temporarily offline. */ }
  }
}
async function register(sql,a) {
  await sql`INSERT INTO mail0_sync_accounts(user_id,account_id,provider,email,name) VALUES(${a.user_id},${a.account_id},${a.provider},${a.email},${a.name}) ON CONFLICT(user_id,account_id) DO UPDATE SET email=excluded.email,name=excluded.name`;
}
export async function runAccount(sql,config,google,a) {
  const settings={...defaults,...(await sql`SELECT * FROM mail0_sync_settings WHERE user_id=${a.user_id}`)[0]};
  const requestedAt=a.request_stamp || a.requested_at;
  await sql`UPDATE mail0_sync_accounts SET status='syncing',error_code=NULL WHERE user_id=${a.user_id} AND account_id=${a.account_id}`;
  try {
    let checkpoint=a.checkpoint,full=false; const folderErrors={};
    if(a.provider==='google') {
      const [connection]=await sql`SELECT refresh_token FROM mail0_connection WHERE user_id=${a.user_id} AND id=${a.account_id}`;
      if(!connection?.refresh_token) return;
      ({checkpoint,full}=await google.sync(sql,{...a,...connection},settings));
    } else {
      const snapshot=await bridge(config,a.user_id,'sync.snapshot',{accountId:a.account_id,limit:settings.max_messages});
      for(const folder of snapshot.folders) {
        if(folder.error) {folderErrors[folder.folder]=folder.error;continue;}
        const rows=folder.threads.map(row=>imapEntry(a.account_id,folder.folder,row));
        await upsert(sql,a,rows);
        const ids=rows.map(r=>r.native_id);
        await sql`DELETE FROM mail0_cached_mail WHERE user_id=${a.user_id} AND account_id=${a.account_id} AND ${folder.folder}=ANY(folders) AND NOT(native_id=ANY(${ids}::text[]))`;
      }
    }
    await prune(sql,a,settings);
    await sql`UPDATE mail0_sync_accounts SET status=${Object.keys(folderErrors).length?'partial':'ready'},error_code=NULL,folder_errors=${sql.json(folderErrors)},last_synced_at=now(),next_sync_at=now()+${settings.interval_seconds}*interval '1 second',completed_request_at=${requestedAt}::text::timestamptz,checkpoint=${checkpoint},last_full_sync_at=CASE WHEN ${full} THEN now() ELSE last_full_sync_at END WHERE user_id=${a.user_id} AND account_id=${a.account_id}`;
    console.log('Mailbox sync completed',JSON.stringify({provider:a.provider,partial:Object.keys(folderErrors).length>0}));
  } catch(e) {
    const code=errorCode(e);
    await prune(sql,a,settings);
    await sql`UPDATE mail0_sync_accounts SET status='error',error_code=${code},next_sync_at=now()+${Math.max(settings.interval_seconds,code==='RATE_LIMIT'?300:60)}*interval '1 second',completed_request_at=${requestedAt}::text::timestamptz WHERE user_id=${a.user_id} AND account_id=${a.account_id}`;
    console.warn('Mailbox sync deferred',JSON.stringify({provider:a.provider,code,detail:/^[A-Z0-9_]+$/.test(e.code || '')?e.code:undefined,status:e.status}));
  }
}
export async function main(config=process.env) {
  const limits=resourceLimits(config);
  const sql=postgres(config.DATABASE_URL,{max:limits.syncAccounts+2,connect_timeout:5,idle_timeout:10});
  await sql.unsafe(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
  // One worker per database, even after accidental duplicate service starts.
  const lock=await sql.reserve();
  if(!(await lock`SELECT pg_try_advisory_lock(20260906,1) AS acquired`)[0].acquired) throw Error('Sync worker already running');
  const google=new GoogleSync(config),active=new Map();let stopped=false,lastDiscovery=0,discovery=null;
  process.on('SIGTERM',()=>stopped=true);process.on('SIGINT',()=>stopped=true);
  console.log('Local background mailbox synchronization started');
  while(!stopped) {
    try {
      await sql`INSERT INTO mail0_sync_worker_health VALUES(1,now()) ON CONFLICT(id) DO UPDATE SET heartbeat_at=excluded.heartbeat_at`;
      if(!discovery && Date.now()-lastDiscovery>30000) { lastDiscovery=Date.now(); discovery=discover(sql,config).catch(()=>console.warn('Mailbox discovery will retry')).finally(()=>discovery=null); }
      const due=await sql`SELECT *,requested_at::text AS request_stamp FROM mail0_sync_accounts WHERE next_sync_at<=now() OR requested_at>coalesce(completed_request_at,'epoch'::timestamptz) ORDER BY (requested_at>coalesce(completed_request_at,'epoch'::timestamptz)) DESC, next_sync_at,account_id LIMIT 100`;
      for(const a of due) {
        if(active.size>=limits.syncAccounts) break;
        const key=a.user_id+':'+a.account_id;if(active.has(key))continue;
        const task=runAccount(sql,config,google,a).catch(()=>console.warn('Sync database operation failed')).finally(()=>active.delete(key));active.set(key,task);
      }
    } catch {console.warn('Sync scheduler will retry after a local service failure');}
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  await Promise.allSettled([...active.values(),discovery].filter(Boolean));await lock.release();await sql.end();
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(()=>{console.error('Mailbox sync startup failed; check local service configuration');process.exitCode=1;});
