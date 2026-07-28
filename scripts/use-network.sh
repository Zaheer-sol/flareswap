#!/usr/bin/env bash
# Points the backend and the frontend at the same network, in one step.
#
# These two configs must agree. When they drift the failure is quiet and confusing: the frontend
# reads contracts on one chain while the backend indexes another, so pages render but every
# number is wrong or missing. One script, one source of truth.
#
# Usage:
#   ./scripts/use-network.sh local      # Anvil devnet (chain 31337)
#   ./scripts/use-network.sh coston2    # Flare testnet (chain 114)
#   ./scripts/use-network.sh flare      # Flare mainnet (chain 14)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"

case "$TARGET" in
  local)
    CHAIN_ID=31337
    RPC="http://127.0.0.1:8545"
    LABEL="Local Anvil devnet"
    ;;
  coston2)
    CHAIN_ID=114
    RPC="https://coston2-api.flare.network/ext/C/rpc"
    LABEL="Flare Coston2 testnet"
    ;;
  flare)
    CHAIN_ID=14
    RPC="https://flare-api.flare.network/ext/C/rpc"
    LABEL="Flare mainnet"
    ;;
  *)
    echo "usage: $0 {local|coston2|flare}" >&2
    exit 1
    ;;
esac

BACKEND_ENV="$ROOT/backend/.env"
FRONTEND_ENV="$ROOT/frontend/.env.local"

# Rewrites KEY=value in place, appending when the key is absent. Everything else is preserved,
# so secrets already in the file (RELAYER_PRIVATE_KEY, FDC keys) survive a network switch.
set_var() {
  local file=$1 key=$2 value=$3
  touch "$file"
  if grep -qE "^${key}=" "$file"; then
    # BSD sed (macOS) needs the empty -i argument; GNU sed tolerates it via the separate form.
    if sed --version >/dev/null 2>&1; then
      sed -i "s|^${key}=.*|${key}=${value}|" "$file"
    else
      sed -i '' "s|^${key}=.*|${key}=${value}|" "$file"
    fi
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

set_var "$BACKEND_ENV" CHAIN_ID "$CHAIN_ID"
set_var "$BACKEND_ENV" FLARE_RPC_URL "$RPC"
set_var "$FRONTEND_ENV" NEXT_PUBLIC_CHAIN_ID "$CHAIN_ID"
set_var "$FRONTEND_ENV" NEXT_PUBLIC_API_URL "http://localhost:4000"

echo "switched to: $LABEL (chain $CHAIN_ID)"
echo "  backend  -> $BACKEND_ENV"
echo "  frontend -> $FRONTEND_ENV"

DEPLOYMENT="$ROOT/contracts/deployments/${CHAIN_ID}.json"
if [ -f "$DEPLOYMENT" ]; then
  echo "  contracts: $(jq -r .intentManager "$DEPLOYMENT") (IntentManager)"
else
  echo
  echo "  !! No deployment for chain $CHAIN_ID yet. Deploy first:"
  case "$TARGET" in
    local)
      echo "       cd contracts && anvil &"
      echo "       forge script script/DeployLocal.s.sol:DeployLocal \\"
      echo "         --rpc-url $RPC --broadcast --slow"
      ;;
    *)
      echo "       cd contracts"
      echo "       export PRIVATE_KEY=0x...            # funded with the native gas token"
      echo "       export XRPL_DEPOSIT_ADDRESS=r...    # address users pay into"
      echo "       forge script script/Deploy.s.sol:Deploy --rpc-url $TARGET --broadcast --slow"
      echo "       forge script script/Seed.s.sol:Seed   --rpc-url $TARGET --broadcast --slow"
      ;;
  esac
  echo "       ./contracts/script/export-abis.sh"
fi

echo
echo "Restart both dev servers to pick this up (frontend env vars are inlined at build time)."
