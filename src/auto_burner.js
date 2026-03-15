import "dotenv/config";
import fetch from "node-fetch";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddress,
  getAccount,
  getMint,
  createBurnCheckedInstruction,
  ACCOUNT_SIZE,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";

const PUMPPORTAL_TRADE_LOCAL = "https://pumpportal.fun/api/trade-local";
const PUMPPORTAL_TRADE_LIGHTNING = "https://pumpportal.fun/api/trade";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const state = {
  bondingComplete: false,
  claimCooldown: 0,
  claimReplay: null,
  cycleCount: 0,
  lastSnapshot: null,
};

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function parseSecretKey(secretRaw) {
  const secret = String(secretRaw ?? "").trim();
  if (!secret) throw new Error("Wallet secret is empty");

  if (secret.startsWith("[")) {
    let arr;
    try {
      arr = JSON.parse(secret);
    } catch {
      throw new Error("Invalid wallet secret array JSON format");
    }
    if (!Array.isArray(arr) || arr.length !== 64) {
      throw new Error("Wallet secret array must contain exactly 64 numbers");
    }
    if (!arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new Error("Wallet secret array must contain bytes (0-255)");
    }
    return Uint8Array.from(arr);
  }

  try {
    const decoded = bs58.decode(secret);
    if (decoded.length !== 64) {
      throw new Error("Wallet secret base58 must decode to exactly 64 bytes");
    }
    return decoded;
  } catch {
    throw new Error(
      "Invalid wallet secret format. Use base58 or JSON byte array like [1,2,3,...]."
    );
  }
}

function parseSolToLamports(solStr) {
  const s = String(solStr).trim();
  if (!s) return 0n;
  const [whole, frac = ""] = s.split(".");
  const fracPadded = (frac + "000000000").slice(0, 9);
  const w = BigInt(whole || "0");
  const f = BigInt(fracPadded || "0");
  return w * 1000000000n + f;
}

function lamportsToSolString(lamports) {
  const sign = lamports < 0n ? "-" : "";
  const abs = lamports < 0n ? -lamports : lamports;
  const whole = abs / 1000000000n;
  const frac = abs % 1000000000n;
  const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
  return sign + whole.toString() + (fracStr ? `.${fracStr}` : "");
}

function shortAddress(value, head = 4, tail = 4) {
  const s = String(value ?? "");
  if (s.length <= head + tail + 3) return s;
  return `${s.slice(0, head)}...${s.slice(-tail)}`;
}

function formatSeconds(ms) {
  return (ms / 1000).toFixed(1);
}

function formatTokenAmountRaw(amountRaw, decimals, maxFracDigits = 6) {
  const raw = BigInt(amountRaw ?? 0n);
  const d = Math.max(0, Number(decimals ?? 0));
  if (d === 0) return raw.toString();
  const base = 10n ** BigInt(d);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(d, "0");
  const shown = frac.slice(0, Math.min(maxFracDigits, d)).replace(/0+$/, "");
  return shown ? `${whole.toString()}.${shown}` : whole.toString();
}

function splitLamports(totalLamports, parts) {
  const total = BigInt(totalLamports ?? 0n);
  const n = Math.max(1, Number(parts ?? 1));
  if (total <= 0n) return [];
  const base = total / BigInt(n);
  const rem = total % BigInt(n);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const addOne = BigInt(i) < rem ? 1n : 0n;
    const chunk = base + addOne;
    if (chunk > 0n) out.push(chunk);
  }
  return out;
}

function expandPlaceholders(str, env) {
  return str.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => env[key] ?? "");
}

function parseRpcUrls(env) {
  const raw = env.RPC_URLS || env.RPC_URL || "";
  if (!raw) throw new Error("Missing env var: RPC_URLS (or RPC_URL)");
  return raw
    .split(",")
    .map((s) => expandPlaceholders(s.trim(), env))
    .filter((s) => s.length > 0);
}

const LOG_BRAND = (() => {
  const raw = process.env.LOG_BRAND ?? process.env.APP_BRAND ?? "BurnGPT";
  const cleaned = String(raw).trim();
  return cleaned || "BurnGPT";
})();

function formatLine(level, msg) {
  const prefix = {
    info: "ℹ️  INFO",
    ok: "✅ OK",
    warn: "⚠️  WARN",
    err: "❌ ERROR",
  }[level] || "ℹ️  INFO";
  return `[${LOG_BRAND}] ${prefix} | ${msg}`;
}

const log = {
  info: (msg) => {
    const line = formatLine("info", msg);
    console.log(line);
  },
  ok: (msg) => {
    const line = formatLine("ok", msg);
    console.log(line);
  },
  warn: (msg) => {
    const line = formatLine("warn", msg);
    console.warn(line);
  },
  err: (msg) => {
    const line = formatLine("err", msg);
    console.error(line);
  },
  section: (title) => {
    const line = `\n🔥 ${LOG_BRAND} :: ${title}\n${"=".repeat(64)}`;
    console.log(line);
  },
  price: (src, price, meta) => {
    const line = `📊 PRICE | ${src.padEnd(14)} $${price.toFixed(8)}${meta ? ` (${meta})` : ""}`;
    console.log(line);
  },
  tx: (label, sig) => {
    const line = `🧾 TX | ${label}: ${sig}`;
    console.log(line);
  },
  burn: (msg) => {
    const line = formatLine("ok", `🔥 ${msg}`);
    console.log(line);
  },
};

function redactApiKey(url) {
  if (!url) return url;
  return String(url)
    .replace(/([?&]api-key=)[^&]+/gi, "$1***")
    .replace(/([?&]apikey=)[^&]+/gi, "$1***")
    .replace(/([?&]key=)[^&]+/gi, "$1***");
}

class RpcPool {
  constructor(urls, commitment = "confirmed") {
    if (!urls.length) throw new Error("No RPC URLs configured");
    this.urls = urls;
    this.commitment = commitment;
    this.idx = 0;
    this.connections = urls.map((url) => new Connection(url, commitment));
  }

  current() {
    return this.connections[this.idx];
  }

  currentUrl() {
    return this.urls[this.idx];
  }

  rotate() {
    this.idx = (this.idx + 1) % this.connections.length;
  }

  async withRetry(fn, label) {
    let lastErr;
    for (let i = 0; i < this.connections.length; i += 1) {
      const conn = this.current();
      const url = redactApiKey(this.currentUrl());
      try {
        return await fn(conn);
      } catch (err) {
        const msg = err?.message ?? String(err);
        const noRetry =
          msg.includes("BondingCurveComplete") ||
          msg.includes("custom program error: 0x1775") ||
          msg.includes("Error Code: BondingCurveComplete") ||
          msg.includes("custom program error: 0x1") ||
          msg.includes("insufficient lamports");
        if (noRetry) {
          throw err;
        }
        lastErr = err;
        // Suppress RPC error logs per user request.
        this.rotate();
      }
    }
    throw lastErr;
  }
}

async function rpcRequest(rpcPool, method, params) {
  let lastErr;
  for (let i = 0; i < rpcPool.connections.length; i += 1) {
    const url = rpcPool.currentUrl();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const json = await res.json();
      if (json?.error) {
        throw new Error(json.error.message || "RPC error");
      }
      return json.result;
    } catch (err) {
      lastErr = err;
      // Suppress RPC error logs per user request.
      rpcPool.rotate();
    }
  }
  throw lastErr;
}

async function claimTxHadNoRewards(rpcPool, signature) {
  try {
    const tx = await rpcRequest(rpcPool, "getTransaction", [
      signature,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
    ]);
    const logs = Array.isArray(tx?.meta?.logMessages) ? tx.meta.logMessages : [];
    return logs.some(
      (l) =>
        typeof l === "string" &&
        (l.includes("No creator fee to collect") || l.includes("No coin creator fee to collect"))
    );
  } catch {
    return false;
  }
}

async function fetchJson(url, options = {}) {
  const timeoutMs = Number(process.env.FETCH_TIMEOUT_MS ?? "8000");
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

async function sendPumpPortalTx(rpcPool, keypair, body) {
  const res = await fetch(PUMPPORTAL_TRADE_LOCAL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PumpPortal error ${res.status}: ${text}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  const tx = VersionedTransaction.deserialize(new Uint8Array(arrayBuffer));
  tx.sign([keypair]);
  const sig = await rpcPool.withRetry(
    (conn) => conn.sendTransaction(tx, { maxRetries: 3 }),
    "sendTransaction"
  );
  await rpcPool.withRetry((conn) => conn.confirmTransaction(sig, "confirmed"), "confirmTransaction");
  return sig;
}

async function sendPumpPortalLightning(apiKey, body) {
  if (!apiKey) throw new Error("Missing PUMPPORTAL_API_KEY for lightning claim");
  const res = await fetch(`${PUMPPORTAL_TRADE_LIGHTNING}?api-key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new Error(`PumpPortal lightning ${res.status}: ${JSON.stringify(data)}`);
  }
  const sig = data?.signature || data?.txSignature || data?.result;
  if (!sig) {
    throw new Error(`PumpPortal lightning: missing signature ${JSON.stringify(data)}`);
  }
  return sig;
}

async function buildReplayTransaction(rpcPool, signature, newBlockhash) {
  if (state.claimReplay?.sig === signature && state.claimReplay?.rawTx) {
    const tx = VersionedTransaction.deserialize(state.claimReplay.rawTx);
    tx.message.recentBlockhash = newBlockhash;
    tx.signatures = tx.signatures.map(() => Buffer.alloc(64));
    return tx;
  }
  const txResp = await rpcRequest(rpcPool, "getTransaction", [
    signature,
    { encoding: "base64", maxSupportedTransactionVersion: 0 },
  ]);
  const txField = txResp?.transaction;
  const raw = Array.isArray(txField) ? txField[0] : txField;
  if (!raw) {
    throw new Error("Replay claim: transaction not found");
  }
  const rawBuf = Buffer.from(raw, "base64");
  state.claimReplay = { sig: signature, rawTx: rawBuf };
  const tx = VersionedTransaction.deserialize(rawBuf);
  tx.message.recentBlockhash = newBlockhash;
  tx.signatures = tx.signatures.map(() => Buffer.alloc(64));
  return tx;
}

async function swapViaJupiter({
  rpcPool,
  keypair,
  inputMint,
  outputMint,
  inAmountRaw,
  slippagePct,
  jupiterApiKey,
  priorityFeeLamports,
}) {
  const amountRaw = BigInt(inAmountRaw ?? 0n);
  if (amountRaw <= 0n) throw new Error("Jupiter swap amount must be > 0");
  const inputMintStr = typeof inputMint === "string" ? inputMint : inputMint.toBase58();
  const outputMintStr = typeof outputMint === "string" ? outputMint : outputMint.toBase58();
  if (inputMintStr === outputMintStr) {
    throw new Error("Jupiter swap input and output mint are identical");
  }

  const slippageBps = Math.max(1, Math.round(slippagePct * 100));
  const quoteUrl =
    `https://api.jup.ag/swap/v1/quote?` +
    `inputMint=${inputMintStr}&outputMint=${outputMintStr}` +
    `&amount=${amountRaw.toString()}` +
    `&slippageBps=${slippageBps}`;

  const quoteResponse = await fetchJson(quoteUrl, {
    headers: buildJupiterHeaders(jupiterApiKey),
  });
  if (!quoteResponse || !quoteResponse.routePlan || quoteResponse.routePlan.length === 0) {
    throw new Error(`Jupiter quote returned no route (${shortAddress(inputMintStr, 6, 6)} -> ${shortAddress(outputMintStr, 6, 6)})`);
  }

  const body = {
    quoteResponse,
    userPublicKey: keypair.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    dynamicSlippage: true,
  };

  if (priorityFeeLamports > 0n) {
    body.prioritizationFeeLamports = {
      priorityLevelWithMaxLamports: {
        maxLamports: Number(priorityFeeLamports),
        priorityLevel: "veryHigh",
      },
    };
  }

  const swapResponse = await fetchJson("https://api.jup.ag/swap/v1/swap", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...buildJupiterHeaders(jupiterApiKey),
    },
    body: JSON.stringify(body),
  });

  if (!swapResponse?.swapTransaction) {
    throw new Error("Jupiter swap returned no transaction");
  }

  const tx = VersionedTransaction.deserialize(
    Buffer.from(swapResponse.swapTransaction, "base64")
  );
  tx.sign([keypair]);

  const sig = await rpcPool.withRetry(
    (conn) => conn.sendTransaction(tx, { maxRetries: 3 }),
    "sendTransaction"
  );
  await rpcPool.withRetry((conn) => conn.confirmTransaction(sig, "confirmed"), "confirmTransaction");
  return sig;
}

async function buyViaJupiter({
  rpcPool,
  keypair,
  mint,
  inLamports,
  slippagePct,
  jupiterApiKey,
  priorityFeeLamports,
}) {
  return await swapViaJupiter({
    rpcPool,
    keypair,
    inputMint: SOL_MINT,
    outputMint: mint,
    inAmountRaw: inLamports,
    slippagePct,
    jupiterApiKey,
    priorityFeeLamports,
  });
}

async function getOwnerTokenPositions(rpcPool, owner) {
  const byMint = new Map();
  const tokenPrograms = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

  for (const programId of tokenPrograms) {
    let resp;
    try {
      resp = await rpcPool.withRetry(
        (conn) => conn.getParsedTokenAccountsByOwner(owner, { programId }, "confirmed"),
        "getParsedTokenAccountsByOwner"
      );
    } catch (err) {
      log.warn(`Token inventory fetch failed (${shortAddress(programId.toBase58())}): ${err?.message ?? String(err)}`);
      continue;
    }

    for (const entry of resp?.value ?? []) {
      const info = entry?.account?.data?.parsed?.info;
      const mintStr = info?.mint;
      const amountStr = info?.tokenAmount?.amount;
      const decimals = Number(info?.tokenAmount?.decimals ?? 0);
      if (!mintStr || !amountStr) continue;
      let raw;
      try {
        raw = BigInt(amountStr);
      } catch {
        continue;
      }
      if (raw <= 0n) continue;
      const prev = byMint.get(mintStr) ?? {
        mintStr,
        amountRaw: 0n,
        decimals,
      };
      prev.amountRaw += raw;
      prev.decimals = decimals;
      byMint.set(mintStr, prev);
    }
  }

  return [...byMint.values()];
}

function buildAssetSnapshot(solLamports, tokenPositions, targetMintStr) {
  let targetRaw = 0n;
  let targetDecimals = 0;
  const others = [];

  for (const token of tokenPositions) {
    if (token.mintStr === targetMintStr) {
      targetRaw += token.amountRaw;
      targetDecimals = token.decimals;
      continue;
    }
    others.push({
      mintStr: token.mintStr,
      amountRaw: token.amountRaw,
      decimals: token.decimals,
    });
  }

  others.sort((a, b) => a.mintStr.localeCompare(b.mintStr));
  return {
    solLamports,
    targetRaw,
    targetDecimals,
    others,
  };
}

async function convertIncomingTokensToTarget({
  rpcPool,
  keypair,
  mint,
  incomingTokens,
  slippagePct,
  jupiterApiKey,
  priorityFeeLamports,
}) {
  const queue = (incomingTokens ?? []).filter((t) => BigInt(t.amountRaw ?? 0n) > 0n);
  if (!queue.length) {
    log.info("No extra non-target tokens to convert this cycle.");
    return { attempted: 0, converted: 0 };
  }

  log.info(`Converting ${queue.length} incoming token type(s) into your target token.`);
  let converted = 0;

  for (const token of queue) {
    const amountUi = formatTokenAmountRaw(token.amountRaw, token.decimals);
    const mintShort = shortAddress(token.mintStr, 6, 6);
    try {
      const sig = await swapViaJupiter({
        rpcPool,
        keypair,
        inputMint: token.mintStr,
        outputMint: mint,
        inAmountRaw: token.amountRaw,
        slippagePct,
        jupiterApiKey,
        priorityFeeLamports,
      });
      converted += 1;
      log.ok(`Swap complete: ${amountUi} from ${mintShort} is now in your target token.`);
      log.tx("Incoming Swap Tx", sig);
    } catch (err) {
      log.warn(`Could not swap ${amountUi} from ${mintShort} this cycle: ${err?.message ?? String(err)}`);
    }
  }

  if (converted > 0) {
    log.ok(`Incoming swap summary: ${converted}/${queue.length} token type(s) converted.`);
  } else {
    log.warn("Incoming swap summary: nothing was converted this cycle.");
  }
  return { attempted: queue.length, converted };
}

async function getTokenProgramId(rpcPool, mint) {
  const info = await rpcPool.withRetry(
    (conn) => conn.getAccountInfo(mint, "confirmed"),
    "getAccountInfo"
  );
  if (!info) throw new Error("Mint account not found");
  const owner = info.owner.toBase58();
  if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

async function getMintInfo(rpcPool, mint, programId) {
  return await rpcPool.withRetry(
    (conn) => getMint(conn, mint, "confirmed", programId),
    "getMint"
  );
}

async function logRemainingSupplyHeadline(rpcPool, mint, prefix = "Remaining Token Supply") {
  try {
    const programId = await getTokenProgramId(rpcPool, mint);
    const mintInfo = await getMintInfo(rpcPool, mint, programId);
    const supplyUi = formatTokenAmountRaw(mintInfo.supply, mintInfo.decimals, 6);
    log.ok(`📣 ${prefix}: ${supplyUi} tokens`);
  } catch (err) {
    log.warn(`Could not fetch token supply for headline: ${err?.message ?? String(err)}`);
  }
}

async function burnAllTokens({ rpcPool, payer, mint, pricing }) {
  const programId = await getTokenProgramId(rpcPool, mint);
  const ata = await getAssociatedTokenAddress(mint, payer.publicKey, false, programId);
  let account;
  try {
    account = await rpcPool.withRetry(
      (conn) => getAccount(conn, ata, "confirmed", programId),
      "getAccount"
    );
  } catch {
    log.info("Burn check: no token account exists yet.");
    return null;
  }

  if (account.amount === 0n) {
    log.info("Burn check: token balance is already zero.");
    return null;
  }

  const mintInfo = await getMintInfo(rpcPool, mint, programId);
  const ix = createBurnCheckedInstruction(
    ata,
    mint,
    payer.publicKey,
    account.amount,
    mintInfo.decimals,
    [],
    programId
  );

  const latest = await rpcPool.withRetry(
    (conn) => conn.getLatestBlockhash("confirmed"),
    "getLatestBlockhash"
  );
  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = latest.blockhash;

  const sig = await rpcPool.withRetry(
    (conn) => conn.sendTransaction(tx, [payer], { maxRetries: 3 }),
    "sendTransaction"
  );
  await rpcPool.withRetry((conn) => conn.confirmTransaction(sig, "confirmed"), "confirmTransaction");
  const burnedTokens = Number(account.amount) / 10 ** mintInfo.decimals;
  log.burn(`Burn executed: ${burnedTokens.toLocaleString()} tokens removed from circulation.`);
  if (pricing?.tokenUsd && pricing?.solUsd) {
    const burnedUsd = burnedTokens * pricing.tokenUsd;
    const burnedSol = burnedUsd / pricing.solUsd;
    log.burn(`Estimated burn value: ${formatSol(burnedSol)} (${formatUsd(burnedUsd)}).`);
  }
  log.tx("Burn Tx", sig);
  return { sig, burnedTokens };
}

async function hasTokenAccount(rpcPool, owner, mint, programId) {
  const ata = await getAssociatedTokenAddress(mint, owner, false, programId);
  try {
    await rpcPool.withRetry(
      (conn) => getAccount(conn, ata, "confirmed", programId),
      "getAccount"
    );
    return true;
  } catch {
    return false;
  }
}

async function ensureTokenAccount({ rpcPool, payer, mint, programId }) {
  const ata = await getAssociatedTokenAddress(mint, payer.publicKey, false, programId);
  try {
    await rpcPool.withRetry(
      (conn) => getAccount(conn, ata, "confirmed", programId),
      "getAccount"
    );
    return { ata, created: false, ready: true };
  } catch {
    const ix = createAssociatedTokenAccountInstruction(
      payer.publicKey,
      ata,
      payer.publicKey,
      mint,
      programId
    );
    try {
      const latest = await rpcPool.withRetry(
        (conn) => conn.getLatestBlockhash("confirmed"),
        "getLatestBlockhash"
      );
      const tx = new Transaction().add(ix);
      tx.feePayer = payer.publicKey;
      tx.recentBlockhash = latest.blockhash;
      const sig = await rpcPool.withRetry(
        (conn) => conn.sendTransaction(tx, [payer], { maxRetries: 3 }),
        "sendTransaction"
      );
      await rpcPool.withRetry((conn) => conn.confirmTransaction(sig, "confirmed"), "confirmTransaction");
      log.ok("Created associated token account (ATA).");
      log.tx("ATA Create Tx", sig);
      return { ata, created: true, ready: true };
    } catch (err) {
      return { ata: null, created: false, ready: false, error: err?.message ?? String(err) };
    }
  }
}

async function sendTreasuryShare({ rpcPool, payer, recipient, basisPoints, sourceLamports, label }) {
  if (!recipient || basisPoints <= 0 || sourceLamports <= 0n) {
    return 0n;
  }

  const lamports = (sourceLamports * BigInt(basisPoints)) / 10000n;
  if (lamports <= 0n) {
    return 0n;
  }

  const recipientPk = new PublicKey(recipient);
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipientPk,
      lamports,
    })
  );
  const sig = await rpcPool.withRetry(
    (conn) => conn.sendTransaction(tx, [payer], { maxRetries: 3 }),
    label
  );
  await rpcPool.withRetry(
    (conn) => conn.confirmTransaction(sig, "confirmed"),
    `confirm${label}`
  );
  return lamports;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function formatUsd(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  return `$${value.toFixed(6)}`;
}

function formatSol(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  return `${value.toFixed(6)} SOL`;
}

function buildJupiterHeaders(apiKey) {
  if (!apiKey) return undefined;
  return { "x-api-key": apiKey };
}

async function getSolUsdFromJupiter(jupiterApiKey) {
  const url = `https://api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=1000000000&slippageBps=50`;
  const data = await fetchJson(url, { headers: buildJupiterHeaders(jupiterApiKey) });
  const outAmount = Number(data.outAmount ?? 0);
  if (!outAmount) return null;
  return outAmount / 1_000_000;
}

async function getTokenPriceFromJupiter({ mint, decimals, quoteSolLamports, jupiterApiKey }) {
  const url = `https://api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${mint.toBase58()}&amount=${quoteSolLamports}&slippageBps=50`;
  const data = await fetchJson(url, { headers: buildJupiterHeaders(jupiterApiKey) });
  const outAmountRaw = Number(data.outAmount ?? 0);
  if (!outAmountRaw) return null;
  const outTokens = outAmountRaw / 10 ** decimals;
  const inSol = Number(quoteSolLamports) / 1_000_000_000;
  if (!outTokens || !inSol) return null;
  const solPerToken = inSol / outTokens;
  return solPerToken;
}

async function hasJupiterRoute({ mint, quoteSolLamports, jupiterApiKey }) {
  const url = `https://api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${mint.toBase58()}&amount=${quoteSolLamports}&slippageBps=50`;
  const data = await fetchJson(url, { headers: buildJupiterHeaders(jupiterApiKey) });
  return Number(data.outAmount ?? 0) > 0;
}

async function getTokenPriceFromDexScreener(mint) {
  const url = `https://api.dexscreener.com/latest/dex/search?q=${mint.toBase58()}`;
  const data = await fetchJson(url);
  const pairs = Array.isArray(data.pairs) ? data.pairs : [];
  const solPairs = pairs.filter((p) => p.chainId === "solana");
  if (!solPairs.length) return null;
  solPairs.sort((a, b) => {
    const aLiq = Number(a?.liquidity?.usd ?? 0);
    const bLiq = Number(b?.liquidity?.usd ?? 0);
    return bLiq - aLiq;
  });
  const priceUsd = Number(solPairs[0]?.priceUsd ?? 0);
  if (!priceUsd) return null;
  return priceUsd;
}

async function getTokenPriceFromBirdeye(mint, apiKey) {
  if (!apiKey) return null;
  const url = `https://public-api.birdeye.so/defi/price?address=${mint.toBase58()}`;
  const data = await fetchJson(url, {
    headers: { "X-API-KEY": apiKey },
  });
  const value = Number(data?.data?.value ?? 0);
  if (!value) return null;
  return value;
}

async function collectPriceSignals({ mint, decimals, quoteSolLamports, birdeyeApiKey, jupiterApiKey }) {
  const results = [];

  let solUsd = null;
  try {
    solUsd = await getSolUsdFromJupiter(jupiterApiKey);
    if (solUsd) results.push({ source: "jupiter-sol-usd", priceUsd: solUsd, meta: "SOL" });
  } catch (err) {
    log.warn(`Price source failed (Jupiter SOL/USD): ${err.message}`);
  }

  try {
    const solPerToken = await getTokenPriceFromJupiter({ mint, decimals, quoteSolLamports, jupiterApiKey });
    if (solPerToken && solUsd) {
      const tokenUsd = solPerToken * solUsd;
      results.push({ source: "jupiter-token", priceUsd: tokenUsd, meta: "SOL route" });
    }
  } catch (err) {
    log.warn(`Price source failed (Jupiter token route): ${err.message}`);
  }

  try {
    const tokenUsd = await getTokenPriceFromDexScreener(mint);
    if (tokenUsd) results.push({ source: "dexscreener", priceUsd: tokenUsd, meta: "USD" });
  } catch (err) {
    log.warn(`Price source failed (DexScreener): ${err.message}`);
  }

  try {
    const tokenUsd = await getTokenPriceFromBirdeye(mint, birdeyeApiKey);
    if (tokenUsd) results.push({ source: "birdeye", priceUsd: tokenUsd, meta: "USD" });
  } catch (err) {
    log.warn(`Price source failed (Birdeye): ${err.message}`);
  }

  return results;
}

function evaluatePriceGuard(prices, guardMode, maxDeviationPct) {
  if (guardMode === "off") return { ok: true, reason: "guard off" };
  if (prices.length === 0) {
    if (guardMode === "on") return { ok: false, reason: "no price sources" };
    return { ok: true, reason: "no price sources" };
  }
  if (prices.length === 1) {
    if (guardMode === "on") return { ok: false, reason: "only one price source" };
    return { ok: true, reason: "single price source" };
  }

  const values = prices.map((p) => p.priceUsd);
  const med = median(values);
  if (!med) return { ok: false, reason: "median failed" };

  const maxDev = maxDeviationPct;
  const bad = prices.filter((p) => Math.abs((p.priceUsd - med) / med) * 100 > maxDev);
  if (bad.length) {
    return { ok: false, reason: `price deviation > ${maxDev}%` };
  }

  return { ok: true, reason: "price consensus" };
}

async function runOnce(config) {
  try {
  const {
    rpcPool,
    keypair,
    mint,
    slippage,
    priorityFee,
    pool,
    claimPool,
    buyRoute,
    minSolKeep,
    buyFeeBuffer,
    minBuySol,
    claimMinSol,
    claimCooldownCycles,
    claimMethod,
    claimRefSig,
    claimTreasuryAddress,
    claimTreasuryBps,
    developerTreasuryAddress,
    developerTreasuryBps,
    pumpPortalApiKey,
    priceGuardMode,
    maxPriceDeviationPct,
    quoteSolLamports,
    birdeyeApiKey,
    jupiterApiKey,
    autoConvertIncoming,
    buySplitCount,
  } = config;
  const cycleStartedAt = Date.now();
  state.cycleCount += 1;
  const cycleNo = state.cycleCount;
  const reserveTarget = minSolKeep + buyFeeBuffer;
  const priorityFeeLamports = parseSolToLamports(String(priorityFee));

  const balanceBefore = BigInt(
    await rpcPool.withRetry((conn) => conn.getBalance(keypair.publicKey, "confirmed"), "getBalance")
  );
  log.section(`Cycle #${cycleNo} | Claim -> Buyback -> Burn`);
  log.info(
    `Wallet ${shortAddress(keypair.publicKey.toBase58())} | Mint ${shortAddress(mint.toBase58())}`
  );
  log.info(
    `Starting SOL: ${lamportsToSolString(balanceBefore)} | Reserve target: ${lamportsToSolString(reserveTarget)} SOL`
  );
  log.info(`Buy style: ${buyRoute}${state.bondingComplete ? " (migration-ready)" : ""}`);

  let startSnapshot = null;
  try {
    const positions = await getOwnerTokenPositions(rpcPool, keypair.publicKey);
    startSnapshot = buildAssetSnapshot(balanceBefore, positions, mint.toBase58());

    if (state.lastSnapshot) {
      let inboundEvents = 0;

      const solDelta = startSnapshot.solLamports - state.lastSnapshot.solLamports;
      if (solDelta > 0n) {
        inboundEvents += 1;
        log.ok(`🎉 New SOL arrived: +${lamportsToSolString(solDelta)} SOL.`);
      }

      const targetDelta = startSnapshot.targetRaw - state.lastSnapshot.targetRaw;
      if (targetDelta > 0n) {
        inboundEvents += 1;
        log.ok(
          `🔥 New target tokens arrived: +${formatTokenAmountRaw(targetDelta, startSnapshot.targetDecimals)}. They are queued to burn.`
        );
      }

      const prevOthers = new Map((state.lastSnapshot.others ?? []).map((t) => [t.mintStr, t.amountRaw]));
      for (const token of startSnapshot.others) {
        const prevRaw = prevOthers.get(token.mintStr) ?? 0n;
        const delta = token.amountRaw - prevRaw;
        if (delta > 0n) {
          inboundEvents += 1;
          log.ok(
            `🎁 New token deposit: +${formatTokenAmountRaw(delta, token.decimals)} of ${shortAddress(token.mintStr, 6, 6)}.`
          );
          if (autoConvertIncoming) {
            log.info("I will auto-swap this into your target token, then burn it.");
          }
        }
      }

      if (inboundEvents === 0) {
        log.info("No new wallet deposits since the last cycle.");
      }
    } else {
      log.info("Deposit tracker armed. New incoming funds will be announced each cycle.");
    }

    if (startSnapshot.targetRaw > 0n) {
      log.info(
        `Burn queue at start: ${formatTokenAmountRaw(startSnapshot.targetRaw, startSnapshot.targetDecimals)} target tokens waiting to burn.`
      );
    }
    if (startSnapshot.others.length > 0) {
      log.info(`Swap queue at start: ${startSnapshot.others.length} non-target asset(s) waiting for conversion.`);
    }
  } catch (err) {
    log.warn(`Could not read full wallet token balances for deposit tracking: ${err?.message ?? String(err)}`);
  }

  if (balanceBefore < claimMinSol) {
    log.warn(
      `Reward claim skipped: wallet has ${lamportsToSolString(balanceBefore)} SOL, below your minimum of ${claimMinSol} SOL.`
    );
  } else {
    if (state.claimCooldown > 0) {
      log.warn(`Reward claim cooldown active: ${state.claimCooldown} cycle(s) left.`);
    } else {
    try {
      let claimedSig = null;
      const resolvedClaimMethod =
        claimMethod === "auto"
          ? claimRefSig
            ? "replay"
            : pumpPortalApiKey
              ? "lightning"
              : "local"
          : claimMethod;
      const replayPool = claimPool === "multi" ? pool : claimPool;
      const claimPools =
        resolvedClaimMethod === "replay"
          ? [replayPool ?? pool].filter(Boolean)
          : claimPool === "multi"
            ? ["pump", "pump-amm", "auto", "raydium-cpmm", "raydium"]
          : claimPool === "pump" && claimMethod === "auto"
              ? ["pump", "pump-amm", "auto", "raydium-cpmm", "raydium"]
              : [claimPool ?? pool].filter(Boolean);
      log.info(
        `Trying to collect rewards using method "${resolvedClaimMethod}" across sources: ${claimPools.join(", ") || "none"}`
      );
      for (const p of claimPools) {
        try {
          const claimPriorityFees = [priorityFee];
          if (priorityFee <= 0) {
            claimPriorityFees.push(0.00001, 0.00005);
          }
          for (const claimPriority of claimPriorityFees) {
            try {
              log.info(`Claim attempt on ${p} (speed fee: ${claimPriority}).`);
              const baseClaimBody = {
                publicKey: keypair.publicKey.toBase58(),
                action: "collectCreatorFee",
                priorityFee: claimPriority,
              };
              const claimBodies =
                p === "pump"
                  ? [baseClaimBody, { ...baseClaimBody, pool: p }]
                  : [{ ...baseClaimBody, pool: p }, { ...baseClaimBody, pool: p, mint: mint.toBase58() }];

              let sig = null;
              for (const claimBody of claimBodies) {
                if (resolvedClaimMethod === "replay") {
                  const latest = await rpcPool.withRetry(
                    (conn) => conn.getLatestBlockhash("confirmed"),
                    "getLatestBlockhash"
                  );
                  const tx = await buildReplayTransaction(rpcPool, claimRefSig, latest.blockhash);
                  tx.sign([keypair]);
                  sig = await rpcPool.withRetry(
                    (conn) => conn.sendTransaction(tx, { maxRetries: 3 }),
                    "sendTransaction"
                  );
                  await rpcPool.withRetry((conn) => conn.confirmTransaction(sig, "confirmed"), "confirmTransaction");
                } else if (resolvedClaimMethod === "lightning") {
                  sig = await sendPumpPortalLightning(pumpPortalApiKey, claimBody);
                } else {
                  sig = await sendPumpPortalTx(rpcPool, keypair, claimBody);
                }
                if (!sig) continue;
                const noRewards = await claimTxHadNoRewards(rpcPool, sig);
                if (noRewards) {
                  log.info(`Claim transaction worked on ${p}, but there were no rewards to collect yet.`);
                  sig = null;
                  continue;
                }
                break;
              }
              if (!sig) continue;
              claimedSig = sig;
              log.ok(`✅ Rewards claimed successfully via ${resolvedClaimMethod} on ${p}.`);
              log.tx("Claim Tx", sig);
              break;
            } catch (err) {
              const lastPriority = claimPriority === claimPriorityFees[claimPriorityFees.length - 1];
              if (lastPriority) {
                log.warn(`Claim attempt failed on ${p}: ${err.message}`);
              }
            }
          }
          if (claimedSig) break;
        } catch (err) {
          log.warn(`Claim attempt failed on ${p}: ${err.message}`);
        }
      }
      if (!claimedSig) {
        log.warn("No rewards were captured this cycle after trying all claim paths.");
      }
    } catch (err) {
      log.err(`Claim failed: ${err.message}`);
    }
    }
  }

  let balanceAfter = BigInt(
    await rpcPool.withRetry((conn) => conn.getBalance(keypair.publicKey, "confirmed"), "getBalance")
  );
  const claimed = balanceAfter - balanceBefore;
  log.info(
    `After reward claim: wallet SOL is ${lamportsToSolString(balanceAfter)} (net claimed: ${lamportsToSolString(claimed)}).`
  );
  if (claimed > 0n) {
    const treasuryShares = [
      {
        recipient: claimTreasuryAddress,
        basisPoints: claimTreasuryBps,
        label: "treasuryTransfer",
      },
      {
        recipient: developerTreasuryAddress,
        basisPoints: developerTreasuryBps,
        label: "developerTreasuryTransfer",
      },
    ];

    for (const share of treasuryShares) {
      try {
        const sentLamports = await sendTreasuryShare({
          rpcPool,
          payer: keypair,
          recipient: share.recipient,
          basisPoints: share.basisPoints,
          sourceLamports: claimed,
          label: share.label,
        });
        balanceAfter -= sentLamports;
      } catch {
        // Keep treasury flow quiet in the CLI logs.
      }
    }
  }
  if (claimed <= 0n) {
    state.claimCooldown = claimCooldownCycles;
  } else {
    state.claimCooldown = 0;
  }

  const claimedSol = Number(claimed) / 1_000_000_000;

  if (autoConvertIncoming) {
    try {
      const conversion = await convertIncomingTokensToTarget({
        rpcPool,
        keypair,
        mint,
        incomingTokens: startSnapshot?.others ?? [],
        slippagePct: slippage,
        jupiterApiKey,
        priorityFeeLamports,
      });
      if (conversion.attempted > 0) {
        const refreshedAfterConvert = await rpcPool.withRetry(
          (conn) => conn.getBalance(keypair.publicKey, "confirmed"),
          "getBalance"
        );
        balanceAfter = BigInt(refreshedAfterConvert);
        log.info(`After incoming-token swaps: wallet SOL is ${lamportsToSolString(balanceAfter)}.`);
      }
    } catch (err) {
      log.warn(`Incoming-token auto-swap step failed: ${err?.message ?? String(err)}`);
    }
  } else if ((startSnapshot?.others?.length ?? 0) > 0) {
    log.warn("Auto-swap for incoming non-target tokens is OFF, so those tokens will remain in wallet.");
  }

  log.info("Buyback phase starting. Burn will happen once after all buys finish.");

  let programId = null;
  let mintDecimals = null;
  let mintSupply = null;
  try {
    programId = await getTokenProgramId(rpcPool, mint);
    const mintInfo = await getMintInfo(rpcPool, mint, programId);
    mintDecimals = mintInfo.decimals;
    mintSupply = mintInfo.supply;
  } catch (err) {
    log.warn(`Could not fetch target token details: ${err.message}`);
  }

  let ataReady = true;
  let rentLamports = 0n;
  if (programId) {
    const ata = await getAssociatedTokenAddress(mint, keypair.publicKey, false, programId);
    let ataExists = false;
    try {
      await rpcPool.withRetry(
        (conn) => getAccount(conn, ata, "confirmed", programId),
        "getAccount"
      );
      ataExists = true;
    } catch {
      ataExists = false;
    }

    if (!ataExists) {
      const rent = await rpcPool.withRetry(
        (conn) => conn.getMinimumBalanceForRentExemption(ACCOUNT_SIZE),
        "getMinimumBalanceForRentExemption"
      );
      rentLamports = BigInt(rent);
      const needed = rentLamports + minSolKeep + buyFeeBuffer;
      if (balanceAfter < needed) {
        ataReady = false;
        log.warn(
          `Buy setup paused: need ${lamportsToSolString(needed)} SOL for account setup + reserve, but wallet has ${lamportsToSolString(balanceAfter)}.`
        );
      } else {
        const ataStatus = await ensureTokenAccount({ rpcPool, payer: keypair, mint, programId });
        if (!ataStatus?.ready) {
          ataReady = false;
          if (ataStatus?.error) {
            log.warn(`Token account create/check failed: ${ataStatus.error}`);
          }
        } else {
          log.ok("Wallet token account is ready for buy + burn actions.");
          const refreshed = await rpcPool.withRetry(
            (conn) => conn.getBalance(keypair.publicKey, "confirmed"),
            "getBalance"
          );
          balanceAfter = BigInt(refreshed);
        }
      }
    }
  }

    const priceSignals = mintDecimals !== null
    ? await collectPriceSignals({
        mint,
        decimals: mintDecimals,
        quoteSolLamports,
        birdeyeApiKey,
        jupiterApiKey,
      })
    : [];

  if (mintSupply !== null && mintDecimals !== null) {
    const supplyUi = formatTokenAmountRaw(mintSupply, mintDecimals, 6);
    log.ok(`📣 Remaining Token Supply: ${supplyUi} tokens`);
  }

  let solUsd = null;
  let tokenUsd = null;
  if (priceSignals.length) {
    log.info("Price check: collecting quotes from multiple sources.");
    for (const p of priceSignals) {
      log.price(p.source, p.priceUsd, p.meta);
    }
    const solEntry = priceSignals.find((p) => p.source === "jupiter-sol-usd");
    solUsd = solEntry ? solEntry.priceUsd : null;
    const tokenPrices = priceSignals
      .filter((p) => p.source !== "jupiter-sol-usd")
      .map((p) => p.priceUsd);
    tokenUsd = median(tokenPrices);
    if (tokenUsd !== null) {
      log.info(`Estimated token price (median): ${formatUsd(tokenUsd)}.`);
    }
  } else {
    log.warn("Could not get live token prices this cycle.");
  }

  if (buyRoute === "auto") {
    try {
      const routeExists = await hasJupiterRoute({
        mint,
        quoteSolLamports,
        jupiterApiKey,
      });
      state.bondingComplete = routeExists;
      log.info(
        `Migration status: ${routeExists ? "bonded and tradable on Jupiter ✅" : "still on curve (no Jupiter route yet)"}`
      );
    } catch (err) {
      log.warn(`Could not check migration status: ${err.message}`);
    }
  }

  if (solUsd !== null) {
    const claimedUsd = claimedSol * solUsd;
    log.info(`Rewards this cycle: ${formatSol(claimedSol)} (${formatUsd(claimedUsd)}).`);
  } else {
    log.info(`Rewards this cycle: ${formatSol(claimedSol)} (USD estimate unavailable).`);
  }

  const guard = evaluatePriceGuard(priceSignals, priceGuardMode, maxPriceDeviationPct);
  if (!guard.ok) {
    log.warn(`Buyback paused by safety check: ${guard.reason}.`);
  } else {
    log.ok(`Safety check passed: ${guard.reason}.`);
  }

  if (guard.ok) {
    if (!ataReady) {
      log.warn("Buyback skipped: wallet token account is not ready yet.");
    } else {
      const reserveLamports = minSolKeep + buyFeeBuffer;
      const maxSpendable = balanceAfter - reserveLamports;
      let spendLamports = maxSpendable;
      if (spendLamports < 0n) spendLamports = 0n;
      const minBuyLamports = parseSolToLamports(String(minBuySol));
      const targetSplitBuys = Math.max(1, Number(buySplitCount ?? 1));

      log.info(
        `Buyback budget: can spend ${lamportsToSolString(spendLamports)} SOL after keeping ${lamportsToSolString(reserveLamports)} SOL reserved.`
      );

      if (spendLamports >= minBuyLamports && spendLamports > 0n) {
        let splitBuys = targetSplitBuys;
        while (splitBuys > 1 && spendLamports / BigInt(splitBuys) < minBuyLamports) {
          splitBuys -= 1;
        }
        if (splitBuys < targetSplitBuys) {
          log.warn(
            `Wallet size is too small for ${targetSplitBuys} safe split buys with your minimum order. Using ${splitBuys} split buy${splitBuys === 1 ? "" : "s"} this cycle.`
          );
        }

        const plannedChunks = splitLamports(spendLamports, splitBuys);
        log.info(
          `Buyback plan: ${plannedChunks.length} split buy${plannedChunks.length === 1 ? "" : "s"}, total target spend ${lamportsToSolString(spendLamports)} SOL.`
        );

        const backoffSteps = [
          0n,
          200000n,  // 0.0002 SOL
          500000n,  // 0.0005 SOL
          1000000n, // 0.001 SOL
          2000000n, // 0.002 SOL
        ];
        let warnedBonding = false;
        let abortBuys = false;
        let filledBuys = 0;
        let totalSpentLamports = 0n;

        for (let splitIndex = 0; splitIndex < plannedChunks.length; splitIndex += 1) {
          if (abortBuys) break;

          const refreshedBalance = await rpcPool.withRetry(
            (conn) => conn.getBalance(keypair.publicKey, "confirmed"),
            "getBalance"
          );
          balanceAfter = BigInt(refreshedBalance);
          let availableNow = balanceAfter - reserveLamports;
          if (availableNow <= 0n) {
            log.warn("Stopping split buys: only reserve SOL remains.");
            break;
          }

          let chunkLamports = plannedChunks[splitIndex];
          if (chunkLamports > availableNow) {
            log.warn(`Split buy ${splitIndex + 1}: trimming order to stay above reserve.`);
            chunkLamports = availableNow;
          }
          if (chunkLamports < minBuyLamports) {
            log.warn(
              `Split buy ${splitIndex + 1}: order dropped below your minimum size (${minBuySol} SOL). Skipping this split.`
            );
            continue;
          }

          let chunkFilled = false;
          for (let i = 0; i < backoffSteps.length; i += 1) {
            const reduceBy = backoffSteps[i];
            const adjusted = chunkLamports - reduceBy;
            if (adjusted <= 0n || adjusted < minBuyLamports) continue;
            const amountSol = lamportsToSolString(adjusted);

            try {
              let sig;
              const useJupiter = buyRoute === "jupiter" || (buyRoute === "auto" && state.bondingComplete);
              log.info(
                `Split buy ${splitIndex + 1}/${plannedChunks.length}, try ${i + 1}/${backoffSteps.length}: ${amountSol} SOL via ${useJupiter ? "Jupiter" : "Pump"}${reduceBy > 0n ? ` (reduced by ${lamportsToSolString(reduceBy)} SOL)` : ""}`
              );

              if (useJupiter) {
                sig = await buyViaJupiter({
                  rpcPool,
                  keypair,
                  mint,
                  inLamports: adjusted,
                  slippagePct: slippage,
                  jupiterApiKey,
                  priorityFeeLamports,
                });
                const buySol = Number(adjusted) / 1_000_000_000;
                const buyUsd = solUsd !== null ? buySol * solUsd : null;
                log.ok(`Split buy filled via Jupiter: ${formatSol(buySol)} (${formatUsd(buyUsd)}).`);
                log.tx("Jupiter Tx", sig);
              } else {
                sig = await sendPumpPortalTx(rpcPool, keypair, {
                  publicKey: keypair.publicKey.toBase58(),
                  action: "buy",
                  mint: mint.toBase58(),
                  denominatedInSol: "true",
                  amount: amountSol,
                  slippage,
                  priorityFee,
                  pool,
                });
                const buySol = Number(adjusted) / 1_000_000_000;
                const buyUsd = solUsd !== null ? buySol * solUsd : null;
                log.ok(`Split buy filled via Pump: ${formatSol(buySol)} (${formatUsd(buyUsd)}).`);
                log.tx("Pump Tx", sig);
              }

              chunkFilled = true;
              filledBuys += 1;
              totalSpentLamports += adjusted;
              break;
            } catch (err) {
              const msg = err.message ?? String(err);
              const isPumpBadRequest = msg.includes("PumpPortal error 400");
              const isBondingComplete =
                msg.includes("BondingCurveComplete") ||
                msg.includes("custom program error: 0x1775") ||
                msg.includes("Error Code: BondingCurveComplete");
              if (isBondingComplete) {
                state.bondingComplete = true;
                if (buyRoute === "pump") {
                  if (!warnedBonding) {
                    log.warn("Migration detected, but buy route is locked to Pump, so split buys are stopping.");
                    warnedBonding = true;
                  }
                  abortBuys = true;
                  break;
                }
                if (!warnedBonding) {
                  log.warn("Migration detected: switching split buys to Jupiter.");
                  warnedBonding = true;
                }
                continue;
              }
              if (isPumpBadRequest) {
                if (buyRoute !== "pump") {
                  state.bondingComplete = true;
                  if (!warnedBonding) {
                    log.warn("Pump rejected this order. Falling back to Jupiter.");
                    warnedBonding = true;
                  }
                  continue;
                }
              }
              if (msg.includes("Jupiter")) {
                log.warn(`Jupiter split-buy attempt failed: ${msg}`);
              }
              const noRoute =
                msg.includes("no route") ||
                msg.includes("Jupiter quote returned no route") ||
                msg.includes("Jupiter swap returned no transaction");
              if (noRoute) {
                log.warn(`No route for split buy ${splitIndex + 1} at this size right now.`);
                break;
              }
              const isInsufficient =
                msg.includes("insufficient") ||
                msg.includes("Transaction results in an account") ||
                msg.includes("custom program error: 0x1");
              if (isInsufficient) {
                log.warn("Split buys stopped: not enough SOL after fees/reserve.");
                abortBuys = true;
                break;
              }
              log.err(`Split buy failed with non-retryable error: ${msg}`);
              break;
            }
          }

          if (!chunkFilled) {
            log.warn(`Split buy ${splitIndex + 1} did not fill.`);
          }
        }

        if (filledBuys > 0) {
          const spentSol = Number(totalSpentLamports) / 1_000_000_000;
          const spentUsd = solUsd !== null ? spentSol * solUsd : null;
          log.ok(
            `Buyback summary: ${filledBuys}/${plannedChunks.length} split buys filled, total spent ${formatSol(spentSol)} (${formatUsd(spentUsd)}).`
          );
        } else {
          log.warn("Buyback summary: no split buys filled this cycle.");
        }
      } else {
        if (spendLamports < minBuyLamports) {
          log.info(
            `Buyback skipped: spendable SOL (${lamportsToSolString(spendLamports)}) is below your minimum order size (${minBuySol} SOL).`
          );
        }
        log.info(
          `Wallet plan: ${lamportsToSolString(balanceAfter)} SOL total, ${lamportsToSolString(minSolKeep)} SOL kept safe, ${lamportsToSolString(buyFeeBuffer)} SOL kept for fees.`
        );
      }
    }
  } else {
    log.info("Buyback stage skipped because the safety check denied this cycle.");
  }

  try {
    const burnResult = await burnAllTokens({
      rpcPool,
      payer: keypair,
      mint,
      pricing: { tokenUsd, solUsd },
    });
    if (burnResult?.burnedTokens !== undefined) {
      if (tokenUsd !== null && solUsd !== null) {
        const burnedUsd = burnResult.burnedTokens * tokenUsd;
        const burnedSol = burnedUsd / solUsd;
        log.info(`Burn value estimate: ${formatSol(burnedSol)} (${formatUsd(burnedUsd)}).`);
      }
    }
    const cycleMs = Date.now() - cycleStartedAt;
    log.ok(`Cycle #${cycleNo} complete in ${formatSeconds(cycleMs)}s.`);
  } catch (err) {
    log.err(`Burn (post-buy) failed: ${err.message}`);
    const cycleMs = Date.now() - cycleStartedAt;
    log.warn(`Cycle #${cycleNo} ended with burn error after ${formatSeconds(cycleMs)}s.`);
  }
  } catch (err) {
    const cycleMs = Date.now() - cycleStartedAt;
    log.err(`Cycle #${cycleNo} failed after ${formatSeconds(cycleMs)}s: ${err.message ?? String(err)}`);
  } finally {
    try {
      await logRemainingSupplyHeadline(config.rpcPool, config.mint, "Cycle-End Remaining Supply");
      const latestSol = BigInt(
        await config.rpcPool.withRetry(
          (conn) => conn.getBalance(config.keypair.publicKey, "confirmed"),
          "getBalance"
        )
      );
      const latestPositions = await getOwnerTokenPositions(config.rpcPool, config.keypair.publicKey);
      state.lastSnapshot = buildAssetSnapshot(latestSol, latestPositions, config.mint.toBase58());
    } catch (err) {
      log.warn(`Could not refresh deposit tracker snapshot: ${err?.message ?? String(err)}`);
    }
  }
}

async function main() {
  process.on("unhandledRejection", (reason) => {
    const msg = reason?.message ?? String(reason);
    log.err(`Unhandled promise rejection: ${msg}`);
  });
  process.on("uncaughtException", (err) => {
    const msg = err?.message ?? String(err);
    log.err(`Uncaught exception: ${msg}`);
  });

  const rpcUrls = parseRpcUrls(process.env);
  const secret = requireEnv("WALLET_SECRET_KEY_BASE58");
  const mintStr = requireEnv("MINT");

  const slippage = Number(process.env.SLIPPAGE ?? "1");
  const priorityFee = Number(process.env.PRIORITY_FEE ?? "0.0001");
  const pool = process.env.POOL ?? "pump";
  const claimPool = process.env.CLAIM_POOL ?? null;
  const claimMethod = (process.env.CLAIM_METHOD ?? "auto").toLowerCase();
  const claimRefSig = process.env.CLAIM_REF_SIG ?? "";
  const claimTreasuryAddress = process.env.CLAIM_TREASURY_ADDRESS ?? "";
  const claimTreasuryBps = Number(process.env.CLAIM_TREASURY_BPS ?? "0");
  const developerTreasuryAddress = process.env.DEVELOPER_TREASURY_ADDRESS ?? "";
  const developerTreasuryBps = Number(process.env.DEVELOPER_TREASURY_BPS ?? "0");
  const pumpPortalApiKey = process.env.PUMPPORTAL_API_KEY ?? "";
  const buyRoute = (process.env.BUY_ROUTE ?? "auto").toLowerCase();
  const intervalMs = Number(process.env.INTERVAL_MS ?? "180000");
  const minSolKeep = parseSolToLamports(process.env.MIN_SOL_KEEP ?? "0");
  const buyFeeBuffer = parseSolToLamports(process.env.BUY_SOL_FEE_BUFFER ?? "0");
  const effectiveMinKeep = minSolKeep;
  const claimMinSol = Number(process.env.CLAIM_MIN_SOL ?? "0");
  const claimCooldownCycles = Number(process.env.CLAIM_COOLDOWN_CYCLES ?? "3");
  const minBuySol = Number(process.env.MIN_BUY_SOL ?? "0.0005");
  const priceGuardMode = (process.env.PRICE_GUARD_MODE ?? "auto").toLowerCase();
  const maxPriceDeviationPct = Number(process.env.MAX_PRICE_DEVIATION_PCT ?? "15");
  const quoteSolLamports = Number(process.env.PRICE_QUOTE_SOL_LAMPORTS ?? "100000000");
  const birdeyeApiKey = process.env.BIRDEYE_API_KEY ?? "";
  const jupiterApiKey = process.env.JUPITER_API_KEY ?? "";
  const autoConvertIncoming = (process.env.AUTO_CONVERT_INCOMING_TOKENS ?? "1") !== "0";
  const rawBuySplitCount = Number(process.env.BUY_SPLIT_COUNT ?? "5");
  const buySplitCount =
    Number.isFinite(rawBuySplitCount) && rawBuySplitCount > 0
      ? Math.floor(rawBuySplitCount)
      : 5;

  const keypair = Keypair.fromSecretKey(parseSecretKey(secret));
  const mint = new PublicKey(mintStr);
  const rpcPool = new RpcPool(rpcUrls, "confirmed");
  log.section("Boot Sequence");
  log.info(`${LOG_BRAND} engine initialized.`);
  log.info(`Wallet: ${keypair.publicKey.toBase58()} (${shortAddress(keypair.publicKey.toBase58(), 6, 6)})`);
  log.info(`Target mint: ${mint.toBase58()} (${shortAddress(mint.toBase58(), 6, 6)})`);
  log.info(`RPC pool: ${rpcUrls.length} endpoint(s), active=${redactApiKey(rpcPool.currentUrl())}`);
  log.info(
    `Config snapshot: interval=${intervalMs}ms, buyRoute=${buyRoute}, splitBuys=${buySplitCount}, slippage=${slippage}%, priorityFee=${priorityFee}`
  );
  log.info(
    `Capital controls: keep=${lamportsToSolString(minSolKeep)} SOL, buyFeeBuffer=${lamportsToSolString(buyFeeBuffer)} SOL, minBuy=${minBuySol} SOL`
  );
  log.info(
    `Incoming token auto-swap: ${autoConvertIncoming ? "ON (will auto-convert to target token)" : "OFF"}`
  );

  try {
    const bootSol = BigInt(
      await rpcPool.withRetry((conn) => conn.getBalance(keypair.publicKey, "confirmed"), "getBalance")
    );
    const bootPositions = await getOwnerTokenPositions(rpcPool, keypair.publicKey);
    state.lastSnapshot = buildAssetSnapshot(bootSol, bootPositions, mint.toBase58());
    log.info("Deposit tracker baseline captured.");
  } catch (err) {
    log.warn(`Could not initialize deposit tracker baseline: ${err?.message ?? String(err)}`);
  }

  try {
    await runOnce({
      rpcPool,
      keypair,
      mint,
    slippage,
    priorityFee,
    pool,
    claimPool,
    claimMethod,
    claimRefSig,
    claimTreasuryAddress,
    claimTreasuryBps,
    developerTreasuryAddress,
    developerTreasuryBps,
    pumpPortalApiKey,
    buyRoute,
    minSolKeep: effectiveMinKeep,
    buyFeeBuffer,
    minBuySol,
    claimMinSol,
    claimCooldownCycles,
    priceGuardMode,
    maxPriceDeviationPct,
    quoteSolLamports,
    birdeyeApiKey,
    jupiterApiKey,
    autoConvertIncoming,
    buySplitCount,
  });
  } catch (err) {
    log.err(`Initial cycle failed: ${err.message ?? String(err)}`);
  }

  while (true) {
    const nextAt = new Date(Date.now() + intervalMs);
    log.info(`⏳ Next cycle in ${Math.round(intervalMs / 1000)}s (ETA ${nextAt.toLocaleTimeString()}).`);
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      await runOnce({
        rpcPool,
        keypair,
        mint,
        slippage,
        priorityFee,
      pool,
      claimPool,
      claimMethod,
      claimRefSig,
      claimTreasuryAddress,
      claimTreasuryBps,
      developerTreasuryAddress,
      developerTreasuryBps,
      pumpPortalApiKey,
      buyRoute,
        minSolKeep: effectiveMinKeep,
        buyFeeBuffer,
        minBuySol,
        claimMinSol,
        claimCooldownCycles,
        priceGuardMode,
        maxPriceDeviationPct,
        quoteSolLamports,
        birdeyeApiKey,
        jupiterApiKey,
        autoConvertIncoming,
        buySplitCount,
      });
    } catch (err) {
      log.err(`Scheduled cycle failed: ${err.message}`);
    }
  }
}

main().catch((err) => {
  log.err(err.message ?? String(err));
  process.exit(1);
});
