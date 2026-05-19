import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/types";
import { Env } from "../types";
import { StoredPasskey } from "../../shared/types";
import {
  ok,
  err,
  parseBody,
  u8ToB64url,
  b64urlToU8,
} from "../utils";

export function isAuthed(request: Request, env: Env): boolean {
  const pwd = env.ADMIN_PASSWORD || env.API_SECRET || "admin888";
  const auth = request.headers.get("Authorization") || "";
  return auth === `Bearer ${pwd}`;
}

function getRpID(request: Request): string {
  const host = request.headers.get("x-forwarded-host") || new URL(request.url).host;
  return host.split(":")[0];
}

function getOrigins(request: Request): string | string[] {
  const url = new URL(request.url);
  
  // 支持反向代理头，以获取正确的协议和域名
  const proto = request.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
  const host = request.headers.get("x-forwarded-host") || url.host;
  const origin = `${proto}://${host}`;

  if (origin.includes("localhost") || origin.includes("127.0.0.1")) {
    return [origin, "http://localhost:5173", "http://localhost:3000", "http://localhost:8787"];
  }
  return origin;
}

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  const body = await parseBody<{ password?: string }>(request);
  const pwd = env.ADMIN_PASSWORD || env.API_SECRET || "admin888";
  if (body?.password === pwd) return ok({ token: pwd });
  return err("密码错误", 401);
}

export async function handlePasskeyStatus(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT COUNT(*) as count FROM passkeys").all();
  return ok({ count: results[0]?.count ?? 0 });
}

export async function handlePasskeyList(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT id, name, created_at FROM passkeys").all();
  return ok(results);
}

export async function handlePasskeyDelete(id: string, env: Env): Promise<Response> {
  await env.DB.prepare("DELETE FROM passkeys WHERE id = ?").bind(id).run();
  return ok();
}

export async function handlePasskeyRegisterBegin(request: Request, env: Env): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT id, transports FROM passkeys").all();
  const rpID = getRpID(request);

  const options = await generateRegistrationOptions({
    rpName: "Legado Subscription",
    rpID,
    userID: new TextEncoder().encode("admin"),
    userName: "admin",
    userDisplayName: "Administrator",
    excludeCredentials: results.map((p) => ({
      id: p.id as string,
      transports: JSON.parse((p.transports as string) || "[]") as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });

  await env.KV.put("passkey:reg_challenge", options.challenge, { expirationTtl: 300 });
  return ok(options);
}

export async function handlePasskeyRegisterFinish(request: Request, env: Env): Promise<Response> {
  const expectedChallenge = await env.KV.get("passkey:reg_challenge");
  if (!expectedChallenge) return err("Challenge 已过期", 400);

  const body = (await request.json()) as RegistrationResponseJSON;
  const expectedRPID = getRpID(request);
  const expectedOrigin = getOrigins(request);

  try {
    const verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin,
      expectedRPID,
    });

    if (verification.verified && verification.registrationInfo) {
      const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;
      const stored = {
        id: body.id,
        public_key: u8ToB64url(credentialPublicKey),
        counter,
        transports: JSON.stringify(body.response.transports || []),
        name: `Passkey ${new Date().toLocaleDateString()}`,
        created_at: new Date().toISOString(),
      };

      await env.DB.prepare(
        "INSERT INTO passkeys (id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
        .bind(stored.id, stored.public_key, stored.counter, stored.transports, stored.name, stored.created_at)
        .run();

      await env.KV.delete("passkey:reg_challenge");
      return ok({ name: stored.name });
    }
  } catch (e) {
    console.error("Passkey 注册验证异常:", e);
    return err("注册验证过程中发生错误", 500);
  }

  return err("验证失败", 400);
}

export async function handlePasskeyLoginBegin(request: Request, env: Env): Promise<Response> {
  const rpID = getRpID(request);

  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "preferred",
  });

  await env.KV.put("passkey:auth_challenge", options.challenge, { expirationTtl: 300 });
  return ok(options);
}

export async function handlePasskeyLoginFinish(request: Request, env: Env): Promise<Response> {
  const expectedChallenge = await env.KV.get("passkey:auth_challenge");
  if (!expectedChallenge) return err("Challenge 已过期", 400);

  const body = (await request.json()) as AuthenticationResponseJSON;
  const allPasskeys = await env.DB.prepare("SELECT * FROM passkeys").all();
  let passkey = allPasskeys.results.find((p: any) => p.id === body.id);

  if (!passkey) {
    try {
      const bBytes = b64urlToU8(body.id);
      passkey = allPasskeys.results.find((p: any) => {
        try {
          const pBytes = b64urlToU8(p.id);
          if (pBytes.length !== bBytes.length) return false;
          for (let i = 0; i < pBytes.length; i++) {
            if (pBytes[i] !== bBytes[i]) return false;
          }
          return true;
        } catch { return false; }
      });
    } catch { /* ignore */ }
  }

  if (!passkey) {
    return err("找不到凭证", 404);
  }

  const expectedRPID = getRpID(request);
  const expectedOrigin = getOrigins(request);

  try {
    const verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin,
      expectedRPID,
      authenticator: {
        credentialID: b64urlToU8(passkey.id as string) as any,
        credentialPublicKey: b64urlToU8(passkey.public_key as string) as any,
        counter: passkey.counter as number,
        transports: JSON.parse((passkey.transports as string) || "[]"),
      },
    });

    if (verification.verified) {
      await env.DB.prepare("UPDATE passkeys SET counter = ? WHERE id = ?")
        .bind(verification.authenticationInfo.newCounter, passkey.id)
        .run();

      await env.KV.delete("passkey:auth_challenge");
      const pwd = env.ADMIN_PASSWORD || env.API_SECRET || "admin888";
      return ok({ token: pwd });
    }
  } catch (e) {
    console.error("Passkey 登录验证异常:", e);
    return err("登录验证过程中发生错误", 500);
  }

  return err("验证失败", 401);
}
