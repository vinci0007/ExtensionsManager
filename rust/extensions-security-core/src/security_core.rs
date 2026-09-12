use crate::models::{manifest_id, signature, CommandSecurityCoreRequest, ExtensionSecurityInfo};
use crate::policy::enforce_signature_policy;
use crate::revocation::enforce_revocations;
use crate::signature::verify_signature;
use crate::trust::enforce_trust_bundle;

pub fn evaluate_manifest(request: &CommandSecurityCoreRequest) -> Result<ExtensionSecurityInfo, String> {
    let manifest_id = manifest_id(&request.manifest)?;
    // Secure-by-default: an unconfigured policy behaves as
    // 'require-signature-except-development' — unsigned plugins load only when
    // the host explicitly declares isDevelopment: true. Mirrors the TS default.
    let signature_policy = request
        .signature_policy
        .as_deref()
        .unwrap_or("require-signature-except-development");
    let is_development = request.is_development.unwrap_or(false);

    enforce_signature_policy(&request.manifest, signature_policy, is_development)?;

    if let Some(signature) = signature(&request.manifest) {
        verify_signature(request, &request.manifest, &signature, &manifest_id)?;
    }

    enforce_revocations(request, &request.manifest)?;

    if signature(&request.manifest).is_none() {
        return Ok(ExtensionSecurityInfo {
            status: "unsigned".to_string(),
            reason: "Extension has no manifest signature.".to_string(),
        });
    }

    let trust_bundle = match &request.trust_bundle {
        Some(bundle) => bundle,
        None => {
            return Ok(ExtensionSecurityInfo {
                status: "third-party-untrusted".to_string(),
                reason: "Signed extension has no official authorization trust bundle.".to_string(),
            })
        }
    };

    enforce_trust_bundle(&request.manifest, trust_bundle, &manifest_id)
}

#[cfg(test)]
mod tests {
    use super::evaluate_manifest;
    use crate::models::CommandSecurityCoreRequest;
    use serde_json::json;

    #[test]
    fn unsigned_manifest_returns_unsigned_status_when_policy_allows_it() {
        let request = CommandSecurityCoreRequest {
            manifest: json!({
                "id": "demo.unsigned",
                "version": "1.0.0",
                "protocolVersion": "1",
                "artifact": { "kind": "module", "entry": "./index.js" },
                "runtime": "node",
                "capabilities": [{ "name": "demo.hello" }]
            }),
            signature_policy: Some("allow-unsigned".to_string()),
            is_development: Some(false),
            trust_bundle: None,
            revocation_list: None,
            trusted_key_directory: None,
            trusted_public_keys: None,
        };

        let result = evaluate_manifest(&request).expect("unsigned manifest should be accepted");

        assert_eq!(
            result,
            crate::models::ExtensionSecurityInfo {
                status: "unsigned".to_string(),
                reason: "Extension has no manifest signature.".to_string(),
            }
        );
    }
}
