import { allowPairedAuthRoute } from './pairing-auth-policy';
import assert from 'node:assert/strict';
import test from 'node:test';

test('self-hosted authentication only permits paired sessions and provider linking', () => {
  for (const signedIn of [true, false]) {
    for (const route of [
      'sign-in/email',
      'sign-in/social',
      'sign-up/email',
      'reset-password',
      'verify-email',
      'phone-number/verify',
      'sign-in%2Fsocial',
      'token',
      'oauth2/authorize',
      'unknown',
      '%ZZ',
    ]) {
      assert.equal(allowPairedAuthRoute('/api/auth/' + route, signedIn), false, route);
    }
    assert.equal(allowPairedAuthRoute('/api/auth/get-session', signedIn), true);
  }
  for (const route of [
    'link-social',
    'callback/google',
    'callback/microsoft',
    'revoke-session',
    'update-user',
  ]) {
    assert.equal(allowPairedAuthRoute('/api/auth/' + route, false), false);
    assert.equal(allowPairedAuthRoute('/api/auth/' + route, true), true);
  }
});
