import assert from 'node:assert/strict';
import process from 'node:process';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const requireFromRoot = createRequire(join(process.cwd(), 'package.json'));
const jwksPath = requireFromRoot.resolve('jwks-rsa');
const requireFromJwks = createRequire(jwksPath);
const { retrieveSigningKeys } = requireFromJwks('./utils.js');
await (async () => {
  const { passportJwtSecret } = requireFromRoot('jwks-rsa');
  const provider = passportJwtSecret({ jwksUri: 'https://invalid.example/never-requested' });
  await new Promise((resolve, reject) =>
    provider({}, 'not-a-jwt', (error, key) => {
      try {
        assert.equal(error, null);
        assert.equal(key, null);
        resolve();
      } catch (e) {
        reject(e);
      }
    }),
  );

  for (const [kind, options] of [
    ['rsa', { modulusLength: 2048 }],
    ['ec', { namedCurve: 'prime256v1' }],
  ]) {
    const { publicKey, privateKey } = generateKeyPairSync(kind, options);
    const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig' };
    const { SignJWT, jwtVerify } = await import('jose');
    const algorithm = kind === 'rsa' ? 'RS256' : 'ES256';
    const jwt = await new SignJWT({ test: 'local-only' })
      .setProtectedHeader({ alg: algorithm, kid: 'test-key' })
      .sign(privateKey);
    const validProvider = passportJwtSecret({
      jwksUri: 'https://invalid.example/local-fixture',
      fetcher: async () => ({ keys: [publicJwk] }),
    });
    const returnedKey = await new Promise((resolve, reject) =>
      validProvider({}, jwt, (error, key) => (error ? reject(error) : resolve(key))),
    );
    assert.ok(returnedKey);
    const verified = await jwtVerify(jwt, createPublicKey(returnedKey), {
      algorithms: [algorithm],
    });
    assert.equal(verified.payload.test, 'local-only');
    const keys = await retrieveSigningKeys([publicJwk]);
    assert.equal(keys.length, 1);
    assert.equal(keys[0].kid, 'test-key');
    assert.deepEqual(
      createPublicKey(keys[0].getPublicKey()).export({ format: 'jwk' }),
      publicKey.export({ format: 'jwk' }),
    );
    assert.equal((await retrieveSigningKeys([{ ...publicJwk, use: 'enc' }])).length, 0);
    assert.equal(
      (await retrieveSigningKeys([{ ...privateKey.export({ format: 'jwk' }), use: 'sig' }])).length,
      0,
    );
  }
})().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
