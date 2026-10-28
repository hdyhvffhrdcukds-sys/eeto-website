// Real SQLite constraints and production worker routes; synthetic data only.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from './src/index.js';
const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('./migrations/0004-concurrent-sessions.sql', import.meta.url), 'utf8'));
db.exec('ALTER TABLE licenses ADD COLUMN key_value TEXT; CREATE TABLE admin_credentials(id INTEGER PRIMARY KEY, key_hash TEXT, bootstrap_hash TEXT)');
const env = { ADMIN_API_KEY:'isolated-test-only', DB:{
  prepare(sql) { return { async all() { return {results:db.prepare(sql).all()}; }, bind(...args) { return {
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async all() { return {results:db.prepare(sql).all(...args)}; },
    async run() { return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}}; }
  }; } }; }
}};
async function request(path, body, method='POST') {
  const response = await worker.fetch(new Request('https://example.test/v1/'+path, {
    method, headers:{'content-type':'application/json','x-admin-key':env.ADMIN_API_KEY},
    ...(method==='GET'?{}:{body:JSON.stringify(body)})
  }), env);
  return {status:response.status,body:await response.json()};
}
const failures=[];
async function test(name, action) { try { await action(); console.log('PASS '+name); } catch(e) { failures.push(name); console.error('FAIL '+name+': '+e.message); } }
async function fixture(maxDevices) {
  const created=await request('admin/licenses',{customerName:'synthetic',maxDevices});
  assert.equal(created.status,201); const {id,licenseKey}=created.body;
  const payload=(deviceId,activationToken,sessionId,purpose='startup')=>({deviceId,activationToken,sessionId:id+sessionId,protocolVersion:2,purpose});
  return {id,licenseKey,
    activate:(deviceId,sessionId=deviceId)=>request('activate',{licenseKey,deviceId,sessionId:id+sessionId,protocolVersion:2}),
    check:(deviceId,activationToken,sessionId=deviceId,purpose='nc-export')=>request('check',payload(deviceId,activationToken,sessionId,purpose)),
    release:(deviceId,activationToken,sessionId=deviceId)=>request('release',payload(deviceId,activationToken,sessionId)),
    active:()=>Number(db.prepare('SELECT COUNT(DISTINCT a.id) AS n FROM activations a JOIN license_sessions s ON s.activation_id=a.id WHERE a.license_id=? AND a.revoked_at IS NULL AND s.released_at IS NULL').get(id).n)};
}
await test('empty license displays zero PCs',async()=>{
  const f=await fixture(1);const list=await request('admin/licenses',null,'GET');
  assert.equal(list.body.licenses.find(x=>x.id===f.id).active_devices,0);
});
await test('ten installed PCs, one concurrent slot; normal exit permits next PC',async()=>{
  const f=await fixture(1);const first=await f.activate('pc0');assert.equal(first.status,200);
  for(let i=1;i<10;i++) assert.equal((await f.activate('pc'+i)).status,409);
  assert.equal(f.active(),1);
  assert.equal((await f.check('pc0',first.body.activationToken)).status,200);
  await f.release('pc0',first.body.activationToken);
  assert.equal((await f.activate('pc1')).status,200);
  assert.equal((await f.check('pc0',first.body.activationToken)).status,403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM activations WHERE license_id=?').get(f.id).n,10);
});
await test('twenty simultaneous launches cannot exceed quotas 1, 2 or 5',async()=>{
  for(const max of [1,2,5]) {const f=await fixture(max);
    const r=await Promise.all(Array.from({length:20},(_,i)=>f.activate('pc'+i)));
    assert.equal(r.filter(x=>x.status===200).length,max);assert.equal(f.active(),max);
    assert.ok(r.every(x=>[200,409].includes(x.status)));
  }
});
await test('same PC processes share one slot, exit releases only that process',async()=>{
  const f=await fixture(1);const a=await f.activate('a','process1');const t=a.body.activationToken;
  assert.equal((await f.check('a',t,'process2','startup')).status,200);
  await f.release('a',t,'process1');assert.equal(f.active(),1);
  assert.equal((await f.check('a',t,'process2')).status,200);
  assert.equal((await f.activate('b')).status,409);
  await f.release('a',t,'process2');assert.equal(f.active(),0);
  assert.equal((await f.activate('b')).status,200);
});
await test('no idle expiry: a PC doing no NC work retains usage',async()=>{
  const f=await fixture(1);const a=await f.activate('a');
  db.prepare('UPDATE license_sessions SET created_at=? WHERE activation_id IN (SELECT id FROM activations WHERE license_id=?)').run('2000-01-01T00:00:00Z',f.id);
  assert.equal((await f.activate('b')).status,409);
  assert.equal((await f.check('a',a.body.activationToken)).status,200);
});
await test('admin releases crashed PC; old process cannot export or reacquire same session',async()=>{
  const f=await fixture(1);const a=await f.activate('a');
  const list=await request('admin/licenses/'+f.id+'/sessions',null,'GET');assert.equal(list.body.sessions.length,1);
  const id=list.body.sessions[0].activation_id;
  await request('admin/licenses/'+f.id+'/release-device',{activationId:id});assert.equal(f.active(),0);
  const b=await f.activate('b');assert.equal(b.status,200);
  assert.equal((await f.check('a',a.body.activationToken)).status,403);
  assert.equal((await f.check('a',a.body.activationToken,'a','startup')).status,409);
  assert.equal((await f.check('a',a.body.activationToken,'new-process','startup')).status,409);
  await f.release('b',b.body.activationToken);
  assert.equal((await f.check('a',a.body.activationToken,'new-process','startup')).status,200);
});
await test('release cannot affect another device/session/license; duplicate release harmless',async()=>{
  const f=await fixture(2);const a=await f.activate('a');const b=await f.activate('b');
  await f.release('b',a.body.activationToken,'a');assert.equal(f.active(),2);
  await f.release('a',a.body.activationToken,'b');assert.equal(f.active(),2);
  await f.release('a',a.body.activationToken);await f.release('a',a.body.activationToken);assert.equal(f.active(),1);
  assert.equal((await f.check('b',b.body.activationToken)).status,200);
});
await test('stopped permanent license blocks startup and NC regardless of session',async()=>{
  const f=await fixture(1);const a=await f.activate('a');await request('admin/licenses/'+f.id+'/status',{enabled:false});
  assert.equal((await f.check('a',a.body.activationToken)).status,403);assert.equal((await f.activate('b')).status,403);
  await f.release('a',a.body.activationToken);assert.equal(f.active(),0);
});
await test('lowering concurrent quota requires freeing usage, not unregistering devices',async()=>{
  const f=await fixture(2);const a=await f.activate('a');await f.activate('b');
  assert.equal((await request('admin/licenses/'+f.id+'/update',{maxDevices:1})).status,409);
  await f.release('a',a.body.activationToken);
  assert.equal((await request('admin/licenses/'+f.id+'/update',{maxDevices:1})).status,200);
  assert.equal((await f.activate('c')).status,409);
});
await test('old clients must upgrade rather than bypass concurrency',async()=>{
  const f=await fixture(1);assert.equal((await request('activate',{licenseKey:f.licenseKey,deviceId:'old'})).status,426);
  assert.equal(f.active(),0);
});
await test('renewing key while already running cannot rotate working token',async()=>{
  const f=await fixture(1);const a=await f.activate('a');assert.equal((await f.activate('a','other')).status,409);
  assert.equal((await f.check('a',a.body.activationToken)).status,200);
});
await test('revoked device cannot export; re-registration needs a fresh session',async()=>{
  const f=await fixture(1);const a=await f.activate('a');const row=db.prepare('SELECT id FROM activations WHERE license_id=?').get(f.id);
  await request('admin/licenses/'+f.id+'/revoke',{activationId:row.id});
  assert.equal((await f.check('a',a.body.activationToken)).status,403);
  assert.equal(f.active(),0);
  assert.equal((await f.activate('a','fresh-process')).status,200);
});
db.close();if(failures.length){console.error(failures.length+' scenarios failed');process.exitCode=1;}
