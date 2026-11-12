use near_sdk::env;
use near_sdk::serde_json::{json, Value};

/// Logs a NEP-297 event.
pub fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "preday", "version": "1.0.0", "event": event, "data": data })
    ));
}
