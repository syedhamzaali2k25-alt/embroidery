"""Who is calling: the Supabase sign-in token (JWT) checked on every user route.

The user id comes only from a token this module has verified (its "sub" claim), never from the
request body or a query parameter. A missing, expired, forged or anon token is Unauthorized.

Projects with asymmetric signing keys (ES256/RS256, the Supabase default for new projects) are
checked here against the project's public keys (JWKS). Projects still on the legacy shared
secret (HS256) are checked by asking Supabase Auth itself (GET /auth/v1/user), because the API
does not hold that secret.
"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass
from typing import Callable, Protocol

import httpx
import jwt

ASYMMETRIC = ("ES256", "RS256", "EdDSA")


class Unauthorized(Exception):
    """No usable sign-in token (401). The message is safe to show."""


class AuthUnavailable(Exception):
    """Supabase could not be asked whether the token is good (503); the caller may retry."""


@dataclass(frozen=True)
class User:
    id: str
    token: str | None  # the verified access token, passed on to Supabase so RLS applies
    email: str | None = None  # from the verified token only (team invites are checked against it)


# Local mode (no Supabase settings): everything belongs to this one user and no sign-in is asked.
LOCAL_USER = User(id="local", token=None)


class Auth(Protocol):
    def verify(self, token: str) -> User: ...


def _email(value) -> str | None:
    return value.strip().lower() if isinstance(value, str) and "@" in value else None


def _user_id(sub: object) -> str:
    try:
        return str(uuid.UUID(str(sub)))
    except ValueError:
        raise Unauthorized("This sign-in token has no user in it. Sign in again.") from None


class SupabaseAuth:
    """Checks Supabase access tokens. `timeout_s` and `cache_s` are read when first needed (config.py
    auth.http_timeout_s and auth.jwks_cache_s), so an unchosen value only affects signed-in routes."""

    def __init__(self, url: str, publishable_key: str, timeout_s: Callable[[], float], cache_s: Callable[[], float],
                 http: httpx.Client | None = None):
        self.url = url.rstrip("/")
        self.issuer = f"{self.url}/auth/v1"
        self.publishable_key = publishable_key
        self.timeout_s = timeout_s
        self.cache_s = cache_s
        self.http = http or httpx.Client()
        self._keys: dict[str, jwt.PyJWK] = {}
        self._fetched_at = 0.0
        self._lock = threading.Lock()

    # ---------- public signing keys ----------
    def _fetch_keys(self) -> None:
        response = self.http.get(f"{self.issuer}/.well-known/jwks.json", timeout=self.timeout_s())
        response.raise_for_status()
        keys = {}
        for item in response.json().get("keys", []):
            try:
                keys[item.get("kid", "")] = jwt.PyJWK(item)
            except jwt.PyJWTError:
                continue  # a key type this server cannot use; tokens signed with it are refused
        self._keys, self._fetched_at = keys, time.monotonic()

    def _key(self, kid: str) -> jwt.PyJWK:
        with self._lock:
            stale = time.monotonic() - self._fetched_at > self.cache_s()
            if stale or kid not in self._keys:
                try:
                    self._fetch_keys()
                except (httpx.HTTPError, ValueError) as exc:
                    raise AuthUnavailable() from exc
            if kid not in self._keys:
                raise Unauthorized("This sign-in token was not made by this project. Sign in again.")
            return self._keys[kid]

    # ---------- verify ----------
    def verify(self, token: str) -> User:
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError:
            raise Unauthorized("The sign-in token is not valid. Sign in again.") from None
        alg = header.get("alg")
        if alg in ASYMMETRIC:
            key = self._key(header.get("kid", ""))
            try:
                claims = jwt.decode(token, key.key, algorithms=[alg], audience="authenticated", issuer=self.issuer,
                                    options={"require": ["exp", "sub", "aud", "iss"]})
            except jwt.ExpiredSignatureError:
                raise Unauthorized("Your sign-in has expired. Sign in again.") from None
            except jwt.PyJWTError:
                raise Unauthorized("The sign-in token is not valid. Sign in again.") from None
            if claims.get("role") != "authenticated":
                raise Unauthorized("Sign in to continue.")
            return User(id=_user_id(claims.get("sub")), token=token, email=_email(claims.get("email")))
        if alg == "HS256":
            return self._ask_supabase(token)
        raise Unauthorized("The sign-in token is not valid. Sign in again.")

    def _ask_supabase(self, token: str) -> User:
        """Legacy HS256 projects: Supabase Auth checks the token (signature, expiry, sign-out)."""
        try:
            response = self.http.get(f"{self.issuer}/user", timeout=self.timeout_s(),
                                     headers={"apikey": self.publishable_key, "Authorization": f"Bearer {token}"})
        except httpx.HTTPError as exc:
            raise AuthUnavailable() from exc
        if response.status_code != 200:
            raise Unauthorized("The sign-in token is not valid. Sign in again.")
        body = response.json()
        return User(id=_user_id(body.get("id")), token=token, email=_email(body.get("email")))
