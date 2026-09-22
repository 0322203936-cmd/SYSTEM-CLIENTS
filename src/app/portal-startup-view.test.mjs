import assert from 'node:assert/strict';
import test from 'node:test';

let getPortalStartupView;
try {
  ({ getPortalStartupView } = await import('./portal-startup-view.mjs'));
} catch {
  // The assertion below reports the intended missing startup behavior.
}

test('starts on Dashboard and removes a saved Reconciliation route on reload', () => {
  assert.equal(typeof getPortalStartupView, 'function', 'startup view resolver must exist');
  assert.deepEqual(
    getPortalStartupView('https://portal.example/?view=reconciliation&lang=es#home'),
    { activeTab: 'dashboard', reconciliationView: false, url: 'https://portal.example/?lang=es#home' }
  );
});

test('keeps unrelated query parameters and the hash when already on Dashboard', () => {
  assert.equal(typeof getPortalStartupView, 'function', 'startup view resolver must exist');
  assert.deepEqual(
    getPortalStartupView('https://portal.example/?lang=es#home'),
    { activeTab: 'dashboard', reconciliationView: false, url: 'https://portal.example/?lang=es#home' }
  );
});
