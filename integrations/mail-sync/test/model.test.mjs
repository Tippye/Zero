import test from 'node:test';
import assert from 'node:assert/strict';
import {googleEntry,draftEntry,imapEntry,errorCode} from '../src/model.mjs';
test('Google metadata maps folders and thread identity without downloading bodies',()=>{
 const r=googleEntry('a',{id:'same',historyId:'2',messages:[{id:'message',internalDate:'1788650000000',labelIds:['INBOX','UNREAD','STARRED'],payload:{headers:[{name:'From',value:'Sender <sender@example.invalid>'},{name:'Subject',value:'Hello'}]}}]});
 assert.deepEqual(r.folders,['inbox','starred']);assert.equal(r.preview.latest.sender.email,'sender@example.invalid');assert.equal(r.preview.latest.threadId,'mbx.a.same');assert.equal(r.preview.latest.body,'');
 assert.equal(googleEntry('a',{id:'draftonly',messages:[{labelIds:['DRAFT']}]}),null);
});
test('draft and IMAP IDs remain provider-specific and account-scoped',()=>{
 const d=draftEntry('a',{id:'draft-id',message:{id:'message-id',internalDate:'1788650000000',payload:{headers:[]}}});
 assert.equal(d.draft_preview.id,'mbx.a.draft-id');assert.equal(d.kind,'draft');
 const a=imapEntry('a','inbox',{id:'native',subject:'test',receivedOn:'2026-09-06T00:00:00Z',unread:true});
 const b=imapEntry('b','inbox',{id:'native',subject:'test',receivedOn:'2026-09-06T00:00:00Z',unread:true});
 assert.notEqual(a.preview.latest.id,b.preview.latest.id);assert.ok(a.tags.includes('UNREAD'));
 assert.equal(errorCode({status:429}),'RATE_LIMIT');assert.equal(errorCode({code:'AUTH_FAILED'}),'DISCONNECTED');
});
