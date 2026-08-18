//! Gateway authentication.
//!
//! One module serves both editions:
//!
//! - **API keys** (`Authorization: Bearer oc_...`): workspace keys and org keys
//!   (`oc_org_*`) validate everywhere. An `oc_` bearer COMMITS the request to
//!   key auth — a failed validation is a hard 401, never a fallthrough to
//!   session auth (see [`classify_bearer`]). LIVENESS (the key's user still an
//!   active member of the key's org) is re-checked in every edition; the ROLE
//!   rechecks (org-key admin, workspace-key access binding) enforce on cloud and
//!   on a licensed self-host — mirroring the Node API's role resolver, which
//!   no-ops only for unlicensed non-RBAC deployments.
//! - **Sessions**: when `COGNITO_USER_POOL_ID` is configured (cloud), a Cognito
//!   JWT from the `Authorization` header is validated via RS256 + JWKS.
//!   Otherwise the self-hosted session cookie is validated — a signed token
//!   backed by a `sessions` row, so signing out or revoking takes effect here
//!   immediately. There is no third arm: a request without a valid credential
//!   is anonymous.
//! - **Workspace resolution**: the cloud edition is multi-workspace and requires a
//!   validated `X-Workspace-Id` (the web sets it from the URL) — never a silent
//!   default. The onprem edition falls back to the caller's default workspace.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use base64::Engine as _;
use hyper::HeaderMap;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use ring::hmac;
use serde::Deserialize;
use sqlx::PgPool;
use tokio::sync::RwLock;
use tracing::{debug, warn};

use crate::db;
use crate::edition::{edition, Edition};
use crate::gateway::GatewayState;

// ── AuthError ────────────────────────────────────────────────────────────

/// Authentication error — always returns 401 Unauthorized.
#[derive(Debug)]
pub(crate) struct AuthError(String);

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "auth error: {}", self.0)
    }
}

impl IntoResponse for AuthError {
    fn into_response(self) -> axum::response::Response {
        (StatusCode::UNAUTHORIZED, self.0).into_response()
    }
}

// ── Cached env reads ─────────────────────────────────────────────────────

fn better_auth_secret() -> Option<&'static str> {
    static SECRET: OnceLock<Option<String>> = OnceLock::new();
    SECRET
        .get_or_init(|| {
            std::env::var("BETTER_AUTH_SECRET")
                .ok()
                .or_else(|| std::env::var("AUTH_SECRET").ok())
                .filter(|s| !s.trim().is_empty())
        })
        .as_deref()
}

/// Whether the key ROLE rechecks (org-key admin/owner, workspace-key
/// admin-or-binding) are enforced. RBAC is enforced on cloud and on a
/// LICENSED self-host (#66); the Node API's role resolver mirrors exactly
/// that (it is wired on cloud and on entitled onprem), and the gateway must
/// gate identically or a key would work through the web API and fail at the
/// gateway — or the reverse.
///
/// This gates ONLY the role layer. LIVENESS — the key's user still being an
/// ACTIVE member of the key's org ([`db::user_is_active_org_member`] for org
/// keys, [`db::user_can_access_workspace`] for workspace keys) — is unconditional
/// and checked in every edition, entitled or not.
fn enforce_key_rechecks(edition: Edition, entitled: bool) -> bool {
    edition == Edition::Cloud || entitled
}

/// How a session request's workspace is resolved when no validated
/// `X-Workspace-Id` header is present. Cloud is multi-workspace and REFUSES —
/// never a silent default; onprem falls back to the caller's default workspace
/// (org → first workspace). Takes `Edition` as a parameter so both arms are
/// table-tested; `edition()` is read only at the call site.
#[derive(Debug, PartialEq, Eq)]
enum SessionWorkspaceResolution {
    /// The validated header workspace wins, in every edition.
    Workspace(String),
    /// Cloud, header absent: 401 — the web always names the workspace.
    RequireHeader,
    /// Onprem, header absent: resolve the caller's default workspace.
    DefaultFallback,
}

fn session_workspace_resolution(
    header_workspace: Option<String>,
    edition: Edition,
) -> SessionWorkspaceResolution {
    match (header_workspace, edition) {
        (Some(id), _) => SessionWorkspaceResolution::Workspace(id),
        (None, Edition::Cloud) => SessionWorkspaceResolution::RequireHeader,
        (None, Edition::Onprem) => SessionWorkspaceResolution::DefaultFallback,
    }
}

// ── Extractors ───────────────────────────────────────────────────────────

/// Authenticated user with a required workspace. Used by most gateway routes.
/// Equivalent to the Node API's `auth()` (requireWorkspace: true, the default).
///
/// Add as an Axum handler parameter to require authentication:
/// ```ignore
/// async fn list_secrets(auth: AuthUser) -> impl IntoResponse { ... }
/// ```
pub(crate) struct AuthUser {
    pub user_id: String,
    pub workspace_id: String,
    pub auth_method: String,
}

impl FromRequestParts<GatewayState> for AuthUser {
    type Rejection = AuthError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &GatewayState,
    ) -> Result<Self, Self::Rejection> {
        let pool = &state.policy_engine.pool;

        // An `oc_` bearer COMMITS the request to API-key auth: a failed
        // validation is a hard 401, never a session fallthrough (see
        // [`classify_bearer`]).
        if let BearerDisposition::ApiKey(token) = classify_bearer(bearer_token(&parts.headers)) {
            let auth = validate_api_key(pool, token, &parts.headers, edition()).await?;
            // An org key must name its workspace explicitly on workspace routes —
            // in every edition (there is no meaningful default inside an org).
            // The key itself is VALID here; the missing workspace gets its own
            // user-actionable 401, distinct from "invalid API key".
            let workspace_id = auth.workspace_id.ok_or_else(|| {
                warn!(
                    auth_method = %auth.auth_method,
                    "api key auth: X-Workspace-Id header is required"
                );
                AuthError("X-Workspace-Id (formerly X-Project-Id) header is required".to_string())
            })?;
            return Ok(Self {
                user_id: auth.user_id,
                workspace_id,
                auth_method: auth.auth_method,
            });
        }

        // No `oc_` bearer present — session auth.
        let session = validate_session(pool, &parts.headers).await?;

        // A validated X-Workspace-Id always wins; the header-less decision is the
        // edition branch (see `session_workspace_resolution`).
        let header_workspace =
            optional_workspace_header(&parts.headers, &session.user_id, pool).await?;
        let workspace_id = match session_workspace_resolution(header_workspace, edition()) {
            SessionWorkspaceResolution::Workspace(id) => id,
            SessionWorkspaceResolution::RequireHeader => {
                warn!(user_id = %session.user_id, "auth: X-Workspace-Id header is required");
                return Err(AuthError(
                    "X-Workspace-Id (formerly X-Project-Id) header is required".to_string(),
                ));
            }
            SessionWorkspaceResolution::DefaultFallback => {
                db::find_default_workspace_id_by_user(pool, &session.user_id)
                    .await
                    .map_err(|e| {
                        warn!(error = %e, "auth: failed to resolve workspace");
                        AuthError("internal error".to_string())
                    })?
                    .ok_or_else(|| {
                        warn!(user_id = %session.user_id, "auth: no workspace found for user");
                        AuthError("no workspace found".to_string())
                    })?
            }
        };

        Ok(Self {
            user_id: session.user_id,
            workspace_id,
            auth_method: session.auth_method.to_string(),
        })
    }
}

/// Authenticated user with an optional workspace. Used by org-level routes.
/// Equivalent to the Node API's `auth({ requireWorkspace: false })`.
///
/// `organization_id` is `Some` only for an org API key (`oc_org_*`); a workspace
/// key or a workspace-scoped browser session leaves it `None`, and org-level
/// handlers reject that with 403 (the credential is valid but not org-scoped).
pub(crate) struct OrgAuthUser {
    pub user_id: String,
    #[allow(dead_code)]
    pub workspace_id: Option<String>,
    pub organization_id: Option<String>,
    pub auth_method: String,
}

impl OrgAuthUser {
    /// Require a workspace ID, returning an auth error if absent.
    /// Equivalent to the Node API's `requireWorkspaceId(auth)`.
    #[allow(dead_code)]
    pub fn require_workspace_id(&self) -> Result<&str, AuthError> {
        self.workspace_id.as_deref().ok_or_else(|| {
            AuthError("X-Workspace-Id (formerly X-Project-Id) header is required".to_string())
        })
    }
}

impl FromRequestParts<GatewayState> for OrgAuthUser {
    type Rejection = AuthError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &GatewayState,
    ) -> Result<Self, Self::Rejection> {
        let pool = &state.policy_engine.pool;

        // An `oc_` bearer COMMITS the request to API-key auth: a failed
        // validation is a hard 401, never a session fallthrough (see
        // [`classify_bearer`]).
        if let BearerDisposition::ApiKey(token) = classify_bearer(bearer_token(&parts.headers)) {
            let auth = validate_api_key(pool, token, &parts.headers, edition()).await?;
            return Ok(Self {
                user_id: auth.user_id,
                workspace_id: auth.workspace_id,
                organization_id: auth.organization_id,
                auth_method: auth.auth_method,
            });
        }

        // No `oc_` bearer present — session auth. Workspace is optional here (org-level
        // routes); take it from X-Workspace-Id when present (validated), and
        // never fall back to a default workspace. A browser session carries no
        // organization scope (that would need a validated X-Organization-Id —
        // a follow-up); org-only routes therefore 403 a session for now.
        let session = validate_session(pool, &parts.headers).await?;

        let workspace_id =
            optional_workspace_header(&parts.headers, &session.user_id, pool).await?;

        Ok(Self {
            user_id: session.user_id,
            workspace_id,
            organization_id: None,
            auth_method: session.auth_method.to_string(),
        })
    }
}

/// Resolve the workspace from the `X-Workspace-Id` header. Returns `None` when the
/// header is absent, the validated workspace when the user is a member of its
/// organization, or an auth error when the header names a workspace the user may
/// not access.
async fn optional_workspace_header(
    headers: &HeaderMap,
    user_id: &str,
    pool: &PgPool,
) -> Result<Option<String>, AuthError> {
    let Some(workspace_id) = headers
        .get("x-workspace-id")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        // Rename compat (temporary): the legacy X-Project-Id fills absence
        // only — a canonical header always wins — and the value still goes
        // through the same access check below.
        .or_else(|| crate::compat::legacy_workspace_header(headers))
    else {
        return Ok(None);
    };

    let allowed = db::user_can_access_workspace(pool, user_id, workspace_id)
        .await
        .map_err(|e| {
            warn!(error = %e, "auth: failed to verify workspace access");
            AuthError("internal error".to_string())
        })?;

    if !allowed {
        warn!(
            user_id = %user_id,
            workspace_id = %workspace_id,
            "auth: user is not a member of the workspace's organization"
        );
        // Don't disclose whether the workspace exists.
        return Err(AuthError("workspace not found".to_string()));
    }

    Ok(Some(workspace_id.to_string()))
}

// ── API key validation ──────────────────────────────────────────────────

/// Intermediate auth result before conversion to `AuthUser` or `OrgAuthUser`.
struct ApiKeyAuth {
    user_id: String,
    workspace_id: Option<String>,
    /// The key's organization — `Some` only for an org key (`oc_org_*`), which
    /// `OrgAuthUser` requires; `None` for a workspace key.
    organization_id: Option<String>,
    auth_method: String,
}

/// 401 body for any failed `oc_` API-key validation. Deliberately uniform
/// (unknown key, db error, failed recheck all read the same) — the `warn!`
/// logs carry the specific reason.
fn invalid_api_key() -> AuthError {
    AuthError("invalid API key".to_string())
}

/// How the request's bearer token routes authentication.
///
/// **Strict key commit semantics**: an `oc_`-prefixed bearer COMMITS the
/// request to API-key validation. If the key fails to validate — unknown key,
/// database error, failed recheck — the request fails with a hard 401
/// (`invalid API key`); session auth NEVER runs as a fallback. (The historical
/// fallthrough let an invalid org key land on the ambient onprem local session
/// and act as the local admin; org keys exist in every edition, so the commit
/// is unconditional.) Session auth runs only when no `oc_` bearer is present.
#[derive(Debug, PartialEq, Eq)]
enum BearerDisposition<'a> {
    /// `Authorization: Bearer oc_…` — commit to API-key validation.
    ApiKey(&'a str),
    /// No bearer token, or a non-`oc_` bearer (e.g. a Cognito JWT) — proceed
    /// to session auth.
    Session,
}

/// Classify the (already extracted) bearer token. See [`BearerDisposition`]
/// for the commit rule this encodes.
fn classify_bearer(token: Option<&str>) -> BearerDisposition<'_> {
    match token {
        Some(t) if t.starts_with("oc_") => BearerDisposition::ApiKey(t),
        _ => BearerDisposition::Session,
    }
}

/// The bearer token from the `Authorization` header, if one is present.
fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    extract_bearer_token(headers).ok()
}

/// Validate an `oc_` API key (workspace or org-scoped).
///
/// Runs only once [`classify_bearer`] has committed the request to key auth:
/// every failure returns the hard `invalid API key` 401 and never falls
/// through to session auth.
///
/// For org keys without an `X-Workspace-Id` header (an empty value counts as
/// absent), returns `Ok` with `workspace_id: None` — a VALID key with a missing
/// workspace; the caller decides whether that is an error (`AuthUser` requires a
/// workspace, `OrgAuthUser` does not). The role rechecks run only where
/// [`enforce_key_rechecks`] says so (cloud).
async fn validate_api_key(
    pool: &PgPool,
    token: &str,
    headers: &HeaderMap,
    edition: Edition,
) -> Result<ApiKeyAuth, AuthError> {
    let prefix = token.get(..12).unwrap_or(token);

    // Org key (oc_org_*)
    if token.starts_with("oc_org_") {
        let org_key = db::find_org_api_key(pool, token)
            .await
            .map_err(|e| {
                warn!(error = %e, "org api key auth: db error");
                invalid_api_key()
            })?
            .ok_or_else(|| {
                warn!("org api key auth: unknown key");
                invalid_api_key()
            })?;

        // LIVENESS — every edition: the key authenticates only while its user
        // is still an ACTIVE member of the key's org, so suspension or removal
        // kills the key immediately.
        let is_active =
            db::user_is_active_org_member(pool, &org_key.user_id, &org_key.organization_id)
                .await
                .map_err(|e| {
                    warn!(error = %e, "org api key auth: membership check failed");
                    invalid_api_key()
                })?;
        if !is_active {
            warn!(
                user_id = %org_key.user_id,
                org_id = %org_key.organization_id,
                "org api key auth: user is no longer an active org member"
            );
            return Err(invalid_api_key());
        }

        // ROLE — cloud + licensed onprem (#66): org keys are an admin
        // capability, so re-check the user still holds admin/owner in the org
        // and the key stops working after a demotion. Unlicensed onprem
        // enforces no roles (every active member of the org is trusted).
        if enforce_key_rechecks(edition, crate::edition::entitled()) {
            let is_admin = crate::ee::rbac::user_is_org_admin(
                pool,
                &org_key.user_id,
                &org_key.organization_id,
            )
            .await
            .map_err(|e| {
                warn!(error = %e, "org api key auth: admin check failed");
                invalid_api_key()
            })?;
            if !is_admin {
                warn!(
                    user_id = %org_key.user_id,
                    org_id = %org_key.organization_id,
                    "org api key auth: user no longer admin/owner"
                );
                return Err(invalid_api_key());
            }
        }

        // An empty `X-Workspace-Id` value counts as absent — mirrors
        // `optional_workspace_header`. Rename compat (temporary): the legacy
        // X-Project-Id fills absence only; `verify_workspace_in_org` below
        // fences the aliased value exactly like a canonical one.
        let header_workspace_id = headers
            .get("x-workspace-id")
            .and_then(|v| v.to_str().ok())
            .filter(|s| !s.is_empty())
            .or_else(|| crate::compat::legacy_workspace_header(headers));

        if let Some(workspace_id) = header_workspace_id {
            let valid = db::verify_workspace_in_org(pool, workspace_id, &org_key.organization_id)
                .await
                .map_err(|e| {
                    warn!(
                        error = %e,
                        "org api key auth: workspace verification failed"
                    );
                    invalid_api_key()
                })?;

            if !valid {
                warn!(
                    org_id = %org_key.organization_id,
                    workspace_id = %workspace_id,
                    "org api key auth: workspace does not belong to organization"
                );
                return Err(invalid_api_key());
            }

            return Ok(ApiKeyAuth {
                user_id: org_key.user_id,
                workspace_id: Some(workspace_id.to_string()),
                organization_id: Some(org_key.organization_id),
                auth_method: format!("org_api_key:{prefix}"),
            });
        }

        // No X-Workspace-Id header — the key is valid; return auth with no
        // workspace. The caller (AuthUser vs OrgAuthUser extractor) decides
        // whether to reject or accept based on its workspace requirement.
        return Ok(ApiKeyAuth {
            user_id: org_key.user_id,
            workspace_id: None,
            organization_id: Some(org_key.organization_id),
            auth_method: format!("org_api_key:{prefix}"),
        });
    }

    // Workspace key (oc_*)
    let api_key = db::find_api_key(pool, token)
        .await
        .map_err(|e| {
            warn!(error = %e, "api key auth: db error");
            invalid_api_key()
        })?
        .ok_or_else(|| {
            warn!("api key auth: unknown key");
            invalid_api_key()
        })?;

    // LIVENESS — every edition: the key authenticates only while its user is
    // still an ACTIVE member of the workspace's org, so suspension or removal
    // kills the key immediately.
    let is_active = db::user_can_access_workspace(pool, &api_key.user_id, &api_key.workspace_id)
        .await
        .map_err(|e| {
            warn!(error = %e, "api key auth: membership check failed");
            invalid_api_key()
        })?;
    if !is_active {
        warn!(
            user_id = %api_key.user_id,
            workspace_id = %api_key.workspace_id,
            "api key auth: user is no longer an active member of the workspace's org"
        );
        return Err(invalid_api_key());
    }

    // ROLE — cloud + licensed onprem (#66): the user must still hold per-workspace access — an
    // org admin/owner, or a WorkspaceAccess binding (direct or via a group).
    // Closes the gap where a key keeps working after the user is demoted or
    // the workspace is unshared. Mirrors the web's `canAccessWorkspaceAsUser`,
    // which no-ops for non-RBAC editions.
    if enforce_key_rechecks(edition, crate::edition::entitled()) {
        let can_access = crate::ee::rbac::user_can_manage_workspace(
            pool,
            &api_key.user_id,
            &api_key.workspace_id,
        )
        .await
        .map_err(|e| {
            warn!(error = %e, "api key auth: access check failed");
            invalid_api_key()
        })?;
        if !can_access {
            warn!(
                user_id = %api_key.user_id,
                workspace_id = %api_key.workspace_id,
                "api key auth: user no longer has access to workspace"
            );
            return Err(invalid_api_key());
        }
    }

    Ok(ApiKeyAuth {
        user_id: api_key.user_id,
        workspace_id: Some(api_key.workspace_id),
        organization_id: None,
        auth_method: format!("api_key:{prefix}"),
    })
}

// ── Session validation ───────────────────────────────────────────────────

/// A validated session: the internal user ID plus the method label reported in
/// `auth_method`.
struct SessionAuth {
    user_id: String,
    auth_method: &'static str,
}

/// Validate an incoming browser request: Cognito (Bearer JWT) when the pool is
/// configured, otherwise the self-hosted session cookie. There is no
/// unauthenticated arm — a request without a valid credential is anonymous.
async fn validate_session(pool: &PgPool, headers: &HeaderMap) -> Result<SessionAuth, AuthError> {
    if cognito_configured() {
        return Ok(SessionAuth {
            user_id: validate_cognito(pool, headers).await?,
            auth_method: "cognito",
        });
    }
    Ok(SessionAuth {
        user_id: validate_session_cookie(pool, headers).await?,
        auth_method: "session",
    })
}

// ── Session mode (better-auth cookie) ────────────────────────────────────

/// The cookie names the self-hosted identity layer issues, most specific
/// first: browsers get the `__Secure-` variant on HTTPS deployments and the
/// bare name otherwise, so both have to be accepted.
///
/// Mirrors `packages/api/src/lib/better-auth-contract.ts`. This process can't
/// import it, so the strings are pinned there and here, and the e2e suite
/// asserts the two agree by sending a cookie the API itself minted.
const SESSION_COOKIE_NAMES: [&str; 2] = [
    "__Secure-better-auth.session_token",
    "better-auth.session_token",
];

/// A base64 SHA-256 HMAC is always 44 characters ending in one `=`. Checking
/// that first rejects malformed cookies before any crypto or database work.
const SIGNATURE_LEN: usize = 44;

/// Split a signed cookie value into its token and signature.
///
/// The value is `<token>.<base64 signature>`, percent-encoded as a whole (the
/// signature's `+`, `/` and `=` do not survive a cookie otherwise). The token
/// is alphanumeric, so the last `.` is unambiguously the separator.
fn split_signed_cookie(value: &str) -> Option<(String, String)> {
    let decoded = percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .ok()?;
    let (token, signature) = decoded.rsplit_once('.')?;
    if token.is_empty() || signature.len() != SIGNATURE_LEN || !signature.ends_with('=') {
        return None;
    }
    Some((token.to_string(), signature.to_string()))
}

/// Verify the cookie's signature and return the session token it carries.
///
/// The signature is HMAC-SHA256 over the token alone, keyed with the raw
/// bytes of the shared secret — the format the identity layer produces. The
/// token is high-entropy and looked up in the database anyway, so this check
/// is defence in depth: it discards forgeries before they reach Postgres.
fn verify_signed_session_cookie(cookie_header: &str, secret: &str) -> Option<String> {
    // Try each name through to a usable split: a stale or truncated cookie
    // under the first name must not mask a good one under the second.
    let (token, signature) = SESSION_COOKIE_NAMES
        .iter()
        .find_map(|name| parse_cookie(cookie_header, name).and_then(split_signed_cookie))?;

    let expected = base64::engine::general_purpose::STANDARD
        .decode(&signature)
        .ok()?;

    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    hmac::verify(&key, token.as_bytes(), &expected).ok()?;

    Some(token)
}

/// Validate a self-hosted browser session and return the internal user ID.
async fn validate_session_cookie(pool: &PgPool, headers: &HeaderMap) -> Result<String, AuthError> {
    let cookie_header = headers
        .get(hyper::header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| {
            warn!("session auth: no cookie header");
            AuthError("missing cookie".to_string())
        })?;

    let secret = better_auth_secret().ok_or_else(|| {
        // Generic body — the config detail stays in the log, not the response.
        warn!("session auth: BETTER_AUTH_SECRET not set");
        AuthError("authentication unavailable".to_string())
    })?;

    let token = verify_signed_session_cookie(cookie_header, secret).ok_or_else(|| {
        warn!("session auth: no valid session cookie");
        AuthError("invalid session token".to_string())
    })?;

    let user = db::find_user_by_session_token(pool, &token)
        .await
        .map_err(|e| {
            warn!(error = %e, "session auth: db error");
            AuthError("internal error".to_string())
        })?
        .ok_or_else(|| {
            // Signed by us, but the row is gone or past its expiry — a signed
            // out, revoked or stale session.
            warn!("session auth: no live session for token");
            AuthError("session expired".to_string())
        })?;

    Ok(user.id)
}

// ── Cognito mode (Bearer JWT, RS256 via JWKS) ────────────────────────────

/// Cognito ID token claims. The `sub` field is the Cognito user ID; it maps to
/// `User.externalAuthId` in the database — the same value Cognito returns as
/// `userId` from `getCurrentUser()`.
#[derive(Debug, Deserialize)]
struct CognitoClaims {
    sub: String,
}

/// How long to cache JWKS keys before allowing a refresh.
const JWKS_MIN_REFRESH_INTERVAL: Duration = Duration::from_secs(300);

/// A single JWK (JSON Web Key) for RS256 verification.
#[derive(Debug, Deserialize)]
struct Jwk {
    kid: String,
    kty: String,
    n: String,
    e: String,
    #[serde(rename = "use")]
    use_: Option<String>,
}

/// JWKS response from Cognito.
#[derive(Debug, Deserialize)]
struct JwksResponse {
    keys: Vec<Jwk>,
}

/// Cached JWKS keys, keyed by `kid`.
struct JwksCache {
    keys: HashMap<String, DecodingKey>,
    last_fetched: Instant,
    jwks_url: String,
}

impl JwksCache {
    fn new(jwks_url: String) -> Self {
        Self {
            keys: HashMap::new(),
            last_fetched: Instant::now() - JWKS_MIN_REFRESH_INTERVAL,
            jwks_url,
        }
    }

    /// Get the decoding key for a `kid`, fetching from Cognito if needed.
    async fn get_key(&mut self, kid: &str) -> Result<&DecodingKey, AuthError> {
        if !self.keys.contains_key(kid) {
            // Rate-limit JWKS fetches to avoid hammering Cognito on invalid tokens
            if self.last_fetched.elapsed() < JWKS_MIN_REFRESH_INTERVAL {
                return Err(AuthError("unknown signing key".to_string()));
            }
            self.refresh().await?;
        }

        self.keys
            .get(kid)
            .ok_or_else(|| AuthError("unknown signing key".to_string()))
    }

    /// Fetch fresh keys from the Cognito JWKS endpoint.
    async fn refresh(&mut self) -> Result<(), AuthError> {
        let resp: JwksResponse = reqwest::get(&self.jwks_url)
            .await
            .map_err(|e| {
                warn!(error = %e, "cognito auth: failed to fetch JWKS");
                AuthError("failed to fetch signing keys".to_string())
            })?
            .json()
            .await
            .map_err(|e| {
                warn!(error = %e, "cognito auth: failed to parse JWKS");
                AuthError("failed to parse signing keys".to_string())
            })?;

        self.keys.clear();
        for jwk in resp.keys {
            // Only use RSA signing keys (skip encryption keys)
            if jwk.kty != "RSA" || jwk.use_.as_deref() == Some("enc") {
                continue;
            }
            match DecodingKey::from_rsa_components(&jwk.n, &jwk.e) {
                Ok(key) => {
                    self.keys.insert(jwk.kid, key);
                }
                Err(e) => {
                    warn!(error = %e, "cognito auth: failed to parse JWK");
                }
            }
        }

        self.last_fetched = Instant::now();
        Ok(())
    }
}

/// Global JWKS cache, initialized once from environment.
static JWKS: OnceLock<Option<Arc<RwLock<JwksCache>>>> = OnceLock::new();

fn jwks_state() -> &'static Option<Arc<RwLock<JwksCache>>> {
    JWKS.get_or_init(|| {
        let region = std::env::var("AWS_REGION").unwrap_or_else(|_| "us-east-1".to_string());
        let user_pool_id = match std::env::var("COGNITO_USER_POOL_ID") {
            Ok(id) if !id.trim().is_empty() => id,
            _ => return None,
        };

        let jwks_url = format!(
            "https://cognito-idp.{region}.amazonaws.com/{user_pool_id}/.well-known/jwks.json"
        );

        Some(Arc::new(RwLock::new(JwksCache::new(jwks_url))))
    })
}

/// Whether Cognito session auth is configured (`COGNITO_USER_POOL_ID` set).
/// This is the session-validator selector: cloud deployments set the pool id,
/// self-hosted ones never do.
fn cognito_configured() -> bool {
    jwks_state().is_some()
}

fn jwks_cache() -> Result<&'static Arc<RwLock<JwksCache>>, AuthError> {
    jwks_state().as_ref().ok_or_else(|| {
        // Generic body — the config detail stays in the log, not the response.
        warn!("cognito auth: COGNITO_USER_POOL_ID env var not set");
        AuthError("unauthorized".to_string())
    })
}

/// Validate a Cognito JWT from the Authorization header and return the internal user ID.
async fn validate_cognito(pool: &PgPool, headers: &HeaderMap) -> Result<String, AuthError> {
    // 1. Extract bearer token from Authorization header
    let token = extract_bearer_token(headers)?;

    // 2. Decode JWT header to get the `kid` (key ID)
    let header = decode_header(token).map_err(|e| {
        // Tokens without dots aren't JWTs — normal fallthrough from non-JWT auth
        if token.matches('.').count() < 2 {
            debug!(error = %e, "cognito auth: non-JWT token, skipping");
        } else {
            warn!(error = %e, "cognito auth: failed to decode JWT header");
        }
        AuthError("invalid token".to_string())
    })?;

    let kid = header.kid.ok_or_else(|| {
        warn!("cognito auth: JWT header missing kid");
        AuthError("invalid token".to_string())
    })?;

    // 3. Get the decoding key from JWKS cache (fetches from Cognito if needed)
    let cache = jwks_cache()?;
    let key = {
        let mut cache_write = cache.write().await;
        // Clone the key to release the lock before decode
        cache_write.get_key(&kid).await?.clone()
    };

    // 4. Validate and decode the JWT (RS256)
    let mut validation = Validation::new(Algorithm::RS256);
    validation.validate_exp = true;
    // Cognito ID tokens don't always have an `aud` claim that matches
    // the client ID when using hosted UI. Disable audience validation
    // and rely on the issuer + signature instead.
    validation.validate_aud = false;

    let token_data = decode::<CognitoClaims>(token, &key, &validation).map_err(|e| {
        warn!(error = %e, "cognito auth: JWT validation failed");
        AuthError("invalid token".to_string())
    })?;

    let sub = &token_data.claims.sub;

    // 5. Look up user by Cognito user ID (externalAuthId in DB)
    let user = db::find_user_by_external_auth_id(pool, sub)
        .await
        .map_err(|e| {
            warn!(error = %e, "cognito auth: db error");
            AuthError("internal error".to_string())
        })?
        .ok_or_else(|| {
            warn!(sub = %sub, "cognito auth: user not found");
            AuthError("user not found".to_string())
        })?;

    Ok(user.id)
}

// ── Helpers ──────────────────────────────────────────────────────────────

/// Extract the bearer token from the `Authorization` header.
/// The `Bearer` scheme is case-insensitive per RFC 6750.
fn extract_bearer_token(headers: &HeaderMap) -> Result<&str, AuthError> {
    let auth_header = headers
        .get(hyper::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AuthError("missing authorization header".to_string()))?;

    if auth_header.len() < 7 || !auth_header[..7].eq_ignore_ascii_case("bearer ") {
        return Err(AuthError("invalid authorization scheme".to_string()));
    }

    Ok(&auth_header[7..])
}

/// Parse a specific cookie value from a Cookie header string.
fn parse_cookie<'a>(cookie_header: &'a str, name: &str) -> Option<&'a str> {
    cookie_header.split(';').find_map(|pair| {
        let pair = pair.trim();
        let (key, value) = pair.split_once('=')?;
        if key.trim() == name {
            Some(value.trim())
        } else {
            None
        }
    })
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // A cookie value in the exact shape the identity layer issues:
    // `<token>.<base64 HMAC-SHA256 of the token>`, percent-encoded. The e2e
    // suite proves the real library agrees; these pin the parsing and the
    // verification against a known-good value.
    const FIXTURE_SECRET: &str = "gateway-session-fixture-secret-0123456789";
    const FIXTURE_TOKEN: &str = "abcdefghijklmnopqrstuvwxyz012345";
    const FIXTURE_COOKIE: &str =
        "abcdefghijklmnopqrstuvwxyz012345.z9I8tEiX%2BAIXeqzoVvf07Qzt6xNExqUqR%2FzEmTaeaAU%3D";

    #[test]
    fn verifies_a_signed_session_cookie_under_both_names() {
        // The names are spelled out rather than read from SESSION_COOKIE_NAMES
        // on purpose: iterating the constant would make this test's input
        // change with the constant, so a wrong name would still pass. These
        // literals are the contract the TypeScript side issues against.
        for name in [
            "__Secure-better-auth.session_token",
            "better-auth.session_token",
        ] {
            let header = format!("other=x; {name}={FIXTURE_COOKIE}; path=/");
            assert_eq!(
                verify_signed_session_cookie(&header, FIXTURE_SECRET).as_deref(),
                Some(FIXTURE_TOKEN),
                "cookie name {name}"
            );
        }
    }

    #[test]
    fn rejects_a_cookie_signed_with_another_secret() {
        let header = format!("better-auth.session_token={FIXTURE_COOKIE}");
        assert_eq!(
            verify_signed_session_cookie(&header, "a-different-secret"),
            None
        );
    }

    #[test]
    fn rejects_a_tampered_token() {
        // Same signature, one character of the token changed: the signature
        // covers the token, so this must not verify.
        let tampered = FIXTURE_COOKIE.replacen("abcdefgh", "abcdefgX", 1);
        let header = format!("better-auth.session_token={tampered}");
        assert_eq!(verify_signed_session_cookie(&header, FIXTURE_SECRET), None);
    }

    #[test]
    fn rejects_an_unsigned_or_malformed_cookie() {
        for value in [
            FIXTURE_TOKEN, // bare token, no signature
            "no-dot-at-all",
            ".onlyasignature",
            "token.tooshort=",
        ] {
            let header = format!("better-auth.session_token={value}");
            assert_eq!(
                verify_signed_session_cookie(&header, FIXTURE_SECRET),
                None,
                "value {value:?}"
            );
        }
    }

    #[test]
    fn rejects_signatures_that_are_not_a_sha256_hmac() {
        // Shape is checked before any base64 or HMAC work, so a cookie whose
        // signature could not possibly be one is discarded cheaply — the
        // parser must not hand such values on.
        for signature in [
            "short=",                                         // too short
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", // too long
            "z9I8tEiXAAIXeqzoVvf07Qzt6xNExqUqRAzEmTaeaAUx",   // right length, unpadded
        ] {
            assert_eq!(
                split_signed_cookie(&format!("{FIXTURE_TOKEN}.{signature}")),
                None,
                "signature {signature:?}"
            );
        }
    }

    #[test]
    fn splits_at_the_last_dot_after_percent_decoding() {
        // The signature reaches the wire percent-encoded (base64 contains
        // characters cookies cannot carry), so decoding has to happen before
        // the HMAC comparison — and the separator is the LAST dot.
        let (token, signature) = split_signed_cookie(FIXTURE_COOKIE).expect("splits");
        assert_eq!(token, FIXTURE_TOKEN);
        assert!(
            signature.ends_with('='),
            "signature was not decoded: {signature}"
        );
        assert_eq!(signature.len(), SIGNATURE_LEN);
    }

    #[test]
    fn parse_cookie_finds_value() {
        let header = "other=abc; better-auth.session_token=tok.sig; path=/";
        assert_eq!(
            parse_cookie(header, "better-auth.session_token"),
            Some("tok.sig")
        );
    }

    #[test]
    fn parse_cookie_missing() {
        let header = "other=abc; foo=bar";
        assert_eq!(parse_cookie(header, "better-auth.session_token"), None);
    }

    #[test]
    fn parse_cookie_empty() {
        assert_eq!(parse_cookie("", "better-auth.session_token"), None);
    }

    #[test]
    fn extract_bearer_valid() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer eyJhbGciOi...".parse().unwrap());
        assert_eq!(extract_bearer_token(&headers).unwrap(), "eyJhbGciOi...");
    }

    #[test]
    fn extract_bearer_lowercase() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "bearer mytoken".parse().unwrap());
        assert_eq!(extract_bearer_token(&headers).unwrap(), "mytoken");
    }

    #[test]
    fn extract_bearer_mixed_case() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "BEARER mytoken".parse().unwrap());
        assert_eq!(extract_bearer_token(&headers).unwrap(), "mytoken");
    }

    #[test]
    fn extract_bearer_missing_header() {
        let headers = HeaderMap::new();
        assert!(extract_bearer_token(&headers).is_err());
    }

    #[test]
    fn extract_bearer_wrong_scheme() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Basic abc123".parse().unwrap());
        assert!(extract_bearer_token(&headers).is_err());
    }

    #[test]
    fn jwks_url_construction() {
        let region = "us-east-1";
        let pool_id = "us-east-1_abc123";
        let url =
            format!("https://cognito-idp.{region}.amazonaws.com/{pool_id}/.well-known/jwks.json");
        assert_eq!(
            url,
            "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc123/.well-known/jwks.json"
        );
    }

    // The key rechecks are RBAC enforcement — cloud or a licensed self-host,
    // mirroring the Node API's role resolver (which no-ops only for the
    // unlicensed onprem edition).
    // The header-less session arm is the auth module's second edition branch,
    // both arms pinned: cloud refuses (multi-workspace, never a silent default);
    // onprem falls back to the caller's default workspace. A validated header
    // wins everywhere.
    #[test]
    fn session_workspace_resolution_per_edition() {
        assert_eq!(
            session_workspace_resolution(Some("p1".into()), Edition::Cloud),
            SessionWorkspaceResolution::Workspace("p1".into())
        );
        assert_eq!(
            session_workspace_resolution(Some("p1".into()), Edition::Onprem),
            SessionWorkspaceResolution::Workspace("p1".into())
        );
        assert_eq!(
            session_workspace_resolution(None, Edition::Cloud),
            SessionWorkspaceResolution::RequireHeader
        );
        assert_eq!(
            session_workspace_resolution(None, Edition::Onprem),
            SessionWorkspaceResolution::DefaultFallback
        );
    }

    #[test]
    fn key_rechecks_enforce_on_cloud_and_licensed_onprem() {
        assert!(enforce_key_rechecks(Edition::Cloud, false));
        assert!(enforce_key_rechecks(Edition::Cloud, true));
        assert!(enforce_key_rechecks(Edition::Onprem, true));
        assert!(!enforce_key_rechecks(Edition::Onprem, false));
    }

    // ── Strict key commit semantics (`classify_bearer`) ──────────────────
    //
    // An `oc_` bearer must COMMIT the request to key auth: on validation
    // failure the extractors return the hard 401 and never reach session
    // auth. These tests pin the dispatch; the hard-401 propagation is the
    // `?` on `validate_api_key` in both extractors.

    #[test]
    fn oc_bearer_commits_to_api_key_auth() {
        assert_eq!(
            classify_bearer(Some("oc_abc123")),
            BearerDisposition::ApiKey("oc_abc123")
        );
        assert_eq!(
            classify_bearer(Some("oc_org_abc123")),
            BearerDisposition::ApiKey("oc_org_abc123")
        );
    }

    #[test]
    fn non_oc_bearer_goes_to_session_auth() {
        // A Cognito JWT rides the same header — it must reach session auth.
        assert_eq!(
            classify_bearer(Some("eyJhbGciOiJSUzI1NiJ9.x.y")),
            BearerDisposition::Session
        );
        assert_eq!(classify_bearer(Some("")), BearerDisposition::Session);
        assert_eq!(classify_bearer(None), BearerDisposition::Session);
    }

    #[test]
    fn oc_prefix_is_exact_not_fuzzy() {
        // Only the literal `oc_` prefix commits; look-alikes go to session
        // auth (and fail there as invalid JWTs/cookies).
        assert_eq!(classify_bearer(Some("OC_ABC")), BearerDisposition::Session);
        assert_eq!(classify_bearer(Some("oc-abc")), BearerDisposition::Session);
    }

    #[test]
    fn bearer_scheme_is_case_insensitive_for_key_commit() {
        for scheme in ["Bearer", "bearer", "BEARER"] {
            let mut headers = HeaderMap::new();
            headers.insert("authorization", format!("{scheme} oc_key").parse().unwrap());
            assert_eq!(
                classify_bearer(bearer_token(&headers)),
                BearerDisposition::ApiKey("oc_key")
            );
        }
    }

    #[test]
    fn non_bearer_scheme_never_commits_to_key_auth() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Basic oc_abc".parse().unwrap());
        assert_eq!(
            classify_bearer(bearer_token(&headers)),
            BearerDisposition::Session
        );
        assert_eq!(
            classify_bearer(bearer_token(&HeaderMap::new())),
            BearerDisposition::Session
        );
    }

    #[test]
    fn invalid_api_key_body_is_generic() {
        // Clients depend on this exact user-actionable body — pin it.
        assert_eq!(invalid_api_key().0, "invalid API key");
    }
}
