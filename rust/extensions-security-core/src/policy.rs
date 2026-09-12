use crate::models::{manifest_id, signature};
use serde_json::Value;

pub fn should_require_signature(policy: &str, is_development: bool) -> bool {
    match policy {
        "allow-unsigned" => false,
        "require-signature" => true,
        "require-signature-except-development" => !is_development,
        // Unknown policy values (host typos, future strings) fail closed.
        _ => true,
    }
}

pub fn enforce_signature_policy(
    manifest: &Value,
    policy: &str,
    is_development: bool,
) -> Result<(), String> {
    if !should_require_signature(policy, is_development) || signature(manifest).is_some() {
        return Ok(());
    }

    let manifest_id = manifest_id(manifest)?;
    Err(format!("Extension signature required by policy: {manifest_id}"))
}

#[cfg(test)]
mod tests {
    use super::{enforce_signature_policy, should_require_signature};
    use serde_json::json;

    #[test]
    fn helper_matches_expected_modes() {
        assert!(!should_require_signature("allow-unsigned", false));
        assert!(should_require_signature("require-signature", false));
        assert!(!should_require_signature("require-signature-except-development", true));
        assert!(should_require_signature("require-signature-except-development", false));
    }

    #[test]
    fn unknown_policy_values_fail_closed() {
        assert!(should_require_signature("allow-unsigend-typo", false));
        assert!(should_require_signature("allow-unsigend-typo", true));
        assert!(should_require_signature("", false));
    }

    #[test]
    fn missing_signature_is_rejected_when_policy_requires_it() {
        let manifest = json!({
            "id": "demo.require-signature",
            "version": "1.0.0",
            "protocolVersion": "1",
            "artifact": { "kind": "module", "entry": "./index.js" },
            "runtime": "node",
            "capabilities": [{ "name": "demo.hello" }]
        });

        let error = enforce_signature_policy(&manifest, "require-signature", false)
            .expect_err("manifest should require a signature");

        assert_eq!(error, "Extension signature required by policy: demo.require-signature");
    }
}
