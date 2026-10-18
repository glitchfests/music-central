// electron-builder afterSign hook: registers the Windows build with castLabs EVS so Widevine
// (needed for Spotify's in-app player) gets a production license. Runs only when an EVS account
// is set up (EVS_ACCOUNT_NAME and EVS_PASSWD in the environment); otherwise the build stays
// unregistered and Spotify songs fall back to playing on your Spotify device.
const { execFileSync } = require('child_process');

exports.default = async function evsSign(context) {
  if (context.electronPlatformName !== 'win32' && context.electronPlatformName !== 'darwin') return;
  if (!process.env.EVS_ACCOUNT_NAME || !process.env.EVS_PASSWD) {
    console.warn('  • EVS not configured: skipping Widevine production signing (set EVS_ACCOUNT_NAME and EVS_PASSWD)');
    return;
  }
  const py = process.env.PYTHON || 'python3';
  execFileSync(py, ['-m', 'castlabs_evs.account', 'reauth', '--no-ask'], { stdio: 'inherit' });
  execFileSync(py, ['-m', 'castlabs_evs.vmp', 'sign-pkg', '--no-ask', context.appOutDir], { stdio: 'inherit' });
};
