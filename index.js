'use strict'
const cote = require('cote')({statusLogsEnabled:false});
const u = require('@elife/utils');
const fs = require('fs');
const path = require('path');
const StellarSdk = require('stellar-sdk');

const LIVE_HORIZON = "https://horizon.stellar.org/"
const TEST_HORIZON = "https://horizon-testnet.stellar.org/"

const EVER_ISSUER = process.env.EVER_ISSUER || 'GBHXZED3Z6FVCFLUISGP47KYA6FSEWINDJVUJHEUW2Z6OX3ON243335S'

/*      understand/
 * This is the main entry point where we start.
 *
 *      outcome/
 * Start our microservice and register with the communication manager.
 */
function main() {
    startMicroservice()
    registerWithCommMgr()
};

const msKey = 'everlife-transfer-ever';
const commMgrClient = new cote.Requester({
    name: 'elife-transfer-ever -> CommMgr',
    key: 'everlife-communication-svc',
});

const stellarClient = new cote.Requester({
    name: 'elife-transfer-ever -> Stellar',
    key: 'everlife-stellar-svc',
})

function sendReply(msg, req) {
    req.type = 'reply'
    req.msg = msg
    commMgrClient.send(req, (err) => {
        if(err) u.showErr(err)
    })
}

function registerWithCommMgr() {
    commMgrClient.send({
        type: 'register-msg-handler',
        mskey: msKey,
        mstype: 'msg',
        mshelp: [
            { cmd: '/transfer_ever', txt: 'transfer ever' }
        ],
    }, (err) => {
        if(err) u.showErr(err)
    })
}

function getServer() {
    if(process.env.ELIFE_STELLAR_HORIZON === "test") {
        return new StellarSdk.Server(TEST_HORIZON)
    } else {
        return new StellarSdk.Server(LIVE_HORIZON)
    }
}

function getNetworkPassphrase() {
    if(process.env.ELIFE_STELLAR_HORIZON === "test") {
        return StellarSdk.Networks.TESTNET
    } else {
        return StellarSdk.Networks.PUBLIC
    }
}

function getUserKeys(ctx) {
    if(!ctx.user.secret) return null
    try {
        return StellarSdk.Keypair.fromSecret(ctx.user.secret);
    } catch(err) {
        return null
    }
}

function loadAvatarAccount(ctx, req, cb) {
    const server = getServer()
    ctx.avatar.acc = null
    server.loadAccount(ctx.avatar.wallet.pub)
        .then(acc => {
            ctx.avatar.acc = acc
            cb()
        })
        .catch(cb)
}

function showBalance(account) {
    let msg = ''
    let balances = account.balances;
    if (balances.length) {
        msg += 'Available balance in my wallet is \n'
        for (let b of balances) {
            if (b.asset_code) {
                msg += `${b.asset_code.toUpperCase()}:\t${b.balance}\n`
            } else if (b.asset_type && b.asset_type === 'native') {
                msg += `XLM:\t${b.balance}\n`
            } else if (b.asset_type) {
                msg += `${b.asset_type.toUpperCase()}:\t${b.balance}\n`
            }
        }
    }

    return msg;
}

function checkBalanceAndGetIssuer(account, code, amount, req) {
    let balances = account.balances;
    if (balances.length) {
        for (let b of balances) {
            if (code.toLowerCase() === 'native') {
                if(b.asset_type && b.asset_type.toLowerCase() === code.toLowerCase() && parseFloat(b.balance) >= parseFloat(amount)) {
                    if (b.asset_issuer) return b.asset_issuer
                    else return ""
                }
            } else {
                if(b.asset_code && b.asset_code.toLowerCase() === code.toLowerCase() && parseFloat(b.balance) >= parseFloat(amount)) {
                    if (b.asset_issuer) return b.asset_issuer
                    else return ""
                }
            }
        }
    }

    return null
}

function loadUserAccount(ctx, req, cb) {
    const server = getServer()
    const kp = getUserKeys(ctx)
    if(!kp) return cb("Error: failed getting user keys");
    server.loadAccount(kp.publicKey())
        .then(acc => {
            let issuer = checkBalanceAndGetIssuer(acc, ctx.asset.code, ctx.asset.amount, req);
            if ( issuer !== null) {
                ctx.user.acc = acc;
                ctx.asset.issuer = issuer;
                cb()
            } else {
                cb("Error: Account doesn't have enough balance");
            }
        })
        .catch(err => {
            cb(err)
        })
}

function makePayment(ctx, req, cb) {
    const destination = ctx.avatar.wallet.pub
    if(!destination) return cb("Error: Wallet not found")

    const acc = ctx.avatar.acc
    if(!acc) return cb("Error: User account not found")

    const kp = getUserKeys(ctx)
    if(!kp) return cb("Error: Failed getting user Keys")

    const destAcc = ctx.avatar.wallet._kp

    const server = getServer()

    try {
        let sendAsset = null
        let issuer = ctx.asset.issuer !== "" ? ctx.asset.issuer : EVER_ISSUER;
        if (ctx.asset.code.toLowerCase() === 'native') sendAsset = StellarSdk.Asset.native()
        else sendAsset = new StellarSdk.Asset(ctx.asset.code.toUpperCase(), issuer)

        const destAsset = new StellarSdk.Asset('EVER', EVER_ISSUER)
        const op = {
            sendAsset,
            sendMax: ctx.asset.amount,
            destination,
            destAsset,
            destAmount: ctx.asset.amount,
        }
        server.fetchBaseFee()
            .then(fee => {
                const txn = new StellarSdk.TransactionBuilder(acc, { fee, networkPassphrase: getNetworkPassphrase() })
                    .addOperation(StellarSdk.Operation.pathPaymentStrictReceive(op))
                    .setTimeout(30)
                    .build();
                txn.sign(ctx.avatar.wallet._kp);
                server.submitTransaction(txn)
                    .then(() => {
                        loadAvatarAccount(ctx, req, err => {
                            if (err) cb(err)
                            else cb()
                        });
                    })
                    .catch(err => {
                        sendReply(`Err: ${JSON.stringify(err)} ${err}`, req);
                        cb(err)
                    })
            })
            .catch(err => {
                sendReply(`Err catch: ${JSON.stringify(err)} ${err}`, req);
                cb(err)
            })
    } catch (err) {
        sendReply(`Err catch: ${JSON.stringify(err)} ${err}`, req);
        cb(err)
    }
}

function enableEverTrustline(ctx, req, cb) {
    const acc = ctx.avatar.acc;
    if(!acc) return cb("Error: Invalid avatar account");

    function has_ever_1(balances) {
        if(!balances) return false
        for(let i = 0;i < balances.length;i++) {
            const b = balances[i]
            if(b.asset_code === "EVER" && b.asset_issuer === EVER_ISSUER) return true
        }
        return false
    }

    if(has_ever_1(acc.balances)) return cb()

    const asset = new StellarSdk.Asset("EVER", EVER_ISSUER)
    const server = getServer()

    server.fetchBaseFee()
        .then(fee => {
            const txn = new StellarSdk.TransactionBuilder(acc, { fee, networkPassphrase: getNetworkPassphrase() })
                .addOperation(StellarSdk.Operation.changeTrust({ asset }))
                .setTimeout(30)
                .build()
            txn.sign(ctx.avatar.wallet._kp);
            server.submitTransaction(txn)
                .then(() => {
                    loadAvatarAccount(ctx, req, err => {
                        if (err) cb(err)
                        else cb()
                    });
                })
                .catch(err => {
                    cb(err);
                });

        })
        .catch(err => {
            cb(err);
        });
}

function activateAvatarAccount(ctx, req, cb) {
    if(ctx.avatar.acc) return cb()

    const dest = ctx.avatar.wallet.pub
    if(!dest) return cb("Error: Wallet not found")

    const acc = ctx.user.acc
    if(!acc) return cb("Error: User account not found")

    const kp = getUserKeys(ctx)
    if(!kp) return cb("Error: Failed getting user Keys")

    const server = getServer()

    const op = {
        destination: dest,
        startingBalance: "5",
    }
    server.fetchBaseFee()
        .then(fee => {
            const txn = new StellarSdk.TransactionBuilder(acc, { fee, networkPassphrase: getNetworkPassphrase() })
                .addOperation(StellarSdk.Operation.createAccount(op))
                .setTimeout(30)
                .build()
            txn.sign(kp)
            server.submitTransaction(txn)
                .then(() => {
                    loadAvatarAccount(ctx, req, err => {
                        if (err) cb(err)
                        else cb()
                    });
                })
                .catch(cb)
        })
        .catch(cb)
}

function readAvatarWallet(ctx, req, cb) {
    const nucleus = path.join(u.ssbLoc(), 'nucleus');
    fs.readFile(nucleus, 'utf8', (err, data) => {
        if(err) {
            cb(err)
        }
        try {
            data = data.replace(/\s*#[^\n]*/g, "")
            data = JSON.parse(data);
            if(data.stellar && data.stellar.publicKey && data.stellar.secretKey) {
                let wallet = {
                    pub: data.stellar.publicKey,
                    _kp: StellarSdk.Keypair.fromSecret(data.stellar.secretKey),
                };
                ctx.avatar.wallet = wallet;
                cb();
            } else {
                cb('Error: Stellar Account not found.')
            }
        } catch(err) {
            cb(err)
        }
    })
}

function loadAvatarAccountInit(ctx, req, cb) {
    readAvatarWallet(ctx, req, err =>  {
        if(err) cb(err)
        else {
            loadAvatarAccount(ctx, req, err => {
                if (err) cb(err)
                else cb()
            });
        }
    })
}

function start(msg, req, cb) {
    let [command, secretKey, amount, asset] = msg.split(' ');

    if (parseFloat(amount) < 100) cb('Error: Minimum balance should be 100')

    if (asset.toLowerCase() === 'xlm') {
        asset =  'native'
    }

    let ctx = {
        avatar: {
            wallet: null,
            acc: null,
        },
        user: {
            secret: secretKey,
            acc: null
        },
        asset: {
            amount: amount,
            code: asset,
            issuer: null
        }
    }

    loadUserAccount(ctx, req, err => {
        if (err) cb(err);
        else {
            loadAvatarAccountInit(ctx, req, err => {
                if (err && err.name === "NotFoundError") {
                    sendReply('Hold on let me activate the account by funding it with 5 XLM.', req);
                    activateAvatarAccount(ctx, req, err => {
                        if(err) cb(err)
                        else {
                            sendReply(`Activated successfully with 5 XLM.\nNext up I'm going to use some XLM to buy EVER from market to fund this stellar account with ${amount}EVER. The minimum balance is 100 EVER.`, req);
                            enableEverTrustline(ctx, req, err => {
                                if (err) cb(err)
                                else {
                                    makePayment(ctx, req, err => {
                                        if (err) cb(err)
                                        else {
                                            sendReply('Funding Successfull.', req);
                                            sendReply(showBalance(ctx.avatar.acc), req);
                                            cb();
                                        }
                                    })
                                }
                            })
                        }
                    })
                } else {
                    makePayment(ctx, req, err => {
                        if(err) cb(err)
                        else cb()
                    })
                }
            })
        }
    })

}

function startMicroservice() {
    const svc = new cote.Responder({
        name: 'Everlife transfer ever',
        key: msKey,
    });
    svc.on('msg', (req, cb) => {
        let msg = req.msg.trim()
        if (msg.startsWith('/activate_stellar_account')) {
            cb(null, true);
            if (msg.split(' ').length == 4) {
                sendReply("Please wait while I am transferring the amount.", req);
                start(msg, req, err => {
                    if (err) u.showError(err);
                });
            } else {
                sendReply("Error: Please check the parameters. ( /activate_stellar_account <SECRET_KEY> <AMT> <ASSET> )", req);
            }
        } else {
            return cb();
        }
    })
}

main();
