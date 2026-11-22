'use strict';
/*
 * Public keys that may sign tunnelview-update.json (DECISIONS U1). A list, so a new key can ship
 * in one release before the release after it is signed with it (rotation).
 *
 *   kid        the first 16 lowercase hex characters of SHA-256 of the raw 32-byte Ed25519 public
 *              key (update-manifest.keyId). In a shell:
 *                node -e "const c=require('crypto');console.log(c.createHash('sha256').update(Buffer.from(process.argv[1],'base64url')).digest('hex').slice(0,16))" <publicKey>
 *   publicKey  the raw 32-byte Ed25519 public key, base64url without padding. The same value is
 *              the repository variable UPDATE_PUBLIC_KEY, which CI passes to
 *              `node scripts/sign-update.js --pub`; that script refuses a key that is not listed here.
 *
 * Node built-ins only (sign-update.js requires this file in a job without node_modules).
 * test/update-manifest.test.js checks every kid against its key.
 */
const KEYS = Object.freeze([
  Object.freeze({
    kid: '3f8c892c42f7ffac',
    publicKey: 'HpauGGB_6J3ZetoaaXAdBZbrj4DXVpwzODsP2mzIiIE', // production key, created 2026-11-07
  }),
]);

module.exports = { KEYS };
