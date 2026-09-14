/*
 * EETO MIRACLE license service.
 * Secrets are added with `wrangler secret put`: ADMIN_API_KEY.
 * Never add administrator secrets or real customer keys to Git.
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const LICENSE_KEY_PREFIX = "MIR";
const MAX_BODY_BYTES = 16_384;

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
      else if (request.method === "POST" && url.pathname === "/v1/admin/licenses")
        response = await createLicense(request, env);
      else if (request.method === "GET" && url.pathname === "/v1/admin/licenses")
        response = await listLicenses(request, env);
      else if (request.method === "POST" && /^\/v1\/admin\/licenses\/[^/]+\/revoke$/.test(url.pathname))
        response = await revokeActivation(request, env, url.pathname.split("/")[4]);
      else if (request.method === "POST" && /^\/v1\/admin\/licenses\/[^/]+\/status$/.test(url.pathname))
        response = await setLicenseStatus(request, env, url.pathname.split("/")[4]);
      else if (request.method === "POST" && /^\/v1\/admin\/licenses\/[^/]+\/update$/.test(url.pathname))
        response = await updateLicense(request, env, url.pathname.split("/")[4]);
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

  let activation = await env.DB.prepare(
    "SELECT id, token_hash, revoked_at FROM activations WHERE license_id = ? AND device_hash = ?"
  ).bind(license.id, deviceHash).first();

  if (activation?.revoked_at) activation = null;
  if (!activation) {
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM activations WHERE license_id = ? AND revoked_at IS NULL"
    ).bind(license.id).first();
    if (Number(count.count) >= Number(license.max_devices))
      return error(409, "device_limit", "허용된 PC 수를 모두 사용 중입니다. 관리자에게 기존 PC 해제를 요청하세요.");

    const token = randomToken();
    activation = { id: crypto.randomUUID(), token_hash: await sha256(token) };
    await env.DB.prepare(
      "INSERT INTO activations (id, license_id, device_hash, device_label, token_hash, activated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(activation.id, license.id, deviceHash, deviceLabel, activation.token_hash, now, now).run();
    await audit(env, license.id, "activate", deviceLabel);
    return json(leaseResponse(license, token, now, env));
  }

  const token = randomToken();
  const tokenHash = await sha256(token);
  await env.DB.prepare("UPDATE activations SET token_hash = ?, device_label = ?, last_seen_at = ? WHERE id = ?")
    .bind(tokenHash, deviceLabel, now, activation.id).run();
  await audit(env, license.id, "renew_activation", deviceLabel);
  return json(leaseResponse(license, token, now, env));
}

async function check(request, env) {
  const body = await readJson(request);
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
  await env.DB.prepare("UPDATE activations SET last_seen_at = ? WHERE id = ?").bind(now, activation.id).run();
  return json(leaseResponse(activation, activationToken, now, env));
}

async function createLicense(request, env) {
  requireAdmin(request, env);
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
  requireAdmin(request, env);
  const results = await env.DB.prepare(`SELECT l.id, l.key_value, l.key_suffix, l.customer_name, l.max_devices, l.expires_at, l.enabled,
      l.features_json, l.created_at, l.updated_at,
      SUM(CASE WHEN a.revoked_at IS NULL THEN 1 ELSE 0 END) AS active_devices
      FROM licenses l LEFT JOIN activations a ON a.license_id = l.id GROUP BY l.id ORDER BY l.created_at DESC LIMIT 500`).all();
  return json({ licenses: results.results.map(x => ({ ...x, features: JSON.parse(x.features_json) })) });
}

async function revokeActivation(request, env, licenseId) {
  requireAdmin(request, env);
  const body = await readJson(request);
  const activationId = requiredString(body.activationId, "activationId", 64);
  const result = await env.DB.prepare("UPDATE activations SET revoked_at = ? WHERE id = ? AND license_id = ? AND revoked_at IS NULL")
    .bind(isoNow(), activationId, licenseId).run();
  if (!result.meta.changes) return error(404, "activation_not_found", "활성화를 찾을 수 없습니다.");
  await audit(env, licenseId, "revoke_activation", activationId);
  return json({ ok: true });
}

async function setLicenseStatus(request, env, licenseId) {
  requireAdmin(request, env);
  const body = await readJson(request);
  const enabled = body.enabled === true;
  const result = await env.DB.prepare("UPDATE licenses SET enabled = ?, updated_at = ? WHERE id = ?")
    .bind(enabled ? 1 : 0, isoNow(), licenseId).run();
  if (!result.meta.changes) return error(404, "license_not_found", "라이선스를 찾을 수 없습니다.");
  await audit(env, licenseId, enabled ? "enable_license" : "disable_license", "");
  return json({ ok: true, enabled });
}

async function updateLicense(request, env, licenseId) {
  requireAdmin(request, env);
  const body = await readJson(request);
  const expiresAt = optionalDate(body.expiresAt);
  const maxDevices = integer(body.maxDevices, "maxDevices", 1, 50);
  const result = await env.DB.prepare("UPDATE licenses SET expires_at = ?, max_devices = ?, updated_at = ? WHERE id = ?")
    .bind(expiresAt, maxDevices, isoNow(), licenseId).run();
  if (!result.meta.changes) return error(404, "license_not_found", "라이선스를 찾을 수 없습니다.");
  await audit(env, licenseId, "update_license", `expiresAt=${expiresAt ?? "none"};maxDevices=${maxDevices}`);
  return json({ ok: true, expiresAt, maxDevices });
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

function requireAdmin(request, env) {
  const key = request.headers.get("x-admin-key");
  if (!env.ADMIN_API_KEY || !key || !timingSafeEqual(key, env.ADMIN_API_KEY)) throw new HttpError(401, "admin_unauthorized", "관리자 인증이 필요합니다.");
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
function corsHeaders(request, env) { const origin = request.headers.get("origin"); return origin && origin === env.CORS_ORIGIN ? { ...JSON_HEADERS, "access-control-allow-origin": origin, "access-control-allow-headers": "content-type, x-admin-key", "access-control-allow-methods": "GET, POST, OPTIONS", "vary": "Origin" } : JSON_HEADERS; }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS }); }
function error(status, code, message) { return json({ ok: false, code, message }, status); }
function withHeaders(response, headers) { const result = new Headers(response.headers); for (const [key, value] of Object.entries(headers)) result.set(key, value); return new Response(response.body, { status: response.status, headers: result }); }
class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
