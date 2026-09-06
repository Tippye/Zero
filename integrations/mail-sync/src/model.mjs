import addresses from 'email-addresses';
import { createHash } from 'node:crypto';
export const defaults = { max_messages: 500, max_age_days: 90, body_budget_mb: 50, interval_seconds: 120 };
export const mid = (account,id) => `mbx.${encodeURIComponent(account)}.${encodeURIComponent(id).replace(/\./g,'%2E')}`;
const addr = value => { try { return (addresses.parseAddressList(value || '') || []).flatMap(a => a.type === 'group' ? a.addresses : [a]).map(a => ({name:a.name || '',email:a.address || ''})); } catch { return []; } };
export function preview(account, native, message, tags, count = 1) {
  const labels = tags.map(id => ({ id, name:id, type:'system' }));
  const latest = { ...message, id:mid(account,native),threadId:mid(account,native),tags:labels,body:'',decodedBody:'',processedHtml:'',attachments:[],blobUrl:'',tls:true,isDraft:tags.includes('DRAFT'),unread:tags.includes('UNREAD') };
  return { messages:[latest],latest,labels,totalReplies:count,hasUnread:tags.includes('UNREAD') };
}
export function googleEntry(account, thread) {
  const messages = thread.messages || [];
  const normal = messages.filter(m => !m.labelIds?.includes('DRAFT'));
  if (!normal.length) return null;
  const last = [...normal].sort((a,b) => Number(a.internalDate)-Number(b.internalDate)).at(-1);
  const h = Object.fromEntries((last.payload?.headers || []).map(h=>[h.name.toLowerCase(),h.value]));
  const tags = [...new Set(normal.flatMap(m=>m.labelIds || []))];
  const folders = ['inbox','sent','spam','bin'].filter((f,i)=>tags.includes(['INBOX','SENT','SPAM','TRASH'][i]));
  if (!tags.some(t=>['INBOX','SPAM','TRASH','DRAFT'].includes(t))) folders.push('archive');
  if (tags.includes('STARRED')) folders.push('starred');
  return entry(thread.id,folders,tags,preview(account,thread.id,{ sender:addr(h.from)[0] || {email:'',name:''},to:addr(h.to),cc:addr(h.cc),bcc:addr(h.bcc),subject:h.subject || '',receivedOn:new Date(Number(last.internalDate)||0).toISOString() },tags,messages.length),null,thread.historyId || '');
}
export function draftEntry(account, draft) {
  const m=draft.message || {},h=Object.fromEntries((m.payload?.headers || []).map(h=>[h.name.toLowerCase(),h.value]));
  return entry(draft.id,['draft'],['DRAFT'],null,{ id:mid(account,draft.id),sourceMessageId:m.id,subject:h.subject || '',to:addr(h.to).map(a=>a.email),rawMessage:{internalDate:m.internalDate || '0'} },m.historyId || '',new Date(Number(m.internalDate)||0).toISOString());
}
export function imapEntry(account, folder, row) {
  const tag = {inbox:'INBOX',sent:'SENT',draft:'DRAFT',archive:'ARCHIVE',spam:'SPAM',bin:'TRASH'}[folder];
  const tags=[tag,...(row.unread?['UNREAD']:[]),...(row.starred?['STARRED']:[]),...(row.important?['IMPORTANT']:[])];
  return entry(row.id,[folder,...(row.starred?['starred']:[])],tags,preview(account,row.id,{sender:row.from?.[0] || {email:'',name:''},to:row.to || [],cc:row.cc || [],bcc:row.bcc || [],subject:row.subject,receivedOn:row.receivedOn},tags),folder==='draft'?{id:mid(account,row.id),subject:row.subject,to:(row.to || []).map(a=>a.email),rawMessage:{internalDate:String(new Date(row.receivedOn).getTime())}}:null,'');
}
function entry(native_id,folders,tags,p,draft_preview,version,date) {
  const received_at=date || p?.latest.receivedOn || new Date(Number(draft_preview?.rawMessage.internalDate)||0).toISOString();
  const search_text=JSON.stringify([p?.latest.sender,p?.latest.to,p?.latest.subject,draft_preview?.to,draft_preview?.subject]).toLowerCase();
  return {native_id,kind:draft_preview?'draft':'mail',folders,tags,received_at,search_text,preview:p,draft_preview,version:version ? `provider:${version}` : createHash('sha256').update(JSON.stringify([p,draft_preview])).digest('hex')};
}
export function errorCode(error) {
  if (error.status===429 || /quota|rateLimit/i.test(error.code || '')) return 'RATE_LIMIT';
  if (error.status===401 || error.code==='invalid_grant' || error.code==='AUTH_FAILED') return 'DISCONNECTED';
  if (error.name==='TimeoutError' || /TIMEOUT/.test(error.code || '')) return 'TIMEOUT';
  return 'UNAVAILABLE';
}
