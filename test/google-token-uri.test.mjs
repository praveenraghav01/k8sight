// Tests for the Google token-endpoint guard (SSRF protection).
// A service-account key's token_uri is user-supplied; the token exchange always
// POSTs to the fixed GOOGLE_TOKEN_URI, and assertGoogleTokenUri rejects a key
// that declares a non-Google endpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GOOGLE_TOKEN_URI, assertGoogleTokenUri } from '../lib/google-token-uri.mjs';

test('GOOGLE_TOKEN_URI is the fixed Google endpoint', () => {
  assert.equal(GOOGLE_TOKEN_URI, 'https://oauth2.googleapis.com/token');
});

test('accepts a missing token_uri (caller falls back to the constant)', () => {
  assert.doesNotThrow(() => assertGoogleTokenUri(undefined));
  assert.doesNotThrow(() => assertGoogleTokenUri(''));
  assert.doesNotThrow(() => assertGoogleTokenUri(null));
});

test('accepts Google token endpoints', () => {
  assert.doesNotThrow(() => assertGoogleTokenUri('https://oauth2.googleapis.com/token'));
  assert.doesNotThrow(() => assertGoogleTokenUri('https://sts.googleapis.com/v1/token'));
});

test('rejects non-Google hosts (SSRF / credential exfiltration)', () => {
  assert.throws(() => assertGoogleTokenUri('https://evil.example.com/token'), /non-Google token endpoint/);
  // Lookalike hosts must not slip through a naive suffix/substring check.
  assert.throws(() => assertGoogleTokenUri('https://oauth2.googleapis.com.evil.com/token'), /non-Google token endpoint/);
  assert.throws(() => assertGoogleTokenUri('https://evil.com/oauth2.googleapis.com/token'), /non-Google token endpoint/);
});

test('rejects non-https schemes', () => {
  assert.throws(() => assertGoogleTokenUri('http://oauth2.googleapis.com/token'), /non-Google token endpoint/);
  assert.throws(() => assertGoogleTokenUri('file:///etc/passwd'), /non-Google token endpoint|Invalid token_uri/);
});

test('rejects unparseable values', () => {
  assert.throws(() => assertGoogleTokenUri('not a url'), /Invalid token_uri/);
});
