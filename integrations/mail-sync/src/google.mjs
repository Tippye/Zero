import { fetch, ProxyAgent } from 'undici';
import { googleEntry, draftEntry } from './model.mjs';
import { upsert } from './store.mjs';
export class GoogleSync {
  constructor(config) { this.config=config; this.tokens=new Map(); this.dispatcher=config.ZERO_GOOGLE_PROXY?new ProxyAgent(config.ZERO_GOOGLE_PROXY):undefined; }
  async json(url, options={}) {
    const response=await fetch(url,{...options,dispatcher:this.dispatcher,signal:AbortSignal.timeout(30000),redirect:'manual'});
    const data=await response.json();
    if (!response.ok) throw Object.assign(new Error('Google request failed'),{status:response.status,code:typeof data.error==='string'?data.error:data.error?.errors?.[0]?.reason});
    return data;
  }
  async token(a) {
    const current=this.tokens.get(a.account_id);
    if(current?.until>Date.now()) return current.value;
    const value=await this.json('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:this.config.GOOGLE_CLIENT_ID,client_secret:this.config.GOOGLE_CLIENT_SECRET,refresh_token:a.refresh_token,grant_type:'refresh_token'}).toString()});
    this.tokens.set(a.account_id,{value:value.access_token,until:Date.now()+(value.expires_in-60)*1000});return value.access_token;
  }
  async sync(sql,a,settings) {
    const token=await this.token(a);
    const api=(path,query={})=>this.json('https://gmail.googleapis.com/gmail/v1/users/me/'+path+'?'+new URLSearchParams(query),{headers:{Authorization:'Bearer '+token}});
    const load=async id=>{try {return googleEntry(a.account_id,await api('threads/'+encodeURIComponent(id),{format:'metadata'}));}catch(e){if(e.status===404)return null;throw e;}};
    let checkpoint=a.checkpoint, full=!checkpoint || !a.last_full_sync_at || Date.now()-new Date(a.last_full_sync_at).getTime()>86400000;
    if(!full) {
      try {
        const historyStart=checkpoint;
        let pageToken='', changed=new Set();
        do {
          const h=await api('history',{startHistoryId:historyStart,maxResults:'500',...(pageToken?{pageToken}:{})});
          for(const event of h.history || []) for(const m of event.messages || []) if(m.threadId) changed.add(m.threadId);
          checkpoint=h.historyId;pageToken=h.nextPageToken || '';
          if(changed.size>settings.max_messages*2) {full=true;break;}
        } while(pageToken);
        if(!full) for(const id of changed) {
          const row=await load(id);
          if(row) await upsert(sql,a,[row]);
          else await sql`DELETE FROM mail0_cached_mail WHERE user_id=${a.user_id} AND account_id=${a.account_id} AND kind='mail' AND native_id=${id}`;
        }
      } catch(e) {if(e.status===404) full=true;else throw e;}
    }
    if(full) {
      checkpoint=(await api('profile')).historyId;
      const ids=[],seen=[], versions=new Map();let pageToken='';
      do {
        const page=await api('threads',{q:`newer_than:${settings.max_age_days}d -in:drafts`,maxResults:String(Math.min(100,settings.max_messages-ids.length)),includeSpamTrash:'true',...(pageToken?{pageToken}:{})});
        for(const thread of page.threads || []) {ids.push(thread.id);if(thread.historyId)versions.set(thread.id,`provider:${thread.historyId}`);}pageToken=page.nextPageToken || '';
      } while(pageToken && ids.length<settings.max_messages);
      const existing=await sql`SELECT native_id,version FROM mail0_cached_mail WHERE user_id=${a.user_id} AND account_id=${a.account_id} AND kind='mail'`;
      const unchanged=new Set(existing.filter(r=>versions.get(r.native_id)===r.version).map(r=>r.native_id));
      seen.push(...ids.filter(id=>unchanged.has(id)));
      const missing=ids.filter(id=>!unchanged.has(id));
      // Two requests at a time keep the background worker below provider rate limits.
      for(let i=0;i<missing.length;i+=2) {
        const rows=await Promise.all(missing.slice(i,i+2).map(load));
        if (i+2<missing.length) await new Promise(resolve=>setTimeout(resolve,1000));
        await upsert(sql,a,rows);seen.push(...rows.filter(Boolean).map(r=>r.native_id));
      }
      await sql`DELETE FROM mail0_cached_mail WHERE user_id=${a.user_id} AND account_id=${a.account_id} AND kind='mail' AND NOT(native_id=ANY(${seen}::text[]))`;
    }
    // Draft IDs differ from thread/message IDs; preserve them for the existing composer.
    const drafts=[];let pageToken='';
    do {
      const page=await api('drafts',{maxResults:String(Math.min(100,settings.max_messages-drafts.length)),q:`newer_than:${settings.max_age_days}d`,...(pageToken?{pageToken}:{})});
      drafts.push(...(page.drafts || []));pageToken=page.nextPageToken || '';
    } while(pageToken && drafts.length<settings.max_messages);
    const existingDrafts=await sql`SELECT native_id,draft_preview FROM mail0_cached_mail WHERE user_id=${a.user_id} AND account_id=${a.account_id} AND kind='draft'`;
    const sameDraft=new Set(drafts.filter(d=>existingDrafts.some(r=>r.native_id===d.id && r.draft_preview?.sourceMessageId===d.message.id)).map(d=>d.id));
    const draftIds=[...sameDraft], changedDrafts=drafts.filter(d=>!sameDraft.has(d.id));
    for(let i=0;i<changedDrafts.length;i+=2) {
      const rows=await Promise.all(changedDrafts.slice(i,i+2).map(async d=>{
        try {return draftEntry(a.account_id,{id:d.id,message:await api('messages/'+encodeURIComponent(d.message.id),{format:'metadata'})});}
        catch(e){if(e.status===404)return null;throw e;}
      }));
      if (i+2<changedDrafts.length) await new Promise(resolve=>setTimeout(resolve,1000));
      await upsert(sql,a,rows);draftIds.push(...rows.filter(Boolean).map(r=>r.native_id));
    }
    await sql`DELETE FROM mail0_cached_mail WHERE user_id=${a.user_id} AND account_id=${a.account_id} AND kind='draft' AND NOT(native_id=ANY(${draftIds}::text[]))`;
    return {checkpoint,full};
  }
}
