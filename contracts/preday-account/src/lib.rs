//! Code shared by every `<handle>.<preday>` account.
//!
//! The account holds no access keys. Its only job is to forward whatever USDC
//! it has received to the parent contract, tagged with its own handle.

use near_sdk::{env, AccountId, Gas, GasWeight, NearToken, Promise};

const USDC_KEY: &[u8] = b"usdc";
const BALANCE_GAS: Gas = Gas::from_tgas(5);
const CALLBACK_GAS: Gas = Gas::from_tgas(5);
const MAX_BALANCE_LEN: usize = 48;

/// Stores the USDC token id. Input is the raw account id, sent by the parent
/// in the same batch that creates this account.
#[no_mangle]
pub extern "C" fn new() {
    let (_, parent) = identity();
    require(
        env::predecessor_account_id() == parent,
        "only the parent can initialize",
    );
    require(!env::storage_has_key(USDC_KEY), "already initialized");
    let usdc: AccountId = env::input()
        .and_then(|input| String::from_utf8(input).ok())
        .and_then(|input| input.parse().ok())
        .unwrap_or_else(|| env::panic_str("invalid usdc account id"));
    env::storage_write(USDC_KEY, usdc.as_bytes());
}

/// Forwards the full USDC balance to the parent. Callable by anyone.
#[no_mangle]
pub extern "C" fn sweep() {
    let account = env::current_account_id();
    Promise::new(usdc())
        .function_call(
            "ft_balance_of",
            format!(r#"{{"account_id":"{account}"}}"#).into_bytes(),
            NearToken::ZERO,
            BALANCE_GAS,
        )
        .then(Promise::new(account).function_call_weight(
            "on_balance",
            Vec::new(),
            NearToken::ZERO,
            CALLBACK_GAS,
            GasWeight(1),
        ))
        .as_return()
        .detach();
}

#[no_mangle]
pub extern "C" fn on_balance() {
    require(
        env::predecessor_account_id() == env::current_account_id(),
        "private",
    );
    let balance = env::promise_result_checked(0, MAX_BALANCE_LEN)
        .ok()
        .and_then(|result| parse_balance(&result))
        .unwrap_or_else(|| env::panic_str("balance query failed"));
    if balance == 0 {
        env::value_return(br#""0""#);
        return;
    }
    let (handle, parent) = identity();
    Promise::new(usdc())
        .function_call_weight(
            "ft_transfer_call",
            transfer_args(&parent, balance, &handle).into_bytes(),
            NearToken::from_yoctonear(1),
            Gas::from_gas(0),
            GasWeight(1),
        )
        .as_return()
        .detach();
}

/// Splits `<handle>.<parent>` into its two parts.
fn identity() -> (String, AccountId) {
    let account = env::current_account_id();
    account
        .as_str()
        .split_once('.')
        .and_then(|(handle, parent)| Some((handle.to_string(), parent.parse().ok()?)))
        .unwrap_or_else(|| env::panic_str("not a named account"))
}

fn usdc() -> AccountId {
    env::storage_read(USDC_KEY)
        .and_then(|value| String::from_utf8(value).ok())
        .and_then(|value| value.parse().ok())
        .unwrap_or_else(|| env::panic_str("not initialized"))
}

fn parse_balance(json: &[u8]) -> Option<u128> {
    std::str::from_utf8(json)
        .ok()?
        .strip_prefix('"')?
        .strip_suffix('"')?
        .parse()
        .ok()
}

fn transfer_args(parent: &AccountId, amount: u128, handle: &str) -> String {
    format!(
        r#"{{"receiver_id":"{parent}","amount":"{amount}","msg":"{{\"income\":\"{handle}\"}}"}}"#
    )
}

fn require(condition: bool, message: &str) {
    if !condition {
        env::panic_str(message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_token_balance() {
        assert_eq!(parse_balance(br#""0""#), Some(0));
        assert_eq!(parse_balance(br#""25000000""#), Some(25_000_000));
        assert_eq!(parse_balance(b"25000000"), None);
        assert_eq!(parse_balance(br#""-1""#), None);
        assert_eq!(parse_balance(b""), None);
    }

    #[test]
    fn builds_transfer_args() {
        let parent: AccountId = "preday.near".parse().unwrap();
        assert_eq!(
            transfer_args(&parent, 1_500_000, "anna"),
            r#"{"receiver_id":"preday.near","amount":"1500000","msg":"{\"income\":\"anna\"}"}"#
        );
    }
}
