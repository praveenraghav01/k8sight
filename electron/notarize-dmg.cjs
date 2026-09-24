// afterAllArtifactBuild hook: notarize + staple the .dmg itself.
//
// The afterSign hook (electron/notarize.cjs) notarizes and staples the .app, so
// the app runs cleanly once dragged out of the disk image. But the .dmg is the
// artifact users actually download, and it's built *after* signing — so it has
// no notarization ticket of its own and `stapler staple` on it fails. Apple
// wants the distribution artifact stapled so a freshly-downloaded .dmg opens
// without an online check. This submits each .dmg and staples the ticket.
//
// Skips silently when Apple credentials aren't in the environment (same as the
// app hook), so local dev / unsigned CI builds still succeed.

const { notarize } = require('@electron/notarize');
const { execFileSync } = require('child_process');

module.exports = async function notarizeDmg(context) {
  if (process.platform !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('[notarize-dmg] Apple credentials not set — skipping .dmg notarization.');
    return;
  }

  const dmgs = (context.artifactPaths || []).filter((p) => p.endsWith('.dmg'));
  if (!dmgs.length) return;

  for (const dmg of dmgs) {
    console.log(`[notarize-dmg] Submitting ${dmg} to Apple — this can take a few minutes…`);
    await notarize({
      appPath: dmg, // notarytool accepts .dmg/.zip/.pkg, not just .app
      appleId: APPLE_ID,
      appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
      teamId: APPLE_TEAM_ID,
    });
    execFileSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' });
    console.log(`[notarize-dmg] ${dmg} notarized and stapled.`);
  }
};
