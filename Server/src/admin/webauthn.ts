import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { WorkerEnv } from "../env.js";
import { ServiceError } from "../../../packages/core/src/shared/errors.js";
import { createSession, sha256 } from "./auth.js";
import { runtimeValue } from "./runtime-config.js";

async function rp(request: Request, env: WorkerEnv): Promise<{ id: string; origin: string }> {
  const url = new URL(request.url);
  const [configuredId, configuredOrigin] = await Promise.all([
    runtimeValue(env, "server.admin_rp_id"),
    runtimeValue(env, "server.admin_origin"),
  ]);
  return {
    id: configuredId ?? env.ADMIN_RP_ID ?? url.hostname,
    origin: configuredOrigin ?? env.ADMIN_ORIGIN ?? url.origin,
  };
}

function requireBootstrapAuthorization(request: Request, env: WorkerEnv): void {
  if (env.BOOTSTRAP_TOKEN === undefined || request.headers.get("authorization") !== `Bearer ${env.BOOTSTRAP_TOKEN}`) {
    throw new ServiceError(401, "UNAUTHORIZED");
  }
}

function bytes(value: ArrayBuffer | number[]): Uint8Array<ArrayBuffer> {
  const source = Array.isArray(value) ? Uint8Array.from(value) : new Uint8Array(value);
  const output = new Uint8Array(new ArrayBuffer(source.byteLength));
  output.set(source);
  return output;
}

export async function bootstrapOptions(request: Request, env: WorkerEnv, body: Record<string, unknown>): Promise<unknown> {
  requireBootstrapAuthorization(request, env);
  const count = await env.ADMIN_DB.prepare("SELECT COUNT(*) count FROM webauthn_credentials").first<{ count: number }>();
  if ((count?.count ?? 0) > 0) throw new ServiceError(409, "CONFLICT");
  if (typeof body.email !== "string" || typeof body.display_name !== "string" || body.email.length > 320 || body.display_name.length > 100)
    throw new ServiceError(400, "INVALID_REQUEST");
  const userId = crypto.randomUUID();
  const relyingParty = await rp(request, env);
  const options = await generateRegistrationOptions({
    rpName: "Mora Admin",
    rpID: relyingParty.id,
    userName: body.email,
    userDisplayName: body.display_name,
    userID: new TextEncoder().encode(userId),
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  const challengeId = crypto.randomUUID();
  await env.ADMIN_DB.prepare(
    `
    INSERT INTO auth_challenges (
      id, kind, user_id, challenge, expires_at,
      pending_user_id, pending_email, pending_display_name
    ) VALUES (?1, 'registration', NULL, ?2, ?3, ?4, ?5, ?6)
  `,
  )
    .bind(challengeId, options.challenge, Date.now() + 5 * 60_000, userId, body.email.toLowerCase(), body.display_name)
    .run();
  return { challenge_id: challengeId, options };
}

export async function bootstrapVerify(
  request: Request,
  env: WorkerEnv,
  body: Record<string, unknown>,
): Promise<{ user_id: string; cookie: string }> {
  if (typeof body.challenge_id !== "string" || typeof body.response !== "object" || body.response === null)
    throw new ServiceError(400, "INVALID_REQUEST");
  const challenge = await env.ADMIN_DB.prepare(
    `
    SELECT challenge,pending_user_id,pending_email,pending_display_name
    FROM auth_challenges
    WHERE id=?1 AND kind='registration' AND user_id IS NULL AND expires_at>?2
  `,
  )
    .bind(body.challenge_id, Date.now())
    .first<{
      challenge: string;
      pending_user_id: string;
      pending_email: string;
      pending_display_name: string;
    }>();
  if (challenge === null) throw new ServiceError(400, "INVALID_CHALLENGE");
  const relyingParty = await rp(request, env);
  const verification = await verifyRegistrationResponse({
    response: body.response as Parameters<typeof verifyRegistrationResponse>[0]["response"],
    expectedChallenge: challenge.challenge,
    expectedOrigin: relyingParty.origin,
    expectedRPID: relyingParty.id,
    requireUserVerification: true,
  });
  if (!verification.verified || verification.registrationInfo === undefined) throw new ServiceError(401, "VERIFICATION_FAILED");
  const credential = verification.registrationInfo.credential;
  const now = Date.now();
  await env.ADMIN_DB.batch([
    env.ADMIN_DB.prepare(
      `
      INSERT INTO users (id,email,display_name,created_at)
      SELECT ?1,?2,?3,?4 WHERE NOT EXISTS (SELECT 1 FROM webauthn_credentials)
    `,
    ).bind(challenge.pending_user_id, challenge.pending_email, challenge.pending_display_name, now),
    env.ADMIN_DB.prepare(
      "INSERT OR IGNORE INTO roles (id, name, permissions, system, created_at) VALUES ('owner', 'Owner', '[\"*\"]', 1, ?1)",
    ).bind(now),
    env.ADMIN_DB.prepare("INSERT INTO user_roles (user_id, role_id) VALUES (?1, 'owner')").bind(challenge.pending_user_id),
    env.ADMIN_DB.prepare(
      "INSERT INTO webauthn_credentials (id, user_id, public_key, counter, transports, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    ).bind(
      credential.id,
      challenge.pending_user_id,
      credential.publicKey,
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      now,
    ),
    env.ADMIN_DB.prepare("DELETE FROM auth_challenges WHERE id = ?1").bind(body.challenge_id),
  ]);
  const session = await createSession(env.ADMIN_DB, challenge.pending_user_id);
  return { user_id: challenge.pending_user_id, cookie: session.cookie };
}

export async function credentialOptions(request: Request, env: WorkerEnv, body: Record<string, unknown>): Promise<unknown> {
  requireBootstrapAuthorization(request, env);
  if (typeof body.email !== "string" || body.email.length === 0 || body.email.length > 320) throw new ServiceError(400, "INVALID_REQUEST");
  const user = await env.ADMIN_DB.prepare("SELECT id,email,display_name FROM users WHERE email=?1 AND status='active'")
    .bind(body.email.toLowerCase())
    .first<{ id: string; email: string; display_name: string }>();
  if (user === null) throw new ServiceError(401, "UNAUTHORIZED");
  const credentials = await env.ADMIN_DB.prepare("SELECT id,transports FROM webauthn_credentials WHERE user_id=?1")
    .bind(user.id)
    .all<{ id: string; transports: string }>();
  const relyingParty = await rp(request, env);
  const options = await generateRegistrationOptions({
    rpName: "Mora Admin",
    rpID: relyingParty.id,
    userName: user.email,
    userDisplayName: user.display_name,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    excludeCredentials: credentials.results.map((credential) => ({
      id: credential.id,
      transports: JSON.parse(credential.transports) as AuthenticatorTransport[],
    })),
  });
  const challengeId = crypto.randomUUID();
  await env.ADMIN_DB.prepare("INSERT INTO auth_challenges (id,kind,user_id,challenge,expires_at) VALUES (?1,'registration',?2,?3,?4)")
    .bind(challengeId, user.id, options.challenge, Date.now() + 5 * 60_000)
    .run();
  return { challenge_id: challengeId, options };
}

export async function credentialVerify(
  request: Request,
  env: WorkerEnv,
  body: Record<string, unknown>,
): Promise<{ user_id: string; cookie: string }> {
  requireBootstrapAuthorization(request, env);
  if (typeof body.challenge_id !== "string" || typeof body.response !== "object" || body.response === null)
    throw new ServiceError(400, "INVALID_REQUEST");
  const challenge = await env.ADMIN_DB.prepare(
    `
    SELECT c.user_id,c.challenge
    FROM auth_challenges c
    JOIN users u ON u.id=c.user_id
    WHERE c.id=?1 AND c.kind='registration' AND c.user_id IS NOT NULL AND c.expires_at>?2 AND u.status='active'
  `,
  )
    .bind(body.challenge_id, Date.now())
    .first<{ user_id: string; challenge: string }>();
  if (challenge === null) throw new ServiceError(400, "INVALID_CHALLENGE");
  const relyingParty = await rp(request, env);
  const verification = await verifyRegistrationResponse({
    response: body.response as Parameters<typeof verifyRegistrationResponse>[0]["response"],
    expectedChallenge: challenge.challenge,
    expectedOrigin: relyingParty.origin,
    expectedRPID: relyingParty.id,
    requireUserVerification: true,
  });
  if (!verification.verified || verification.registrationInfo === undefined) throw new ServiceError(401, "VERIFICATION_FAILED");
  const credential = verification.registrationInfo.credential;
  await env.ADMIN_DB.batch([
    env.ADMIN_DB.prepare(
      "INSERT INTO webauthn_credentials (id,user_id,public_key,counter,transports,created_at) VALUES (?1,?2,?3,?4,?5,?6)",
    ).bind(
      credential.id,
      challenge.user_id,
      credential.publicKey,
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      Date.now(),
    ),
    env.ADMIN_DB.prepare("DELETE FROM auth_challenges WHERE id=?1").bind(body.challenge_id),
  ]);
  const session = await createSession(env.ADMIN_DB, challenge.user_id);
  return { user_id: challenge.user_id, cookie: session.cookie };
}

export async function loginOptions(request: Request, env: WorkerEnv, body: Record<string, unknown>): Promise<unknown> {
  if (typeof body.email !== "string") throw new ServiceError(400, "INVALID_REQUEST");
  const user = await env.ADMIN_DB.prepare("SELECT id FROM users WHERE email = ?1 AND status = 'active'")
    .bind(body.email.toLowerCase())
    .first<{ id: string }>();
  if (user === null) throw new ServiceError(401, "UNAUTHORIZED");
  const credentials = await env.ADMIN_DB.prepare("SELECT id, transports FROM webauthn_credentials WHERE user_id = ?1")
    .bind(user.id)
    .all<{ id: string; transports: string }>();
  const relyingParty = await rp(request, env);
  const options = await generateAuthenticationOptions({
    rpID: relyingParty.id,
    userVerification: "required",
    allowCredentials: credentials.results.map((credential) => ({
      id: credential.id,
      transports: JSON.parse(credential.transports) as AuthenticatorTransport[],
    })),
  });
  const challengeId = crypto.randomUUID();
  await env.ADMIN_DB.prepare(
    "INSERT INTO auth_challenges (id, kind, user_id, challenge, expires_at) VALUES (?1, 'authentication', ?2, ?3, ?4)",
  )
    .bind(challengeId, user.id, options.challenge, Date.now() + 5 * 60_000)
    .run();
  return { challenge_id: challengeId, options };
}

export async function loginVerify(
  request: Request,
  env: WorkerEnv,
  body: Record<string, unknown>,
): Promise<{ user_id: string; cookie: string }> {
  if (typeof body.challenge_id !== "string" || typeof body.response !== "object" || body.response === null)
    throw new ServiceError(400, "INVALID_REQUEST");
  const response = body.response as { id?: unknown };
  if (typeof response.id !== "string") throw new ServiceError(400, "INVALID_REQUEST");
  const challenge = await env.ADMIN_DB.prepare(
    "SELECT user_id, challenge FROM auth_challenges WHERE id = ?1 AND kind = 'authentication' AND expires_at > ?2",
  )
    .bind(body.challenge_id, Date.now())
    .first<{ user_id: string; challenge: string }>();
  const credential = await env.ADMIN_DB.prepare("SELECT id, public_key, counter, transports FROM webauthn_credentials WHERE id = ?1")
    .bind(response.id)
    .first<{ id: string; public_key: ArrayBuffer | number[]; counter: number; transports: string }>();
  if (challenge === null || credential === null) throw new ServiceError(401, "UNAUTHORIZED");
  const relyingParty = await rp(request, env);
  const verification = await verifyAuthenticationResponse({
    response: body.response as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
    expectedChallenge: challenge.challenge,
    expectedOrigin: relyingParty.origin,
    expectedRPID: relyingParty.id,
    credential: {
      id: credential.id,
      publicKey: bytes(credential.public_key),
      counter: credential.counter,
      transports: JSON.parse(credential.transports) as AuthenticatorTransport[],
    },
    requireUserVerification: true,
  });
  if (!verification.verified) throw new ServiceError(401, "VERIFICATION_FAILED");
  await env.ADMIN_DB.batch([
    env.ADMIN_DB.prepare("UPDATE webauthn_credentials SET counter = ?1, last_used_at = ?2 WHERE id = ?3").bind(
      verification.authenticationInfo.newCounter,
      Date.now(),
      credential.id,
    ),
    env.ADMIN_DB.prepare("DELETE FROM auth_challenges WHERE id = ?1").bind(body.challenge_id),
  ]);
  const session = await createSession(env.ADMIN_DB, challenge.user_id);
  return { user_id: challenge.user_id, cookie: session.cookie };
}

export async function logout(request: Request, env: WorkerEnv): Promise<string> {
  const token = request.headers.get("cookie")?.match(/(?:^|;\s*)mora_session=([^;]+)/u)?.[1];
  if (token !== undefined)
    await env.ADMIN_DB.prepare("DELETE FROM sessions WHERE id_hash = ?1")
      .bind(await sha256(decodeURIComponent(token)))
      .run();
  return "mora_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
}
