const ethers = require("ethers");
const axios = require("axios");
const dotenv = require("dotenv");
const { Web3 } = require("web3");
dotenv.config();
const fs = require("fs");
const { BigNumber, utils } = require("ethers");

const UNISWAPV3ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";

const QUOTEV3 = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";

const INIT_TOKENS = {
    WETH: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
};
const PROVIDER = new ethers.providers.JsonRpcProvider(`https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_MAINNET_API}`);

const WALLET = new ethers.Wallet(process.env.PRIVATE_KEY);

const UNISWAPROUTERV3ABI = require("./UniswapV3RouterABI.json");
const QUOTERV3ABI = require("./Quoter.json");

const SIGNER = WALLET.connect(PROVIDER);

const uniswapV3 = new ethers.Contract(UNISWAPV3ROUTER, UNISWAPROUTERV3ABI, SIGNER);

const quoterv3 = new ethers.Contract(QUOTEV3, QUOTERV3ABI, SIGNER);

const web3 = new Web3(`https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_MAINNET_API}`);

const uniswap = new web3.eth.Contract(UNISWAPROUTERV3ABI, UNISWAPV3ROUTER);

const sem = require("semaphore")(1);

// return

let pairMap = {};
let symbolIdMap = {};
let idSymbolMap = {};

const parseTokenData = (token) => {
    symbolIdMap[token.symbol] = token.id;
    idSymbolMap[token.id] = token.symbol;
};

const parseData = (pairs) => {
    for (let i = 0; i < pairs.length; i += 1) {
        const { id: pairID, feeTier, token0Price, token1Price, token0, token1, volumeUSD, untrackedVolumeUSD, poolDayData } = pairs[i];

        if (poolDayData.length == 0) continue;
        if (poolDayData[0].tvlUSD < 10000) continue;
        if (poolDayData[0].volumeUSD < 10000) continue;

        parseTokenData(token0);
        parseTokenData(token1);
        const t0 = pairs[i].token0;
        const t1 = pairs[i].token1;
        if (pairMap[t0.id] === undefined) {
            pairMap[t0.id] = {
                symbol: idSymbolMap[t0.id],
            };
        }
        if (pairMap[t0.id][t1.id] === undefined) {
            pairMap[t0.id][t1.id] = {
                symbol: `${idSymbolMap[t1.id]}  ${volumeUSD} ${untrackedVolumeUSD}`,
            };
        }
        if (pairMap[t1.id] === undefined) {
            pairMap[t1.id] = {
                symbol: idSymbolMap[t1.id],
            };
        }
        if (pairMap[t1.id][t0.id] === undefined) {
            pairMap[t1.id][t0.id] = {
                symbol: `${idSymbolMap[t0.id]}  ${volumeUSD} ${untrackedVolumeUSD}`,
            };
        }

        if (pairMap[t0.id][t1.id][feeTier] === undefined) {
            pairMap[t0.id][t1.id][feeTier] = { pairId: pairID, feeTier: feeTier, price: token0Price };
        }

        if (pairMap[t1.id][t0.id][feeTier] === undefined) {
            pairMap[t1.id][t0.id][feeTier] = { pairId: pairID, feeTier: feeTier, price: token1Price };
        }
    }
};

const fetchUniswapData = async () => {
    const data1 = {
        query: `{
            pools(first: 1000, orderBy: volumeUSD, orderDirection: desc){
              id
              token0 {
                id
                name
                symbol
              }
              token1 {
                id
                name
                symbol
              }token1Price  token0Price feeTier
              liquidity  volumeUSD
              poolDayData(first: 10, orderBy: date, where: {
                date_gt: ${parseInt(Date.now() / 1000) - 24 * 60 * 60}
                } ){
                  tvlUSD
                  volumeUSD
                }}
         }`,
    };

    const data2 = {
        query: `{
            pools(first: 1000, skip:1000, orderBy: volumeUSD, orderDirection: desc){
              id
              token0 {
                id
                name
                symbol
              }
              token1 {
                id
                name
                symbol
              }token1Price  token0Price feeTier
              liquidity  volumeUSD
              poolDayData(first: 10, orderBy: date, where: {
                date_gt: ${parseInt(Date.now() / 1000) - 24 * 60 * 60}
                } ){
                  tvlUSD
                  volumeUSD
                }}
         }`,
    };

    const response1 = axios({ method: "POST", data: data1, url: "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3" });
    const response2 = axios({ method: "POST", data: data2, url: "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3" });

    const [resp1, resp2] = await Promise.all([response1, response2]);

    let pairs = [...resp1.data.data.pools, ...resp2.data.data.pools];

    const finalPair = pairs.filter((pair) => pair.liquidity >= "1000000000000000000");

    return finalPair;
};

const threeWayArbitrage = (initToken, thresh) => {
    const opps = [];
    for (const i of Object.keys(pairMap[initToken])) {
        if (i === "symbol") continue;

        for (const a of Object.keys(pairMap[i][initToken])) {
            if (a === "symbol") continue;

            const price1 = pairMap[i][initToken][a].price;

            for (const j of Object.keys(pairMap[i])) {
                if (j === "symbol") continue;
                if (j === initToken) continue;

                for (const b of Object.keys(pairMap[j][i])) {
                    if (b === "symbol") continue;

                    const price2 = pairMap[j][i][b].price;

                    if (pairMap[initToken][j] !== undefined) {
                        for (const c of Object.keys(pairMap[initToken][j])) {
                            if (c === "symbol") continue;

                            const price3 = pairMap[initToken][j][c].price;

                            const price = price1 * price2 * price3;

                            if (price < thresh || price > 1.07) continue;

                            const oppObj = {
                                symbol1: idSymbolMap[initToken],
                                symbol2: idSymbolMap[i],
                                symbol3: idSymbolMap[j],
                                price1,
                                price2,
                                price3,
                                price,
                                symbol1ID: initToken,
                                symbol2ID: i,
                                symbol3ID: j,
                                pairID1: pairMap[i][initToken][a],
                                pairID2: pairMap[j][i][b],
                                pairID3: pairMap[initToken][j][c],
                            };

                            if (price > 2) {
                                console.log("===========================================");

                                console.log("===========================================");
                            }

                            opps.push(oppObj);
                        }
                    }
                }
            }
        }
    }
    return opps;
};

const fourWayArbitrage = (initToken, thresh) => {
    const opps = [];
    for (const i of Object.keys(pairMap[initToken])) {
        if (i === "symbol") continue;

        for (const a of Object.keys(pairMap[i][initToken])) {
            if (a === "symbol") continue;

            const price1 = pairMap[i][initToken][a].price;

            for (const j of Object.keys(pairMap[i])) {
                if (j === "symbol") continue;
                if (j === initToken) continue;

                for (const b of Object.keys(pairMap[j][i])) {
                    if (b === "symbol") continue;

                    const price2 = pairMap[j][i][b].price;

                    for (const k of Object.keys(pairMap[j])) {
                        if (k === "symbol") continue;
                        if (k === initToken || k === i) continue;

                        for (const c of Object.keys(pairMap[k][j])) {
                            if (c === "symbol") continue;

                            const price3 = pairMap[k][j][c].price;

                            if (pairMap[initToken][k] !== undefined) {
                                for (const d of Object.keys(pairMap[initToken][k])) {
                                    if (d === "symbol") continue;

                                    const price4 = pairMap[initToken][k][d].price;

                                    const price = price1 * price2 * price3 * price4;
                                    if (price < thresh || price > 1.07) continue;

                                    const oppObj = {
                                        symbol1: idSymbolMap[initToken],
                                        symbol2: idSymbolMap[i],
                                        symbol3: idSymbolMap[j],
                                        symbol4: idSymbolMap[k],
                                        price1,
                                        price2,
                                        price3,
                                        price4,
                                        price,
                                        symbol1ID: initToken,
                                        symbol2ID: i,
                                        symbol3ID: j,
                                        symbol4ID: k,
                                        pairID1: pairMap[i][initToken][a],
                                        pairID2: pairMap[j][i][b],
                                        pairID3: pairMap[k][j][c],
                                        pairID4: pairMap[initToken][k][d],
                                    };
                                    if (price > 2) {
                                        console.log("===========================================");
                                        console.log("===========================================");
                                    }
                                    opps.push(oppObj);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    return opps;
};

const getArbitrageOpportunities = (initToken, thresh = 1) => {
    console.log("getArbitrageOpportunities", initToken);
    /*
    eth/usdt => eth
    usdt/eth => usdt
        A / WETH

        A / WETH
        B / A
        WETH / B
    */
    const opps = [...threeWayArbitrage(initToken, thresh), ...fourWayArbitrage(initToken, thresh)];

    // const opps = [...threeWayArbitrage(initToken, thresh)]
    opps.sort((a, b) => (a.price > b.price ? -1 : 1));
    return opps;
};

async function binaryBestAmountIn(gasCostWei, amountIn, pathHash) {
    let l = gasCostWei * 10;

    let r = parseInt(amountIn.toString());

    let counter = 6;

    let bestAmountIn = BigNumber.from(0);
    let bestAmountOut = BigNumber.from(0);
    let bestTokenProfit = BigNumber.from(0);

    const amountInMap = {};
    try {
        // console.log({l:utils.formatEther(l),r:utils.formatEther(r)})
        while (l <= r && counter > 0) {
            const amountInArr = [];
            const mid = (l + r) / 2; // (l+r)/2
            const lmid = (l + mid) / 2; // (l+mid)/2
            const rmid = (mid + r) / 2; // (mid+r)/2

            let amountMidPromise;
            if (amountInMap[mid.toString()] !== undefined) {
                amountMidPromise = amountInMap[mid.toString()];
            } else {
                amountMidPromise = await quoterv3.callStatic.quoteExactInput(pathHash, ethers.utils.parseUnits(mid.toString(), "wei"));
            }
            const amountLmidPromise = await quoterv3.callStatic.quoteExactInput(pathHash, ethers.utils.parseUnits(lmid.toString(), "wei"));
            const amountRmidPromise = await quoterv3.callStatic.quoteExactInput(pathHash, ethers.utils.parseUnits(rmid.toString(), "wei"));

            // console.log("DATAAAA")
            // console.log(amountMidPromise , amountLmidPromise , amountRmidPromise)

            amountInArr.push(amountLmidPromise);
            amountInArr.push(amountMidPromise);
            amountInArr.push(amountRmidPromise);

            const [amountLmid, amountMid, amountRmid] = await Promise.all(amountInArr);

            amountInMap[mid.toString()] = amountMid;
            amountInMap[lmid.toString()] = amountLmid;
            amountInMap[rmid.toString()] = amountRmid;

            // return
            const amountLmidOut = amountLmid.toString()[amountLmid.toString().length - 1] - amountLmid.toString()[0];
            const amountMidOut = amountMid.toString()[amountMid.toString().length - 1] - amountMid.toString()[0];
            const amountRmidOut = amountRmid.toString()[amountRmid.toString().length - 1] - amountRmid.toString()[0];

            if (mid > parseInt(bestAmountIn.toString())) {
                bestAmountIn = mid;
                bestAmountOut = amountMid.toString()[amountMid.toString().length - 1];
                bestTokenProfit = amountMidOut;
            }

            if (amountMidOut > amountLmidOut && amountMidOut > amountRmidOut) {
                break;
            }
            if (amountLmidOut >= amountRmidOut) {
                r = mid;
            } else if (amountRmidOut > amountLmidOut) {
                l = mid;
            }
            counter -= 1;
        }
    } catch (err) {
        console.log("getAmountsOut Error:", err);
    }
    return { bestAmountIn, bestAmountOut, bestTokenProfit };
}

// Single Arbitrage
const processArbitrage = async (opp, amountIn, gasPrice) => {
    console.log(opp);
    const to = process.env.WALLET_ADDRESS;
    const path = [];

    for (let i = 1; i < 10; i += 1) {
        let key = `symbol${i}ID`;
        if (opp[key] === undefined) {
            break;
        }
        path.push(opp[key]);
    }
    path.push(opp["symbol1ID"]);

    // console.log("PATH", path)
    // return

    var pathHash;
    if (path.length == 5) {
        pathHash = web3.utils.encodePacked(
            { value: opp.symbol1ID, type: "address" },
            { value: opp.pairID1.feeTier, type: "uint24" },
            { value: opp.symbol2ID, type: "address" },
            { value: opp.pairID2.feeTier, type: "uint24" },
            { value: opp.symbol3ID, type: "address" },
            { value: opp.pairID3.feeTier, type: "uint24" },
            { value: opp.symbol4ID, type: "address" },
            { value: opp.pairID4.feeTier, type: "uint24" },
            { value: opp.symbol1ID, type: "address" }
        );
    } else if (path.length == 4) {
        pathHash = web3.utils.encodePacked(
            { value: opp.symbol1ID, type: "address" },
            { value: opp.pairID1.feeTier, type: "uint24" },
            { value: opp.symbol2ID, type: "address" },
            { value: opp.pairID2.feeTier, type: "uint24" },
            { value: opp.symbol3ID, type: "address" },
            { value: opp.pairID3.feeTier, type: "uint24" },
            { value: opp.symbol1ID, type: "address" }
        );
    }

    console.log(pathHash);

    console.log(opp.symbol1ID, amountIn.toString());

    try {
        if (path.length == 5) {
            var amt1 = await quoterv3.callStatic.quoteExactInputSingle(opp.symbol1ID, opp.symbol2ID, opp.pairID1.feeTier, amountIn.toString(), 0);

            console.log(opp.symbol2, parseInt(amt1.toString()), opp.pairID1.feeTier);

            var amt2 = await quoterv3.callStatic.quoteExactInputSingle(opp.symbol2ID, opp.symbol3ID, opp.pairID2.feeTier, "4824030000", 0);

            console.log(opp.symbol3, parseInt(amt2.toString()), opp.pairID2.feeTier);

            var amt3 = await quoterv3.callStatic.quoteExactInputSingle(opp.symbol3ID, opp.symbol4ID, opp.pairID3.feeTier, amt2.toString(), 0);

            console.log(opp.symbol4, parseInt(amt3.toString()), opp.pairID3.feeTier);

            var amt4 = await quoterv3.callStatic.quoteExactInputSingle(opp.symbol4ID, opp.symbol1ID, opp.pairID4.feeTier, amt3.toString(), 0);

            amt4 = parseInt(amt4.toString()) / 1e18;

            console.log(opp.symbol1, amt4, opp.pairID4.feeTier);

            var amt = await quoterv3.callStatic.quoteExactInput(pathHash, amountIn.toString());
            console.log("final amount", parseInt(amt.toString()));
        } else if (path.length == 4) {
            var amt1 = await quoterv3.callStatic.quoteExactInputSingle(opp.symbol1ID, opp.symbol2ID, opp.pairID1.feeTier, amountIn.toString(), 0);

            console.log(opp.symbol2, parseInt(amt1.toString()), opp.pairID1.feeTier);

            var amt2 = await quoterv3.callStatic.quoteExactInputSingle(opp.symbol2ID, opp.symbol3ID, opp.pairID2.feeTier, amt1.toString(), 0);

            console.log(opp.symbol3, parseInt(amt2.toString()), opp.pairID2.feeTier);

            var amt3 = await quoterv3.callStatic.quoteExactInputSingle(opp.symbol3ID, opp.symbol1ID, opp.pairID3.feeTier, amt2.toString(), 0);

            amt3 = parseInt(amt3.toString()) / 1e18;

            console.log(opp.symbol1, amt4, opp.pairID3.feeTier);

            var amt = await quoterv3.callStatic.quoteExactInput(pathHash, amountIn.toString());
            console.log("final amount", parseInt(amt.toString()));
        }
    } catch (err) {
        return;
    }
    let gasEstimate;
    try {
        gasEstimate = await uniswap.methods
            .exactInput([pathHash, to, amountIn.toString(), amountIn.toString()])
            .estimateGas({ from: process.env.WALLET_ADDRESS });

        console.log("gasEstimate", gasEstimate);
    } catch (err) {
        console.log("estimateGas Error:", err);
        gasEstimate = 500000;
        return;
    }

    gasCostWei = parseInt(gasEstimate.toString()) * parseInt(gasPrice.gasPrice.toString()); // in wei

    const { bestAmountIn, bestAmountOut, bestTokenProfit } = await binaryBestAmountIn(gasCostWei, amountIn, pathHash);

    amountIn = bestAmountIn;
    amountOut = bestAmountOut;
    const tokenProfit = bestTokenProfit;

    const finalProfit = parseInt(tokenProfit.toString()) - gasCostWei;
    const minAmountOut = parseInt(amountIn.toString()) + gasCostWei;

    if (tokenProfit === undefined || parseInt(tokenProfit.toString()) < 0 || finalProfit < 0) {
        console.log("no profit ", { finalProfit: finalProfit / 1e18 });
        return;
    }

    console.log({
        gasPrice: gasPrice.gasPrice,
        gasEstimate: gasEstimate,
        gasCost: gasCostWei,
        finalProfit: finalProfit,
        amountIn: amountIn,
        amountOut: bestAmountOut,
        minAmountOut: minAmountOut,
        path: pathHash,
    });

    if (finalProfit < ethers.utils.parseUnits("0.01", "ether")) {
        console.log("=> Low Profit");
        return;
    }
    console.log(opp);

    console.log("****** WILL EXEC ********");

    const profit = await execTrade(
        {
            pathHash,
            amountIn,
            to,
            gasPrice,
            gasEstimate,
            minAmountOut,
        },
        true
    );
};

const execTrade = async (tradeObj, exec = false) => {
    // TODO: Check Approvals only

    const { amountIn, minAmountOut, pathHash, to, gasEstimate, gasPrice } = tradeObj;
    // console.log(tradeObj)
    if (exec) {
        console.log("==> POSSIBLE TRADE OPPORTUNITY", sem.available([1]));
        if (!sem.available([1])) {
            console.log("====> ANOTHER TRADE IN PROGRESS");
            return;
        }
        sem.take(async () => {
            console.log("======> EXECUTING TRADE");

            var tx = await callSwapTokens(amountIn, minAmountOut, pathHash, to, gasEstimate);

            console.log(tx);

            sem.leave();
            process.exit();
        });
    }
};

const callSwapTokens = async (amountIn, minAmountOut, pathHash, to, gasEstimate) => {
    const feeData = await PROVIDER.getFeeData();

    const nonce = await PROVIDER.getTransactionCount(SIGNER.address);

    const iUniswapRouter = new ethers.utils.Interface(UNISWAPROUTERV3ABI);

    let data = iUniswapRouter.encodeFunctionData("exactInput", [[pathHash, to, amountIn.toString(), amountIn.toString()]]);

    const transaction = {
        to: UNISWAPV3ROUTER,
        value: ethers.utils.parseEther("0"),
        gasLimit: gasEstimate,
        type: 0x2,
        maxPriorityFeePerGas: feeData["maxPriorityFeePerGas"],
        maxFeePerGas: feeData["maxFeePerGas"],
        chainId: 1,
        data: data,
        nonce: nonce,
    };

    let rawTransaction = await SIGNER.signTransaction(transaction).then(ethers.utils.serializeTransaction(transaction));

    const requestData = {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendRawTransaction",
        params: [rawTransaction],
    };

    const bodyText = JSON.stringify(requestData);

    const messageSignature = await SIGNER.signMessage(ethers.utils.id(bodyText));

    const signature = `${SIGNER.address}:${messageSignature}`;

    const headers = {
        "Content-Type": "application/json",
        "X-Flashbots-Signature": `${signature}`,
    };

    const bundle2 = await fetch("https://rpc.blocknative.com/boost", {
        method: "POST",
        headers: headers,
        body: JSON.stringify(requestData),
    }).then((response) => response.json());

    console.log(bundle2);
    console.log("Swap transaction hash:", swap.transactionHash);
    return bundle2;
};

const init = async () => {
    while (true) {
        console.log("$$$$$ $$$$$$$$$ $$$$$$");
        console.log("$$$$$ ARBITRAGE $$$$$$");
        console.log("$$$$$ $$$$$$$$$ $$$$$$");
        pairMap = {};
        symbolIdMap = {};
        idSymbolMap = {};
        let pairs;
        try {
            pairs = await fetchUniswapData();
            // fs.writeFileSync("pairMap.json", JSON.stringify(pairs), "utf-8");
        } catch (err) {
            console.log("fetch uniswapV3 data error");
            continue;
        }

        parseData(pairs);

        // fs.writeFileSync("pairMap.json", JSON.stringify(pairMap), "utf-8");

        const initToken = INIT_TOKENS.WETH;

        const opps = getArbitrageOpportunities(initToken, 1.04);

        // fs.writeFileSync("pairMap.json",JSON.stringify(opps),"utf-8");

        const gasPrice = await PROVIDER.getFeeData();
        const arbRes = [];
        console.log(`Total Arbitrages: ${opps.length}`);

        for (let i = 0; i < opps.length; i += 1) {
            const amountIn = ethers.utils.parseEther("0.1");
            const arbitrageRes = processArbitrage(opps[i], amountIn, gasPrice);

            arbRes.push(arbitrageRes);
        }
        await Promise.all(arbRes);
        console.log("All arbitrages processed.");
        // break;
    }
};

async function start() {
    console.log("begin");
    try {
        await init();
        setTimeout(function () { start(); }, 5000);
    }
    catch (err) {
        console.log(`Uncaught error ${err}`);
        process.exit();
    }
    console.log("end");

}
start();
