// Client-side access gate for the Service Center monitor.
//
// The monitor has no login of its own. inSight (the portal app) already holds
// the user's JWT; when it launches the Service Center it hands that token over
// in the launch URL's hash (#sc_jwt=<token>). The monitor ingests it, keeps it
// in its own localStorage, and decodes it locally only to read the `exp` claim
// so the user is logged out automatically the moment it expires. If no valid
// token is present the user is sent to a page telling them to sign in to
// inSight and reopen the app. This works alongside the portal-referrer gate
// that nginx and the backend already enforce (the monitor may only be opened
// from /ng/portal).
// NOTE: this is a soft, client-side gate — not a replacement for server-side
// token verification.
(function (global) {
  'use strict';

  var TOKEN_KEY = 'sc_monitor_jwt';
  var DENIED_PAGE = 'denied.html';
  var APP_PAGE = 'index.html';
  var watchTimer = null;

  // inSight (port 80) and this monitor (port 10000) are different origins, so
  // the monitor cannot read inSight's localStorage. inSight therefore hands the
  // JWT over in the launch URL's hash (#sc_jwt=<token>). The hash is never sent
  // to the server, so the token stays out of access logs and the Referer.
  var URL_TOKEN_KEY = 'sc_jwt';

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

  function isValid(token) {
    token = token || getToken();
    if (!token) return false;
    var payload = decodePayload(token);
    if (!payload) return false; // not a decodable JWT -> reject
    // No exp claim -> trust the token; otherwise it must still be in the future.
    return typeof payload.exp !== 'number' ? true : Date.now() < payload.exp * 1000;
  }

  // Pull a JWT handed over by inSight in the URL hash (#sc_jwt=<token>), store
  // it, and scrub it from the address bar / history so it isn't leaked or
  // bookmarked. Returns true when a usable token was ingested.
  function ingestTokenFromUrl() {
    var hash = global.location.hash || '';
    if (hash.indexOf(URL_TOKEN_KEY + '=') === -1) return false;
    var match = hash.match(new RegExp('[#&]' + URL_TOKEN_KEY + '=([^&]+)'));
    var token = match ? decodeURIComponent(match[1]) : null;
    try {
      global.history.replaceState(null, '', global.location.pathname + global.location.search);
    } catch (e) {}
    if (token && isValid(token)) { setToken(token); return true; }
    return false;
  }

  function currentFile() {
    var p = global.location.pathname;
    var f = p.substring(p.lastIndexOf('/') + 1);
    return f === '' ? APP_PAGE : f;
  }

  function redirectToDenied() {
    if (currentFile() !== DENIED_PAGE) global.location.replace(DENIED_PAGE);
  }

  function logout() {
    clearToken();
    redirectToDenied();
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

  // Guard the app: accept a token freshly handed over by inSight, then bounce
  // unauthenticated / expired users to the "open from inSight" page.
  function requireAuth() {
    ingestTokenFromUrl();
    if (!isValid()) { logout(); return false; }
    startExpiryWatch();
    return true;
  }

  global.Auth = {
    logout: logout,
    getToken: getToken,
    isValid: isValid,
    requireAuth: requireAuth,
    ingestTokenFromUrl: ingestTokenFromUrl,
    APP_PAGE: APP_PAGE,
    DENIED_PAGE: DENIED_PAGE
  };
})(window);
