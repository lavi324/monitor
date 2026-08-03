// Client-side access gate for the Service Center monitor.
//
// Access requires a JWT obtained from the Service Center login endpoint
// (http://<ip>/api/JWTAuthentication/login). The token is decoded locally only
// to read its `exp` claim, so the user is logged out automatically the moment
// it expires. This works alongside the portal-referrer gate that nginx and the
// backend already enforce (the monitor may only be opened from /ng/portal).
// NOTE: this is a soft, client-side gate — not a replacement for server-side
// token verification.
(function (global) {
  'use strict';

  var TOKEN_KEY = 'sc_monitor_jwt';
  var LOGIN_PAGE = 'login.html';
  var APP_PAGE = 'index.html';
  var watchTimer = null;

  // The login call is issued same-origin (through the monitor's own nginx,
  // which reverse-proxies it to the Service Center auth service on the host).
  // Going same-origin avoids the CORS block that a direct cross-port request
  // to http://<ip>/api/... would hit. Never localhost — it resolves to the IP
  // the monitor was opened from.
  function loginEndpoint() {
    return '/api/JWTAuthentication/login';
  }

  function getToken() {
    try { return global.localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }

  function setToken(token) {
    try { global.localStorage.setItem(TOKEN_KEY, token); } catch (e) {}
  }

  function clearToken() {
    try { global.localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }

  // Decode a JWT payload without verifying its signature (base64url -> JSON).
  function decodePayload(token) {
    if (!token || typeof token !== 'string') return null;
    var parts = token.split('.');
    if (parts.length < 2) return null;
    var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    try {
      return JSON.parse(decodeURIComponent(escape(global.atob(b64))));
    } catch (e) {
      try { return JSON.parse(global.atob(b64)); } catch (e2) { return null; }
    }
  }

  // Expiry in ms since epoch, or null when the token carries no exp claim.
  function expiryMs(token) {
    var payload = decodePayload(token);
    if (!payload || typeof payload.exp !== 'number') return null;
    return payload.exp * 1000;
  }

  function isValid(token) {
    token = token || getToken();
    if (!token) return false;
    var exp = expiryMs(token);
    // No exp claim -> trust the token; otherwise it must still be in the future.
    return exp === null ? true : Date.now() < exp;
  }

  function currentFile() {
    var p = global.location.pathname;
    var f = p.substring(p.lastIndexOf('/') + 1);
    return f === '' ? APP_PAGE : f;
  }

  function redirectToLogin() {
    if (currentFile() !== LOGIN_PAGE) global.location.replace(LOGIN_PAGE);
  }

  function logout() {
    clearToken();
    redirectToLogin();
  }

  // Poll so an expired token (or one cleared in another tab) logs the user out
  // within a few seconds without needing a page reload.
  function startExpiryWatch() {
    if (watchTimer) global.clearInterval(watchTimer);
    watchTimer = global.setInterval(function () {
      if (!isValid()) logout();
    }, 5000);
    global.addEventListener('storage', function (e) {
      if (e.key === TOKEN_KEY && !isValid()) logout();
    });
  }

  // Guard the app: bounce unauthenticated / expired users to the login page.
  function requireAuth() {
    if (!isValid()) { logout(); return false; }
    startExpiryWatch();
    return true;
  }

  function extractToken(data) {
    if (!data) return null;
    if (typeof data === 'string') return data;
    // Service Center wraps the payload in `data`; the JWT is `loginToken`.
    var d = data.data || data;
    return d.loginToken || d.token || d.accessToken || d.access_token || d.jwt ||
      data.loginToken || data.token || data.accessToken || null;
  }

  async function login(username, password) {
    var res = await fetch(loginEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ userName: username, pass: password })
    });
    if (!res.ok) {
      var msg = 'Login failed (' + res.status + ')';
      try {
        var errBody = await res.json();
        if (errBody && (errBody.message || errBody.error)) msg = errBody.message || errBody.error;
      } catch (e) {}
      throw new Error(msg);
    }
    var data = null;
    try { data = await res.json(); } catch (e) {}
    var token = extractToken(data);
    if (!token) throw new Error('Login response did not contain a token');
    setToken(token);
    return token;
  }

  global.Auth = {
    login: login,
    logout: logout,
    getToken: getToken,
    isValid: isValid,
    requireAuth: requireAuth,
    loginEndpoint: loginEndpoint,
    APP_PAGE: APP_PAGE,
    LOGIN_PAGE: LOGIN_PAGE
  };
})(window);
