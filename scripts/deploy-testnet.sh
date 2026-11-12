#!/usr/bin/env bash
# Deploys the whole system to NEAR testnet with demo timings.
# Usage: scripts/deploy-testnet.sh <prefix>   creates <prefix>, <prefix>-usdc and <prefix>-verifier .testnet
set -euo pipefail

PREFIX="${1:?usage: deploy-testnet.sh <prefix>}"
PREDAY="$PREFIX.testnet"
USDC="$PREFIX-usdc.testnet"
VERIFIER="$PREFIX-verifier.testnet"
OUT="$(cd "$(dirname "$0")/../contracts" && pwd)/target/near"
NET=(network-config testnet)
SIGN=(sign-with-legacy-keychain send)

# The faucet rate-limits account creation. Set FUNDER to an account you hold a key for to pay for them instead.
for account in "$PREDAY" "$USDC" "$VERIFIER"; do
  if [ -n "${FUNDER:-}" ]; then
    near account create-account fund-myself "$account" '3.5 NEAR' \
      autogenerate-new-keypair save-to-legacy-keychain sign-as "$FUNDER" "${NET[@]}" "${SIGN[@]}"
  else
    near account create-account sponsor-by-faucet-service "$account" \
      autogenerate-new-keypair save-to-legacy-keychain "${NET[@]}" create
  fi
done

# The named-account code is published once and referenced by hash from every pay account.
# Publishing costs about 2.6 NEAR and is needed once per build of the account code. Set SKIP_PUBLISH=1 to reuse it.
if [ -z "${SKIP_PUBLISH:-}" ]; then
  near contract deploy-as-global use-file "$OUT/preday_account/preday_account.wasm" \
    as-global-hash "$VERIFIER" "${NET[@]}" "${SIGN[@]}"
fi
ACCOUNT_CODE="$(python3 - "$OUT/preday_account/preday_account.wasm" <<'PY'
import hashlib, sys
digest = hashlib.sha256(open(sys.argv[1], "rb").read()).digest()
alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
number, out = int.from_bytes(digest, "big"), ""
while number:
    number, rest = divmod(number, 58)
    out = alphabet[rest] + out
print("1" * (len(digest) - len(digest.lstrip(b"\0"))) + out)
PY
)"

near contract deploy "$USDC" use-file "$OUT/test_usdc/test_usdc.wasm" \
  with-init-call new json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' "${NET[@]}" "${SIGN[@]}"

near contract deploy "$VERIFIER" use-file "$OUT/test_verifier/test_verifier.wasm" \
  with-init-call new json-args "{\"preday\":\"$PREDAY\"}" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' "${NET[@]}" "${SIGN[@]}"

# Demo timings: 2 minutes of history instead of 30 days, late after 10 minutes, written off after 20,
# level-ups after 15 seconds instead of 7 days, LP withdrawals 1 minute after the last deposit.
PARAMS='{"min_payments":3,"min_history_ms":120000,"base_share_bps":3000,"ladder":["25000000","50000000","100000000","200000000","400000000"],"fee_bps":500,"min_fee":"1000000","late_after_ms":600000,"write_off_after_ms":1200000,"reserve_bps":2000,"max_utilization_bps":8000,"min_payment":"10000000","seasoning_ms":15000,"withdraw_delay_ms":60000}'
near contract deploy "$PREDAY" use-file "$OUT/preday/preday.wasm" \
  with-init-call new json-args "{\"usdc\":\"$USDC\",\"verifier\":\"$VERIFIER\",\"account_code\":\"$ACCOUNT_CODE\",\"params\":$PARAMS,\"params_delay_ms\":60000}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' "${NET[@]}" "${SIGN[@]}"

near contract call-function as-transaction "$USDC" storage_deposit \
  json-args "{\"account_id\":\"$PREDAY\",\"registration_only\":true}" \
  prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as "$PREDAY" "${NET[@]}" "${SIGN[@]}"

echo "Deployed. Set VITE_CONTRACT_ID=$PREDAY in web/.env"
