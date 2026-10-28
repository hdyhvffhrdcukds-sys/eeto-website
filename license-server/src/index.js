/*
 * EETO MIRACLE license service.
 * Secrets are added with `wrangler secret put`: ADMIN_API_KEY.
 * Never add administrator secrets or real customer keys to Git.
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const LICENSE_KEY_PREFIX = "MIR";
const MAX_BODY_BYTES = 16_384;
function requireSession(body) {
  if (body.protocolVersion !== 2) throw new HttpError(426, "client_update_required", "동시 사용 인증을 지원하는 최신 미라클로 업데이트해 주세요.");
  return requiredString(body.sessionId, "sessionId", 128);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    try {
      let response;
      if (request.method === "GET" && url.pathname === "/v1/health")
        response = json({ ok: true, service: "eeto-miracle-license" });
      else if (request.method === "POST" && url.pathname === "/v1/activate")
        response = await activate(request, env);
      else if (request.method === "POST" && url.pathname === "/v1/check")
        response = await check(request, env);
      else if (request.method === "POST" && url.pathname === "/v1/release")
        response = await releaseSession(request, env);
      else if (request.method === "POST" && url.pathname === "/v1/admin/key")
        response = await changeAdminKey(request, env);
      else if (request.method === "POST" && /^\/v1\/admin\/licenses\/[^/]+\/permanent$/.test(url.pathname))
        response = await setPermanentLicense(request, env, url.pathname.split("/")[4]);
      else if (request.method === "POST" && url.pathname === "/v1/admin/licenses")
        response = await createLicense(request, env);
      else if (request.method === "GET" && url.pathname === "/v1/admin/licenses")
        response = await listLicenses(request, env);
      else if (request.method === "GET" && /^\/v1\/admin\/licenses\/[^/]+\/sessions$/.test(url.pathname))
        response = await listSessions(request, env, url.pathname.split("/")[4]);
      else if (request.method === "POST" && /^\/v1\/admin\/licenses\/[^/]+\/release-device$/.test(url.pathname))
        response = await releaseDevice(request, env, url.pathname.split("/")[4]);
      else if (request.method === "POST" && /^\/v1\/admin\/licenses\/[^/]+\/revoke$/.test(url.pathname))
        response = await revokeActivation(request, env, url.pathname.split("/")[4]);
      else if (request.method === "POST" && /^\/v1\/admin\/licenses\/[^/]+\/status$/.test(url.pathname))
        response = await setLicenseStatus(request, env, url.pathname.split("/")[4]);
      else if (request.method === "POST" && /^\/v1\/admin\/licenses\/[^/]+\/update$/.test(url.pathname))
        response = await updateLicense(request, env, url.pathname.split("/")[4]);
      else if (request.method === "DELETE" && /^\/v1\/admin\/licenses\/[^/]+$/.test(url.pathname))
        response = await deleteLicense(request, env, url.pathname.split("/")[4]);
      else response = error(404, "not_found", "요청한 주소가 없습니다.");

      return withHeaders(response, headers);
    } catch (cause) {
      if (cause instanceof HttpError)
        return withHeaders(error(cause.status, cause.code, cause.message), headers);
      console.error(cause);
      return withHeaders(error(500, "server_error", "라이선스 서버 오류입니다."), headers);
    }
  }
};

async function activate(request, env) {
  const body = await readJson(request);
  const sessionId = requireSession(body);
  const licenseKey = requiredString(body.licenseKey, "licenseKey", 128).toUpperCase();
  const deviceId = requiredString(body.deviceId, "deviceId", 256);
  const deviceLabel = requiredString(body.deviceLabel ?? "MIRACLE PC", "deviceLabel", 100);
  const keyHash = await sha256(licenseKey);
  const deviceHash = await sha256(deviceId);
  const now = isoNow();
  const license = await env.DB.prepare(
    "SELECT id, customer_name, max_devices, expires_at, enabled, features_json FROM licenses WHERE key_hash = ?"
  ).bind(keyHash).first();

  if (!license || !license.enabled || isExpired(license.expires_at))
    return error(403, "license_unavailable", "사용할 수 없는 라이선스입니다.");

  const token = randomToken();
  const tokenHash = await sha256(token);
  // Registration is not a concurrent usage slot.
  const result = await env.DB.prepare(`INSERT INTO activations
      (id, license_id, device_hash, device_label, token_hash, activated_at, last_seen_at)
      SELECT ?, l.id, ?, ?, ?, ?, ? FROM licenses l
      WHERE l.id = ? AND l.enabled = 1 AND (l.expires_at IS NULL OR l.expires_at > ?)
      ON CONFLICT(license_id, device_hash) DO UPDATE SET
        device_label = excluded.device_label, token_hash = excluded.token_hash,
        last_seen_at = excluded.last_seen_at, revoked_at = NULL
      WHERE NOT EXISTS (SELECT 1 FROM license_sessions s WHERE s.activation_id=activations.id AND s.released_at IS NULL)`)
    .bind(crypto.randomUUID(), deviceHash, deviceLabel, tokenHash, now, now, license.id, now).run();
  if (!result.meta.changes) return error(409, "device_in_use", "이 PC의 미라클이 이미 사용 중이거나 라이선스를 사용할 수 없습니다. 기존 프로그램을 종료하거나 관리자에게 사용 해제를 요청하세요.");
  return check(new Request(request.url, {method:"POST", headers:{"content-type":"application/json"},
    body:JSON.stringify({activationToken:token,deviceId,sessionId,protocolVersion:2,purpose:"startup"})}), env);
}

async function check(request, env) {
  const body = await readJson(request);
  const sessionId = requireSession(body);
  const activationToken = requiredString(body.activationToken, "activationToken", 256);
  const deviceId = requiredString(body.deviceId, "deviceId", 256);
  const tokenHash = await sha256(activationToken);
  const deviceHash = await sha256(deviceId);
  const activation = await env.DB.prepare(`SELECT a.id, a.license_id, a.device_hash, a.revoked_at,
      l.customer_name, l.expires_at, l.enabled, l.features_json
      FROM activations a JOIN licenses l ON l.id = a.license_id WHERE a.token_hash = ?`)
    .bind(tokenHash).first();

  if (!activation || activation.revoked_at || activation.device_hash !== deviceHash || !activation.enabled || isExpired(activation.expires_at))
    return error(403, "activation_unavailable", "활성화가 유효하지 않습니다.");

  const now = isoNow();
  const sessionHash = await sha256(sessionId);
  if (body.purpose === "nc-export") {
    const session=await env.DB.prepare("SELECT activation_id FROM license_sessions WHERE session_hash=? AND activation_id=? AND released_at IS NULL")
      .bind(sessionHash,activation.id).first();
    if (!session) return error(403,"session_released","이 PC의 사용권이 해제되었습니다. 작업을 저장한 뒤 미라클을 다시 실행하세요. NC는 내보내지 않았습니다.");
  } else if (body.purpose === "startup") {
    // No timer/expiry: a silent PC may still be working. Only exit or an explicit
    // administrator release returns the slot. Tombstones fence stale NC requests.
    const acquired = await env.DB.prepare(`INSERT INTO license_sessions(session_hash,activation_id,created_at)
      SELECT ?, a.id, ? FROM activations a JOIN licenses l ON l.id=a.license_id
      WHERE a.id=? AND a.token_hash=? AND a.revoked_at IS NULL AND l.enabled=1
        AND (l.expires_at IS NULL OR l.expires_at>?)
        AND (EXISTS(SELECT 1 FROM license_sessions s WHERE s.activation_id=a.id AND s.released_at IS NULL)
          OR (SELECT COUNT(DISTINCT s.activation_id) FROM license_sessions s
            JOIN activations other ON other.id=s.activation_id
            WHERE other.license_id=l.id AND other.revoked_at IS NULL AND s.released_at IS NULL) < l.max_devices)
      ON CONFLICT(session_hash) DO UPDATE SET session_hash=excluded.session_hash
        WHERE license_sessions.activation_id=excluded.activation_id AND license_sessions.released_at IS NULL`)
      .bind(sessionHash, now, activation.id, tokenHash, now).run();
    if (!acquired.meta.changes)
      return error(409, "concurrent_limit", "다른 PC에서 미라클을 사용 중입니다. 허용된 동시 사용 대수를 모두 사용 중이므로 해당 PC에서 종료한 뒤 다시 실행하세요. 비정상 종료한 경우 관리자에게 사용 해제를 요청하세요.");
  } else return error(400,"invalid_purpose","인증 요청 종류를 확인하세요.");
  await env.DB.prepare("UPDATE activations SET last_seen_at = ? WHERE id = ?").bind(now, activation.id).run();
  return json({...leaseResponse(activation, activationToken, now, env), protocolVersion:2, sessionConfirmed:true});
}

async function releaseSession(request, env) {
  const body=await readJson(request);
  const sessionHash=await sha256(requireSession(body));
  const tokenHash=await sha256(requiredString(body.activationToken,"activationToken",256));
  const deviceHash=await sha256(requiredString(body.deviceId,"deviceId",256));
  await env.DB.prepare(`UPDATE license_sessions SET released_at=? WHERE session_hash=? AND activation_id IN
    (SELECT id FROM activations WHERE token_hash=? AND device_hash=?)`).bind(isoNow(),sessionHash,tokenHash,deviceHash).run();
  return json({ok:true});
}

async function listSessions(request, env, licenseId) {
  await requireAdmin(request,env);
  const rows=await env.DB.prepare(`SELECT a.id AS activation_id,a.device_label,MIN(s.created_at) AS started_at
    FROM activations a JOIN license_sessions s ON s.activation_id=a.id
    WHERE a.license_id=? AND a.revoked_at IS NULL AND s.released_at IS NULL GROUP BY a.id`).bind(licenseId).all();
  return json({sessions:rows.results});
}

async function releaseDevice(request, env, licenseId) {
  await requireAdmin(request,env);
  const body=await readJson(request);
  const id=requiredString(body.activationId,"activationId",64);
  const result=await env.DB.prepare(`UPDATE license_sessions SET released_at=? WHERE released_at IS NULL
    AND activation_id IN (SELECT id FROM activations WHERE id=? AND license_id=?)`).bind(isoNow(),id,licenseId).run();
  await audit(env,licenseId,"release_device",id);
  return json({ok:true,released:result.meta.changes});
}

async function createLicense(request, env) {
  await requireAdmin(request, env);
  const body = await readJson(request);
  const customerName = requiredString(body.customerName, "customerName", 120);
  const maxDevices = integer(body.maxDevices ?? 1, "maxDevices", 1, 50);
  const expiresAt = optionalDate(body.expiresAt);
  const features = Array.isArray(body.features) ? body.features.filter(x => typeof x === "string").slice(0, 30) : [];
  const licenseKey = body.licenseKey ? requiredString(body.licenseKey, "licenseKey", 128).toUpperCase() : createLicenseKey();
  const now = isoNow();
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(`INSERT INTO licenses
      (id, key_hash, key_value, key_suffix, customer_name, max_devices, expires_at, enabled, features_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .bind(id, await sha256(licenseKey), licenseKey, licenseKey.slice(-5), customerName, maxDevices, expiresAt,
        JSON.stringify(features), now, now).run();
  } catch {
    return error(409, "duplicate_key", "이미 등록된 라이선스 키입니다.");
  }
  await audit(env, id, "create_license", customerName);
  return json({ id, licenseKey, customerName, maxDevices, expiresAt, features }, 201);
}

async function listLicenses(request, env) {
  await requireAdmin(request, env);
  const results = await env.DB.prepare(`SELECT l.id, l.key_value, l.key_suffix, l.customer_name, l.max_devices, l.expires_at, l.enabled,
      l.features_json, l.created_at, l.updated_at,
      COUNT(DISTINCT CASE WHEN a.revoked_at IS NULL AND s.released_at IS NULL AND s.session_hash IS NOT NULL THEN a.id END) AS active_devices,
      COUNT(DISTINCT CASE WHEN a.revoked_at IS NULL THEN a.id END) AS registered_devices
      FROM licenses l LEFT JOIN activations a ON a.license_id = l.id LEFT JOIN license_sessions s ON s.activation_id=a.id GROUP BY l.id ORDER BY l.created_at DESC LIMIT 500`).all();
  return json({ licenses: results.results.map(x => ({ ...x, features: JSON.parse(x.features_json) })) });
}

async function revokeActivation(request, env, licenseId) {
  await requireAdmin(request, env);
  const body = await readJson(request);
  const activationId = requiredString(body.activationId, "activationId", 64);
  const result = await env.DB.prepare("UPDATE activations SET revoked_at = ? WHERE id = ? AND license_id = ? AND revoked_at IS NULL")
    .bind(isoNow(), activationId, licenseId).run();
  if (!result.meta.changes) return error(404, "activation_not_found", "활성화를 찾을 수 없습니다.");
  await env.DB.prepare("UPDATE license_sessions SET released_at=? WHERE activation_id=? AND released_at IS NULL")
    .bind(isoNow(),activationId).run();
  await audit(env, licenseId, "revoke_activation", activationId);
  return json({ ok: true });
}

async function setLicenseStatus(request, env, licenseId) {
  await requireAdmin(request, env);
  const body = await readJson(request);
  const enabled = body.enabled === true;
  const result = await env.DB.prepare("UPDATE licenses SET enabled = ?, updated_at = ? WHERE id = ?")
    .bind(enabled ? 1 : 0, isoNow(), licenseId).run();
  if (!result.meta.changes) return error(404, "license_not_found", "라이선스를 찾을 수 없습니다.");
  await audit(env, licenseId, enabled ? "enable_license" : "disable_license", "");
  return json({ ok: true, enabled });
}

async function setPermanentLicense(request, env, licenseId) {
  await requireAdmin(request, env);
  const body = await readJson(request);
  if (typeof body.permanent !== 'boolean') throw new HttpError(400, 'invalid_permanent', '영구락 설정을 확인하세요.');
  const expiresAt = body.permanent ? null : optionalDate(body.expiresAt);
  if (!body.permanent && (!expiresAt || isExpired(expiresAt)))
    throw new HttpError(400, 'invalid_expiresAt', '영구락 해제 시 미래의 만료일을 지정하세요.');
  const result = await env.DB.prepare('UPDATE licenses SET expires_at = ?, updated_at = ? WHERE id = ?')
    .bind(expiresAt, isoNow(), licenseId).run();
  if (!result.meta.changes) return error(404, 'license_not_found', '라이선스를 찾을 수 없습니다.');
  await audit(env, licenseId, 'set_permanent', body.permanent ? 'permanent' : expiresAt);
  return json({ ok: true, permanent: body.permanent, expiresAt });
}

async function updateLicense(request, env, licenseId) {
  await requireAdmin(request, env);
  const body = await readJson(request);
  const expiresAt = optionalDate(body.expiresAt);
  const maxDevices = integer(body.maxDevices, "maxDevices", 1, 50);
  // Do not evict arbitrary PCs. This condition is atomic with the limit update.
  const result = await env.DB.prepare(`UPDATE licenses SET expires_at = ?, max_devices = ?, updated_at = ?
      WHERE id = ? AND (SELECT COUNT(DISTINCT a.id) FROM activations a JOIN license_sessions s ON s.activation_id=a.id
        WHERE a.license_id = ? AND a.revoked_at IS NULL AND s.released_at IS NULL AND s.session_hash IS NOT NULL) <= ?`)
    .bind(expiresAt, maxDevices, isoNow(), licenseId, licenseId, maxDevices).run();
  if (!result.meta.changes) {
    const exists = await env.DB.prepare("SELECT id FROM licenses WHERE id = ?").bind(licenseId).first();
    if (!exists) return error(404, "license_not_found", "라이선스를 찾을 수 없습니다.");
    return error(409, "active_devices_exceed_limit", "현재 사용 중인 PC 수보다 동시 사용 대수를 줄일 수 없습니다. 먼저 다른 PC에서 미라클을 종료하세요.");
  }
  await audit(env, licenseId, "update_license", `expiresAt=${expiresAt ?? "none"};maxDevices=${maxDevices}`);
  return json({ ok: true, expiresAt, maxDevices });
}

async function deleteLicense(request, env, licenseId) {
  await requireAdmin(request, env);
  const license = await env.DB.prepare("SELECT id FROM licenses WHERE id = ?").bind(licenseId).first();
  if (!license) return error(404, "license_not_found", "라이선스를 찾을 수 없습니다.");

  await env.DB.batch([
    env.DB.prepare("DELETE FROM activations WHERE license_id = ?").bind(licenseId),
    env.DB.prepare("DELETE FROM audit_log WHERE license_id = ?").bind(licenseId),
    env.DB.prepare("DELETE FROM licenses WHERE id = ?").bind(licenseId)
  ]);
  return json({ ok: true });
}

function leaseResponse(license, activationToken, now, env) {
  const until = new Date(new Date(now).getTime() + leaseDays(env) * 86_400_000);
  const licenseEnd = license.expires_at ? new Date(license.expires_at) : null;
  if (licenseEnd && licenseEnd < until) until.setTime(licenseEnd.getTime());
  return {
    activationToken,
    customerName: license.customer_name,
    features: JSON.parse(license.features_json),
    licenseExpiresAt: license.expires_at ?? null,
    checkUntil: until.toISOString(),
    serverTime: now
  };
}

async function requireAdmin(request, env) {
  const key = request.headers.get("x-admin-key");
  if (!env.ADMIN_API_KEY || !key || key.length > 256) throw new HttpError(401, "admin_unauthorized", "관리자 인증이 필요합니다.");
  // Changing the Cloudflare secret remains an out-of-band recovery mechanism.
  const bootstrap = await sha256(env.ADMIN_API_KEY);
  const saved = await env.DB.prepare("SELECT key_hash FROM admin_credentials WHERE id = 1 AND bootstrap_hash = ?").bind(bootstrap).first();
  const expected = saved?.key_hash ?? bootstrap;
  if (!timingSafeEqual(await sha256(key), expected)) throw new HttpError(401, "admin_unauthorized", "관리자 인증이 필요합니다.");
  return { bootstrap, expected };
}
async function changeAdminKey(request, env) {
  const auth = await requireAdmin(request, env);
  const body = await readJson(request);
  const next = requiredString(body.newKey, "newKey", 128);
  if (!/^[!-~]{12,128}$/.test(next)) throw new HttpError(400, "weak_key", "새 키는 공백 없이 영문·숫자·기호 12~128자로 입력하세요. 안전한 키 자동 생성을 권장합니다.");
  if (next !== body.confirmKey) throw new HttpError(400, "key_mismatch", "새 키와 확인 값이 다릅니다.");
  const hash = await sha256(next);
  if (hash === auth.expected || hash === auth.bootstrap) throw new HttpError(400, "same_key", "기존 키와 다른 새 키를 입력하세요.");
  const result = await env.DB.prepare(`INSERT INTO admin_credentials(id, bootstrap_hash, key_hash, updated_at)
    VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET bootstrap_hash=excluded.bootstrap_hash,
    key_hash=excluded.key_hash, updated_at=excluded.updated_at
    WHERE admin_credentials.bootstrap_hash != excluded.bootstrap_hash OR admin_credentials.key_hash = ?`)
    .bind(auth.bootstrap, hash, isoNow(), auth.expected).run();
  if (!result.meta.changes) throw new HttpError(409, "key_changed", "다른 화면에서 키가 변경되었습니다. 현재 키로 다시 로그인하세요.");
  return json({ ok: true });
}
async function readJson(request) {
  const size = Number(request.headers.get("content-length") ?? 0);
  if (size > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large", "요청이 너무 큽니다.");
  try { return await request.json(); } catch { throw new HttpError(400, "invalid_json", "JSON 형식이 올바르지 않습니다."); }
}
function requiredString(value, name, max) {
  if (typeof value !== "string" || !(value = value.trim()) || value.length > max) throw new HttpError(400, "invalid_" + name, `${name} 값이 올바르지 않습니다.`);
  return value;
}
function integer(value, name, min, max) { if (!Number.isInteger(value) || value < min || value > max) throw new HttpError(400, "invalid_" + name, `${name} 값이 올바르지 않습니다.`); return value; }
function optionalDate(value) { if (value == null || value === "") return null; const date = new Date(value); if (Number.isNaN(date.getTime())) throw new HttpError(400, "invalid_expiresAt", "만료일이 올바르지 않습니다."); return date.toISOString(); }
function isExpired(value) { return value && new Date(value).getTime() < Date.now(); }
function leaseDays(env) { const days = Number(env.LEASE_DAYS ?? 7); return Number.isInteger(days) && days >= 1 && days <= 30 ? days : 7; }
function isoNow() { return new Date().toISOString(); }
function randomToken() { const bytes = new Uint8Array(32); crypto.getRandomValues(bytes); return base64Url(bytes); }
function createLicenseKey() { const bytes = new Uint8Array(15); crypto.getRandomValues(bytes); return `${LICENSE_KEY_PREFIX}-${base64Url(bytes).toUpperCase().replaceAll("_", "X").replaceAll("-", "Y").slice(0, 5)}-${base64Url(bytes).toUpperCase().replaceAll("_", "X").replaceAll("-", "Y").slice(5, 10)}-${base64Url(bytes).toUpperCase().replaceAll("_", "X").replaceAll("-", "Y").slice(10, 15)}`; }
function base64Url(bytes) { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
async function sha256(value) { const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, "0")).join(""); }
function timingSafeEqual(a, b) { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; }
async function audit(env, licenseId, action, detail) { await env.DB.prepare("INSERT INTO audit_log (id, license_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), licenseId, action, detail, isoNow()).run(); }
function corsHeaders(request, env) { const origin = request.headers.get("origin"); return origin && origin === env.CORS_ORIGIN ? { ...JSON_HEADERS, "access-control-allow-origin": origin, "access-control-allow-headers": "content-type, x-admin-key", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "vary": "Origin" } : JSON_HEADERS; }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS }); }
function error(status, code, message) { return json({ ok: false, code, message }, status); }
function withHeaders(response, headers) { const result = new Headers(response.headers); for (const [key, value] of Object.entries(headers)) result.set(key, value); return new Response(response.body, { status: response.status, headers: result }); }
class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
