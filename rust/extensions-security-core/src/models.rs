use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSecurityCoreRequest {
    pub manifest: Value,
    pub signature_policy: Option<String>,
    pub is_development: Option<bool>,
    pub trust_bundle: Option<TrustBundle>,
    pub revocation_list: Option<RevocationList>,
    pub trusted_key_directory: Option<String>,
    pub trusted_public_keys: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone)]
pub struct SignaturePayload {
    pub algorithm: String,
    pub key_id: String,
    pub value: String,
}

#[derive(Debug)]
pub struct TrustMetadata {
    pub publisher_id: String,
    pub trust_domain: String,
    pub issued_by: String,
    pub expires_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustBundle {
    pub issuers: Vec<TrustBundleIssuer>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustBundleIssuer {
    pub id: String,
    pub trust_domain: String,
    pub authorization: Option<String>,
    pub allowed_publisher_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevocationList {
    pub revoked_signature_keys: Option<Vec<RevokedSignatureKey>>,
    pub revoked_issuers: Option<Vec<RevokedIssuer>>,
    pub revoked_publishers: Option<Vec<RevokedPublisher>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokedSignatureKey {
    pub key_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokedIssuer {
    pub issuer_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokedPublisher {
    pub publisher_id: String,
}

#[derive(Debug, Serialize, PartialEq, Eq, Clone)]
pub struct ExtensionSecurityInfo {
    pub status: String,
    pub reason: String,
}

pub fn manifest_id(manifest: &Value) -> Result<String, String> {
    manifest
        .get("id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| "Extension manifest id is required".to_string())
}

pub fn signature(manifest: &Value) -> Option<SignaturePayload> {
    let object = manifest.get("signature")?.as_object()?;
    Some(SignaturePayload {
        algorithm: object.get("algorithm")?.as_str()?.to_string(),
        key_id: object.get("keyId")?.as_str()?.to_string(),
        value: object.get("value")?.as_str()?.to_string(),
    })
}

pub fn trust_metadata(manifest: &Value) -> Result<Option<TrustMetadata>, String> {
    let Some(object) = manifest.get("trust") else {
        return Ok(None);
    };
    let Some(object) = object.as_object() else {
        return Err("Extension trust metadata must be an object".to_string());
    };

    Ok(Some(TrustMetadata {
        publisher_id: object
            .get("publisherId")
            .and_then(Value::as_str)
            .ok_or_else(|| "Extension trust publisherId is required".to_string())?
            .to_string(),
        trust_domain: object
            .get("trustDomain")
            .and_then(Value::as_str)
            .ok_or_else(|| "Extension trust trustDomain is required".to_string())?
            .to_string(),
        issued_by: object
            .get("issuedBy")
            .and_then(Value::as_str)
            .ok_or_else(|| "Extension trust issuedBy is required".to_string())?
            .to_string(),
        expires_at: object
            .get("expiresAt")
            .and_then(Value::as_str)
            .map(ToString::to_string),
    }))
}
