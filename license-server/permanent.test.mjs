import assert from 'node:assert/strict';
import worker from './src/index.js';
const license={expires_at:'2030-01-01T00:00:00.000Z',max_devices:3,enabled:0};
const env={ADMIN_API_KEY:'test-admin-key',DB:{prepare(sql){return {bind(...args){return {
  async first(){return null},
  async run(){
    if(sql.startsWith('UPDATE licenses')){
      assert.equal(sql,'UPDATE licenses SET expires_at = ?, updated_at = ? WHERE id = ?');
      if(args[2]!=='test')return {meta:{changes:0}};
      license.expires_at=args[0];
    }
    return {meta:{changes:1}};
  }
}}}}}};
async function call(body,key=env.ADMIN_API_KEY,id='test'){
  return worker.fetch(new Request(`https://example.test/v1/admin/licenses/${id}/permanent`,{method:'POST',headers:{'x-admin-key':key,'content-type':'application/json'},body:JSON.stringify(body)}),env);
}
assert.equal((await call({permanent:true},'wrong')).status,401);
assert.equal((await call({permanent:'true'})).status,400);
assert.equal((await call({permanent:true})).status,200);
assert.equal(license.expires_at,null);
assert.equal(license.max_devices,3);assert.equal(license.enabled,0);
assert.equal((await call({permanent:false})).status,400);
assert.equal((await call({permanent:false,expiresAt:'2000-01-01'})).status,400);
assert.equal((await call({permanent:false,expiresAt:'2099-12-31T14:59:59Z'})).status,200);
assert.equal(license.expires_at,'2099-12-31T14:59:59.000Z');
assert.equal((await call({permanent:true},env.ADMIN_API_KEY,'missing')).status,404);
console.log('PASS permanent enable/disable, expiry validation, authentication, PC/status preservation');
