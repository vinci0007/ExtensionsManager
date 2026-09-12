use serde_json::Value;
use std::collections::BTreeMap;

pub fn canonicalize_manifest(manifest: &Value) -> Result<String, String> {
    let unsigned_manifest = manifest_without_signature(manifest)?;
    Ok(canonicalize_value(&unsigned_manifest))
}

fn manifest_without_signature(manifest: &Value) -> Result<Value, String> {
    let Some(object) = manifest.as_object() else {
        return Err("Extension manifest must be an object".to_string());
    };
    let mut clone = object.clone();
    clone.remove("signature");
    Ok(Value::Object(clone))
}

fn canonicalize_value(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(boolean) => boolean.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(string) => serde_json::to_string(string).expect("failed to encode string"),
        Value::Array(items) => {
            let parts = items.iter().map(canonicalize_value).collect::<Vec<_>>();
            format!("[{}]", parts.join(","))
        }
        Value::Object(map) => {
            let sorted = map
                .iter()
                .map(|(key, value)| (key.as_str(), value))
                .collect::<BTreeMap<_, _>>();
            let parts = sorted
                .into_iter()
                .map(|(key, value)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("failed to encode key"),
                        canonicalize_value(value)
                    )
                })
                .collect::<Vec<_>>();
            format!("{{{}}}", parts.join(","))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::canonicalize_manifest;
    use serde_json::json;

    #[test]
    fn removes_signature_and_sorts_object_keys() {
        let manifest = json!({
            "version": "1.0.0",
            "id": "demo.extension",
            "nested": {
                "z": 2,
                "a": 1
            },
            "signature": {
                "algorithm": "ed25519",
                "keyId": "demo-key",
                "value": "AAAA"
            }
        });

        let canonical = canonicalize_manifest(&manifest).expect("canonical form should be generated");

        assert_eq!(
            canonical,
            r#"{"id":"demo.extension","nested":{"a":1,"z":2},"version":"1.0.0"}"#
        );
    }
}
