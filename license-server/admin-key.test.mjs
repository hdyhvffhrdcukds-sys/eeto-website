import assert from 'node:assert/strict';
import worker from './src/index.js';
let row;
const env={ADMIN_API_KEY:'bootstrap-test-key-123456789',DB:{prepare(sql){return {async all(){return {results:[]}},bind(...args){return {
  async first(){return row?.bootstrap_hash===args[0]?row:null},
  async all(){return {results:[]}},
  async run(){assert.match(sql,/INSERT INTO admin_credentials/);if(row&&row.bootstrap_hash===args[0]&&row.key_hash!==args[3])return {meta:{changes:0}};row={bootstrap_hash:args[0],key_hash:args[1]};return {meta:{changes:1}}}
}}}}}};
async function call(key,body){return worker.fetch(new Request('https://example.test/v1/admin/'+(body?'key':'licenses'),{method:body?'POST':'GET',headers:{'x-admin-key':key,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env)}
const next='new-test-admin-key-123456789';
assert.equal((await call('incorrect')).status,401);
assert.equal((await call(env.ADMIN_API_KEY)).status,200);
assert.equal((await call(env.ADMIN_API_KEY,{newKey:'short',confirmKey:'short'})).status,400);
assert.equal((await call(env.ADMIN_API_KEY,{newKey:next,confirmKey:'mismatch'})).status,400);
assert.equal((await call('incorrect',{newKey:next,confirmKey:next})).status,401);
assert.equal((await call(env.ADMIN_API_KEY,{newKey:next,confirmKey:next})).status,200);
assert.equal((await call(env.ADMIN_API_KEY)).status,401);
assert.equal((await call(next)).status,200);
assert.notEqual(row.key_hash,next);
assert.equal((await call(next,{newKey:next,confirmKey:next})).status,400);
env.ADMIN_API_KEY='recovery-key-123456789012345';
assert.equal((await call(next)).status,401);
assert.equal((await call(env.ADMIN_API_KEY)).status,200);
console.log('PASS: authentication, validation, rotation, old-key rejection, hashed storage, recovery');
