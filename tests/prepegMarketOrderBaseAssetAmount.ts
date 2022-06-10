import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN, getMarketOrderParams, ONE, ZERO } from '../sdk';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	Admin,
	MARK_PRICE_PRECISION,
	calculateMarkPrice,
	calculateTradeSlippage,
	PositionDirection,
	EventSubscriber,
	convertToNumber,
} from '../sdk/src';

import {
	getFeedData,
	// initUserAccounts,
	mockOracle,
	mockUserUSDCAccount,
	mockUSDCMint,
	setFeedPrice,
} from './testHelpers';

describe('clearing_house', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let userAccountPublicKey: PublicKey;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetAmount = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetAmount = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);
	let solUsd;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		clearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId,
			{
				commitment: 'confirmed',
			}
		);

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribeToAll();

		const periodicity = new BN(60 * 60); // 1 HOUR
		solUsd = await mockOracle(1);

		await clearingHouse.initializeMarket(
			solUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			new BN(1_000),
			undefined,
			1000
		);
		await clearingHouse.updateMarketBaseSpread(new BN(0), 500);

		[, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Long from 0 position', async () => {
		const marketIndex = new BN(0);
		const baseAssetAmount = new BN(497450503674885);
		const market0 = clearingHouse.getMarketAccount(0);

		const [pctAvgSlippage, pctMaxSlippage, entryPrice, newPrice] =
			calculateTradeSlippage(
				PositionDirection.LONG,
				baseAssetAmount,
				market0,
				'base'
			);

		console.log('after trade est. mark price:', convertToNumber(newPrice));
		await setFeedPrice(anchor.workspace.Pyth, 1.01, solUsd);
		let curPrice = (await getFeedData(anchor.workspace.Pyth, solUsd)).price;
		console.log('new oracle price:', curPrice);
		const orderParams = getMarketOrderParams(
			marketIndex,
			PositionDirection.LONG,
			ZERO,
			baseAssetAmount,
			false
		);
		let txSig = await clearingHouse.placeAndFillOrder(orderParams);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);
		const market = clearingHouse.getMarketAccount(0);
		console.log(
			'after trade mark price:',
			convertToNumber(calculateMarkPrice(market))
		);
		// curPrice = (await getFeedData(anchor.workspace.Pyth, solUsd)).price;
		// console.log('price:', curPrice);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		// assert(user.collateral.eq(new BN(9950250)));
		// assert(user.totalFeePaid.eq(new BN(49750)));
		assert(user.cumulativeDeposits.eq(usdcAmount));

		assert.ok(
			clearingHouse
				.getUserAccount()
				.positions[0].quoteAssetAmount.gt(new BN(49750001))
		);
		console.log(clearingHouse.getUserAccount().positions[0].baseAssetAmount);
		assert.ok(
			clearingHouse
				.getUserAccount()
				.positions[0].baseAssetAmount.eq(baseAssetAmount)
		);

		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(497450503674885)));
		assert.ok(market.baseAssetAmountLong.eq(new BN(497450503674885)));
		assert.ok(market.baseAssetAmountShort.eq(ZERO));
		assert.ok(market.openInterest.eq(ONE));
		assert.ok(market.amm.totalFee.gt(new BN(49750)));
		assert.ok(market.amm.totalFeeMinusDistributions.gt(new BN(49750)));

		const tradeRecord = eventSubscriber.getEventsArray('TradeRecord')[0].data;
		assert.ok(tradeRecord.user.equals(userAccountPublicKey));
		assert.ok(tradeRecord.recordId.eq(new BN(1)));
		assert.ok(
			JSON.stringify(tradeRecord.direction) ===
				JSON.stringify(PositionDirection.LONG)
		);
		assert.ok(tradeRecord.baseAssetAmount.eq(new BN(497450503674885)));
		assert.ok(tradeRecord.liquidation == false);
		assert.ok(tradeRecord.quoteAssetAmount.gt(new BN(49750001)));
		assert.ok(tradeRecord.marketIndex.eq(marketIndex));
	});

	it('Long even more', async () => {
		const marketIndex = new BN(0);
		const baseAssetAmount = new BN(497450503674885 / 50);
		const market0 = clearingHouse.getMarketAccount(0);

		const [pctAvgSlippage, pctMaxSlippage, entryPrice, newPrice] =
			calculateTradeSlippage(
				PositionDirection.LONG,
				baseAssetAmount,
				market0,
				'base'
			);

		console.log('after trade est. mark price:', convertToNumber(newPrice));
		await setFeedPrice(anchor.workspace.Pyth, 1.0281, solUsd);
		let curPrice = (await getFeedData(anchor.workspace.Pyth, solUsd)).price;
		console.log('new oracle price:', curPrice);
		const orderParams = getMarketOrderParams(
			marketIndex,
			PositionDirection.LONG,
			ZERO,
			baseAssetAmount,
			false
		);
		let txSig = await clearingHouse.placeAndFillOrder(orderParams);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);
		const market = clearingHouse.getMarketAccount(0);
		console.log(
			'after trade mark price:',
			convertToNumber(calculateMarkPrice(market))
		);
		// curPrice = (await getFeedData(anchor.workspace.Pyth, solUsd)).price;
		// console.log('price:', curPrice);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		// assert(user.collateral.eq(new BN(9950250)));
		// assert(user.totalFeePaid.eq(new BN(49750)));
		assert(user.cumulativeDeposits.eq(usdcAmount));

		assert.ok(
			clearingHouse
				.getUserAccount()
				.positions[0].quoteAssetAmount.gt(new BN(49750001))
		);
		console.log(clearingHouse.getUserAccount().positions[0].baseAssetAmount);
		// assert.ok(
		// 	clearingHouse
		// 		.getUserAccount()
		// 		.positions[0].baseAssetAmount.eq(baseAssetAmount)
		// );
	});

	it('Reduce long position', async () => {
		const marketIndex = new BN(0);
		const baseAssetAmount = new BN(497450503674885).div(new BN(2));
		const market0 = clearingHouse.getMarketAccount(0);
		const orderParams = getMarketOrderParams(
			marketIndex,
			PositionDirection.SHORT,
			ZERO,
			baseAssetAmount,
			false
		);

		const [pctAvgSlippage, pctMaxSlippage, entryPrice, newPrice] =
			calculateTradeSlippage(
				PositionDirection.SHORT,
				baseAssetAmount,
				market0,
				'base'
			);

		console.log('after trade est. mark price:', convertToNumber(newPrice));
		await setFeedPrice(anchor.workspace.Pyth, 1.02234232, solUsd);
		let curPrice = (await getFeedData(anchor.workspace.Pyth, solUsd)).price;
		console.log('new oracle price:', curPrice);

		let txSig = await clearingHouse.placeAndFillOrder(orderParams);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		const market = clearingHouse.getMarketAccount(0);
		console.log(
			'after trade mark price:',
			convertToNumber(calculateMarkPrice(market))
		);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);
		// assert.ok(
		// 	clearingHouse
		// 		.getUserAccount()
		// 		.positions[0].quoteAssetAmount.eq(new BN(24875001))
		// );
		console.log(
			clearingHouse.getUserAccount().positions[0].baseAssetAmount.toNumber()
		);
		// assert.ok(
		// 	clearingHouse
		// 		.getUserAccount()
		// 		.positions[0].baseAssetAmount.eq(new BN(248725251837443))
		// );
		console.log(user.collateral.toString());
		console.log(user.totalFeePaid.toString());
		// assert.ok(user.collateral.eq(new BN(9926611)));
		// assert(user.totalFeePaid.eq(new BN(74626)));
		assert(user.cumulativeDeposits.eq(usdcAmount));

		console.log(market.amm.netBaseAssetAmount.toString());
		// assert.ok(market.amm.netBaseAssetAmount.eq(new BN(248725251837443)));
		// assert.ok(market.baseAssetAmountLong.eq(new BN(248725251837443)));
		// assert.ok(market.baseAssetAmountShort.eq(ZERO));
		// assert.ok(market.openInterest.eq(ONE));
		// assert.ok(market.amm.totalFee.eq(new BN(74626)));
		// assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(74626)));

		const tradeRecord = eventSubscriber.getEventsArray('TradeRecord')[0].data;

		assert.ok(tradeRecord.user.equals(userAccountPublicKey));
		assert.ok(tradeRecord.recordId.eq(new BN(3)));
		assert.ok(
			JSON.stringify(tradeRecord.direction) ===
				JSON.stringify(PositionDirection.SHORT)
		);
		console.log(tradeRecord.baseAssetAmount.toNumber());
		assert.ok(tradeRecord.baseAssetAmount.eq(new BN(248725251837442)));
		assert.ok(tradeRecord.liquidation == false);
		// assert.ok(tradeRecord.quoteAssetAmount.eq(new BN(24876237)));
		assert.ok(tradeRecord.marketIndex.eq(new BN(0)));
	});

	// it('Reverse long position', async () => {
	// 	const marketIndex = new BN(0);
	// 	const baseAssetAmount = new BN(497450503674885);
	// 	const orderParams = getMarketOrderParams(
	// 		marketIndex,
	// 		PositionDirection.SHORT,
	// 		ZERO,
	// 		baseAssetAmount,
	// 		false
	// 	);
	// 	await clearingHouse.placeAndFillOrder(orderParams);

	// 	const user: any = await clearingHouse.program.account.user.fetch(
	// 		userAccountPublicKey
	// 	);

	// 	// assert.ok(user.collateral.eq(new BN(9875627)));
	// 	assert(user.totalFeePaid.eq(new BN(124371)));
	// 	assert.ok(
	// 		clearingHouse
	// 			.getUserAccount()
	// 			.positions[0].quoteAssetAmount.eq(new BN(24871287))
	// 	);
	// 	console.log(
	// 		clearingHouse.getUserAccount().positions[0].baseAssetAmount.toString()
	// 	);
	// 	assert.ok(
	// 		clearingHouse
	// 			.getUserAccount()
	// 			.positions[0].baseAssetAmount.eq(new BN(-248725251837442))
	// 	);

	// 	const market = clearingHouse.getMarketAccount(0);
	// 	assert.ok(market.amm.netBaseAssetAmount.eq(new BN(-248725251837442)));
	// 	assert.ok(market.baseAssetAmountLong.eq(ZERO));
	// 	assert.ok(market.baseAssetAmountShort.eq(new BN(-248725251837442)));
	// 	assert.ok(market.openInterest.eq(ONE));
	// 	assert.ok(market.amm.totalFee.eq(new BN(124371)));
	// 	assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(124371)));

	// 	const tradeRecord = eventSubscriber.getEventsArray('TradeRecord')[0].data;

	// 	assert.ok(tradeRecord.user.equals(userAccountPublicKey));
	// 	assert.ok(tradeRecord.recordId.eq(new BN(3)));
	// 	assert.ok(
	// 		JSON.stringify(tradeRecord.direction) ===
	// 			JSON.stringify(PositionDirection.SHORT)
	// 	);
	// 	console.log(tradeRecord.baseAssetAmount.toNumber());
	// 	assert.ok(tradeRecord.baseAssetAmount.eq(new BN(497450503674885)));
	// 	assert.ok(tradeRecord.quoteAssetAmount.eq(new BN(49745049)));
	// 	assert.ok(tradeRecord.marketIndex.eq(new BN(0)));
	// });

	// it('Close position', async () => {
	// 	const marketIndex = new BN(0);
	// 	const baseAssetAmount = new BN(248725251837442);
	// 	const orderParams = getMarketOrderParams(
	// 		marketIndex,
	// 		PositionDirection.LONG,
	// 		ZERO,
	// 		baseAssetAmount,
	// 		true
	// 	);
	// 	await clearingHouse.placeAndFillOrder(orderParams);

	// 	const user: any = await clearingHouse.program.account.user.fetch(
	// 		userAccountPublicKey
	// 	);

	// 	assert.ok(
	// 		clearingHouse.getUserAccount().positions[0].quoteAssetAmount.eq(new BN(0))
	// 	);
	// 	assert.ok(
	// 		clearingHouse.getUserAccount().positions[0].baseAssetAmount.eq(new BN(0))
	// 	);
	// 	assert.ok(user.collateral.eq(new BN(9850755)));
	// 	assert(user.totalFeePaid.eq(new BN(149242)));

	// 	const market = clearingHouse.getMarketAccount(0);
	// 	assert.ok(market.amm.netBaseAssetAmount.eq(new BN(0)));
	// 	assert.ok(market.amm.totalFee.eq(new BN(149242)));
	// 	assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(149242)));

	// 	const tradeRecord = eventSubscriber.getEventsArray('TradeRecord')[0].data;

	// 	assert.ok(tradeRecord.user.equals(userAccountPublicKey));
	// 	assert.ok(tradeRecord.recordId.eq(new BN(4)));
	// 	assert.ok(
	// 		JSON.stringify(tradeRecord.direction) ===
	// 			JSON.stringify(PositionDirection.LONG)
	// 	);
	// 	assert.ok(tradeRecord.baseAssetAmount.eq(new BN(248725251837442)));
	// 	assert.ok(tradeRecord.liquidation == false);
	// 	assert.ok(tradeRecord.quoteAssetAmount.eq(new BN(24871288)));
	// 	assert.ok(tradeRecord.marketIndex.eq(new BN(0)));
	// });
});
