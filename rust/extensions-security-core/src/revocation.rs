use crate::models::{signature, trust_metadata, CommandSecurityCoreRequest};
use serde_json::Value;

pub fn enforce_revocations(
    request: &CommandSecurityCoreRequest,
    manifest: &Value,
) -> Result<(), String> {
    let Some(revocation_list) = &request.revocation_list else {
        return Ok(());
    };

    if let Some(signature) = signature(manifest) {
        if revocation_list
            .revoked_signature_keys
            .as_ref()
            .is_some_and(|items| items.iter().any(|item| item.key_id == signature.key_id))
        {
            return Err(format!("Extension signature key revoked: {}", signature.key_id));
        }
    }

    let Some(trust) = trust_metadata(manifest)? else {
        return Ok(());
    };

    if revocation_list
        .revoked_issuers
        .as_ref()
        .is_some_and(|items| items.iter().any(|item| item.issuer_id == trust.issued_by))
    {
        return Err(format!("Extension issuer revoked: {}", trust.issued_by));
    }

    if revocation_list
        .revoked_publishers
        .as_ref()
        .is_some_and(|items| items.iter().any(|item| item.publisher_id == trust.publisher_id))
    {
        return Err(format!("Extension publisher revoked: {}", trust.publisher_id));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::enforce_revocations;
    use crate::models::{CommandSecurityCoreRequest, RevocationList, RevokedIssuer};
    use serde_json::json;

    #[test]
    fn revoked_issuer_is_rejected_for_unsigned_manifest_when_policy_allows_it() {
        let request = CommandSecurityCoreRequest {
            manifest: json!({
                "id": "demo.revoked-issuer",
                "version": "1.0.0",
                "protocolVersion": "1",
                "trust": {
                    "publisherId": "publisher.demo",
                    "trustDomain": "third-party",
                    "issuedBy": "third-party-issuer"
                },
                "artifact": { "kind": "module", "entry": "./index.js" },
                "runtime": "node",
                "capabilities": [{ "name": "demo.hello" }]
            }),
            signature_policy: Some("allow-unsigned".to_string()),
            is_development: Some(false),
            trust_bundle: None,
            revocation_list: Some(RevocationList {
                revoked_signature_keys: None,
                revoked_issuers: Some(vec![RevokedIssuer {
                    issuer_id: "third-party-issuer".to_string(),
                }]),
                revoked_publishers: None,
            }),
            trusted_key_directory: None,
            trusted_public_keys: None,
        };

        let error = enforce_revocations(&request, &request.manifest)
            .expect_err("revoked issuer should be rejected");

        assert_eq!(error, "Extension issuer revoked: third-party-issuer");
    }
}
