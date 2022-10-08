import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import {
	getFeedData,
	initUserAccounts,
	mockOracle,
	mockUserUSDCAccount,
	mockUSDCMint,
	setFeedPrice,
	initializeQuoteSpotMarket,
	sleep,
	printTxLogs,
} from './testHelpers';
import {
	Admin,
	BN,
	QUOTE_SPOT_MARKET_INDEX,
	PRICE_PRECISION,
	FUNDING_RATE_BUFFER_PRECISION,
	PEG_PRECISION,
	ClearingHouse,
	ClearingHouseUser,
	PositionDirection,
	QUOTE_PRECISION,
	AMM_RESERVE_PRECISION,
	calculateReservePrice,
	convertToNumber,
	ExchangeStatus,
	BASE_PRECISION,
	OracleSource,
	isVariant,
} from '../sdk/src';

import { Program } from '@project-serum/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

async function updateFundingRateHelper(
	clearingHouse: ClearingHouse,
	marketIndex: number,
	priceFeedAddress: PublicKey,
	prices: Array<number>
) {
	for (let i = 0; i < prices.length; i++) {
		await new Promise((r) => setTimeout(r, 1000)); // wait 1 second

		const newprice = prices[i];
		await setFeedPrice(anchor.workspace.Pyth, newprice, priceFeedAddress);
		// just to update funding trade .1 cent
		// await clearingHouse.openPosition(
		// 	PositionDirection.LONG,
		// 	QUOTE_PRECISION.div(new BN(100)),
		// 	marketIndex
		// );
		await clearingHouse.fetchAccounts();
		const marketData0 = clearingHouse.getPerpMarketAccount(marketIndex);
		const ammAccountState0 = marketData0.amm;
		const oraclePx0 = await getFeedData(
			anchor.workspace.Pyth,
			ammAccountState0.oracle
		);

		const priceSpread0 =
			convertToNumber(ammAccountState0.lastMarkPriceTwap) -
			convertToNumber(
				ammAccountState0.historicalOracleData.lastOraclePriceTwap
			);
		const frontEndFundingCalc0 = priceSpread0 / oraclePx0.twap / (24 * 3600);

		console.log(
			'funding rate frontend calc0:',
			frontEndFundingCalc0,
			'markTwap0:',
			ammAccountState0.lastMarkPriceTwap.toNumber() /
				PRICE_PRECISION.toNumber(),
			'oracleTwap0:',
			ammAccountState0.historicalOracleData.lastOraclePriceTwap.toNumber() /
				PRICE_PRECISION.toNumber(),
			'markTwap0:',
			ammAccountState0.lastMarkPriceTwap.toNumber(),
			'oracleTwapPyth:',
			oraclePx0.twap,
			'priceSpread',
			priceSpread0
		);

		const cumulativeFundingRateLongOld =
			ammAccountState0.cumulativeFundingRateLong;
		const cumulativeFundingRateShortOld =
			ammAccountState0.cumulativeFundingRateShort;

		const state = clearingHouse.getStateAccount();
		assert(isVariant(state.exchangeStatus, 'active'));

		const market = clearingHouse.getPerpMarketAccount(marketIndex);
		assert(isVariant(market.status, 'active'));

		await clearingHouse.updateFundingRate(priceFeedAddress, marketIndex);

		const CONVERSION_SCALE = FUNDING_RATE_BUFFER_PRECISION.mul(PRICE_PRECISION);

		await clearingHouse.fetchAccounts();
		const marketData = clearingHouse.getPerpMarketAccount(marketIndex);
		const ammAccountState = marketData.amm;
		const peroidicity = marketData.amm.fundingPeriod;

		const lastFundingRate = convertToNumber(
			ammAccountState.lastFundingRate,
			CONVERSION_SCALE
		);

		console.log('last funding rate:', lastFundingRate);
		console.log(
			'cumfunding rate long',
			convertToNumber(
				ammAccountState.cumulativeFundingRateLong,
				CONVERSION_SCALE
			),
			'cumfunding rate short',
			convertToNumber(
				ammAccountState.cumulativeFundingRateShort,
				CONVERSION_SCALE
			)
		);

		const lastFundingLong = ammAccountState.cumulativeFundingRateLong
			.sub(cumulativeFundingRateLongOld)
			.abs();
		const lastFundingShort = ammAccountState.cumulativeFundingRateShort
			.sub(cumulativeFundingRateShortOld)
			.abs();

		assert(ammAccountState.lastFundingRate.abs().gte(lastFundingLong.abs()));
		console.log(
			convertToNumber(ammAccountState.lastFundingRate.abs()) /
				FUNDING_RATE_BUFFER_PRECISION.toNumber(),
			'>=',
			convertToNumber(lastFundingShort.abs()) /
				FUNDING_RATE_BUFFER_PRECISION.toNumber()
		);
		assert(ammAccountState.lastFundingRate.abs().gte(lastFundingShort.abs()));

		const oraclePx = await getFeedData(
			anchor.workspace.Pyth,
			ammAccountState.oracle
		);

		await new Promise((r) => setTimeout(r, 1000)); // wait 1 second

		const priceSpread =
			ammAccountState.lastMarkPriceTwap.toNumber() /
				PRICE_PRECISION.toNumber() -
			ammAccountState.historicalOracleData.lastOraclePriceTwap.toNumber() /
				PRICE_PRECISION.toNumber();
		const frontEndFundingCalc =
			priceSpread / ((24 * 3600) / Math.max(1, peroidicity.toNumber()));

		console.log(
			'funding rate frontend calc:',
			frontEndFundingCalc,
			'markTwap:',
			ammAccountState.lastMarkPriceTwap.toNumber() / PRICE_PRECISION.toNumber(),
			'oracleTwap:',
			ammAccountState.historicalOracleData.lastOraclePriceTwap.toNumber() /
				PRICE_PRECISION.toNumber(),
			'markTwap:',
			ammAccountState.lastMarkPriceTwap.toNumber(),
			'oracleTwapPyth:',
			oraclePx.twap,
			'priceSpread:',
			priceSpread
		);
		const s = new Date(ammAccountState.lastMarkPriceTwapTs.toNumber() * 1000);
		const sdate = s.toLocaleDateString('en-US');
		const stime = s.toLocaleTimeString('en-US');

		console.log('funding rate timestamp:', sdate, stime);

		// assert(Math.abs(frontEndFundingCalc - lastFundingRate) < 9e-6);
	}
}

async function cappedSymFundingScenario(
	clearingHouse: Admin,
	userAccount: ClearingHouseUser,
	clearingHouse2: ClearingHouse,
	userAccount2: ClearingHouseUser,
	marketIndex: number,
	kSqrt: BN,
	priceAction: Array<number>,
	longShortSizes: Array<number>,
	fees = 0
) {
	const priceFeedAddress = await mockOracle(priceAction[0], -10);
	const periodicity = new BN(0);

	await clearingHouse.initializePerpMarket(
		priceFeedAddress,
		kSqrt,
		kSqrt,
		periodicity,
		new BN(priceAction[0] * PEG_PRECISION.toNumber())
	);
	await clearingHouse.accountSubscriber.addOracle({
		source: OracleSource.PYTH,
		publicKey: priceFeedAddress,
	});
	await clearingHouse2.accountSubscriber.addOracle({
		source: OracleSource.PYTH,
		publicKey: priceFeedAddress,
	});
	await sleep(2500);

	if (fees && fees > 0) {
		await clearingHouse.updateExchangeStatus(ExchangeStatus.FUNDINGPAUSED);

		console.log('spawn some fee pool');

		await clearingHouse.openPosition(
			PositionDirection.LONG,
			BASE_PRECISION.mul(new BN(100)),
			marketIndex
		);
		await clearingHouse.closePosition(marketIndex);
		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);
		await clearingHouse.updateExchangeStatus(ExchangeStatus.ACTIVE);
	}
	await clearingHouse.fetchAccounts();

	const oracleData = clearingHouse.getOracleDataForMarket(0);
	console.log(
		'PRICE',
		convertToNumber(
			calculateReservePrice(clearingHouse.getPerpMarketAccount(marketIndex))
		),
		'oracleData:',
		convertToNumber(oracleData.price),
		'+/-',
		convertToNumber(oracleData.confidence)
	);
	console.log(ExchangeStatus.FUNDINGPAUSED);
	console.log(ExchangeStatus.ACTIVE);

	await clearingHouse.updateExchangeStatus(ExchangeStatus.FUNDINGPAUSED);
	await clearingHouse.fetchAccounts();

	if (longShortSizes[0] !== 0) {
		console.log('clearingHouse.openPosition');
		const txSig = await clearingHouse.openPosition(
			PositionDirection.LONG,
			BASE_PRECISION.mul(new BN(longShortSizes[0])),
			marketIndex
		);
		await printTxLogs(clearingHouse.connection, txSig);
	}

	// try{
	if (longShortSizes[1] !== 0) {
		console.log('clearingHouse2.openPosition');
		await clearingHouse2.openPosition(
			PositionDirection.SHORT,
			BASE_PRECISION.mul(new BN(longShortSizes[1])),
			marketIndex
		);
	}
	await sleep(1500);
	await clearingHouse.fetchAccounts();
	await clearingHouse2.fetchAccounts();
	await sleep(1500);

	console.log(longShortSizes[0], longShortSizes[1]);
	await userAccount.fetchAccounts();
	const uA = userAccount.getUserAccount();
	console.log(
		'userAccount.getTotalPositionValue():',
		userAccount.getTotalPerpPositionValue().toString(),
		uA.perpPositions[0].marketIndex,
		':',
		uA.perpPositions[0].baseAssetAmount.toString(),
		'/',
		uA.perpPositions[0].quoteAssetAmount.toString()
	);
	await userAccount2.fetchAccounts();
	const uA2 = userAccount2.getUserAccount();

	console.log(
		'userAccount2.getTotalPositionValue():',
		userAccount2.getTotalPerpPositionValue().toString(),
		uA2.perpPositions[0].marketIndex,
		':',
		uA2.perpPositions[0].baseAssetAmount.toString(),
		'/',
		uA2.perpPositions[0].quoteAssetAmount.toString()
	);

	if (longShortSizes[0] != 0) {
		assert(!userAccount.getTotalPerpPositionValue().eq(new BN(0)));
	} else {
		assert(userAccount.getTotalPerpPositionValue().eq(new BN(0)));
	}
	if (longShortSizes[1] != 0) {
		assert(!userAccount2.getTotalPerpPositionValue().eq(new BN(0)));
	} else {
		assert(userAccount2.getTotalPerpPositionValue().eq(new BN(0)));
	}

	await clearingHouse.fetchAccounts();
	const market = clearingHouse.getPerpMarketAccount(marketIndex);

	await clearingHouse.updateExchangeStatus(ExchangeStatus.ACTIVE);

	console.log('priceAction update', priceAction, priceAction.slice(1));
	await updateFundingRateHelper(
		clearingHouse,
		marketIndex,
		market.amm.oracle,
		priceAction.slice(1)
	);

	await clearingHouse.fetchAccounts();
	await clearingHouse2.fetchAccounts();

	const marketNew = await clearingHouse.getPerpMarketAccount(marketIndex);

	const fundingRateLong = marketNew.amm.cumulativeFundingRateLong; //.sub(prevFRL);
	const fundingRateShort = marketNew.amm.cumulativeFundingRateShort; //.sub(prevFRS);

	console.log(
		'fundingRateLong',
		convertToNumber(
			fundingRateLong,
			PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
		),
		'fundingRateShort',
		convertToNumber(
			fundingRateShort,
			PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
		)
	);
	console.log(
		'baseAssetAmountLong',
		convertToNumber(marketNew.amm.baseAssetAmountLong, AMM_RESERVE_PRECISION),
		'baseAssetAmountShort',
		convertToNumber(marketNew.amm.baseAssetAmountShort, AMM_RESERVE_PRECISION),
		'totalFee',
		convertToNumber(marketNew.amm.totalFee, QUOTE_PRECISION),
		'totalFeeMinusDistributions',
		convertToNumber(marketNew.amm.totalFeeMinusDistributions, QUOTE_PRECISION)
	);

	const fundingPnLForLongs = marketNew.amm.baseAssetAmountLong
		.mul(fundingRateLong)
		.mul(new BN(-1));
	const fundingPnLForShorts = marketNew.amm.baseAssetAmountShort
		.mul(fundingRateShort)
		.mul(new BN(-1));

	const precisionFundingPay = AMM_RESERVE_PRECISION;
	console.log(
		'fundingPnLForLongs',
		convertToNumber(
			fundingPnLForLongs.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		),
		'fundingPnLForShorts',
		convertToNumber(
			fundingPnLForShorts.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		)
	);

	// more dollars long than short
	assert(!fundingRateLong.eq(new BN(0)));
	assert(!fundingRateShort.eq(new BN(0)));

	// await clearingHouse.moveAmmToPrice(
	// 	marketIndex,
	// 	new BN(priceAction[1] * PRICE_PRECISION.toNumber())
	// );

	setFeedPrice(anchor.workspace.Pyth, priceAction[0], priceFeedAddress);
	await clearingHouse.updateExchangeStatus(ExchangeStatus.FUNDINGPAUSED);

	assert(fundingRateShort.lte(fundingRateLong));
	if (longShortSizes[0] !== 0) {
		await clearingHouse.closePosition(marketIndex);
		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);
	}
	if (longShortSizes[1] !== 0) {
		await clearingHouse2.closePosition(marketIndex);
		await clearingHouse2.settlePNL(
			await clearingHouse2.getUserAccountPublicKey(),
			clearingHouse2.getUserAccount(),
			marketIndex
		);
	}
	await clearingHouse.updateExchangeStatus(ExchangeStatus.ACTIVE);
	setFeedPrice(anchor.workspace.Pyth, priceAction[1], priceFeedAddress);

	await sleep(2000);

	await clearingHouse.fetchAccounts();
	await clearingHouse2.fetchAccounts();
	await userAccount.fetchAccounts();
	await userAccount2.fetchAccounts();

	console.log(
		userAccount.getTotalPerpPositionValue().toString(),
		',',
		userAccount2.getTotalPerpPositionValue().toString()
	);

	assert(userAccount.getTotalPerpPositionValue().eq(new BN(0)));
	assert(userAccount2.getTotalPerpPositionValue().eq(new BN(0)));

	return [
		fundingRateLong,
		fundingRateShort,
		fundingPnLForLongs,
		fundingPnLForShorts,
		marketNew.amm.totalFee,
		marketNew.amm.totalFeeMinusDistributions,
	];
}

describe('capped funding', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;

	anchor.setProvider(provider);

	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	let clearingHouse2: ClearingHouse;

	let usdcMint: Keypair;
	let userUSDCAccount: Keypair;

	const ammInitialBaseAssetAmount = new anchor.BN(5 * 10 ** 13).mul(
		PRICE_PRECISION
	);

	const usdcAmount = new BN(100000 * 10 ** 6);

	let userAccount: ClearingHouseUser;
	let userAccount2: ClearingHouseUser;

	let rollingMarketNum = 0;
	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		const spotMarketIndexes = [0];
		const marketIndexes = Array.from({ length: 15 }, (_, i) => i);
		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);
		await clearingHouse.updatePerpAuctionDuration(new BN(0));

		await clearingHouse.initializeUserAccount();
		userAccount = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await userAccount.subscribe();

		await clearingHouse.deposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);

		// create <NUM_USERS> users with 10k that collectively do <NUM_EVENTS> actions
		const [_userUSDCAccounts, _user_keys, clearingHouses, userAccountInfos] =
			await initUserAccounts(
				1,
				usdcMint,
				usdcAmount,
				provider,
				marketIndexes,
				spotMarketIndexes,
				[]
			);

		clearingHouse2 = clearingHouses[0];
		userAccount2 = userAccountInfos[0];
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await userAccount.unsubscribe();

		await clearingHouse2.unsubscribe();
		await userAccount2.unsubscribe();
	});

	it('capped sym funding: ($1 long, $200 short, oracle < mark)', async () => {
		const marketIndex = rollingMarketNum;
		rollingMarketNum += 1;
		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			clearingHouse,
			userAccount,
			clearingHouse2,
			userAccount2,
			marketIndex,
			ammInitialBaseAssetAmount,
			[40, 36.5],
			[1, 200]
		);

		assert(fundingRateLong.abs().gt(fundingRateShort.abs()));
		assert(fundingRateLong.gt(new BN(0)));
		assert(fundingRateShort.gt(new BN(0)));

		assert(fundingPnLForLongs.abs().lt(fundingPnLForShorts.abs()));

		const feeAlloced =
			convertToNumber(totalFee, QUOTE_PRECISION) -
			convertToNumber(cumulativeFee, QUOTE_PRECISION);

		const precisionFundingPay = AMM_RESERVE_PRECISION;
		const fundingPnLForLongsNum = convertToNumber(
			fundingPnLForLongs.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);

		console.log(
			feeAlloced,
			'+',
			Math.abs(fundingPnLForLongsNum),
			'>=',
			fundingPnLForShortsNum
		);
		assert(
			feeAlloced + Math.abs(fundingPnLForLongsNum) >= fundingPnLForShortsNum
		);
	});

	it('capped sym funding: ($0 long, $200 short, oracle < mark)', async () => {
		const marketIndex = rollingMarketNum;
		rollingMarketNum += 1;

		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			clearingHouse,
			userAccount,
			clearingHouse2,
			userAccount2,
			marketIndex,
			ammInitialBaseAssetAmount,
			[40, 36.5],
			[0, 200]
		);

		assert(fundingRateLong.abs().gt(fundingRateShort.abs()));
		assert(fundingRateLong.gt(new BN(0)));
		assert(fundingRateShort.gt(new BN(0)));

		assert(fundingPnLForLongs.abs().lt(fundingPnLForShorts.abs()));

		const feeAlloced =
			convertToNumber(totalFee, QUOTE_PRECISION) -
			convertToNumber(cumulativeFee, QUOTE_PRECISION);

		const precisionFundingPay = AMM_RESERVE_PRECISION;
		const fundingPnLForLongsNum = convertToNumber(
			fundingPnLForLongs.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);

		console.log(
			feeAlloced,
			'+',
			Math.abs(fundingPnLForLongsNum),
			'>=',
			fundingPnLForShortsNum
		);
		assert(
			feeAlloced + Math.abs(fundingPnLForLongsNum) >= fundingPnLForShortsNum
		);
	});
	it('capped sym funding: ($1 long, $200 short, oracle > mark)', async () => {
		// symmetric is taking fees

		const marketIndex = rollingMarketNum;
		rollingMarketNum += 1;

		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			clearingHouse,
			userAccount,
			clearingHouse2,
			userAccount2,
			marketIndex,
			ammInitialBaseAssetAmount,
			[40, 43.5],
			[1, 200]
		);

		assert(fundingRateLong.abs().eq(fundingRateShort.abs()));
		assert(fundingRateLong.lt(new BN(0)));
		assert(fundingRateShort.lt(new BN(0)));

		assert(fundingPnLForLongs.abs().lt(fundingPnLForShorts.abs()));

		const feeAlloced =
			convertToNumber(totalFee, QUOTE_PRECISION) -
			convertToNumber(cumulativeFee, QUOTE_PRECISION);

		const precisionFundingPay = AMM_RESERVE_PRECISION;
		const fundingPnLForLongsNum = convertToNumber(
			fundingPnLForLongs.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);

		console.log(
			feeAlloced,
			'+',
			Math.abs(fundingPnLForLongsNum),
			'>=',
			fundingPnLForShortsNum
		);
		assert(
			feeAlloced + Math.abs(fundingPnLForLongsNum) >= fundingPnLForShortsNum
		);
	});
	it('capped sym funding: ($200 long, $1 short, oracle > mark)', async () => {
		const marketIndex = rollingMarketNum;
		rollingMarketNum += 1;

		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			clearingHouse,
			userAccount,
			clearingHouse2,
			userAccount2,
			marketIndex,
			ammInitialBaseAssetAmount,
			[41, 42.5],
			[200, 1]
		);

		assert(fundingRateShort.abs().gt(fundingRateLong.abs()));
		assert(fundingRateLong.lt(new BN(0)));
		assert(fundingRateShort.lt(new BN(0)));

		assert(fundingPnLForLongs.gt(new BN(0)));
		assert(fundingPnLForShorts.lt(new BN(0)));

		assert(fundingPnLForShorts.abs().lt(fundingPnLForLongs.abs()));

		const feeAlloced =
			convertToNumber(totalFee, QUOTE_PRECISION) -
			convertToNumber(cumulativeFee, QUOTE_PRECISION);

		const precisionFundingPay = AMM_RESERVE_PRECISION;
		const fundingPnLForLongsNum = convertToNumber(
			fundingPnLForLongs.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);

		// amount of money inflow must be greater than or equal to money outflow
		console.log(
			feeAlloced,
			'+',
			Math.abs(fundingPnLForShortsNum),
			'>=',
			fundingPnLForLongsNum
		);
		assert(
			feeAlloced + Math.abs(fundingPnLForShortsNum) >= fundingPnLForLongsNum
		);
	});
	it('capped sym funding: ($2000 long, $1000 short, oracle > mark), clamped to ~3.03% price spread', async () => {
		const marketIndex = rollingMarketNum;
		rollingMarketNum += 1;

		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			clearingHouse,
			userAccount,
			clearingHouse2,
			userAccount2,
			marketIndex,
			ammInitialBaseAssetAmount,
			[41, 44.5],
			[50, 25],
			10000
		);

		//ensure it was clamped :)
		await clearingHouse.fetchAccounts();
		const marketNew = clearingHouse.getPerpMarketAccount(marketIndex);
		console.log(
			'marketNew.amm.historicalOracleData.lastOraclePriceTwap:',
			marketNew.amm.historicalOracleData.lastOraclePriceTwap.toString()
		);
		const clampedFundingRatePct = new BN(
			(0.03 * PRICE_PRECISION.toNumber()) / 24
		).mul(FUNDING_RATE_BUFFER_PRECISION);
		const clampedFundingRate = new BN(44.5 * PRICE_PRECISION.toNumber())
			.mul(FUNDING_RATE_BUFFER_PRECISION)
			.div(new BN(24))
			.div(new BN(33));
		console.log(
			'clamped funding:',
			convertToNumber(clampedFundingRate) /
				FUNDING_RATE_BUFFER_PRECISION.toNumber(),
			'hourly pct:',
			convertToNumber(clampedFundingRatePct) /
				FUNDING_RATE_BUFFER_PRECISION.toNumber()
		);
		console.log(
			'short funding:',
			convertToNumber(fundingRateShort) /
				FUNDING_RATE_BUFFER_PRECISION.toNumber()
		);

		assert(fundingRateShort.abs().eq(fundingRateLong.abs()));
		console.log(fundingRateShort.abs().toString());
		console.log(clampedFundingRate.toString());

		assert(
			fundingRateShort.abs().sub(clampedFundingRate).abs().lt(new BN(1000))
		);

		assert(fundingRateLong.lt(new BN(0)));
		assert(fundingRateShort.lt(new BN(0)));

		assert(fundingPnLForLongs.gt(new BN(0)));
		assert(fundingPnLForShorts.lt(new BN(0)));

		assert(fundingPnLForShorts.abs().lt(fundingPnLForLongs.abs()));

		const feeAlloced =
			convertToNumber(totalFee, QUOTE_PRECISION) -
			convertToNumber(cumulativeFee, QUOTE_PRECISION);

		const precisionFundingPay = AMM_RESERVE_PRECISION;
		const fundingPnLForLongsNum = convertToNumber(
			fundingPnLForLongs.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);

		// amount of money inflow must be greater than or equal to money outflow
		console.log(
			feeAlloced,
			'+',
			Math.abs(fundingPnLForShortsNum),
			'>=',
			fundingPnLForLongsNum
		);
		assert(
			Math.abs(
				feeAlloced + Math.abs(fundingPnLForShortsNum) - fundingPnLForLongsNum
			) < 1e-6
		);
	});
	it('capped sym funding: ($20000 long, $1000 short, oracle > mark), clamped to ~3.03% price spread, fee pool drain', async () => {
		const marketIndex = rollingMarketNum;
		rollingMarketNum += 1;

		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			clearingHouse,
			userAccount,
			clearingHouse2,
			userAccount2,
			marketIndex,
			ammInitialBaseAssetAmount,
			[41, 45.1],
			[50, 25]
		);

		//ensure it was clamped :)
		await clearingHouse.fetchAccounts();
		const _marketNew = clearingHouse.getPerpMarketAccount(marketIndex);
		const clampedFundingRatePct = new BN(
			(0.03 * PRICE_PRECISION.toNumber()) / 24
		).mul(FUNDING_RATE_BUFFER_PRECISION);
		const clampedFundingRate = new BN(45.1 * PRICE_PRECISION.toNumber())
			.mul(FUNDING_RATE_BUFFER_PRECISION)
			.div(new BN(24))
			.div(new BN(33));
		console.log(
			'clamped funding:',
			convertToNumber(clampedFundingRate) /
				FUNDING_RATE_BUFFER_PRECISION.toNumber(),
			'hourly pct:',
			convertToNumber(clampedFundingRatePct) /
				FUNDING_RATE_BUFFER_PRECISION.toNumber()
		);
		console.log(
			'short funding:',
			convertToNumber(fundingRateShort) /
				FUNDING_RATE_BUFFER_PRECISION.toNumber()
		);

		assert(fundingRateShort.abs().gt(fundingRateLong.abs()));
		// assert(fundingRateShort.abs().gt(clampedFundingRate));
		assert(
			fundingRateShort.abs().sub(clampedFundingRate).abs().lt(new BN(1000))
		);
		assert(fundingRateLong.lt(new BN(0)));
		assert(fundingRateShort.lt(new BN(0)));

		assert(fundingPnLForLongs.gt(new BN(0)));
		assert(fundingPnLForShorts.lt(new BN(0)));

		assert(fundingPnLForShorts.abs().lt(fundingPnLForLongs.abs()));

		const feeAlloced =
			convertToNumber(totalFee, QUOTE_PRECISION) -
			convertToNumber(cumulativeFee, QUOTE_PRECISION);

		assert(cumulativeFee.gt(totalFee.div(new BN(2))));
		assert(
			cumulativeFee.gt(totalFee.mul(new BN(2)).div(new BN(3)).sub(new BN(1)))
		);

		const precisionFundingPay = AMM_RESERVE_PRECISION;
		const fundingPnLForLongsNum = convertToNumber(
			fundingPnLForLongs.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);

		// amount of money inflow must be greater than or equal to money outflow
		console.log(
			feeAlloced,
			'+',
			Math.abs(fundingPnLForShortsNum),
			'>=',
			fundingPnLForLongsNum
		);
		assert(
			feeAlloced + Math.abs(fundingPnLForShortsNum) >=
				fundingPnLForLongsNum + 1e-6
		);
	});
	it('capped sym funding: ($2000 long, $1000 short, oracle > mark)', async () => {
		const marketIndex = rollingMarketNum;
		rollingMarketNum += 1;

		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			clearingHouse,
			userAccount,
			clearingHouse2,
			userAccount2,
			marketIndex,
			ammInitialBaseAssetAmount,
			[41, 43.8],
			[2000, 1000]
		);

		assert(fundingRateShort.abs().gt(fundingRateLong.abs()));
		assert(fundingRateLong.lt(new BN(0)));
		assert(fundingRateShort.lt(new BN(0)));

		assert(fundingPnLForLongs.gt(new BN(0)));
		assert(fundingPnLForShorts.lt(new BN(0)));

		assert(fundingPnLForShorts.abs().lt(fundingPnLForLongs.abs()));

		const feeAlloced =
			convertToNumber(totalFee, QUOTE_PRECISION) -
			convertToNumber(cumulativeFee, QUOTE_PRECISION);

		const precisionFundingPay = AMM_RESERVE_PRECISION;
		const fundingPnLForLongsNum = convertToNumber(
			fundingPnLForLongs.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);

		// amount of money inflow must be greater than or equal to money outflow
		console.log(
			feeAlloced,
			'+',
			Math.abs(fundingPnLForShortsNum),
			'>=',
			fundingPnLForLongsNum
		);
		assert(
			feeAlloced + Math.abs(fundingPnLForShortsNum) >= fundingPnLForLongsNum
		);
	});
	it('capped sym funding: ($200 long, $0 short, oracle > mark)', async () => {
		const marketIndex = rollingMarketNum;
		rollingMarketNum += 1;

		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			clearingHouse,
			userAccount,
			clearingHouse2,
			userAccount2,
			marketIndex,
			ammInitialBaseAssetAmount,
			[41, 42.5],
			[200, 0]
		);

		assert(fundingRateShort.abs().gt(fundingRateLong.abs()));
		assert(fundingRateLong.lt(new BN(0)));
		assert(fundingRateShort.lt(new BN(0)));

		assert(fundingPnLForLongs.gt(new BN(0)));
		assert(fundingPnLForShorts.eq(new BN(0)));

		assert(fundingPnLForShorts.abs().lt(fundingPnLForLongs.abs()));

		const feeAlloced =
			convertToNumber(totalFee, QUOTE_PRECISION) -
			convertToNumber(cumulativeFee, QUOTE_PRECISION);

		const precisionFundingPay = AMM_RESERVE_PRECISION;
		const fundingPnLForLongsNum = convertToNumber(
			fundingPnLForLongs.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);

		// amount of money inflow must be greater than or equal to money outflow
		console.log(
			feeAlloced,
			'+',
			Math.abs(fundingPnLForShortsNum),
			'>=',
			fundingPnLForLongsNum
		);
		assert(
			feeAlloced + Math.abs(fundingPnLForShortsNum) >= fundingPnLForLongsNum
		);
	});
	it('capped sym funding: ($200 long, $1 short, oracle < mark)', async () => {
		//symmetric is taking fees
		const marketIndex = rollingMarketNum;
		rollingMarketNum += 1;

		const [
			fundingRateLong,
			fundingRateShort,
			fundingPnLForLongs,
			fundingPnLForShorts,
			totalFee,
			cumulativeFee,
		] = await cappedSymFundingScenario(
			clearingHouse,
			userAccount,
			clearingHouse2,
			userAccount2,
			marketIndex,
			ammInitialBaseAssetAmount,
			[41, 38.5],
			[200, 1]
		);

		assert(fundingRateShort.abs().eq(fundingRateLong.abs()));
		assert(fundingRateLong.gt(new BN(0)));
		assert(fundingRateShort.gt(new BN(0)));

		assert(fundingPnLForLongs.lt(new BN(0)));
		assert(fundingPnLForShorts.gt(new BN(0)));

		assert(fundingPnLForShorts.abs().lt(fundingPnLForLongs.abs()));

		const feeAlloced =
			convertToNumber(totalFee, QUOTE_PRECISION) -
			convertToNumber(cumulativeFee, QUOTE_PRECISION);

		const precisionFundingPay = AMM_RESERVE_PRECISION;
		const fundingPnLForLongsNum = convertToNumber(
			fundingPnLForLongs.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);
		const fundingPnLForShortsNum = convertToNumber(
			fundingPnLForShorts.div(
				PRICE_PRECISION.mul(FUNDING_RATE_BUFFER_PRECISION)
			),
			precisionFundingPay
		);

		// amount of money inflow must be greater than or equal to money outflow
		console.log(
			feeAlloced,
			'+',
			Math.abs(fundingPnLForShortsNum),
			'>=',
			fundingPnLForLongsNum
		);
		assert(
			feeAlloced + Math.abs(fundingPnLForShortsNum) >= fundingPnLForLongsNum
		);
	});
});
