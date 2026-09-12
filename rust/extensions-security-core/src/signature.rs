use crate::canonicalize::canonicalize_manifest;
use crate::models::{CommandSecurityCoreRequest, SignaturePayload};
use base64::Engine;
use ed25519_dalek::pkcs8::DecodePublicKey;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use rsa::pkcs1v15::{Signature as RsaSignature, VerifyingKey as RsaVerifyingKey};
use rsa::RsaPublicKey;
use sha2::Sha256;
use std::fs;
use std::path::Path;

pub fn verify_signature(
    request: &CommandSecurityCoreRequest,
    manifest: &serde_json::Value,
    signature: &SignaturePayload,
    manifest_id: &str,
) -> Result<(), String> {
    let public_key = resolve_public_key(request, &signature.key_id)?;
    let signed_payload = canonicalize_manifest(manifest)?;
    let signature_bytes = base64::engine::general_purpose::STANDARD
        .decode(&signature.value)
        .map_err(|error| format!("Invalid manifest signature: {manifest_id} ({error})"))?;

    match signature.algorithm.as_str() {
        "ed25519" => {
            let verify_key = VerifyingKey::from_public_key_pem(&public_key)
                .map_err(|error| format!("Invalid public key PEM for {}: {error}", signature.key_id))?;
            let signature = Signature::from_slice(&signature_bytes)
                .map_err(|error| format!("Invalid manifest signature: {manifest_id} ({error})"))?;
            verify_key
                .verify(signed_payload.as_bytes(), &signature)
                .map_err(|_| format!("Invalid manifest signature: {manifest_id}"))?;
            Ok(())
        }
        "rsa-sha256" => {
            let verify_key = RsaPublicKey::from_public_key_pem(&public_key)
                .map_err(|error| format!("Invalid public key PEM for {}: {error}", signature.key_id))?;
            let verifying_key = RsaVerifyingKey::<Sha256>::new(verify_key);
            let signature = RsaSignature::try_from(signature_bytes.as_slice())
                .map_err(|error| format!("Invalid manifest signature: {manifest_id} ({error})"))?;
            verifying_key
                .verify(signed_payload.as_bytes(), &signature)
                .map_err(|_| format!("Invalid manifest signature: {manifest_id}"))?;
            Ok(())
        }
        other => Err(format!("Unsupported manifest signature algorithm: {other}")),
    }
}

fn resolve_public_key(request: &CommandSecurityCoreRequest, key_id: &str) -> Result<String, String> {
    if let Some(keys) = &request.trusted_public_keys {
        if let Some(public_key) = keys.get(key_id) {
            return Ok(public_key.clone());
        }
    }

    if let Some(directory) = &request.trusted_key_directory {
        let key_path = Path::new(directory).join(format!("{key_id}.pem"));
        if let Ok(content) = fs::read_to_string(key_path) {
            return Ok(content);
        }
    }

    Err(format!("Untrusted signature key: {key_id}"))
}

#[cfg(test)]
mod tests {
    use super::verify_signature;
    use crate::models::{signature, CommandSecurityCoreRequest};
    use serde_json::{json, Value};
    use std::collections::BTreeMap;

    const ED25519_PUBLIC_KEY_PEM: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAFaNpK/l5Z9wrafNaW4REoHCqb6AlFxVn45tDjXoFAE8=\n-----END PUBLIC KEY-----\n";
    const ED25519_SIGNATURE_BASE64: &str = "IhxVyMRE0d5HpSQjP+sGTjI+1pWND7KKXTjjX/uaj7/lxVRXpa4DW1e0ACI/vLq7BlgbfQlwUhIWHJJBDIlmCg==";
    const RSA_PUBLIC_KEY_PEM: &str = "-----BEGIN PUBLIC KEY-----\nMIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAyAQN3ik0LG0VSSASu3ZM\nLeCIX+2NgWHbETVyDL2JS13XSn4RPTHdft98HZddAsoTjUln/pJOq2oLupntYDY7\n+tmpghUInbbyQ4p8bjZRf2hQQHw3qEyIJRGyT0PZoDXlTiUFFa7zSG6FMG8hUoEU\nittg5olFcECq2t4BDvSqb842wNZKm5xB1dYAmgP2w3DBevQmLNCTkeOmzYkI9MfZ\nYvy/JAJI8P4+SLI1n/L+Be/+4HVF2Hc2jB7EpK1qvFQThmFB5fgwRcsNDeJH3Lu+\nANq8oqSvg+SkUJjYApkxhV8ZA0pj2fdL6PmXxUxevv4vlNFSQxmTnCuUCLcSStck\nJr88rSfWuHitigVZkozmLm/hp4+492tN7ELewVtIF4+d+IPjpYjA+Tt7bQ2uJv78\nhfI0IZUlBEFVNziUaF7QuQlnJOTkg8ehNLNWeEWGUVwiYAJtnK1zFl9762y4Fg8m\n5HjLz0HyJ7SE3uQ3HK8+c0iqbmUIuix/MbiH1N6S1id1AgMBAAE=\n-----END PUBLIC KEY-----\n";
    const RSA_SIGNATURE_BASE64: &str = "g/JP4T3fSvoWxkOs9jBVj1R73ga9pMKXtvY0f6RP9VshnrUr/BVtMv9mREwMU/rCfT0nLrLs27kaG19PPgU3HpBg4pXXMNs7ZLsc2qtIn/qeNnoAUWFSGrSMh2S/NYERKP+Uy1ZfG/LG1S7qS9Xa+ZMa+3KF2jcmlYXP6S2RuWvzubb92RhN2d+4aojq+/R/xRNZ0qVIZNIFnqaw3sJzsZqN7ICS34R0HXMyp7uwi1yhaIQNL+Tdx4m7CGQAzV/f4LnwTExQMa68j92OCBbeg9TQZ+2d8dxGNa6ArKPpHfPiESKIdEACilBDxzRtY/eaGy9TpaoVGMC71IRb20LtY5vHGYjw/w620OTDYde4leFx9kLsxid0R62x53mT4w5j0Cu0CSjvvpYfhT+wnSHUmaC46/RD+Zfk8NqjHhRq4u1VtlQZNNHYWc/ag32FbZXn8Uref3bm+zkpG2q+UwpXVJTMVf+STfQnFqr+sn6OlSGbZ9ugOd5o4U7tAqtobNAc";

    #[test]
    fn verifies_ed25519_fixture_signature() {
        let manifest = fixture_manifest();
        let request = request_with_public_key("demo-key", ED25519_PUBLIC_KEY_PEM);
        let signature = signature(&manifest).expect("signature should be present");

        verify_signature(&request, &manifest, &signature, "demo.signature-fixture")
            .expect("ed25519 signature should verify");
    }

    #[test]
    fn verifies_rsa_sha256_fixture_signature() {
        let manifest = fixture_manifest_with_signature("rsa-sha256", RSA_SIGNATURE_BASE64);
        let request = request_with_public_key("demo-key", RSA_PUBLIC_KEY_PEM);
        let signature = signature(&manifest).expect("signature should be present");

        verify_signature(&request, &manifest, &signature, "demo.signature-fixture")
            .expect("rsa-sha256 signature should verify");
    }

    #[test]
    fn rejects_tampered_manifest_with_valid_fixture_signature() {
        let mut manifest = fixture_manifest();
        manifest["version"] = Value::String("2.0.0".to_string());
        let request = request_with_public_key("demo-key", ED25519_PUBLIC_KEY_PEM);
        let signature = signature(&manifest).expect("signature should be present");

        let error = verify_signature(&request, &manifest, &signature, "demo.signature-fixture")
            .expect_err("tampered manifest should not verify");

        assert_eq!(error, "Invalid manifest signature: demo.signature-fixture");
    }

    fn fixture_manifest() -> Value {
        fixture_manifest_with_signature("ed25519", ED25519_SIGNATURE_BASE64)
    }

    fn fixture_manifest_with_signature(algorithm: &str, signature_value: &str) -> Value {
        json!({
            "id": "demo.signature-fixture",
            "version": "1.0.0",
            "protocolVersion": "1",
            "trust": {
                "publisherId": "publisher.demo",
                "trustDomain": "third-party",
                "issuedBy": "third-party-issuer"
            },
            "artifact": {
                "kind": "module",
                "entry": "./index.js"
            },
            "runtime": "node",
            "capabilities": [
                {
                    "name": "demo.hello"
                }
            ],
            "signature": {
                "algorithm": algorithm,
                "keyId": "demo-key",
                "value": signature_value
            }
        })
    }

    fn request_with_public_key(key_id: &str, public_key_pem: &str) -> CommandSecurityCoreRequest {
        CommandSecurityCoreRequest {
            manifest: json!({}),
            signature_policy: None,
            is_development: None,
            trust_bundle: None,
            revocation_list: None,
            trusted_key_directory: None,
            trusted_public_keys: Some(BTreeMap::from([(
                key_id.to_string(),
                public_key_pem.to_string(),
            )])),
        }
    }
}
