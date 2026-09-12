use crate::models::{trust_metadata, ExtensionSecurityInfo, TrustBundle};
use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

pub fn enforce_trust_bundle(
    manifest: &Value,
    trust_bundle: &TrustBundle,
    manifest_id: &str,
) -> Result<ExtensionSecurityInfo, String> {
    let Some(trust) = trust_metadata(manifest)? else {
        return Ok(ExtensionSecurityInfo {
            status: "third-party-untrusted".to_string(),
            reason: "Signed extension has no official trust metadata.".to_string(),
        });
    };

    let Some(issuer) = trust_bundle.issuers.iter().find(|item| item.id == trust.issued_by) else {
        return Ok(ExtensionSecurityInfo {
            status: "third-party-untrusted".to_string(),
            reason: format!("Extension issuer is not authorized: {}", trust.issued_by),
        });
    };

    if issuer.trust_domain != trust.trust_domain {
        return Err(format!(
            "Extension trust domain mismatch for issuer: {}",
            trust.issued_by
        ));
    }

    if issuer
        .allowed_publisher_ids
        .as_ref()
        .is_some_and(|items| !items.iter().any(|item| item == &trust.publisher_id))
    {
        return Err(format!(
            "Extension publisher is not allowed by issuer: {}",
            trust.publisher_id
        ));
    }

    if let Some(expires_at) = trust.expires_at.as_deref() {
        let expires_at = OffsetDateTime::parse(expires_at, &Rfc3339)
            .map_err(|error| format!("Invalid trust metadata expiry for {manifest_id}: {error}"))?;
        if expires_at <= OffsetDateTime::now_utc() {
            return Err(format!("Extension trust metadata expired: {manifest_id}"));
        }
    }

    if issuer.authorization.as_deref() != Some("authorized") {
        return Ok(ExtensionSecurityInfo {
            status: "third-party-untrusted".to_string(),
            reason: format!(
                "Extension issuer is not officially authorized: {}",
                trust.issued_by
            ),
        });
    }

    Ok(ExtensionSecurityInfo {
        status: "authorized-safe".to_string(),
        reason: format!(
            "Extension manifest is signed by authorized issuer: {}",
            trust.issued_by
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::enforce_trust_bundle;
    use crate::models::{ExtensionSecurityInfo, TrustBundle, TrustBundleIssuer};
    use serde_json::json;

    #[test]
    fn missing_trust_metadata_returns_untrusted_status() {
        let manifest = json!({
            "id": "demo.no-trust",
            "version": "1.0.0",
            "protocolVersion": "1",
            "artifact": { "kind": "module", "entry": "./index.js" },
            "runtime": "node",
            "capabilities": [{ "name": "demo.hello" }]
        });

        let result = enforce_trust_bundle(&manifest, &authorized_trust_bundle(), "demo.no-trust")
            .expect("missing trust metadata should be classified");

        assert_eq!(
            result,
            ExtensionSecurityInfo {
                status: "third-party-untrusted".to_string(),
                reason: "Signed extension has no official trust metadata.".to_string(),
            }
        );
    }

    #[test]
    fn trust_domain_mismatch_is_rejected() {
        let manifest = signed_manifest_with_trust("2999-01-01T00:00:00.000Z");
        let trust_bundle = TrustBundle {
            issuers: vec![TrustBundleIssuer {
                id: "third-party-issuer".to_string(),
                trust_domain: "official".to_string(),
                authorization: Some("authorized".to_string()),
                allowed_publisher_ids: Some(vec!["publisher.demo".to_string()]),
            }],
        };

        let error = enforce_trust_bundle(&manifest, &trust_bundle, "demo.mismatch")
            .expect_err("trust domain mismatch should fail");

        assert_eq!(error, "Extension trust domain mismatch for issuer: third-party-issuer");
    }

    #[test]
    fn expired_trust_metadata_is_rejected() {
        let manifest = signed_manifest_with_trust("2000-01-01T00:00:00.000Z");

        let error = enforce_trust_bundle(&manifest, &authorized_trust_bundle(), "demo.expired")
            .expect_err("expired trust metadata should fail");

        assert_eq!(error, "Extension trust metadata expired: demo.expired");
    }

    fn authorized_trust_bundle() -> TrustBundle {
        TrustBundle {
            issuers: vec![TrustBundleIssuer {
                id: "third-party-issuer".to_string(),
                trust_domain: "third-party".to_string(),
                authorization: Some("authorized".to_string()),
                allowed_publisher_ids: Some(vec!["publisher.demo".to_string()]),
            }],
        }
    }

    fn signed_manifest_with_trust(expires_at: &str) -> serde_json::Value {
        json!({
            "id": "demo.trusted",
            "version": "1.0.0",
            "protocolVersion": "1",
            "trust": {
                "publisherId": "publisher.demo",
                "trustDomain": "third-party",
                "issuedBy": "third-party-issuer",
                "expiresAt": expires_at
            },
            "artifact": { "kind": "module", "entry": "./index.js" },
            "runtime": "node",
            "capabilities": [{ "name": "demo.hello" }]
        })
    }
}
