# Configuration Reference

This project is designed to be controlled through `.env`.

## Required

| Variable | Required | Notes |
| --- | --- | --- |
| `RPC_URLS` | Yes | Comma-separated RPC endpoints. Supports `${ENV_VAR}` placeholders. |
| `WALLET_SECRET_KEY_BASE58` | Yes | Base58 private key or a JSON byte array. |
| `MINT` | Yes | Target token mint to buy and burn. |

## Branding

| Variable | Default | Notes |
| --- | --- | --- |
| `LOG_BRAND` | `BurnGPT` fallback | Changes the brand prefix in CLI logs. |

## Claim Settings

| Variable | Default | Notes |
| --- | --- | --- |
| `POOL` | `pump` | Pool hint for buy calls. |
| `CLAIM_POOL` | empty | Claim source. Can be `pump`, `multi`, or another supported pool name. |
| `CLAIM_METHOD` | `auto` | `auto`, `local`, `lightning`, or `replay`. |
| `CLAIM_REF_SIG` | empty | Used when `CLAIM_METHOD=replay`. |
| `PUMPPORTAL_API_KEY` | empty | Needed for lightning claim flow. |
| `CLAIM_MIN_SOL` | `0` | Skip claim step if wallet SOL is below this amount. |
| `CLAIM_COOLDOWN_CYCLES` | `3` | Cooldown after empty claim cycles. |

## Treasury Splits

These are optional. Keep them explicit for anyone using the project.

| Variable | Default | Notes |
| --- | --- | --- |
| `CLAIM_TREASURY_ADDRESS` | empty | User treasury wallet address. |
| `CLAIM_TREASURY_BPS` | `0` | User treasury share in basis points. `500` = 5%. |
| `DEVELOPER_TREASURY_ADDRESS` | empty | Developer treasury wallet address. |
| `DEVELOPER_TREASURY_BPS` | `0` | Developer treasury share in basis points. `500` = 5%. |

Both treasury splits are calculated from the claimed creator rewards amount.

## Buyback Settings

| Variable | Default | Notes |
| --- | --- | --- |
| `BUY_ROUTE` | `auto` | `pump`, `jupiter`, or `auto`. |
| `BUY_SPLIT_COUNT` | `5` | Target number of buys per cycle. |
| `SLIPPAGE` | `1` | Percent slippage setting. |
| `PRIORITY_FEE` | `0.0001` | Priority fee in SOL format. |
| `INTERVAL_MS` | `180000` | Time between cycles in milliseconds. |
| `MIN_SOL_KEEP` | `0` | SOL reserve never spent on buys. |
| `BUY_SOL_FEE_BUFFER` | `0` | Extra SOL held back for fees. |
| `MIN_BUY_SOL` | `0.0005` | Smallest acceptable buy chunk. |

### Split-Buy Behavior

`BUY_SPLIT_COUNT` is the requested split count.

The bot then checks wallet size and `MIN_BUY_SOL`:

- If the chunks are large enough, it uses the requested count.
- If the chunks would be too small, it automatically steps down to fewer buys.
- If `BUY_SPLIT_COUNT=1`, the cycle becomes a single buy.

## Incoming Token Handling

| Variable | Default | Notes |
| --- | --- | --- |
| `AUTO_CONVERT_INCOMING_TOKENS` | `1` | If enabled, non-target incoming tokens are swapped into the target token. |

## Price Guard

| Variable | Default | Notes |
| --- | --- | --- |
| `PRICE_GUARD_MODE` | `auto` | Guard mode for price validation. |
| `MAX_PRICE_DEVIATION_PCT` | `15` | Max allowed deviation between price sources. |
| `PRICE_QUOTE_SOL_LAMPORTS` | `100000000` | Quote size used for route/price checks. |
| `JUPITER_API_KEY` | empty | Optional Jupiter API key. |
| `BIRDEYE_API_KEY` | empty | Optional Birdeye API key. |
| `FETCH_TIMEOUT_MS` | `8000` | Timeout for external API requests. |

## RPC Setup

| Variable | Default | Notes |
| --- | --- | --- |
| `HELIUS_API_KEY` | empty | Optional helper var for `RPC_URLS`. |

Example:

```env
HELIUS_API_KEY=your_key_here
RPC_URLS=https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY},https://api.mainnet-beta.solana.com
```
