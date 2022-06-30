import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN, isVariant, MarketAccount, OracleSource, ZERO } from '../sdk';

import { Program } from '@project-serum/anchor';
import { getTokenAccount } from '@project-serum/common';

import { PublicKey, TransactionSignature } from '@solana/web3.js';

import {
	Admin,
	MARK_PRICE_PRECISION,
	ClearingHouseUser,
	PositionDirection,
	MAX_LEVERAGE,
	getMarketPublicKey,
	EventSubscriber,
	QUOTE_ASSET_BANK_INDEX,
} from '../sdk/src';

import {
	mockUSDCMint,
	mockUserUSDCAccount,
	mockOracle,
	initializeQuoteAssetBank,
} from './testHelpers';

const calculateTradeAmount = (amountOfCollateral: BN) => {
	const ONE_MANTISSA = new BN(100000);
	const fee = ONE_MANTISSA.div(new BN(1000));
	const tradeAmount = amountOfCollateral
		.mul(MAX_LEVERAGE)
		.mul(ONE_MANTISSA.sub(MAX_LEVERAGE.mul(fee)))
		.div(ONE_MANTISSA);
	return tradeAmount;
};

describe('clearing_house', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let userAccountPublicKey: PublicKey;
	let userAccount: ClearingHouseUser;

	let usdcMint;
	let userUSDCAccount;

	let solUsd;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetAmount = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetAmount = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(1);

		clearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId,
			{
				commitment: 'confirmed',
			},
			0,
			[new BN(0)],
			[new BN(0)],
			[{ publicKey: solUsd, source: OracleSource.PYTH }]
		);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await userAccount.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Initialize State', async () => {
		await clearingHouse.initialize(usdcMint.publicKey, true);

		await clearingHouse.subscribe();
		const state = clearingHouse.getStateAccount();

		assert.ok(state.admin.equals(provider.wallet.publicKey));

		const [expectedInsuranceAccountAuthority, expectedInsuranceAccountNonce] =
			await anchor.web3.PublicKey.findProgramAddress(
				[state.insuranceVault.toBuffer()],
				clearingHouse.program.programId
			);
		assert.ok(
			state.insuranceVaultAuthority.equals(expectedInsuranceAccountAuthority)
		);
		assert.ok(state.insuranceVaultNonce == expectedInsuranceAccountNonce);

		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);
	});

	it('Initialize Market', async () => {
		const periodicity = new BN(60 * 60); // 1 HOUR

		const marketIndex = new BN(0);
		const txSig = await clearingHouse.initializeMarket(
			solUsd,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity
		);

		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		const marketPublicKey = await getMarketPublicKey(
			clearingHouse.program.programId,
			marketIndex
		);
		const market = (await clearingHouse.program.account.market.fetch(
			marketPublicKey
		)) as MarketAccount;

		assert.ok(market.initialized);
		assert.ok(market.amm.netBaseAssetAmount.eq(new BN(0)));
		assert.ok(market.openInterest.eq(new BN(0)));

		const ammD = market.amm;
		console.log(ammD.oracle.toString());
		assert.ok(ammD.oracle.equals(solUsd));
		assert.ok(ammD.baseAssetReserve.eq(ammInitialBaseAssetAmount));
		assert.ok(ammD.quoteAssetReserve.eq(ammInitialQuoteAssetAmount));
		assert.ok(ammD.cumulativeFundingRateLong.eq(new BN(0)));
		assert.ok(ammD.cumulativeFundingRateShort.eq(new BN(0)));
		assert.ok(ammD.fundingPeriod.eq(periodicity));
		assert.ok(ammD.lastFundingRate.eq(new BN(0)));
		assert.ok(!ammD.lastFundingRateTs.eq(new BN(0)));
	});

	it('Initialize user account and deposit collateral atomically', async () => {
		let txSig: TransactionSignature;
		[txSig, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		const user: any = await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		);

		assert.ok(user.authority.equals(provider.wallet.publicKey));
		const depositTokenAmount = clearingHouse.getQuoteAssetTokenAmount();
		assert(depositTokenAmount.eq(usdcAmount));
		assert(
			isVariant(
				clearingHouse.getUserBankBalance(QUOTE_ASSET_BANK_INDEX).balanceType,
				'deposit'
			)
		);

		// Check that clearing house collateral account has proper collateral
		const quoteAssetBankVault = await getTokenAccount(
			provider,
			clearingHouse.getQuoteAssetBankAccount().vault
		);
		assert.ok(quoteAssetBankVault.amount.eq(usdcAmount));

		assert.ok(user.positions.length == 5);
		assert.ok(user.positions[0].baseAssetAmount.toNumber() === 0);
		assert.ok(user.positions[0].quoteEntryAmount.toNumber() === 0);
		assert.ok(user.positions[0].lastCumulativeFundingRate.toNumber() === 0);

		await eventSubscriber.awaitTx(txSig);
		const depositRecord =
			eventSubscriber.getEventsArray('DepositRecord')[0].data;

		assert.ok(depositRecord.userAuthority.equals(provider.wallet.publicKey));
		assert.ok(depositRecord.user.equals(userAccountPublicKey));

		assert.ok(
			JSON.stringify(depositRecord.direction) ===
				JSON.stringify({ deposit: {} })
		);
		assert.ok(depositRecord.amount.eq(new BN(10000000)));
	});

	it('Take short position (w/ negative unrealized pnl)', async () => {
		const marketIndex = new BN(0);

		const ogTokenAmount = clearingHouse.getQuoteAssetTokenAmount();
		console.log('og getQuoteAssetTokenAmount:', ogTokenAmount.toString());

		const newUSDCNotionalAmount = calculateTradeAmount(usdcAmount);
		const txSig = await clearingHouse.openPosition(
			PositionDirection.SHORT,
			newUSDCNotionalAmount,
			marketIndex
		);

		// make user have small loss
		await clearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(MARK_PRICE_PRECISION.toNumber() * 1.05)
		);

		await clearingHouse.fetchAccounts();

		const market0 = clearingHouse.getMarketAccount(marketIndex);
		console.log(
			'market0.amm.pnlPool.balance:',
			market0.amm.pnlPool.balance.toString(),
			'market0.amm.totalFeeMinusDistributions:',
			market0.amm.totalFeeMinusDistributions.toString()
		);

		const user0 = clearingHouse.getUserAccount();
		userAccount = ClearingHouseUser.from(
			clearingHouse,
			provider.wallet.publicKey
		);
		await userAccount.subscribe();
		console.log(
			'before unsettledPnl:',
			user0.positions[0].unsettledPnl.toString()
		);

		const unrealizedPnl = userAccount.getUnrealizedPNL(); //false, marketIndex);
		assert(unrealizedPnl.eq(new BN(-2498026)));

		console.log('before unrealizedPnl:', unrealizedPnl.toString());
		console.log(
			'before quoteAssetAmount:',
			user0.positions[0].quoteAssetAmount.toNumber()
		);
		console.log(
			'before quoteEntryAmount:',
			user0.positions[0].quoteEntryAmount.toNumber()
		);

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			new BN(0)
		);

		await clearingHouse.fetchAccounts();
		await userAccount.fetchAccounts();
		const market = clearingHouse.getMarketAccount(marketIndex);

		const userBankBalance = clearingHouse.getUserBankBalance(
			QUOTE_ASSET_BANK_INDEX
		);

		console.log(
			'market.pnlPool.balance:',
			market.pnlPool.balance.toString(),
			'market.amm.pnlPool.balance:',
			market.amm.pnlPool.balance.toString(),
			'market.amm.totalFeeMinusDistributions:',
			market.amm.totalFeeMinusDistributions.toString()
		);

		const user = clearingHouse.getUserAccount();
		console.log(
			'after unsettledPnl:',
			user.positions[0].unsettledPnl.toString()
		);
		assert(user.positions[0].unsettledPnl.eq(ZERO));

		const unrealizedPnl2 = userAccount.getUnrealizedPNL(); //(false, marketIndex);

		console.log('after unrealizedPnl:', unrealizedPnl2.toString());
		assert(unrealizedPnl2.eq(ZERO));
		console.log(
			'quoteAssetAmount:',
			user.positions[0].quoteAssetAmount.toNumber()
		);
		console.log(
			'quoteEntryAmount:',
			user.positions[0].quoteEntryAmount.toNumber()
		);

		const ogCostBasis = user.positions[0].quoteAssetAmount.add(
			unrealizedPnl //.add(user0.positions[0].unsettledPnl)
		);
		console.log('ogCostBasis:', ogCostBasis.toString());
		assert(ogCostBasis.eq(user.positions[0].quoteEntryAmount));

		const newTokenAmount = clearingHouse.getQuoteAssetTokenAmount();
		console.log(
			'getQuoteAssetTokenAmount:',
			clearingHouse.getQuoteAssetTokenAmount().toString(),
			userBankBalance.balanceType
		);
		assert(isVariant(userBankBalance.balanceType, 'deposit'));

		assert(
			newTokenAmount
				.add(market.pnlPool.balance)
				.add(market.amm.pnlPool.balance)
				.eq(ogTokenAmount)
		);

		await eventSubscriber.awaitTx(txSig);
		const tradeRecord = eventSubscriber.getEventsArray('TradeRecord')[0].data;
		assert.ok(tradeRecord.user.equals(userAccountPublicKey));
		assert.ok(tradeRecord.recordId.eq(new BN(1)));
		assert.ok(
			JSON.stringify(tradeRecord.direction) ===
				JSON.stringify(PositionDirection.SHORT)
		);
		// console.log(tradeRecord.baseAssetAmount.toNumber());
		assert.ok(tradeRecord.baseAssetAmount.eq(new BN(497549506175864)));
		assert.ok(tradeRecord.quoteAssetAmount.eq(new BN(49750000)));

		assert.ok(tradeRecord.marketIndex.eq(new BN(0)));

		await clearingHouse.closePosition(marketIndex);
	});

	it('Take short position (w/ positive unrealized pnl)', async () => {
		const marketIndex = new BN(0);

		const ogTokenAmount = clearingHouse.getQuoteAssetTokenAmount();
		console.log('og getQuoteAssetTokenAmount:', ogTokenAmount.toString());

		const newUSDCNotionalAmount = calculateTradeAmount(usdcAmount);
		const txSig = await clearingHouse.openPosition(
			PositionDirection.SHORT,
			newUSDCNotionalAmount.div(new BN(10)),
			marketIndex
		);

		// make user have small loss
		await clearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(MARK_PRICE_PRECISION.toNumber() * 0.95)
		);
		await clearingHouse.closePosition(marketIndex);

		await clearingHouse.fetchAccounts();

		const market0 = clearingHouse.getMarketAccount(marketIndex);
		console.log(
			'market0.amm.pnlPool.balance:',
			market0.amm.pnlPool.balance.toString(),
			'market0.amm.totalFeeMinusDistributions:',
			market0.amm.totalFeeMinusDistributions.toString()
		);

		const user0 = clearingHouse.getUserAccount();
		userAccount = ClearingHouseUser.from(
			clearingHouse,
			provider.wallet.publicKey
		);
		await userAccount.subscribe();
		console.log(
			'before unsettledPnl:',
			user0.positions[0].unsettledPnl.toString()
		);

		const unrealizedPnl = userAccount.getUnrealizedPNL(); //false, marketIndex);
		// assert(unrealizedPnl.eq(new BN(-2498026)));

		console.log('before unrealizedPnl:', unrealizedPnl.toString());
		console.log(
			'before quoteAssetAmount:',
			user0.positions[0].quoteAssetAmount.toNumber()
		);
		console.log(
			'before quoteEntryAmount:',
			user0.positions[0].quoteEntryAmount.toNumber()
		);

		// close and
		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			new BN(0)
		);

		await clearingHouse.fetchAccounts();
		await userAccount.fetchAccounts();
		const market = clearingHouse.getMarketAccount(marketIndex);

		const userBankBalance = clearingHouse.getUserBankBalance(
			QUOTE_ASSET_BANK_INDEX
		);

		console.log(
			'market.pnlPool.balance:',
			market.pnlPool.balance.toString(),
			'market.amm.pnlPool.balance:',
			market.amm.pnlPool.balance.toString(),
			'market.amm.totalFeeMinusDistributions:',
			market.amm.totalFeeMinusDistributions.toString()
		);

		const user = clearingHouse.getUserAccount();
		console.log(
			'after unsettledPnl:',
			user.positions[0].unsettledPnl.toString()
		);
		assert(user.positions[0].unsettledPnl.eq(ZERO));

		const unrealizedPnl2 = userAccount.getUnrealizedPNL(); //(false, marketIndex);

		console.log('after unrealizedPnl:', unrealizedPnl2.toString());
		assert(unrealizedPnl2.eq(ZERO));
		console.log(
			'quoteAssetAmount:',
			user.positions[0].quoteAssetAmount.toNumber()
		);
		console.log(
			'quoteEntryAmount:',
			user.positions[0].quoteEntryAmount.toNumber()
		);

		const ogCostBasis = user.positions[0].quoteAssetAmount;
		console.log('ogCostBasis:', ogCostBasis.toString());
		assert(ogCostBasis.eq(user.positions[0].quoteEntryAmount));

		const newTokenAmount = clearingHouse.getQuoteAssetTokenAmount();
		console.log(
			'getQuoteAssetTokenAmount:',
			clearingHouse.getQuoteAssetTokenAmount().toString(),
			userBankBalance.balanceType
		);
		assert(isVariant(userBankBalance.balanceType, 'deposit'));

		assert(
			newTokenAmount
				.add(market.pnlPool.balance)
				.add(market.amm.pnlPool.balance)
				.eq(new BN(10000000))
		);

		await eventSubscriber.awaitTx(txSig);
		const tradeRecord = eventSubscriber.getEventsArray('TradeRecord')[0].data;
		assert.ok(tradeRecord.user.equals(userAccountPublicKey));
		assert.ok(tradeRecord.marketIndex.eq(new BN(0)));
	});
});
