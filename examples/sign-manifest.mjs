import {
  InMemoryTrustedKeyStore,
  PublicKeySignatureVerifier,
  generateSigningKeyPair,
  signManifest,
} from '../dist/index.js'

const keyPair = generateSigningKeyPair('ed25519')

const manifest = {
  id: 'demo.signed-extension',
  version: '1.0.0',
  protocolVersion: '1',
  artifact: { kind: 'module', entry: './index.js' },
  runtime: 'node',
  capabilities: [{ name: 'demo.hello' }],
}

const signature = signManifest(manifest, {
  algorithm: 'ed25519',
  keyId: 'demo-key',
  privateKeyPem: keyPair.privateKeyPem,
})

const signedManifest = {
  ...manifest,
  signature,
}

const verifier = new PublicKeySignatureVerifier(
  new InMemoryTrustedKeyStore({
    'demo-key': keyPair.publicKeyPem,
  }),
)

verifier.verify(signedManifest)

console.log(JSON.stringify({
  verified: true,
  signedManifest,
}, null, 2))
