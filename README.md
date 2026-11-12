# Preday

**Payday is whenever you need it.** A pay link for people paid in crypto, with a paycheck advance that pays itself back.

A freelancer claims `preday.app/anna` and sends it to clients instead of a wallet address. The client pays with any coin from any network. Dollars (USDC) arrive, the contract records the income, and after a few payments Anna can take part of her next payment early. When that payment lands, the contract takes the advance and a flat fee out of it and forwards the rest. Nobody has to remember to repay anything.

- Live demo: https://0xnickdev.github.io/preday/ (NEAR testnet, no wallet needed)
- Contract: [`preday-v0.testnet`](https://testnet.nearblocks.io/address/preday-v0.testnet)
- Track: Real-World Money (NEAR Hackathon)

## Why

Paycheck advance is a large business in regular fintech (Dave, EarnIn, Chime MyPay), and all of it runs through a bank account or an employer's payroll system. A contractor paid in stablecoins has neither, so none of it works for them. Preday gets the same guarantee, repayment at the source, from a contract instead of a payroll integration: income passes through the contract before it reaches the worker.

## See it work

### In the browser (2 minutes)

Open the [demo](https://0xnickdev.github.io/preday/). It creates a throwaway testnet account in your browser, so there is nothing to install.

| Do this | You see |
| --- | --- |
| Open the app, claim a name | Your dashboard and a pay link |
| Open the pay page, pay three times with test dollars | Three payments in the dashboard |
| Press "Verify identity", wait 2 minutes | "You can take up to $25 of it today" |
| Press "Get $25 now" and confirm | "Advance open: $26.25" |
| Pay the link once more | Advance closed, limit step moves from $25 to $50 |
| Open Pool | The $1.25 fee split: $1.00 to the pool, $0.25 to the reserve |

The demo deployment uses 2 minutes of required history instead of 30 days. Everything else is the production rule set.

### From a clean clone

Needs Node 24+ and, for the contracts, Rust with the `wasm32-unknown-unknown` target and [cargo-near](https://github.com/near/cargo-near).

```bash
# The whole story on testnet, printed step by step (about 3 minutes)
cd web && npm install
echo "VITE_CONTRACT_ID=preday-v0.testnet" > .env
npm run demo

# The app
npm run dev            # http://localhost:5173

# Contracts: 92 unit tests and 9 sandbox tests with real cross-contract calls
cd ../contracts
for crate in preday preday-account test-usdc test-verifier; do (cd $crate && cargo near build non-reproducible-wasm); done
cargo test --workspace

# Payment service: 48 tests, plus dry quotes against the real 1Click API
cd ../service && npm install && npm test && npm run test:live
```

`npm run demo` ends with output like this:

```
6. Anna takes a $25 advance
   owes $25.00 + $1.25 fee, wallet: $3045.00
7. The next $1,000 payment arrives
   advance paid back, limit level 1, wallet: $4018.75
   pool: $501.00 assets, $0.25 reserve, $1.25 fees earned so far
```

## How a payment moves

```
1. The client pays any coin on any network
      to a one-time deposit address from NEAR Intents (1Click)
2. Intents swaps it to USDC
      and delivers it to the pay account  anna.preday.near
3. sweep() on the pay account, callable by anyone
      forwards all its USDC to the main contract, tagged "anna"
4. preday :: ft_on_transfer
      a) record the payment
      b) an advance is open? repay principal, then the fee
      c) split the fee: 80% to the pool, 20% to the reserve
      d) send the rest to Anna's wallet
```

The pay account exists because an Intents payment arrives as a plain transfer with no memo. One account per person answers "whose money is this" without a trusted watcher. Each pay account has no access keys and runs shared code published once as a NEAR global contract, so it costs 0.001 NEAR and can do exactly one thing.

What NEAR does here:

- **Intents** let the client pay with what they hold. The worker never sees a bridge.
- **Named accounts** make a salary address readable, and global contracts make one per person cheap.
- **The contract** makes repayment at the source impossible to talk around, and makes income history public and checkable.

## The rules

All of these live in contract state and are returned by `get_params`. Changing them goes through a timelock.

| Rule | Value |
| --- | --- |
| Eligibility | 3 payments, 30 days since the first one, one identity check per person |
| Base | Median of the last 3 payments |
| Limit | The lower of 30% of the base and the current step |
| Steps | $25, $50, $100, $200, $400. One step up for each advance repaid on time |
| Open advances | One at a time |
| Fee | 5% of the advance, $1 minimum, fixed when taken, collected at repayment |
| Repayment | From the next payment: principal, then fee, the rest to the worker |
| Short payment | Covers what it can. What is owed never grows |
| Late | 45 days without a payment: limit paused, back to the first step |
| Written off | 90 days: the reserve absorbs the loss, then the pool. That identity gets no more advances |
| Reserve | 20% of every fee |
| Pool utilization | At most 80% of pool assets out in advances |

A 5% fee on a two-week advance is a high rate if you annualize it. The app shows the fee in dollars before the worker confirms and does not hide that.

## Repository

```
contracts/
  preday/            main contract: workers, payment history, advances, the pool
  preday-account/    the pay account. One method: sweep()
  test-usdc/         testnet stand-in for USDC with an open mint
  test-verifier/     testnet stand-in for an identity provider
web/                 Vite + React + TypeScript: landing, pay page, dashboard, pool
service/             Node service: 1Click quotes for a pay link, sweep after a payment succeeds
scripts/             testnet deployment
```

### Contract interface

```
register(handle)                       create the keyless pay account handle.<contract>
ft_on_transfer(sender, amount, msg)    {"income":"anna"} from a pay account, {"deposit":true} from a pool backer
request_advance(amount)                check the limit, send USDC to the worker
withdraw(shares)                       a backer redeems pool shares
claim()                                collect a payout that could not be delivered earlier
set_verified(handle, person_code)      identity provider only. One person, one handle
mark_late(handle) / write_off(handle)  callable by anyone once the deadline has passed
propose_params(params) / apply_params()   owner proposes, anyone applies after the delay

get_worker  get_handle  get_limit  get_payments  get_pool  get_shares  get_params  get_pending_params  get_config
```

What the contract cannot do:

- The owner has no method that moves anyone's money.
- A pay account has no keys. Only its code can act, and the code only forwards USDC to the main contract.
- Amounts are integers of USDC minimal units. There is no floating point anywhere.

## Status

Built for the NEAR Hackathon, started on 12 November 2026. It is not connected to any earlier project.

Working and verified on testnet: pay accounts on global code, income recording, limits, advances, repayment from the next payment, partial repayment, late and write-off, the pool and its reserve, the timelock, and the full browser flow.

Not there yet, stated plainly:

- **Mainnet.** NEAR Intents has no testnet, so on testnet a "payment" is test dollars minted to the pay account. From there it takes the same path. The service that issues real 1Click quotes is built and its request format is verified with dry quotes against the live API, but no real payment has been routed end to end.
- **Identity.** The testnet verifier approves everyone. The contract stores only a hash and already enforces one person, one handle. A real provider plugs in as the `verifier` account.
- **Wallets.** The demo signs with a throwaway key kept in the browser. Wallet sign-in is the first thing to add for real users.
- **Audit.** None. The demo contract account still holds a full-access key, so its code can be replaced. A production deployment would delete that key.
- **Fees on cross-chain withdrawal** from the product plan are not implemented.

## Deploying your own

```bash
scripts/deploy-testnet.sh my-preday      # creates my-preday.testnet and two helper accounts
echo "VITE_CONTRACT_ID=my-preday.testnet" > web/.env
```

Service configuration is described in `service/.env.example`. Keys only ever come from the environment.

## License

MIT
