/**
 * SAML 2.0 SP-initiated single sign-on.
 *
 * Wraps ``@node-saml/node-saml`` to keep the XML canonicalisation and
 * signature checks out of our hands. The flow:
 *
 *   1. ``startLogin`` builds an AuthnRequest, the IdP redirects the
 *      browser to its login page.
 *   2. ``handleAcs`` (the ACS endpoint) validates the IdP's signed
 *      response, extracts the user's email/name, and upserts a local
 *      user record via the same code path as OIDC.
 */

import type { Request, Response } from "express";
import { signToken } from "./auth.js";
import {
  getDecryptedConfig,
  getProvider,
  isEmailAllowed,
  type ProviderRow,
  type SAMLConfig,
} from "./authProviders.js";
import { upsertSsoUser } from "./oidc.js";

interface SAMLClient {
  getAuthorizeUrlAsync(
    relayState: string,
    host: string,
    options?: Record<string, unknown>,
  ): Promise<string>;
  validatePostResponseAsync(
    container: { SAMLResponse: string },
  ): Promise<{ profile: Record<string, unknown> | null; loggedOut: boolean }>;
}

interface SAMLConstructor {
  new (opts: Record<string, unknown>): SAMLClient;
}

let _SAML: SAMLConstructor | null = null;
async function loadSAML(): Promise<SAMLConstructor> {
  if (_SAML) return _SAML;
  // Lazy-import so a fresh checkout without `@node-saml/node-saml`
  // installed still starts cleanly. The dep ships with the backend
  // package.json by default; this just makes the failure mode
  // surface in a single place.
  const mod = (await import("@node-saml/node-saml")) as unknown as {
    SAML: SAMLConstructor;
  };
  _SAML = mod.SAML;
  return _SAML;
}

function callbackUrl(req: Request, providerId: number): string {
  // Same source of truth as the OIDC callback URL — ``NICEMETA_PUBLIC_BASE_URL``
  // pin or X-Forwarded-* derivation. The ACS URL must match the value
  // the admin pre-registered with the IdP.
  const envBase = (process.env.NICEMETA_PUBLIC_BASE_URL || "").trim();
  if (envBase) {
    return `${envBase.replace(/\/+$/, "")}/api/auth/saml/${providerId}/acs`;
  }
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  const host = (req.headers["x-forwarded-host"] as string) || req.get("host");
  return `${proto}://${host}/api/auth/saml/${providerId}/acs`;
}

function clientForProvider(req: Request, provider: ProviderRow): Promise<SAMLClient> {
  const cfg = getDecryptedConfig(provider) as SAMLConfig;
  return loadSAML().then(
    (SAML) =>
      new SAML({
        entryPoint: cfg.entry_point,
        issuer: cfg.issuer,
        callbackUrl: callbackUrl(req, provider.id),
        idpCert: cfg.cert,
        // signAuthnRequest only when we have a private key configured.
        privateKey: cfg.private_key || undefined,
        wantAssertionsSigned: true,
        signatureAlgorithm: "sha256",
        disableRequestedAuthnContext: true,
      }) as SAMLClient,
  );
}

export async function startLogin(
  req: Request,
  res: Response,
  provider: ProviderRow,
): Promise<void> {
  const client = await clientForProvider(req, provider);
  const url = await client.getAuthorizeUrlAsync("", req.get("host") ?? "", {});
  res.redirect(url);
}

export async function handleAcs(
  req: Request,
  _res: Response,
  provider: ProviderRow,
): Promise<{ ok: true; token: string; user: { id: number; email: string; role: string } } | { ok: false; error: string }> {
  const samlResponse = (req.body?.SAMLResponse as string | undefined) ?? "";
  if (!samlResponse) return { ok: false, error: "missing SAMLResponse" };
  const cfg = getDecryptedConfig(provider) as SAMLConfig;
  const client = await clientForProvider(req, provider);
  let profile: Record<string, unknown> | null = null;
  try {
    const out = await client.validatePostResponseAsync({ SAMLResponse: samlResponse });
    profile = out.profile;
  } catch (e) {
    return { ok: false, error: `SAML validation failed: ${(e as Error).message}` };
  }
  if (!profile) return { ok: false, error: "SAML response had no profile" };

  const email =
    (profile[cfg.email_attribute] as string | undefined)
    || (profile.nameID as string | undefined)
    || (profile.email as string | undefined);
  if (!email) return { ok: false, error: "SAML profile had no email attribute" };
  const emailLower = email.toLowerCase();

  if (cfg.allowed_domains.length > 0) {
    const dom = emailLower.split("@").pop() ?? "";
    if (!cfg.allowed_domains.map((d) => d.toLowerCase()).includes(dom)) {
      return { ok: false, error: "email domain not permitted by this IdP" };
    }
  }
  if (!isEmailAllowed(emailLower)) {
    return { ok: false, error: "email domain not on the allowlist" };
  }

  const externalId =
    (profile.nameID as string | undefined)
    || (profile["http://schemas.xmlsoap.org/claims/UPN"] as string | undefined)
    || undefined;

  const user = upsertSsoUser({
    provider_id: provider.id,
    external_id: externalId,
    email: emailLower,
    default_role: provider.default_role,
  });
  return {
    ok: true,
    token: signToken(user),
    user: { id: user.id, email: user.email, role: user.role },
  };
}

export function getProviderRow(id: number): ProviderRow | null {
  return getProvider(id);
}
