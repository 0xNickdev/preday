//! Verifies any caller, using the hash of their account id as the person
//! code. Never deploy to mainnet.

use near_sdk::json_types::Base58CryptoHash;
use near_sdk::serde_json::json;
use near_sdk::{env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise};

const SET_VERIFIED_GAS: Gas = Gas::from_tgas(10);

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct TestVerifier {
    preday: AccountId,
}

#[near]
impl TestVerifier {
    #[init]
    pub fn new(preday: AccountId) -> Self {
        Self { preday }
    }

    pub fn verify(&self, handle: String) -> Promise {
        let person_code =
            Base58CryptoHash::from(env::sha256_array(env::predecessor_account_id().as_bytes()));
        Promise::new(self.preday.clone()).function_call(
            "set_verified",
            json!({ "handle": handle, "person_code": person_code })
                .to_string()
                .into_bytes(),
            NearToken::ZERO,
            SET_VERIFIED_GAS,
        )
    }
}
