import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import {
	BN,
	calculateEffectiveLeverage,
	getMarketOrderParams,
	OracleSource,
	ZERO,
	calculatePrice,
	PEG_PRECISION,
	BASE_PRECISION,
} from '../sdk';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';
import {
	Admin,
	PRICE_PRECISION,
	calculateReservePrice,
	calculateTradeSlippage,
	PositionDirection,
	EventSubscriber,
	convertToNumber,
	findComputeUnitConsumption,
	calculateBidAskPrice,
	calculateUpdatedAMM,
	AMM_TO_QUOTE_PRECISION_RATIO,
	calculateTradeAcquiredAmounts,
	calculateSpread,
	calculateInventoryScale,
	QUOTE_PRECISION,
} from '../sdk/src';

import {
	getFeedData,
	// initUserAccounts,
	mockOracle,
	mockUserUSDCAccount,
	mockUSDCMint,
	setFeedPrice,
	getOraclePriceData,
	initializeQuoteSpotMarket,
} from './testHelpers';

describe('prepeg', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let clearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let userAccountPublicKey: PublicKey;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(100000);
	const ammInitialQuoteAssetAmount = new anchor.BN(
		5 * BASE_PRECISION.toNumber()
	).mul(mantissaSqrtScale);
	const ammInitialBaseAssetAmount = new anchor.BN(
		5 * BASE_PRECISION.toNumber()
	).mul(mantissaSqrtScale);

	const usdcAmount = new BN(10000 * QUOTE_PRECISION.toNumber());

	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;
	let solUsd;
	const mockOracles = [];

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(1, -7, 0);
		mockOracles.push(solUsd);
		for (let i = 1; i <= 4; i++) {
			// init more oracles
			const thisUsd = await mockOracle(i);
			mockOracles.push(thisUsd);
		}

		spotMarketIndexes = [0];
		marketIndexes = mockOracles.map((_, i) => i);
		oracleInfos = mockOracles.map((oracle) => {
			return { publicKey: oracle, source: OracleSource.PYTH };
		});

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
			oracleInfos,
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.updatePerpAuctionDuration(0);

		await clearingHouse.subscribe();
		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);

		const periodicity = new BN(60 * 60); // 1 HOUR
		await clearingHouse.initializePerpMarket(
			solUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			PEG_PRECISION,
			undefined,
			1000
		);
		await clearingHouse.updatePerpMarketBaseSpread(0, 1000);
		await clearingHouse.updatePerpMarketCurveUpdateIntensity(0, 100);
		await clearingHouse.updatePerpMarketStepSizeAndTickSize(
			0,
			new BN(1),
			new BN(1)
		);

		for (let i = 1; i <= 4; i++) {
			// init more markets
			const thisUsd = mockOracles[i];
			await clearingHouse.initializePerpMarket(
				thisUsd,
				ammInitialBaseAssetAmount,
				ammInitialQuoteAssetAmount,
				periodicity,
				new BN(1_000 * i),
				undefined,
				1000
			);
			await clearingHouse.updatePerpMarketBaseSpread(i, 2000);
			await clearingHouse.updatePerpMarketCurveUpdateIntensity(i, 100);
			await clearingHouse.updatePerpMarketStepSizeAndTickSize(
				i,
				new BN(1),
				new BN(1)
			);
		}

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
		const marketIndex = 0;
		const baseAssetAmount = new BN(49745050000);
		const direction = PositionDirection.LONG;
		const market0 = clearingHouse.getPerpMarketAccount(0);

		// await setFeedPrice(anchor.workspace.Pyth, 1.01, solUsd);
		const curPrice = (await getFeedData(anchor.workspace.Pyth, solUsd)).price;
		console.log('new oracle price:', curPrice);
		const oraclePriceData = await getOraclePriceData(
			anchor.workspace.Pyth,
			solUsd
		);
		const position0Before = clearingHouse.getUserAccount().perpPositions[0];
		console.log(position0Before.quoteAssetAmount.eq(ZERO));

		const [_pctAvgSlippage, _pctMaxSlippage, _entryPrice, newPrice] =
			calculateTradeSlippage(
				direction,
				baseAssetAmount,
				market0,
				'base',
				oraclePriceData
			);

		const [
			_acquiredBaseReserve,
			_acquiredQuoteReserve,
			acquiredQuoteAssetAmount,
		] = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			market0,
			'base',
			oraclePriceData
		);

		console.log(
			'acquiredQuoteAssetAmount:',
			acquiredQuoteAssetAmount.toString()
		);

		const [bid, ask] = calculateBidAskPrice(market0.amm, oraclePriceData);

		console.log(
			'bid/ask:',
			convertToNumber(bid),
			'/',
			convertToNumber(ask),
			'after trade est. mark price:',
			convertToNumber(newPrice)
		);
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
		});
		const txSig = await clearingHouse.placeAndTakePerpOrder(orderParams);

		const computeUnits = await findComputeUnitConsumption(
			clearingHouse.program.programId,
			connection,
			txSig,
			'confirmed'
		);
		console.log('compute units', computeUnits);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);
		const market = clearingHouse.getPerpMarketAccount(0);

		const [bid1, ask1] = calculateBidAskPrice(market.amm, oraclePriceData);

		console.log(
			'after trade bid/ask:',
			convertToNumber(bid1),
			'/',
			convertToNumber(ask1),
			'after trade mark price:',
			convertToNumber(calculateReservePrice(market, oraclePriceData))
		);

		const position0 = clearingHouse.getUserAccount().perpPositions[0];

		console.log(position0.quoteAssetAmount.toString());
		console.log('quoteEntryAmount:', position0.quoteBreakEvenAmount.toString());
		assert.ok(position0.quoteEntryAmount.eq(new BN(-49999074)));
		assert.ok(acquiredQuoteAssetAmount.eq(position0.quoteEntryAmount.abs()));
		assert.ok(position0.quoteBreakEvenAmount.eq(new BN(-50049074)));
		assert.ok(
			acquiredQuoteAssetAmount.eq(
				position0.quoteBreakEvenAmount.add(market.amm.totalExchangeFee).abs()
			)
		);

		console.log(
			clearingHouse.getUserAccount().perpPositions[0].baseAssetAmount.toString()
		);
		assert.ok(
			clearingHouse
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(baseAssetAmount)
		);

		console.log('sqrtK:', market.amm.sqrtK.toString());

		assert.ok(market.amm.baseAssetAmountWithAmm.eq(new BN(49745050000)));
		assert.ok(market.amm.baseAssetAmountLong.eq(new BN(49745050000)));
		assert.ok(market.amm.baseAssetAmountShort.eq(ZERO));
		assert.ok(market.numberOfUsersWithBase === 1);
		assert.ok(market.amm.totalFee.gt(new BN(49750)));
		assert.ok(market.amm.totalFeeMinusDistributions.gt(new BN(49750)));
		assert.ok(market.amm.totalExchangeFee.eq(new BN(49999 + 1)));

		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert.ok(orderRecord.taker.equals(userAccountPublicKey));
		assert.ok(orderRecord.baseAssetAmountFilled.eq(new BN(49745050000)));
		assert.ok(orderRecord.quoteAssetAmountFilled.gt(new BN(49750001)));
		assert.ok(orderRecord.marketIndex === 0);

		// console.log(orderRecord);
		console.log(market.amm.totalExchangeFee.toNumber());
		console.log(position0.quoteAssetAmount.toNumber());

		assert.ok(position0.quoteAssetAmount.eq(new BN(-50049074)));
		assert.ok(
			position0.quoteAssetAmount.eq(
				position0.quoteEntryAmount.sub(market.amm.totalExchangeFee)
			)
		);
		assert.ok(position0.quoteAssetAmount.eq(position0.quoteBreakEvenAmount));
	});

	it('Long even more', async () => {
		const marketIndex = 0;
		const baseAssetAmount = new BN(49745050367 / 50);
		const market0 = clearingHouse.getPerpMarketAccount(0);

		await setFeedPrice(anchor.workspace.Pyth, 1.0281, solUsd);
		const curPrice = (await getFeedData(anchor.workspace.Pyth, solUsd)).price;
		console.log('new oracle price:', curPrice);

		const oraclePriceData = await getOraclePriceData(
			anchor.workspace.Pyth,
			solUsd
		);
		assert(market0.amm.pegMultiplier.eq(new BN(1000000)));
		const prepegAMM = calculateUpdatedAMM(market0.amm, oraclePriceData);
		console.log(prepegAMM.pegMultiplier.toString());
		assert(prepegAMM.pegMultiplier.eq(new BN(1005509)));
		const estDist = prepegAMM.totalFee.sub(
			prepegAMM.totalFeeMinusDistributions
		);
		console.log('est distribution:', estDist.toString());

		const [_pctAvgSlippage, _pctMaxSlippage, _entryPrice, newPrice] =
			calculateTradeSlippage(
				PositionDirection.LONG,
				baseAssetAmount,
				market0,
				'base',
				oraclePriceData
			);

		const [
			_acquiredBaseReserve,
			_acquiredQuoteReserve,
			acquiredQuoteAssetAmount,
		] = calculateTradeAcquiredAmounts(
			PositionDirection.LONG,
			baseAssetAmount,
			market0,
			'base',
			oraclePriceData
		);

		const acquiredQuote = _entryPrice
			.mul(baseAssetAmount.abs())
			.div(AMM_TO_QUOTE_PRECISION_RATIO)
			.div(PRICE_PRECISION);
		console.log(
			'est acquiredQuote:',
			acquiredQuote.toNumber(),
			acquiredQuoteAssetAmount.toNumber()
		);
		const newAmm = calculateUpdatedAMM(market0.amm, oraclePriceData);

		const reservePrice = calculatePrice(
			newAmm.baseAssetReserve,
			newAmm.quoteAssetReserve,
			newAmm.pegMultiplier
		);
		const effectiveLeverage = calculateEffectiveLeverage(
			newAmm.baseSpread,
			newAmm.quoteAssetReserve,
			newAmm.terminalQuoteAssetReserve,
			newAmm.pegMultiplier,
			newAmm.baseAssetAmountWithAmm,
			reservePrice,
			newAmm.totalFeeMinusDistributions
		);
		const inventoryScale = calculateInventoryScale(
			newAmm.baseAssetAmountWithAmm,
			newAmm.baseAssetReserve,
			newAmm.minBaseAssetReserve,
			newAmm.maxBaseAssetReserve
		);

		console.log(inventoryScale, effectiveLeverage);

		const longSpread = calculateSpread(
			newAmm,
			PositionDirection.LONG,
			oraclePriceData
		);
		const shortSpread = calculateSpread(
			newAmm,
			PositionDirection.SHORT,
			oraclePriceData
		);

		console.log(newAmm.baseSpread, longSpread, shortSpread, newAmm.maxSpread);
		console.log(inventoryScale);
		console.log(effectiveLeverage);
		assert(newAmm.maxSpread == (100000 / 2) * 0.95);
		assert(inventoryScale == 0.003409);
		assert(effectiveLeverage == 0.19905711326640804);
		assert(shortSpread == 500);
		assert(longSpread.toString() == '26785.610433069665');

		const [bid, ask] = calculateBidAskPrice(market0.amm, oraclePriceData);

		console.log(
			'bid/ask:',
			convertToNumber(bid),
			'/',
			convertToNumber(ask),
			'after trade est. mark price:',
			convertToNumber(newPrice)
		);

		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
		});

		const txSig = await clearingHouse.placeAndTakePerpOrder(orderParams);
		const computeUnits = await findComputeUnitConsumption(
			clearingHouse.program.programId,
			connection,
			txSig,
			'confirmed'
		);
		console.log('compute units', computeUnits);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);
		const market = clearingHouse.getPerpMarketAccount(0);
		const [bid1, ask1] = calculateBidAskPrice(market.amm, oraclePriceData);
		console.log(
			'after trade bid/ask:',
			convertToNumber(bid1),
			'/',
			convertToNumber(ask1),
			'after trade mark price:',
			convertToNumber(calculateReservePrice(market, oraclePriceData))
		);
		assert(bid1.lt(ask1));
		assert(ask1.gt(oraclePriceData.price));
		assert(bid1.lt(oraclePriceData.price));

		console.log(market.amm.pegMultiplier.toString());
		assert(market.amm.pegMultiplier.eq(new BN(1005509)));
		const actualDist = market.amm.totalFee.sub(
			market.amm.totalFeeMinusDistributions
		);
		console.log('actual distribution:', actualDist.toString());

		console.log(prepegAMM.sqrtK.toString(), '==', market.amm.sqrtK.toString());
		const marketInvariant = market.amm.sqrtK.mul(market.amm.sqrtK);

		// check k math good
		assert(
			marketInvariant
				.div(market.amm.baseAssetReserve)
				.eq(market.amm.quoteAssetReserve)
		);
		assert(
			marketInvariant
				.div(market.amm.quoteAssetReserve)
				.eq(market.amm.baseAssetReserve)
		);

		// check prepeg and post trade worked as expected
		assert(prepegAMM.sqrtK.eq(market.amm.sqrtK)); // predicted k = post trade k
		assert(actualDist.sub(estDist).abs().lte(new BN(4))); // cost is near equal
		assert(market.amm.sqrtK.lt(market0.amm.sqrtK)); // k was lowered

		console.log(market.amm.longSpread);
		console.log(market.amm.shortSpread);

		assert(market.amm.longSpread === 26784);
		assert(market.amm.shortSpread === 500);

		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert.ok(orderActionRecord.taker.equals(userAccountPublicKey));
		// console.log(orderRecord);

		await clearingHouse.fetchAccounts();
		const position0 = clearingHouse.getUserAccount().perpPositions[0];
		const position0qea = position0.quoteEntryAmount;
		console.log(
			'position0qea:',
			position0qea.toNumber(),
			'(+',
			acquiredQuoteAssetAmount.toNumber(),
			')'
		);
		console.log(
			'baseASsetAmounts:',
			position0.baseAssetAmount.toNumber(),
			'vs',
			orderActionRecord.baseAssetAmountFilled.toNumber(),
			'vs',
			baseAssetAmount.toNumber()
		);
		console.log(
			'position0.quoteAssetAmount:',
			position0.quoteAssetAmount.toNumber()
		);

		assert(orderActionRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		const recordEntryPrice = orderActionRecord.quoteAssetAmountFilled
			.mul(AMM_TO_QUOTE_PRECISION_RATIO)
			.mul(PRICE_PRECISION)
			.div(orderActionRecord.baseAssetAmountFilled.abs());

		console.log(
			'entry sdk',
			convertToNumber(_entryPrice),
			'vs entry record',
			convertToNumber(recordEntryPrice)
		);

		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];
		console.log(
			'record Auction:',
			convertToNumber(orderRecord.order.auctionStartPrice),
			'->',
			convertToNumber(orderRecord.order.auctionEndPrice),
			'record oracle:',
			convertToNumber(orderActionRecord.oraclePrice)
		);

		// assert.ok(
		// 	position0qea
		// 		.abs()
		// 		.eq(acquiredQuoteAssetAmount.add(new BN(49999074)).add(new BN(-1001)))
		// );
		assert(acquiredQuoteAssetAmount.eq(new BN(1027809)));
		console.log(
			'position0.quoteAssetAmount:',
			position0.quoteAssetAmount.toNumber()
		);
		console.log(
			'position0.quoteEntryAmount:',
			position0.quoteBreakEvenAmount.toNumber()
		);

		assert.ok(position0qea.eq(new BN(-51026883)));
		assert.ok(position0.quoteBreakEvenAmount.eq(new BN(-51077911)));
		assert.ok(position0.quoteAssetAmount.eq(new BN(-51077911)));
	});

	it('Reduce long position', async () => {
		const marketIndex = 0;
		const baseAssetAmount = new BN(24872525000);
		const market0 = clearingHouse.getPerpMarketAccount(0);
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
		});

		await setFeedPrice(anchor.workspace.Pyth, 1.02234232, solUsd);
		const curPrice = (await getFeedData(anchor.workspace.Pyth, solUsd)).price;
		console.log('new oracle price:', curPrice);
		const oraclePriceData = await getOraclePriceData(
			anchor.workspace.Pyth,
			solUsd
		);
		const [_pctAvgSlippage, _pctMaxSlippage, _entryPrice, newPrice] =
			calculateTradeSlippage(
				PositionDirection.SHORT,
				baseAssetAmount,
				market0,
				'base',
				oraclePriceData
			);

		const acquiredQuote = _entryPrice
			.mul(baseAssetAmount.abs())
			.div(AMM_TO_QUOTE_PRECISION_RATIO)
			.div(PRICE_PRECISION);
		console.log('est acquiredQuote:', acquiredQuote.toNumber());

		const [bid, ask] = calculateBidAskPrice(market0.amm, oraclePriceData);

		console.log(
			'bid/ask:',
			convertToNumber(bid),
			'/',
			convertToNumber(ask),
			'after trade est. mark price:',
			convertToNumber(newPrice)
		);

		const txSig = await clearingHouse.placeAndTakePerpOrder(orderParams);
		const computeUnits = await findComputeUnitConsumption(
			clearingHouse.program.programId,
			connection,
			txSig,
			'confirmed'
		);
		console.log('compute units', computeUnits);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		const market = clearingHouse.getPerpMarketAccount(0);
		const [bid1, ask1] = calculateBidAskPrice(market.amm, oraclePriceData);
		console.log(
			'after trade bid/ask:',
			convertToNumber(bid1),
			'/',
			convertToNumber(ask1),
			'after trade mark price:',
			convertToNumber(calculateReservePrice(market, oraclePriceData))
		);

		console.log(
			clearingHouse.getUserAccount().perpPositions[0].baseAssetAmount.toNumber()
		);

		console.log(market.amm.baseAssetAmountWithAmm.toString());

		const orderRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert.ok(orderRecord.taker.equals(userAccountPublicKey));
		console.log(orderRecord.baseAssetAmountFilled.toNumber());
		assert.ok(orderRecord.baseAssetAmountFilled.eq(new BN(24872525000)));
		assert.ok(orderRecord.marketIndex === 0);
	});

	it('Many market balanced prepegs, long position', async () => {
		for (let i = 1; i <= 4; i++) {
			const thisUsd = mockOracles[i];
			const marketIndex = i;
			const baseAssetAmount = new BN(31.02765 * BASE_PRECISION.toNumber());
			const market0 = clearingHouse.getPerpMarketAccount(i);
			const orderParams = getMarketOrderParams({
				marketIndex,
				direction: PositionDirection.LONG,
				baseAssetAmount,
			});

			const curPrice = (await getFeedData(anchor.workspace.Pyth, thisUsd))
				.price;
			console.log('market_index=', i, 'new oracle price:', curPrice);
			const oraclePriceData = await getOraclePriceData(
				anchor.workspace.Pyth,
				thisUsd
			);
			const [_pctAvgSlippage, _pctMaxSlippage, _entryPrice, newPrice] =
				calculateTradeSlippage(
					PositionDirection.LONG,
					baseAssetAmount,
					market0,
					'base',
					oraclePriceData
				);

			const [bid, ask] = calculateBidAskPrice(market0.amm, oraclePriceData);

			console.log(
				'bid/ask:',
				convertToNumber(bid),
				'/',
				convertToNumber(ask),
				'after trade est. mark price:',
				convertToNumber(newPrice)
			);
			try {
				const txSig = await clearingHouse.placeAndTakePerpOrder(orderParams);
				const computeUnits = await findComputeUnitConsumption(
					clearingHouse.program.programId,
					connection,
					txSig,
					'confirmed'
				);
				console.log('compute units', computeUnits);
				console.log(
					'tx logs',
					(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
						.meta.logMessages
				);
			} catch (e) {
				console.error(e);
				assert(false);
			}

			const market = clearingHouse.getPerpMarketAccount(i);
			const [bid1, ask1] = calculateBidAskPrice(market.amm, oraclePriceData);
			console.log(
				'after trade bid/ask:',
				convertToNumber(bid1),
				'/',
				convertToNumber(ask1),
				'after trade mark price:',
				convertToNumber(calculateReservePrice(market, oraclePriceData))
			);
			console.log('----');
		}
	});

	it('Many market expensive prepeg margin', async () => {
		const user = clearingHouse.getUserAccount();

		// todo cheapen margin peg enough to make this work w/ 5 positions
		for (let i = 1; i <= 4; i++) {
			console.log(
				'user market',
				user.perpPositions[i].marketIndex.toString(),
				' base position',
				'=',
				user.perpPositions[i].baseAssetAmount.toNumber() / 1e13
			);
			const thisUsd = mockOracles[i];
			const curPrice = (await getFeedData(anchor.workspace.Pyth, thisUsd))
				.price;
			await setFeedPrice(anchor.workspace.Pyth, curPrice * 1.03, thisUsd);
		}
		const curPrice = (await getFeedData(anchor.workspace.Pyth, mockOracles[0]))
			.price;
		await setFeedPrice(anchor.workspace.Pyth, curPrice * 1.01, mockOracles[0]);

		const orderParams = getMarketOrderParams({
			marketIndex: 0,
			direction: PositionDirection.SHORT,
			baseAssetAmount: user.perpPositions[0].baseAssetAmount.div(new BN(2)),
		});

		const txSig = await clearingHouse.placeAndTakePerpOrder(orderParams);
		const computeUnits = await findComputeUnitConsumption(
			clearingHouse.program.programId,
			connection,
			txSig,
			'confirmed'
		);
		console.log('compute units', computeUnits);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);
	});
});
