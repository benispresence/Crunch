# Crunch v1.1.0

Major feature release: single sign-on, data pipelines, more data sources,
Metabase-style query variables, version history, an outbound MCP client,
and a security-hardened authentication layer.

## Highlights

### SSO & access control
- **OIDC / OAuth2** (Google, Microsoft 365, Okta, Auth0, Authentik, Keycloak, GitHub) with PKCE
- **SAML 2.0** SP-initiated sign-on
- **LDAP / Active Directory** bind-then-search authentication
- **API keys** (`crunch_pk_…`) with per-key scopes that intersect the owner's permissions
- **Permission groups** (Administrators / Editors / Viewers) replacing the flat role flag
- **Email-domain allowlist** for self-registration and SSO auto-provisioning

### Data & analysis
- **Data pipelines** built on dlt, with a cron scheduler and agent tools
- **9 new data sources** plus expanded file formats — folder scan, Excel multi-sheet, cloud URIs (`s3://`, `gs://`, `https://`)
- **Query variables & dashboard filters** (Metabase-style `{{var}}` templating, bound as SQL parameters)
- **Version history** for queries and dashboards, with revert
- **Dashboard agent tools** and a Gantt timeline

### Integrations
- **Outbound MCP client** with OAuth 2.0 (PKCE) so Crunch can consume external MCP servers
- **Bidirectional MCP** support

## Security hardening

Driven by a full audit of the new auth surface. Highlights:

- **Sandboxed pipeline & visualization execution** — allowlist-gated imports, wall-clock timeouts; adversarial imports (`subprocess`, `socket`, string-concatenated module names) refused at runtime
- **SQL-injection fixes** in schema/table introspection (bind parameters everywhere)
- **MongoDB** server-side-JS operators (`$where`, `$function`, `$accumulator`, `$expr.$function`) blocked at parse time
- **File-source containment** via `NICEMETA_FILE_SOURCE_ROOT`
- **OIDC** id_tokens verified against the IdP's JWKS (signature + issuer + audience)
- **SSO account-takeover protections**: `email_verified` gate, no silent binding of an SSO identity to a pre-existing local account by email, and role-capping so SSO can never reach a more-privileged account than the provider's default role
- **SSRF guard** on all admin-configured IdP fetches (HTTPS-only, blocks loopback / private / link-local / cloud-metadata addresses)
- **SAML** audience pinning + clock-skew bounds on top of mandatory assertion signing
- **Trusted callback URLs** — OAuth/SAML redirect URIs are built from a pinned public base, not attacker-controllable forwarded headers
- **API-key revocation** on password change/reset (previously only JWT sessions were revoked)
- The seeded first-run admin password is **no longer returned over HTTP in production**

## Upgrade notes

- **New env var for production SSO:** `NICEMETA_PUBLIC_BASE_URL` must be set to the public origin (e.g. `https://crunch.example.com`) for OAuth/SAML to build a trusted callback URL. The Docker compose file sets this automatically to the SPA origin.
- **Optional:** `JWT_TTL` makes the access-token lifetime configurable (default `30d`).
- **Optional:** `NICEMETA_FILE_SOURCE_ROOT` contains local file-source paths to a directory.
- **Behavior change:** an SSO login whose email matches an **existing local account** is now **refused** until an admin links it, or the provider's `link_existing_by_email` is enabled (and even then, binding to a more-privileged account is refused).
- **First-launch admin password:** shown on the login screen in **native dev only**. In Docker / production read it from `/data/FIRST_RUN_ADMIN_PASSWORD` (or `docker compose ... logs backend | grep "Default admin"`).

## Running it

```bash
# Docker (recommended)
cp docker/.env.example docker/.env
# generate three random secrets and paste them into docker/.env:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
docker compose -f docker/docker-compose.yml --env-file docker/.env up --build
# open http://localhost:8080
```

See [README.md](README.md) for the native development setup (three hot-reloading services) and the full data-source / driver matrix.
