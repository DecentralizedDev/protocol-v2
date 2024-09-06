import {
	AnchorProvider,
	BN,
	Idl,
	Program,
	ProgramAccount,
} from '@coral-xyz/anchor';
import { Idl as Idl30, Program as Program30 } from '@coral-xyz/anchor-30';
import bs58 from 'bs58';
import {
	ASSOCIATED_TOKEN_PROGRAM_ID,
	createAssociatedTokenAccountInstruction,
	createCloseAccountInstruction,
	createInitializeAccountInstruction,
	getAssociatedTokenAddress,
	TOKEN_PROGRAM_ID,
	TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import {
	StateAccount,
	IWallet,
	PositionDirection,
	UserAccount,
	PerpMarketAccount,
	OrderParams,
	Order,
	SpotMarketAccount,
	SpotPosition,
	MakerInfo,
	TakerInfo,
	OptionalOrderParams,
	OrderType,
	ReferrerInfo,
	MarketType,
	TxParams,
	SerumV3FulfillmentConfigAccount,
	isVariant,
	ReferrerNameAccount,
	OrderTriggerCondition,
	SpotBalanceType,
	PerpMarketExtendedInfo,
	UserStatsAccount,
	ModifyOrderParams,
	PhoenixV1FulfillmentConfigAccount,
	ModifyOrderPolicy,
	SwapReduceOnly,
	SettlePnlMode,
	SignedTxData,
	MappedRecord,
	OpenbookV2FulfillmentConfigAccount,
} from './types';
import * as anchor from '@coral-xyz/anchor';
import driftIDL from './idl/drift.json';

import {
	Connection,
	PublicKey,
	TransactionSignature,
	ConfirmOptions,
	Transaction,
	TransactionInstruction,
	AccountMeta,
	Keypair,
	LAMPORTS_PER_SOL,
	Signer,
	SystemProgram,
	AddressLookupTableAccount,
	TransactionVersion,
	VersionedTransaction,
	BlockhashWithExpiryBlockHeight,
} from '@solana/web3.js';

import { TokenFaucet } from './tokenFaucet';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';
import {
	getDriftSignerPublicKey,
	getDriftStateAccountPublicKey,
	getInsuranceFundStakeAccountPublicKey,
	getOpenbookV2FulfillmentConfigPublicKey,
	getPerpMarketPublicKey,
	getPhoenixFulfillmentConfigPublicKey,
	getPythPullOraclePublicKey,
	getReferrerNamePublicKeySync,
	getSerumFulfillmentConfigPublicKey,
	getSerumSignerPublicKey,
	getSpotMarketPublicKey,
	getUserAccountPublicKey,
	getUserAccountPublicKeySync,
	getUserStatsAccountPublicKey,
} from './addresses/pda';
import {
	DriftClientAccountSubscriber,
	DriftClientAccountEvents,
	DataAndSlot,
} from './accounts/types';
import { DriftClientMetricsEvents } from './types';
import { TxSender, TxSigAndSlot } from './tx/types';
import {
	BASE_PRECISION,
	PRICE_PRECISION,
	QUOTE_SPOT_MARKET_INDEX,
	ZERO,
	QUOTE_PRECISION,
	GOV_SPOT_MARKET_INDEX,
} from './constants/numericConstants';
import { findDirectionToClose, positionIsAvailable } from './math/position';
import { getSignedTokenAmount, getTokenAmount } from './math/spotBalance';
import { decodeName, DEFAULT_USER_NAME, encodeName } from './userName';
import { OraclePriceData } from './oracles/types';
import { DriftClientConfig } from './driftClientConfig';
import { PollingDriftClientAccountSubscriber } from './accounts/pollingDriftClientAccountSubscriber';
import { WebSocketDriftClientAccountSubscriber } from './accounts/webSocketDriftClientAccountSubscriber';
import { RetryTxSender } from './tx/retryTxSender';
import { User } from './user';
import { UserSubscriptionConfig } from './userConfig';
import { configs, DRIFT_PROGRAM_ID } from './config';
import { WRAPPED_SOL_MINT } from './constants/spotMarkets';
import { UserStats } from './userStats';
import { isSpotPositionAvailable } from './math/spotPosition';
import { calculateMarketMaxAvailableInsurance } from './math/market';
import { fetchUserStatsAccount } from './accounts/fetch';
import { castNumberToSpotPrecision } from './math/spotMarket';
import {
	JupiterClient,
	QuoteResponse,
	Route,
	SwapMode,
} from './jupiter/jupiterClient';
import { getNonIdleUserFilter } from './memcmp';
import { UserStatsSubscriptionConfig } from './userStatsConfig';
import { getMarinadeDepositIx, getMarinadeFinanceProgram } from './marinade';
import { getOrderParams } from './orderParams';
import { numberToSafeBN } from './math/utils';
import { TransactionParamProcessor } from './tx/txParamProcessor';
import { isOracleValid, trimVaaSignatures } from './math/oracles';
import { TxHandler } from './tx/txHandler';
import {
	wormholeCoreBridgeIdl,
	DEFAULT_RECEIVER_PROGRAM_ID,
} from '@pythnetwork/pyth-solana-receiver';
import { parseAccumulatorUpdateData } from '@pythnetwork/price-service-sdk';
import {
	DEFAULT_WORMHOLE_PROGRAM_ID,
	getGuardianSetPda,
} from '@pythnetwork/pyth-solana-receiver/lib/address';
import { DRIFT_ORACLE_RECEIVER_ID } from './config';
import { WormholeCoreBridgeSolana } from '@pythnetwork/pyth-solana-receiver/lib/idl/wormhole_core_bridge_solana';
import { PythSolanaReceiver } from '@pythnetwork/pyth-solana-receiver/lib/idl/pyth_solana_receiver';
import { getFeedIdUint8Array, trimFeedId } from './util/pythPullOracleUtils';
import { isVersionedTransaction } from './tx/utils';
import pythSolanaReceiverIdl from './idl/pyth_solana_receiver.json';
import { asV0Tx, PullFeed } from '@switchboard-xyz/on-demand';
import switchboardOnDemandIdl from './idl/switchboard_on_demand_30.json';

type RemainingAccountParams = {
	userAccounts: UserAccount[];
	writablePerpMarketIndexes?: number[];
	writableSpotMarketIndexes?: number[];
	readablePerpMarketIndex?: number | number[];
	readableSpotMarketIndexes?: number[];
	useMarketLastSlotCache?: boolean;
	userAccountNotAvailable?: boolean;
};

/**
 * # DriftClient
 * This class is the main way to interact with Drift Protocol. It allows you to subscribe to the various accounts where the Market's state is stored, as well as: opening positions, liquidating, settling funding, depositing & withdrawing, and more.
 */
export class DriftClient {
	connection: Connection;
	wallet: IWallet;
	public program: Program;
	provider: AnchorProvider;
	opts?: ConfirmOptions;
	users = new Map<string, User>();
	userStats?: UserStats;
	activeSubAccountId: number;
	userAccountSubscriptionConfig: UserSubscriptionConfig;
	userStatsAccountSubscriptionConfig: UserStatsSubscriptionConfig;
	accountSubscriber: DriftClientAccountSubscriber;
	eventEmitter: StrictEventEmitter<EventEmitter, DriftClientAccountEvents>;
	metricsEventEmitter: StrictEventEmitter<
		EventEmitter,
		DriftClientMetricsEvents
	>;
	_isSubscribed = false;
	txSender: TxSender;
	perpMarketLastSlotCache = new Map<number, number>();
	spotMarketLastSlotCache = new Map<number, number>();
	mustIncludePerpMarketIndexes = new Set<number>();
	mustIncludeSpotMarketIndexes = new Set<number>();
	authority: PublicKey;
	marketLookupTable: PublicKey;
	lookupTableAccount: AddressLookupTableAccount;
	includeDelegates?: boolean;
	authoritySubAccountMap?: Map<string, number[]>;
	skipLoadUsers?: boolean;
	txVersion: TransactionVersion;
	txParams: TxParams;
	enableMetricsEvents?: boolean;

	txHandler: TxHandler;

	receiverProgram?: Program<PythSolanaReceiver>;
	wormholeProgram?: Program<WormholeCoreBridgeSolana>;
	sbOnDemandProgram?: Program30<Idl30>;
	sbProgramFeedConfigs?: Map<string, any>;

	public get isSubscribed() {
		return this._isSubscribed && this.accountSubscriber.isSubscribed;
	}

	public set isSubscribed(val: boolean) {
		this._isSubscribed = val;
	}

	public constructor(config: DriftClientConfig) {
		this.connection = config.connection;
		this.wallet = config.wallet;
		this.opts = config.opts || {
			...AnchorProvider.defaultOptions(),
			commitment: config?.connection?.commitment,
			preflightCommitment: config?.connection?.commitment, // At the moment this ensures that our transaction simulations (which use Connection object) will use the same commitment level as our Transaction blockhashes (which use these opts)
		};
		this.provider = new AnchorProvider(
			config.connection,
			// @ts-ignore
			config.wallet,
			this.opts
		);
		this.program = new Program(
			driftIDL as Idl,
			config.programID ?? new PublicKey(DRIFT_PROGRAM_ID),
			this.provider
		);

		this.authority = config.authority ?? this.wallet.publicKey;
		this.activeSubAccountId = config.activeSubAccountId ?? 0;
		this.skipLoadUsers = config.skipLoadUsers ?? false;
		this.txVersion = config.txVersion ?? 'legacy';
		this.txParams = {
			computeUnits: config.txParams?.computeUnits ?? 600_000,
			computeUnitsPrice: config.txParams?.computeUnitsPrice ?? 0,
		};

		this.txHandler =
			config?.txHandler ??
			new TxHandler({
				connection: this.connection,
				wallet: this.provider.wallet,
				confirmationOptions: this.opts,
				opts: {
					returnBlockHeightsWithSignedTxCallbackData:
						config.enableMetricsEvents,
					onSignedCb: this.handleSignedTransaction.bind(this),
					preSignedCb: this.handlePreSignedTransaction.bind(this),
				},
				config: config.txHandlerConfig,
			});

		if (config.includeDelegates && config.subAccountIds) {
			throw new Error(
				'Can only pass one of includeDelegates or subAccountIds. If you want to specify subaccount ids for multiple authorities, pass authoritySubaccountMap instead'
			);
		}

		if (config.authoritySubAccountMap && config.subAccountIds) {
			throw new Error(
				'Can only pass one of authoritySubaccountMap or subAccountIds'
			);
		}

		if (config.authoritySubAccountMap && config.includeDelegates) {
			throw new Error(
				'Can only pass one of authoritySubaccountMap or includeDelegates'
			);
		}

		this.authoritySubAccountMap = config.authoritySubAccountMap
			? config.authoritySubAccountMap
			: config.subAccountIds
			? new Map([[this.authority.toString(), config.subAccountIds]])
			: new Map<string, number[]>();

		this.includeDelegates = config.includeDelegates ?? false;
		if (config.accountSubscription?.type === 'polling') {
			this.userAccountSubscriptionConfig = {
				type: 'polling',
				accountLoader: config.accountSubscription.accountLoader,
			};
			this.userStatsAccountSubscriptionConfig = {
				type: 'polling',
				accountLoader: config.accountSubscription.accountLoader,
			};
		} else {
			this.userAccountSubscriptionConfig = {
				type: 'websocket',
				resubTimeoutMs: config.accountSubscription?.resubTimeoutMs,
				logResubMessages: config.accountSubscription?.logResubMessages,
				commitment: config.accountSubscription?.commitment,
			};
			this.userStatsAccountSubscriptionConfig = {
				type: 'websocket',
				resubTimeoutMs: config.accountSubscription?.resubTimeoutMs,
				logResubMessages: config.accountSubscription?.logResubMessages,
				commitment: config.accountSubscription?.commitment,
			};
		}

		if (config.userStats) {
			this.userStats = new UserStats({
				driftClient: this,
				userStatsAccountPublicKey: getUserStatsAccountPublicKey(
					this.program.programId,
					this.authority
				),
				accountSubscription: this.userAccountSubscriptionConfig,
			});
		}

		this.marketLookupTable = config.marketLookupTable;
		if (config.env && !this.marketLookupTable) {
			this.marketLookupTable = new PublicKey(
				configs[config.env].MARKET_LOOKUP_TABLE
			);
		}

		const noMarketsAndOraclesSpecified =
			config.perpMarketIndexes === undefined &&
			config.spotMarketIndexes === undefined &&
			config.oracleInfos === undefined;
		if (config.accountSubscription?.type === 'polling') {
			this.accountSubscriber = new PollingDriftClientAccountSubscriber(
				this.program,
				config.accountSubscription.accountLoader,
				config.perpMarketIndexes ?? [],
				config.spotMarketIndexes ?? [],
				config.oracleInfos ?? [],
				noMarketsAndOraclesSpecified
			);
		} else {
			this.accountSubscriber = new WebSocketDriftClientAccountSubscriber(
				this.program,
				config.perpMarketIndexes ?? [],
				config.spotMarketIndexes ?? [],
				config.oracleInfos ?? [],
				noMarketsAndOraclesSpecified,
				{
					resubTimeoutMs: config.accountSubscription?.resubTimeoutMs,
					logResubMessages: config.accountSubscription?.logResubMessages,
				},
				config.accountSubscription?.commitment
			);
		}
		this.eventEmitter = this.accountSubscriber.eventEmitter;

		this.metricsEventEmitter = new EventEmitter();

		if (config.enableMetricsEvents) {
			this.enableMetricsEvents = true;
		}

		this.txSender =
			config.txSender ??
			new RetryTxSender({
				connection: this.connection,
				wallet: this.wallet,
				opts: this.opts,
				txHandler: this.txHandler,
			});
	}

	public getUserMapKey(subAccountId: number, authority: PublicKey): string {
		return `${subAccountId}_${authority.toString()}`;
	}

	createUser(
		subAccountId: number,
		accountSubscriptionConfig: UserSubscriptionConfig,
		authority?: PublicKey
	): User {
		const userAccountPublicKey = getUserAccountPublicKeySync(
			this.program.programId,
			authority ?? this.authority,
			subAccountId
		);

		return new User({
			driftClient: this,
			userAccountPublicKey,
			accountSubscription: accountSubscriptionConfig,
		});
	}

	public async subscribe(): Promise<boolean> {
		let subscribePromises = [this.addAndSubscribeToUsers()].concat(
			this.accountSubscriber.subscribe()
		);

		if (this.userStats !== undefined) {
			subscribePromises = subscribePromises.concat(this.userStats.subscribe());
		}
		this.isSubscribed = (await Promise.all(subscribePromises)).reduce(
			(success, prevSuccess) => success && prevSuccess
		);

		return this.isSubscribed;
	}

	subscribeUsers(): Promise<boolean>[] {
		return [...this.users.values()].map((user) => user.subscribe());
	}

	/**
	 *	Forces the accountSubscriber to fetch account updates from rpc
	 */
	public async fetchAccounts(): Promise<void> {
		let promises = [...this.users.values()]
			.map((user) => user.fetchAccounts())
			.concat(this.accountSubscriber.fetch());
		if (this.userStats) {
			promises = promises.concat(this.userStats.fetchAccounts());
		}
		await Promise.all(promises);
	}

	public async unsubscribe(): Promise<void> {
		let unsubscribePromises = this.unsubscribeUsers().concat(
			this.accountSubscriber.unsubscribe()
		);
		if (this.userStats !== undefined) {
			unsubscribePromises = unsubscribePromises.concat(
				this.userStats.unsubscribe()
			);
		}
		await Promise.all(unsubscribePromises);
		this.isSubscribed = false;
	}

	unsubscribeUsers(): Promise<void>[] {
		return [...this.users.values()].map((user) => user.unsubscribe());
	}

	statePublicKey?: PublicKey;
	public async getStatePublicKey(): Promise<PublicKey> {
		if (this.statePublicKey) {
			return this.statePublicKey;
		}
		this.statePublicKey = await getDriftStateAccountPublicKey(
			this.program.programId
		);
		return this.statePublicKey;
	}

	signerPublicKey?: PublicKey;
	public getSignerPublicKey(): PublicKey {
		if (this.signerPublicKey) {
			return this.signerPublicKey;
		}
		this.signerPublicKey = getDriftSignerPublicKey(this.program.programId);
		return this.signerPublicKey;
	}

	public getStateAccount(): StateAccount {
		return this.accountSubscriber.getStateAccountAndSlot().data;
	}

	/**
	 * Forces a fetch to rpc before returning accounts. Useful for anchor tests.
	 */
	public async forceGetStateAccount(): Promise<StateAccount> {
		await this.accountSubscriber.fetch();
		return this.accountSubscriber.getStateAccountAndSlot().data;
	}

	public getPerpMarketAccount(
		marketIndex: number
	): PerpMarketAccount | undefined {
		return this.accountSubscriber.getMarketAccountAndSlot(marketIndex)?.data;
	}

	/**
	 * Forces a fetch to rpc before returning accounts. Useful for anchor tests.
	 * @param marketIndex
	 */
	public async forceGetPerpMarketAccount(
		marketIndex: number
	): Promise<PerpMarketAccount | undefined> {
		await this.accountSubscriber.fetch();
		let data =
			this.accountSubscriber.getMarketAccountAndSlot(marketIndex)?.data;
		let i = 0;
		while (data === undefined && i < 10) {
			await this.accountSubscriber.fetch();
			data = this.accountSubscriber.getMarketAccountAndSlot(marketIndex)?.data;
			i++;
		}
		return data;
	}

	public getPerpMarketAccounts(): PerpMarketAccount[] {
		return this.accountSubscriber
			.getMarketAccountsAndSlots()
			.filter((value) => value !== undefined)
			.map((value) => value.data);
	}

	public getSpotMarketAccount(
		marketIndex: number
	): SpotMarketAccount | undefined {
		return this.accountSubscriber.getSpotMarketAccountAndSlot(marketIndex).data;
	}

	/**
	 * Forces a fetch to rpc before returning accounts. Useful for anchor tests.
	 * @param marketIndex
	 */
	public async forceGetSpotMarketAccount(
		marketIndex: number
	): Promise<SpotMarketAccount | undefined> {
		await this.accountSubscriber.fetch();
		return this.accountSubscriber.getSpotMarketAccountAndSlot(marketIndex).data;
	}

	public getSpotMarketAccounts(): SpotMarketAccount[] {
		return this.accountSubscriber
			.getSpotMarketAccountsAndSlots()
			.filter((value) => value !== undefined)
			.map((value) => value.data);
	}

	public getQuoteSpotMarketAccount(): SpotMarketAccount {
		return this.accountSubscriber.getSpotMarketAccountAndSlot(
			QUOTE_SPOT_MARKET_INDEX
		).data;
	}

	public getOraclePriceDataAndSlot(
		oraclePublicKey: PublicKey
	): DataAndSlot<OraclePriceData> | undefined {
		return this.accountSubscriber.getOraclePriceDataAndSlot(oraclePublicKey);
	}

	public async getSerumV3FulfillmentConfig(
		serumMarket: PublicKey
	): Promise<SerumV3FulfillmentConfigAccount> {
		const address = await getSerumFulfillmentConfigPublicKey(
			this.program.programId,
			serumMarket
		);
		return (await this.program.account.serumV3FulfillmentConfig.fetch(
			address
		)) as SerumV3FulfillmentConfigAccount;
	}

	public async getSerumV3FulfillmentConfigs(): Promise<
		SerumV3FulfillmentConfigAccount[]
	> {
		const accounts = await this.program.account.serumV3FulfillmentConfig.all();
		return accounts.map(
			(account) => account.account
		) as SerumV3FulfillmentConfigAccount[];
	}

	public async getPhoenixV1FulfillmentConfig(
		phoenixMarket: PublicKey
	): Promise<PhoenixV1FulfillmentConfigAccount> {
		const address = await getPhoenixFulfillmentConfigPublicKey(
			this.program.programId,
			phoenixMarket
		);
		return (await this.program.account.phoenixV1FulfillmentConfig.fetch(
			address
		)) as PhoenixV1FulfillmentConfigAccount;
	}

	public async getPhoenixV1FulfillmentConfigs(): Promise<
		PhoenixV1FulfillmentConfigAccount[]
	> {
		const accounts =
			await this.program.account.phoenixV1FulfillmentConfig.all();
		return accounts.map(
			(account) => account.account
		) as PhoenixV1FulfillmentConfigAccount[];
	}

	public async getOpenbookV2FulfillmentConfig(
		openbookMarket: PublicKey
	): Promise<OpenbookV2FulfillmentConfigAccount> {
		const address = getOpenbookV2FulfillmentConfigPublicKey(
			this.program.programId,
			openbookMarket
		);
		return (await this.program.account.openbookV2FulfillmentConfig.fetch(
			address
		)) as OpenbookV2FulfillmentConfigAccount;
	}

	public async getOpenbookV2FulfillmentConfigs(): Promise<
		OpenbookV2FulfillmentConfigAccount[]
	> {
		const accounts =
			await this.program.account.openbookV2FulfillmentConfig.all();
		return accounts.map(
			(account) => account.account
		) as OpenbookV2FulfillmentConfigAccount[];
	}

	public async fetchMarketLookupTableAccount(): Promise<AddressLookupTableAccount> {
		if (this.lookupTableAccount) return this.lookupTableAccount;

		if (!this.marketLookupTable) {
			console.log('Market lookup table address not set');
			return;
		}

		const lookupTableAccount = (
			await this.connection.getAddressLookupTable(this.marketLookupTable)
		).value;
		this.lookupTableAccount = lookupTableAccount;

		return lookupTableAccount;
	}

	/**
	 * Update the wallet to use for drift transactions and linked user account
	 * @param newWallet
	 * @param subAccountIds
	 * @param activeSubAccountId
	 * @param includeDelegates
	 */
	public async updateWallet(
		newWallet: IWallet,
		subAccountIds?: number[],
		activeSubAccountId?: number,
		includeDelegates?: boolean,
		authoritySubaccountMap?: Map<string, number[]>
	): Promise<boolean> {
		const newProvider = new AnchorProvider(
			this.connection,
			// @ts-ignore
			newWallet,
			this.opts
		);
		const newProgram = new Program(
			driftIDL as Idl,
			this.program.programId,
			newProvider
		);

		this.skipLoadUsers = false;
		// Update provider for txSender with new wallet details
		this.txSender.wallet = newWallet;
		this.wallet = newWallet;
		this.txHandler.updateWallet(newWallet);
		this.provider = newProvider;
		this.program = newProgram;
		this.authority = newWallet.publicKey;
		this.activeSubAccountId = activeSubAccountId;
		this.userStatsAccountPublicKey = undefined;
		this.includeDelegates = includeDelegates ?? false;
		const walletSupportsVersionedTxns =
			//@ts-ignore
			this.wallet.supportedTransactionVersions?.size ?? 0 > 1;
		this.txVersion = walletSupportsVersionedTxns ? 0 : 'legacy';

		if (includeDelegates && subAccountIds) {
			throw new Error(
				'Can only pass one of includeDelegates or subAccountIds. If you want to specify subaccount ids for multiple authorities, pass authoritySubaccountMap instead'
			);
		}

		if (authoritySubaccountMap && subAccountIds) {
			throw new Error(
				'Can only pass one of authoritySubaccountMap or subAccountIds'
			);
		}

		if (authoritySubaccountMap && includeDelegates) {
			throw new Error(
				'Can only pass one of authoritySubaccountMap or includeDelegates'
			);
		}

		this.authoritySubAccountMap = authoritySubaccountMap
			? authoritySubaccountMap
			: subAccountIds
			? new Map([[this.authority.toString(), subAccountIds]])
			: new Map<string, number[]>();

		/* Reset user stats account */
		if (this.userStats?.isSubscribed) {
			await this.userStats.unsubscribe();
		}

		this.userStats = undefined;

		this.userStats = new UserStats({
			driftClient: this,
			userStatsAccountPublicKey: this.getUserStatsAccountPublicKey(),
			accountSubscription: this.userStatsAccountSubscriptionConfig,
		});

		await this.userStats.subscribe();

		let success = true;

		if (this.isSubscribed) {
			await Promise.all(this.unsubscribeUsers());
			this.users.clear();
			success = await this.addAndSubscribeToUsers();
		}

		return success;
	}

	/**
	 * Update the subscribed accounts to a given authority, while leaving the
	 * connected wallet intact. This allows a user to emulate another user's
	 * account on the UI and sign permissionless transactions with their own wallet.
	 * @param emulateAuthority
	 */
	public async emulateAccount(emulateAuthority: PublicKey): Promise<boolean> {
		this.skipLoadUsers = false;
		// Update provider for txSender with new wallet details
		this.authority = emulateAuthority;
		this.userStatsAccountPublicKey = undefined;
		this.includeDelegates = true;
		const walletSupportsVersionedTxns =
			//@ts-ignore
			this.wallet.supportedTransactionVersions?.size ?? 0 > 1;
		this.txVersion = walletSupportsVersionedTxns ? 0 : 'legacy';

		this.authoritySubAccountMap = new Map<string, number[]>();

		/* Reset user stats account */
		if (this.userStats?.isSubscribed) {
			await this.userStats.unsubscribe();
		}

		this.userStats = undefined;

		this.userStats = new UserStats({
			driftClient: this,
			userStatsAccountPublicKey: this.getUserStatsAccountPublicKey(),
			accountSubscription: this.userStatsAccountSubscriptionConfig,
		});

		await this.userStats.subscribe();

		let success = true;

		if (this.isSubscribed) {
			await Promise.all(this.unsubscribeUsers());
			this.users.clear();
			success = await this.addAndSubscribeToUsers(emulateAuthority);
		}

		return success;
	}

	public async switchActiveUser(subAccountId: number, authority?: PublicKey) {
		const authorityChanged = authority && !this.authority?.equals(authority);

		this.activeSubAccountId = subAccountId;
		this.authority = authority ?? this.authority;
		this.userStatsAccountPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			this.authority
		);

		/* If changing the user authority ie switching from delegate to non-delegate account, need to re-subscribe to the user stats account */
		if (authorityChanged) {
			if (this.userStats && this.userStats.isSubscribed) {
				await this.userStats.unsubscribe();
			}

			this.userStats = new UserStats({
				driftClient: this,
				userStatsAccountPublicKey: this.userStatsAccountPublicKey,
				accountSubscription: this.userAccountSubscriptionConfig,
			});

			this.userStats.subscribe();
		}
	}

	public async addUser(
		subAccountId: number,
		authority?: PublicKey,
		userAccount?: UserAccount
	): Promise<boolean> {
		authority = authority ?? this.authority;
		const userKey = this.getUserMapKey(subAccountId, authority);

		if (this.users.has(userKey) && this.users.get(userKey).isSubscribed) {
			return true;
		}

		const user = this.createUser(
			subAccountId,
			this.userAccountSubscriptionConfig,
			authority
		);

		const result = await user.subscribe(userAccount);

		if (result) {
			this.users.set(userKey, user);
			return true;
		} else {
			return false;
		}
	}

	/**
	 * Adds and subscribes to users based on params set by the constructor or by updateWallet.
	 */
	public async addAndSubscribeToUsers(authority?: PublicKey): Promise<boolean> {
		// save the rpc calls if driftclient is initialized without a real wallet
		if (this.skipLoadUsers) return true;

		let result = true;

		if (this.authoritySubAccountMap && this.authoritySubAccountMap.size > 0) {
			this.authoritySubAccountMap.forEach(async (value, key) => {
				for (const subAccountId of value) {
					result =
						result && (await this.addUser(subAccountId, new PublicKey(key)));
				}
			});

			if (this.activeSubAccountId == undefined) {
				this.switchActiveUser(
					[...this.authoritySubAccountMap.values()][0][0] ?? 0,
					new PublicKey(
						[...this.authoritySubAccountMap.keys()][0] ??
							this.authority.toString()
					)
				);
			}
		} else {
			let userAccounts = [];
			let delegatedAccounts = [];

			const userAccountsPromise = this.getUserAccountsForAuthority(
				authority ?? this.wallet.publicKey
			);

			if (this.includeDelegates) {
				const delegatedAccountsPromise = this.getUserAccountsForDelegate(
					authority ?? this.wallet.publicKey
				);
				[userAccounts, delegatedAccounts] = await Promise.all([
					userAccountsPromise,
					delegatedAccountsPromise,
				]);

				!userAccounts && (userAccounts = []);
				!delegatedAccounts && (delegatedAccounts = []);
			} else {
				userAccounts = (await userAccountsPromise) ?? [];
			}

			const allAccounts = userAccounts.concat(delegatedAccounts);
			const addAllAccountsPromise = allAccounts.map((acc) =>
				this.addUser(acc.subAccountId, acc.authority, acc)
			);

			const addAllAccountsResults = await Promise.all(addAllAccountsPromise);
			result = addAllAccountsResults.every((res) => !!res);

			if (this.activeSubAccountId == undefined) {
				this.switchActiveUser(
					userAccounts.concat(delegatedAccounts)[0]?.subAccountId ?? 0,
					userAccounts.concat(delegatedAccounts)[0]?.authority ?? this.authority
				);
			}
		}

		return result;
	}

	public async initializeUserAccount(
		subAccountId = 0,
		name?: string,
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams
	): Promise<[TransactionSignature, PublicKey]> {
		const initializeIxs = [];

		const [userAccountPublicKey, initializeUserAccountIx] =
			await this.getInitializeUserInstructions(
				subAccountId,
				name,
				referrerInfo
			);

		if (subAccountId === 0) {
			if (
				!(await this.checkIfAccountExists(this.getUserStatsAccountPublicKey()))
			) {
				initializeIxs.push(await this.getInitializeUserStatsIx());
			}
		}

		initializeIxs.push(initializeUserAccountIx);
		const tx = await this.buildTransaction(initializeIxs, txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		await this.addUser(subAccountId);

		return [txSig, userAccountPublicKey];
	}

	async getInitializeUserInstructions(
		subAccountId = 0,
		name?: string,
		referrerInfo?: ReferrerInfo
	): Promise<[PublicKey, TransactionInstruction]> {
		const userAccountPublicKey = await getUserAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			subAccountId
		);

		const remainingAccounts = new Array<AccountMeta>();
		if (referrerInfo !== undefined) {
			remainingAccounts.push({
				pubkey: referrerInfo.referrer,
				isWritable: true,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: referrerInfo.referrerStats,
				isWritable: true,
				isSigner: false,
			});
		}

		const state = this.getStateAccount();
		if (!state.whitelistMint.equals(PublicKey.default)) {
			const associatedTokenPublicKey = await getAssociatedTokenAddress(
				state.whitelistMint,
				this.wallet.publicKey
			);
			remainingAccounts.push({
				pubkey: associatedTokenPublicKey,
				isWritable: false,
				isSigner: false,
			});
		}

		if (name === undefined) {
			if (subAccountId === 0) {
				name = DEFAULT_USER_NAME;
			} else {
				name = `Subaccount ${subAccountId + 1}`;
			}
		}

		const nameBuffer = encodeName(name);
		const initializeUserAccountIx =
			await this.program.instruction.initializeUser(subAccountId, nameBuffer, {
				accounts: {
					user: userAccountPublicKey,
					userStats: this.getUserStatsAccountPublicKey(),
					authority: this.wallet.publicKey,
					payer: this.wallet.publicKey,
					rent: anchor.web3.SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
					state: await this.getStatePublicKey(),
				},
				remainingAccounts,
			});

		return [userAccountPublicKey, initializeUserAccountIx];
	}

	async getInitializeUserStatsIx(): Promise<TransactionInstruction> {
		return await this.program.instruction.initializeUserStats({
			accounts: {
				userStats: this.getUserStatsAccountPublicKey(),
				authority: this.wallet.publicKey,
				payer: this.wallet.publicKey,
				rent: anchor.web3.SYSVAR_RENT_PUBKEY,
				systemProgram: anchor.web3.SystemProgram.programId,
				state: await this.getStatePublicKey(),
			},
		});
	}

	async getNextSubAccountId(): Promise<number> {
		const userStats = this.getUserStats();
		let userStatsAccount: UserStatsAccount;
		if (!userStats) {
			userStatsAccount = await fetchUserStatsAccount(
				this.connection,
				this.program,
				this.wallet.publicKey
			);
		} else {
			userStatsAccount = userStats.getAccount();
		}
		return userStatsAccount.numberOfSubAccountsCreated;
	}

	public async initializeReferrerName(
		name: string
	): Promise<TransactionSignature> {
		const userAccountPublicKey = getUserAccountPublicKeySync(
			this.program.programId,
			this.wallet.publicKey,
			0
		);

		const nameBuffer = encodeName(name);

		const referrerNameAccountPublicKey = getReferrerNamePublicKeySync(
			this.program.programId,
			nameBuffer
		);

		const tx = await this.program.transaction.initializeReferrerName(
			nameBuffer,
			{
				accounts: {
					referrerName: referrerNameAccountPublicKey,
					user: userAccountPublicKey,
					authority: this.wallet.publicKey,
					userStats: this.getUserStatsAccountPublicKey(),
					payer: this.wallet.publicKey,
					rent: anchor.web3.SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
				},
			}
		);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async updateUserName(
		name: string,
		subAccountId = 0
	): Promise<TransactionSignature> {
		const userAccountPublicKey = getUserAccountPublicKeySync(
			this.program.programId,
			this.wallet.publicKey,
			subAccountId
		);

		const nameBuffer = encodeName(name);
		const tx = await this.program.transaction.updateUserName(
			subAccountId,
			nameBuffer,
			{
				accounts: {
					user: userAccountPublicKey,
					authority: this.wallet.publicKey,
				},
			}
		);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async updateUserCustomMarginRatio(
		updates: { marginRatio: number; subAccountId: number }[],
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const ixs = await Promise.all(
			updates.map(async ({ marginRatio, subAccountId }) => {
				const ix = await this.getUpdateUserCustomMarginRatioIx(
					marginRatio,
					subAccountId
				);
				return ix;
			})
		);

		const tx = await this.buildTransaction(ixs, txParams ?? this.txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getUpdateUserCustomMarginRatioIx(
		marginRatio: number,
		subAccountId = 0
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = getUserAccountPublicKeySync(
			this.program.programId,
			this.wallet.publicKey,
			subAccountId
		);

		await this.addUser(subAccountId, this.wallet.publicKey);

		const ix = this.program.instruction.updateUserCustomMarginRatio(
			subAccountId,
			marginRatio,
			{
				accounts: {
					user: userAccountPublicKey,
					authority: this.wallet.publicKey,
				},
			}
		);

		return ix;
	}

	public async getUpdateUserMarginTradingEnabledIx(
		marginTradingEnabled: boolean,
		subAccountId = 0,
		userAccountPublicKey?: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKeyToUse =
			userAccountPublicKey ||
			getUserAccountPublicKeySync(
				this.program.programId,
				this.wallet.publicKey,
				subAccountId
			);

		await this.addUser(subAccountId, this.wallet.publicKey);

		let remainingAccounts;
		try {
			remainingAccounts = this.getRemainingAccounts({
				userAccounts: [this.getUserAccount(subAccountId)],
			});
		} catch (err) {
			remainingAccounts = [];
		}

		return await this.program.instruction.updateUserMarginTradingEnabled(
			subAccountId,
			marginTradingEnabled,
			{
				accounts: {
					user: userAccountPublicKeyToUse,
					authority: this.wallet.publicKey,
				},
				remainingAccounts,
			}
		);
	}

	public async updateUserMarginTradingEnabled(
		updates: { marginTradingEnabled: boolean; subAccountId: number }[]
	): Promise<TransactionSignature> {
		const ixs = await Promise.all(
			updates.map(async ({ marginTradingEnabled, subAccountId }) => {
				return await this.getUpdateUserMarginTradingEnabledIx(
					marginTradingEnabled,
					subAccountId
				);
			})
		);

		const tx = await this.buildTransaction(ixs, this.txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async updateUserDelegate(
		delegate: PublicKey,
		subAccountId = 0
	): Promise<TransactionSignature> {
		const tx = await this.program.transaction.updateUserDelegate(
			subAccountId,
			delegate,
			{
				accounts: {
					user: await this.getUserAccountPublicKey(),
					authority: this.wallet.publicKey,
				},
			}
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async updateUserAdvancedLp(
		updates: { advancedLp: boolean; subAccountId: number }[]
	): Promise<TransactionSignature> {
		const ixs = await Promise.all(
			updates.map(async ({ advancedLp, subAccountId }) => {
				return await this.getUpdateAdvancedDlpIx(advancedLp, subAccountId);
			})
		);

		const tx = await this.buildTransaction(ixs, this.txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getUpdateAdvancedDlpIx(
		advancedLp: boolean,
		subAccountId: number
	) {
		const ix = await this.program.instruction.updateUserAdvancedLp(
			subAccountId,
			advancedLp,
			{
				accounts: {
					user: getUserAccountPublicKeySync(
						this.program.programId,
						this.wallet.publicKey,
						subAccountId
					),
					authority: this.wallet.publicKey,
				},
			}
		);

		return ix;
	}

	public async updateUserReduceOnly(
		updates: { reduceOnly: boolean; subAccountId: number }[]
	): Promise<TransactionSignature> {
		const ixs = await Promise.all(
			updates.map(async ({ reduceOnly, subAccountId }) => {
				return await this.getUpdateUserReduceOnlyIx(reduceOnly, subAccountId);
			})
		);

		const tx = await this.buildTransaction(ixs, this.txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getUpdateUserReduceOnlyIx(
		reduceOnly: boolean,
		subAccountId: number
	) {
		const ix = await this.program.instruction.updateUserReduceOnly(
			subAccountId,
			reduceOnly,
			{
				accounts: {
					user: getUserAccountPublicKeySync(
						this.program.programId,
						this.wallet.publicKey,
						subAccountId
					),
					authority: this.wallet.publicKey,
				},
			}
		);

		return ix;
	}

	public async fetchAllUserAccounts(
		includeIdle = true
	): Promise<ProgramAccount<UserAccount>[]> {
		let filters = undefined;
		if (!includeIdle) {
			filters = [getNonIdleUserFilter()];
		}
		return (await this.program.account.user.all(
			filters
		)) as ProgramAccount<UserAccount>[];
	}

	public async getUserAccountsForDelegate(
		delegate: PublicKey
	): Promise<UserAccount[]> {
		const programAccounts = await this.program.account.user.all([
			{
				memcmp: {
					offset: 40,
					/** data to match, as base-58 encoded string and limited to less than 129 bytes */
					bytes: bs58.encode(delegate.toBuffer()),
				},
			},
		]);

		return programAccounts
			.map((programAccount) => programAccount.account as UserAccount)
			.sort((a, b) => a.subAccountId - b.subAccountId);
	}

	public async getUserAccountsAndAddressesForAuthority(
		authority: PublicKey
	): Promise<ProgramAccount<UserAccount>[]> {
		const programAccounts = await this.program.account.user.all([
			{
				memcmp: {
					offset: 8,
					/** data to match, as base-58 encoded string and limited to less than 129 bytes */
					bytes: bs58.encode(authority.toBuffer()),
				},
			},
		]);

		return programAccounts.map(
			(programAccount) => programAccount as ProgramAccount<UserAccount>
		);
	}

	public async getUserAccountsForAuthority(
		authority: PublicKey
	): Promise<UserAccount[]> {
		const programAccounts = await this.program.account.user.all([
			{
				memcmp: {
					offset: 8,
					/** data to match, as base-58 encoded string and limited to less than 129 bytes */
					bytes: bs58.encode(authority.toBuffer()),
				},
			},
		]);

		return programAccounts
			.map((programAccount) => programAccount.account as UserAccount)
			.sort((a, b) => a.subAccountId - b.subAccountId);
	}

	public async getReferredUserStatsAccountsByReferrer(
		referrer: PublicKey
	): Promise<UserStatsAccount[]> {
		const programAccounts = await this.program.account.userStats.all([
			{
				memcmp: {
					offset: 40,
					/** data to match, as base-58 encoded string and limited to less than 129 bytes */
					bytes: bs58.encode(referrer.toBuffer()),
				},
			},
		]);

		return programAccounts.map(
			(programAccount) => programAccount.account as UserStatsAccount
		);
	}

	public async getReferrerNameAccountsForAuthority(
		authority: PublicKey
	): Promise<ReferrerNameAccount[]> {
		const programAccounts = await this.program.account.referrerName.all([
			{
				memcmp: {
					offset: 8,
					/** data to match, as base-58 encoded string and limited to less than 129 bytes */
					bytes: bs58.encode(authority.toBuffer()),
				},
			},
		]);

		return programAccounts.map(
			(programAccount) => programAccount.account as ReferrerNameAccount
		);
	}

	public async deleteUser(
		subAccountId = 0,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const userAccountPublicKey = getUserAccountPublicKeySync(
			this.program.programId,
			this.wallet.publicKey,
			subAccountId
		);

		const ix = await this.getUserDeletionIx(userAccountPublicKey);

		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(ix, txParams),
			[],
			this.opts
		);

		const userMapKey = this.getUserMapKey(subAccountId, this.wallet.publicKey);
		await this.users.get(userMapKey)?.unsubscribe();
		this.users.delete(userMapKey);

		return txSig;
	}

	public async getUserDeletionIx(userAccountPublicKey: PublicKey) {
		const ix = await this.program.instruction.deleteUser({
			accounts: {
				user: userAccountPublicKey,
				userStats: this.getUserStatsAccountPublicKey(),
				authority: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});

		return ix;
	}

	public async reclaimRent(
		subAccountId = 0,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const userAccountPublicKey = getUserAccountPublicKeySync(
			this.program.programId,
			this.wallet.publicKey,
			subAccountId
		);

		const ix = await this.getReclaimRentIx(userAccountPublicKey);

		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(ix, txParams),
			[],
			this.opts
		);

		return txSig;
	}

	public async getReclaimRentIx(userAccountPublicKey: PublicKey) {
		return await this.program.instruction.reclaimRent({
			accounts: {
				user: userAccountPublicKey,
				userStats: this.getUserStatsAccountPublicKey(),
				authority: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				rent: anchor.web3.SYSVAR_RENT_PUBKEY,
			},
		});
	}

	public getUser(subAccountId?: number, authority?: PublicKey): User {
		subAccountId = subAccountId ?? this.activeSubAccountId;
		authority = authority ?? this.authority;
		const userMapKey = this.getUserMapKey(subAccountId, authority);

		if (!this.users.has(userMapKey)) {
			throw new Error(`DriftClient has no user for user id ${userMapKey}`);
		}
		return this.users.get(userMapKey);
	}

	public hasUser(subAccountId?: number, authority?: PublicKey): boolean {
		subAccountId = subAccountId ?? this.activeSubAccountId;
		authority = authority ?? this.authority;
		const userMapKey = this.getUserMapKey(subAccountId, authority);

		return this.users.has(userMapKey);
	}

	public getUsers(): User[] {
		// delegate users get added to the end
		return [...this.users.values()]
			.filter((acct) =>
				acct.getUserAccount().authority.equals(this.wallet.publicKey)
			)
			.concat(
				[...this.users.values()].filter(
					(acct) =>
						!acct.getUserAccount().authority.equals(this.wallet.publicKey)
				)
			);
	}

	public getUserStats(): UserStats {
		return this.userStats;
	}

	public async fetchReferrerNameAccount(
		name: string
	): Promise<ReferrerNameAccount | undefined> {
		const nameBuffer = encodeName(name);
		const referrerNameAccountPublicKey = getReferrerNamePublicKeySync(
			this.program.programId,
			nameBuffer
		);
		return (await this.program.account.referrerName.fetch(
			referrerNameAccountPublicKey
		)) as ReferrerNameAccount;
	}

	userStatsAccountPublicKey: PublicKey;
	public getUserStatsAccountPublicKey(): PublicKey {
		if (this.userStatsAccountPublicKey) {
			return this.userStatsAccountPublicKey;
		}

		this.userStatsAccountPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			this.authority
		);
		return this.userStatsAccountPublicKey;
	}

	public async getUserAccountPublicKey(
		subAccountId?: number,
		authority?: PublicKey
	): Promise<PublicKey> {
		return this.getUser(subAccountId, authority).userAccountPublicKey;
	}

	public getUserAccount(
		subAccountId?: number,
		authority?: PublicKey
	): UserAccount | undefined {
		return this.getUser(subAccountId, authority).getUserAccount();
	}

	/**
	 * Forces a fetch to rpc before returning accounts. Useful for anchor tests.
	 * @param subAccountId
	 */
	public async forceGetUserAccount(
		subAccountId?: number
	): Promise<UserAccount | undefined> {
		await this.getUser(subAccountId).fetchAccounts();
		return this.getUser(subAccountId).getUserAccount();
	}

	public getUserAccountAndSlot(
		subAccountId?: number
	): DataAndSlot<UserAccount> | undefined {
		return this.getUser(subAccountId).getUserAccountAndSlot();
	}

	public getSpotPosition(
		marketIndex: number,
		subAccountId?: number
	): SpotPosition | undefined {
		return this.getUserAccount(subAccountId).spotPositions.find(
			(spotPosition) => spotPosition.marketIndex === marketIndex
		);
	}

	public getQuoteAssetTokenAmount(): BN {
		return this.getTokenAmount(QUOTE_SPOT_MARKET_INDEX);
	}

	/**
	 * Returns the token amount for a given market. The spot market precision is based on the token mint decimals.
	 * Positive if it is a deposit, negative if it is a borrow.
	 * @param marketIndex
	 */
	public getTokenAmount(marketIndex: number): BN {
		const spotPosition = this.getSpotPosition(marketIndex);
		if (spotPosition === undefined) {
			return ZERO;
		}
		const spotMarket = this.getSpotMarketAccount(marketIndex);
		return getSignedTokenAmount(
			getTokenAmount(
				spotPosition.scaledBalance,
				spotMarket,
				spotPosition.balanceType
			),
			spotPosition.balanceType
		);
	}

	/**
	 * Converts an amount to the spot precision for a given market. The spot market precision is based on the token mint decimals.
	 * @param marketIndex
	 * @param amount
	 */
	public convertToSpotPrecision(marketIndex: number, amount: BN | number): BN {
		const spotMarket = this.getSpotMarketAccount(marketIndex);
		return castNumberToSpotPrecision(amount, spotMarket);
	}

	/**
	 * Converts an amount to the perp precision. The perp market precision is {@link BASE_PRECISION} (1e9).
	 * @param amount
	 */
	public convertToPerpPrecision(amount: BN | number): BN {
		if (typeof amount === 'number') {
			return numberToSafeBN(amount, BASE_PRECISION);
		} else {
			return amount.mul(BASE_PRECISION);
		}
	}

	/**
	 * Converts an amount to the price precision. The perp market precision is {@link PRICE_PRECISION} (1e6).
	 * @param amount
	 */
	public convertToPricePrecision(amount: BN | number): BN {
		if (typeof amount === 'number') {
			return numberToSafeBN(amount, PRICE_PRECISION);
		} else {
			return amount.mul(BASE_PRECISION);
		}
	}

	/**
	 * Each drift instruction must include perp and sport market accounts in the ix remaining accounts.
	 * Use this function to force a subset of markets to be included in the remaining accounts for every ix
	 *
	 * @param perpMarketIndexes
	 * @param spotMarketIndexes
	 */
	public mustIncludeMarketsInIx({
		perpMarketIndexes,
		spotMarketIndexes,
	}: {
		perpMarketIndexes: number[];
		spotMarketIndexes: number[];
	}): void {
		perpMarketIndexes.forEach((perpMarketIndex) => {
			this.mustIncludePerpMarketIndexes.add(perpMarketIndex);
		});

		spotMarketIndexes.forEach((spotMarketIndex) => {
			this.mustIncludeSpotMarketIndexes.add(spotMarketIndex);
		});
	}

	getRemainingAccounts(params: RemainingAccountParams): AccountMeta[] {
		const { oracleAccountMap, spotMarketAccountMap, perpMarketAccountMap } =
			this.getRemainingAccountMapsForUsers(params.userAccounts);

		if (params.useMarketLastSlotCache) {
			const lastUserSlot = params.userAccountNotAvailable ? 0 : this.getUserAccountAndSlot()?.slot;

			for (const [
				marketIndex,
				slot,
			] of this.perpMarketLastSlotCache.entries()) {
				// if cache has more recent slot than user positions account slot, add market to remaining accounts
				// otherwise remove from slot
				if (slot > lastUserSlot) {
					this.addPerpMarketToRemainingAccountMaps(
						marketIndex,
						false,
						oracleAccountMap,
						spotMarketAccountMap,
						perpMarketAccountMap
					);
				} else {
					this.perpMarketLastSlotCache.delete(marketIndex);
				}
			}

			for (const [
				marketIndex,
				slot,
			] of this.spotMarketLastSlotCache.entries()) {
				// if cache has more recent slot than user positions account slot, add market to remaining accounts
				// otherwise remove from slot
				if (slot > lastUserSlot) {
					this.addSpotMarketToRemainingAccountMaps(
						marketIndex,
						false,
						oracleAccountMap,
						spotMarketAccountMap
					);
				} else {
					this.spotMarketLastSlotCache.delete(marketIndex);
				}
			}
		}

		if (params.readablePerpMarketIndex !== undefined) {
			const readablePerpMarketIndexes = Array.isArray(
				params.readablePerpMarketIndex
			)
				? params.readablePerpMarketIndex
				: [params.readablePerpMarketIndex];
			for (const marketIndex of readablePerpMarketIndexes) {
				this.addPerpMarketToRemainingAccountMaps(
					marketIndex,
					false,
					oracleAccountMap,
					spotMarketAccountMap,
					perpMarketAccountMap
				);
			}
		}

		for (const perpMarketIndex of this.mustIncludePerpMarketIndexes.values()) {
			this.addPerpMarketToRemainingAccountMaps(
				perpMarketIndex,
				false,
				oracleAccountMap,
				spotMarketAccountMap,
				perpMarketAccountMap
			);
		}

		if (params.readableSpotMarketIndexes !== undefined) {
			for (const readableSpotMarketIndex of params.readableSpotMarketIndexes) {
				this.addSpotMarketToRemainingAccountMaps(
					readableSpotMarketIndex,
					false,
					oracleAccountMap,
					spotMarketAccountMap
				);
			}
		}

		for (const spotMarketIndex of this.mustIncludeSpotMarketIndexes.values()) {
			this.addSpotMarketToRemainingAccountMaps(
				spotMarketIndex,
				false,
				oracleAccountMap,
				spotMarketAccountMap
			);
		}

		if (params.writablePerpMarketIndexes !== undefined) {
			for (const writablePerpMarketIndex of params.writablePerpMarketIndexes) {
				this.addPerpMarketToRemainingAccountMaps(
					writablePerpMarketIndex,
					true,
					oracleAccountMap,
					spotMarketAccountMap,
					perpMarketAccountMap
				);
			}
		}

		if (params.writableSpotMarketIndexes !== undefined) {
			for (const writableSpotMarketIndex of params.writableSpotMarketIndexes) {
				this.addSpotMarketToRemainingAccountMaps(
					writableSpotMarketIndex,
					true,
					oracleAccountMap,
					spotMarketAccountMap
				);
			}
		}

		return [
			...oracleAccountMap.values(),
			...spotMarketAccountMap.values(),
			...perpMarketAccountMap.values(),
		];
	}

	addPerpMarketToRemainingAccountMaps(
		marketIndex: number,
		writable: boolean,
		oracleAccountMap: Map<string, AccountMeta>,
		spotMarketAccountMap: Map<number, AccountMeta>,
		perpMarketAccountMap: Map<number, AccountMeta>
	): void {
		const perpMarketAccount = this.getPerpMarketAccount(marketIndex);
		perpMarketAccountMap.set(marketIndex, {
			pubkey: perpMarketAccount.pubkey,
			isSigner: false,
			isWritable: writable,
		});
		const oracleWritable =
			writable && isVariant(perpMarketAccount.amm.oracleSource, 'prelaunch');
		oracleAccountMap.set(perpMarketAccount.amm.oracle.toString(), {
			pubkey: perpMarketAccount.amm.oracle,
			isSigner: false,
			isWritable: oracleWritable,
		});
		this.addSpotMarketToRemainingAccountMaps(
			perpMarketAccount.quoteSpotMarketIndex,
			false,
			oracleAccountMap,
			spotMarketAccountMap
		);
	}

	addSpotMarketToRemainingAccountMaps(
		marketIndex: number,
		writable: boolean,
		oracleAccountMap: Map<string, AccountMeta>,
		spotMarketAccountMap: Map<number, AccountMeta>
	): void {
		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);
		spotMarketAccountMap.set(spotMarketAccount.marketIndex, {
			pubkey: spotMarketAccount.pubkey,
			isSigner: false,
			isWritable: writable,
		});
		if (!spotMarketAccount.oracle.equals(PublicKey.default)) {
			oracleAccountMap.set(spotMarketAccount.oracle.toString(), {
				pubkey: spotMarketAccount.oracle,
				isSigner: false,
				isWritable: false,
			});
		}
	}

	getRemainingAccountMapsForUsers(userAccounts: UserAccount[]): {
		oracleAccountMap: Map<string, AccountMeta>;
		spotMarketAccountMap: Map<number, AccountMeta>;
		perpMarketAccountMap: Map<number, AccountMeta>;
	} {
		const oracleAccountMap = new Map<string, AccountMeta>();
		const spotMarketAccountMap = new Map<number, AccountMeta>();
		const perpMarketAccountMap = new Map<number, AccountMeta>();

		for (const userAccount of userAccounts) {
			for (const spotPosition of userAccount.spotPositions) {
				if (!isSpotPositionAvailable(spotPosition)) {
					this.addSpotMarketToRemainingAccountMaps(
						spotPosition.marketIndex,
						false,
						oracleAccountMap,
						spotMarketAccountMap
					);

					if (
						!spotPosition.openAsks.eq(ZERO) ||
						!spotPosition.openBids.eq(ZERO)
					) {
						this.addSpotMarketToRemainingAccountMaps(
							QUOTE_SPOT_MARKET_INDEX,
							false,
							oracleAccountMap,
							spotMarketAccountMap
						);
					}
				}
			}
			for (const position of userAccount.perpPositions) {
				if (!positionIsAvailable(position)) {
					this.addPerpMarketToRemainingAccountMaps(
						position.marketIndex,
						false,
						oracleAccountMap,
						spotMarketAccountMap,
						perpMarketAccountMap
					);
				}
			}
		}

		return {
			oracleAccountMap,
			spotMarketAccountMap,
			perpMarketAccountMap,
		};
	}

	public getOrder(orderId: number, subAccountId?: number): Order | undefined {
		return this.getUserAccount(subAccountId)?.orders.find(
			(order) => order.orderId === orderId
		);
	}

	public getOrderByUserId(
		userOrderId: number,
		subAccountId?: number
	): Order | undefined {
		return this.getUserAccount(subAccountId)?.orders.find(
			(order) => order.userOrderId === userOrderId
		);
	}

	/**
	 * Get the associated token address for the given spot market
	 * @param marketIndex
	 * @param useNative
	 * @param tokenProgram
	 */
	public async getAssociatedTokenAccount(
		marketIndex: number,
		useNative = true,
		tokenProgram = TOKEN_PROGRAM_ID
	): Promise<PublicKey> {
		const spotMarket = this.getSpotMarketAccount(marketIndex);
		if (useNative && spotMarket.mint.equals(WRAPPED_SOL_MINT)) {
			return this.wallet.publicKey;
		}
		const mint = spotMarket.mint;
		return await getAssociatedTokenAddress(
			mint,
			this.wallet.publicKey,
			undefined,
			tokenProgram
		);
	}

	public createAssociatedTokenAccountIdempotentInstruction(
		account: PublicKey,
		payer: PublicKey,
		owner: PublicKey,
		mint: PublicKey,
		tokenProgram = TOKEN_PROGRAM_ID
	): TransactionInstruction {
		return new TransactionInstruction({
			keys: [
				{ pubkey: payer, isSigner: true, isWritable: true },
				{ pubkey: account, isSigner: false, isWritable: true },
				{ pubkey: owner, isSigner: false, isWritable: false },
				{ pubkey: mint, isSigner: false, isWritable: false },
				{
					pubkey: anchor.web3.SystemProgram.programId,
					isSigner: false,
					isWritable: false,
				},
				{ pubkey: tokenProgram, isSigner: false, isWritable: false },
			],
			programId: ASSOCIATED_TOKEN_PROGRAM_ID,
			data: Buffer.from([0x1]),
		});
	}

	public async createDepositTxn(
		amount: BN,
		marketIndex: number,
		associatedTokenAccount: PublicKey,
		subAccountId?: number,
		reduceOnly = false,
		txParams?: TxParams
	): Promise<VersionedTransaction | Transaction> {
		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);

		const isSolMarket = spotMarketAccount.mint.equals(WRAPPED_SOL_MINT);

		const signerAuthority = this.wallet.publicKey;

		const createWSOLTokenAccount =
			isSolMarket && associatedTokenAccount.equals(signerAuthority);

		const instructions = [];

		if (createWSOLTokenAccount) {
			const { ixs, pubkey } = await this.getWrappedSolAccountCreationIxs(
				amount,
				true
			);

			associatedTokenAccount = pubkey;

			instructions.push(...ixs);
		}

		const depositCollateralIx = await this.getDepositInstruction(
			amount,
			marketIndex,
			associatedTokenAccount,
			subAccountId,
			reduceOnly,
			true
		);

		instructions.push(depositCollateralIx);

		// Close the wrapped sol account at the end of the transaction
		if (createWSOLTokenAccount) {
			instructions.push(
				createCloseAccountInstruction(
					associatedTokenAccount,
					signerAuthority,
					signerAuthority,
					[]
				)
			);
		}

		txParams = { ...(txParams ?? this.txParams), computeUnits: 600_000 };

		const tx = await this.buildTransaction(instructions, txParams);

		return tx;
	}

	/**
	 * Deposit funds into the given spot market
	 *
	 * @param amount to deposit
	 * @param marketIndex spot market index to deposit into
	 * @param associatedTokenAccount can be the wallet public key if using native sol
	 * @param subAccountId subaccountId to deposit
	 * @param reduceOnly if true, deposit must not increase account risk
	 */
	public async deposit(
		amount: BN,
		marketIndex: number,
		associatedTokenAccount: PublicKey,
		subAccountId?: number,
		reduceOnly = false,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const tx = await this.createDepositTxn(
			amount,
			marketIndex,
			associatedTokenAccount,
			subAccountId,
			reduceOnly,
			txParams
		);

		const { txSig, slot } = await this.sendTransaction(tx, [], this.opts);
		this.spotMarketLastSlotCache.set(marketIndex, slot);
		return txSig;
	}

	async getDepositInstruction(
		amount: BN,
		marketIndex: number,
		userTokenAccount: PublicKey,
		subAccountId?: number,
		reduceOnly = false,
		userInitialized = true
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await getUserAccountPublicKey(
			this.program.programId,
			this.authority,
			subAccountId ?? this.activeSubAccountId
		);

		let remainingAccounts = [];
		if (userInitialized) {
			remainingAccounts = this.getRemainingAccounts({
				userAccounts: [await this.forceGetUserAccount()],
				useMarketLastSlotCache: true,
				writableSpotMarketIndexes: [marketIndex],
			});
		} else {
			remainingAccounts = this.getRemainingAccounts({
				userAccounts: [],
				writableSpotMarketIndexes: [marketIndex],
			});
		}

		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);

		this.addTokenMintToRemainingAccounts(spotMarketAccount, remainingAccounts);
		const tokenProgram = this.getTokenProgramForSpotMarket(spotMarketAccount);
		return await this.program.instruction.deposit(
			marketIndex,
			amount,
			reduceOnly,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					spotMarket: spotMarketAccount.pubkey,
					spotMarketVault: spotMarketAccount.vault,
					user: userAccountPublicKey,
					userStats: this.getUserStatsAccountPublicKey(),
					userTokenAccount: userTokenAccount,
					authority: this.wallet.publicKey,
					tokenProgram,
				},
				remainingAccounts,
			}
		);
	}

	private async checkIfAccountExists(account: PublicKey): Promise<boolean> {
		try {
			const accountInfo = await this.connection.getAccountInfo(account);
			return accountInfo != null;
		} catch (e) {
			// Doesn't already exist
			return false;
		}
	}

	public async getWrappedSolAccountCreationIxs(
		amount: BN,
		includeRent?: boolean
	): Promise<{
		ixs: anchor.web3.TransactionInstruction[];
		/** @deprecated - this array is always going to be empty, in the current implementation */
		signers: Signer[];
		pubkey: PublicKey;
	}> {
		const authority = this.wallet.publicKey;

		// Generate a random seed for wrappedSolAccount.
		const seed = Keypair.generate().publicKey.toBase58().slice(0, 32);

		// Calculate a publicKey that will be controlled by the authority.
		const wrappedSolAccount = await PublicKey.createWithSeed(
			authority,
			seed,
			TOKEN_PROGRAM_ID
		);

		const result = {
			ixs: [],
			signers: [],
			pubkey: wrappedSolAccount,
		};

		const rentSpaceLamports = new BN(LAMPORTS_PER_SOL / 100);

		const lamports = includeRent
			? amount.add(rentSpaceLamports)
			: rentSpaceLamports;

		result.ixs.push(
			SystemProgram.createAccountWithSeed({
				fromPubkey: authority,
				basePubkey: authority,
				seed,
				newAccountPubkey: wrappedSolAccount,
				lamports: lamports.toNumber(),
				space: 165,
				programId: TOKEN_PROGRAM_ID,
			})
		);

		result.ixs.push(
			createInitializeAccountInstruction(
				wrappedSolAccount,
				WRAPPED_SOL_MINT,
				authority
			)
		);

		return result;
	}

	public getTokenProgramForSpotMarket(
		spotMarketAccount: SpotMarketAccount
	): PublicKey {
		if (spotMarketAccount.tokenProgram === 1) {
			return TOKEN_2022_PROGRAM_ID;
		}
		return TOKEN_PROGRAM_ID;
	}

	public addTokenMintToRemainingAccounts(
		spotMarketAccount: SpotMarketAccount,
		remainingAccounts: AccountMeta[]
	) {
		if (spotMarketAccount.tokenProgram === 1) {
			remainingAccounts.push({
				pubkey: spotMarketAccount.mint,
				isSigner: false,
				isWritable: false,
			});
		}
	}

	public getAssociatedTokenAccountCreationIx(
		tokenMintAddress: PublicKey,
		associatedTokenAddress: PublicKey,
		tokenProgram: PublicKey
	): anchor.web3.TransactionInstruction {
		return createAssociatedTokenAccountInstruction(
			this.wallet.publicKey,
			associatedTokenAddress,
			this.wallet.publicKey,
			tokenMintAddress,
			tokenProgram
		);
	}

	public async createInitializeUserAccountAndDepositCollateralIxs(
		amount: BN,
		userTokenAccount: PublicKey,
		marketIndex = 0,
		subAccountId = 0,
		name?: string,
		fromSubAccountId?: number,
		referrerInfo?: ReferrerInfo,
		donateAmount?: BN,
		customMaxMarginRatio?: number
	): Promise<{
		ixs: TransactionInstruction[];
		userAccountPublicKey: PublicKey;
	}> {
		const ixs = [];

		const [userAccountPublicKey, initializeUserAccountIx] =
			await this.getInitializeUserInstructions(
				subAccountId,
				name,
				referrerInfo
			);

		const spotMarket = this.getSpotMarketAccount(marketIndex);

		const isSolMarket = spotMarket.mint.equals(WRAPPED_SOL_MINT);

		const authority = this.wallet.publicKey;

		const isFromSubaccount =
			fromSubAccountId !== null &&
			fromSubAccountId !== undefined &&
			!isNaN(fromSubAccountId);

		donateAmount = donateAmount ? donateAmount : ZERO;

		const createWSOLTokenAccount =
			(isSolMarket &&
				userTokenAccount.equals(authority) &&
				!isFromSubaccount) ||
			!donateAmount.eq(ZERO);

		const wSolAmount = isSolMarket ? amount.add(donateAmount) : donateAmount;

		let wsolTokenAccount: PublicKey;
		if (createWSOLTokenAccount) {
			const { ixs: startIxs, pubkey } =
				await this.getWrappedSolAccountCreationIxs(wSolAmount, true);

			wsolTokenAccount = pubkey;

			if (isSolMarket) {
				userTokenAccount = pubkey;
			}

			ixs.push(...startIxs);
		}

		const depositCollateralIx = isFromSubaccount
			? await this.getTransferDepositIx(
					amount,
					marketIndex,
					fromSubAccountId,
					subAccountId
			  )
			: await this.getDepositInstruction(
					amount,
					marketIndex,
					userTokenAccount,
					subAccountId,
					false,
					false
			  );

		if (subAccountId === 0) {
			if (
				!(await this.checkIfAccountExists(this.getUserStatsAccountPublicKey()))
			) {
				ixs.push(await this.getInitializeUserStatsIx());
			}
		}
		ixs.push(initializeUserAccountIx, depositCollateralIx);

		if (!donateAmount.eq(ZERO)) {
			const donateIx = await this.getDepositIntoSpotMarketRevenuePoolIx(
				1,
				donateAmount,
				wsolTokenAccount
			);

			ixs.push(donateIx);
		}

		// Set the max margin ratio to initialize account with if passed
		if (customMaxMarginRatio) {
			const customMarginRatioIx = await this.getUpdateUserCustomMarginRatioIx(
				customMaxMarginRatio,
				subAccountId
			);
			ixs.push(customMarginRatioIx);
		}

		// Close the wrapped sol account at the end of the transaction
		if (createWSOLTokenAccount) {
			ixs.push(
				createCloseAccountInstruction(
					wsolTokenAccount,
					authority,
					authority,
					[]
				)
			);
		}

		return {
			ixs,
			userAccountPublicKey,
		};
	}

	public async createInitializeUserAccountAndDepositCollateral(
		amount: BN,
		userTokenAccount: PublicKey,
		marketIndex = 0,
		subAccountId = 0,
		name?: string,
		fromSubAccountId?: number,
		referrerInfo?: ReferrerInfo,
		donateAmount?: BN,
		txParams?: TxParams,
		customMaxMarginRatio?: number
	): Promise<[Transaction | VersionedTransaction, PublicKey]> {
		const { ixs, userAccountPublicKey } =
			await this.createInitializeUserAccountAndDepositCollateralIxs(
				amount,
				userTokenAccount,
				marketIndex,
				subAccountId,
				name,
				fromSubAccountId,
				referrerInfo,
				donateAmount,
				customMaxMarginRatio
			);

		const tx = await this.buildTransaction(ixs, txParams);

		return [tx, userAccountPublicKey];
	}

	/**
	 * Creates the User account for a user, and deposits some initial collateral
	 * @param amount
	 * @param userTokenAccount
	 * @param marketIndex
	 * @param subAccountId
	 * @param name
	 * @param fromSubAccountId
	 * @param referrerInfo
	 * @param donateAmount
	 * @param txParams
	 * @returns
	 */
	public async initializeUserAccountAndDepositCollateral(
		amount: BN,
		userTokenAccount: PublicKey,
		marketIndex = 0,
		subAccountId = 0,
		name?: string,
		fromSubAccountId?: number,
		referrerInfo?: ReferrerInfo,
		donateAmount?: BN,
		txParams?: TxParams,
		customMaxMarginRatio?: number
	): Promise<[TransactionSignature, PublicKey]> {
		const [tx, userAccountPublicKey] =
			await this.createInitializeUserAccountAndDepositCollateral(
				amount,
				userTokenAccount,
				marketIndex,
				subAccountId,
				name,
				fromSubAccountId,
				referrerInfo,
				donateAmount,
				txParams,
				customMaxMarginRatio
			);
		const additionalSigners: Array<Signer> = [];

		const { txSig, slot } = await this.sendTransaction(
			tx,
			additionalSigners,
			this.opts
		);
		this.spotMarketLastSlotCache.set(marketIndex, slot);

		await this.addUser(subAccountId);

		return [txSig, userAccountPublicKey];
	}

	public async initializeUserAccountForDevnet(
		subAccountId = 0,
		name = DEFAULT_USER_NAME,
		marketIndex: number,
		tokenFaucet: TokenFaucet,
		amount: BN,
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams
	): Promise<[TransactionSignature, PublicKey]> {
		const ixs = [];

		const [associateTokenPublicKey, createAssociatedAccountIx, mintToIx] =
			await tokenFaucet.createAssociatedTokenAccountAndMintToInstructions(
				this.wallet.publicKey,
				amount
			);

		const [userAccountPublicKey, initializeUserAccountIx] =
			await this.getInitializeUserInstructions(
				subAccountId,
				name,
				referrerInfo
			);

		const depositCollateralIx = await this.getDepositInstruction(
			amount,
			marketIndex,
			associateTokenPublicKey,
			subAccountId,
			false,
			false
		);

		ixs.push(createAssociatedAccountIx, mintToIx);

		if (subAccountId === 0) {
			if (
				!(await this.checkIfAccountExists(this.getUserStatsAccountPublicKey()))
			) {
				ixs.push(await this.getInitializeUserStatsIx());
			}
		}
		ixs.push(initializeUserAccountIx, depositCollateralIx);

		const tx = await this.buildTransaction(ixs, txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		await this.addUser(subAccountId);

		return [txSig, userAccountPublicKey];
	}

	private async getWithdrawalIxs(
		amount: BN,
		marketIndex: number,
		associatedTokenAddress: PublicKey,
		reduceOnly = false,
		subAccountId?: number
	) {
		const withdrawIxs: anchor.web3.TransactionInstruction[] = [];

		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);

		const isSolMarket = spotMarketAccount.mint.equals(WRAPPED_SOL_MINT);

		const authority = this.wallet.publicKey;

		const createWSOLTokenAccount =
			isSolMarket && associatedTokenAddress.equals(authority);

		if (createWSOLTokenAccount) {
			const { ixs, pubkey } = await this.getWrappedSolAccountCreationIxs(
				amount,
				false
			);

			associatedTokenAddress = pubkey;

			withdrawIxs.push(...ixs);
		} else {
			const accountExists = await this.checkIfAccountExists(
				associatedTokenAddress
			);

			if (!accountExists) {
				const createAssociatedTokenAccountIx =
					this.getAssociatedTokenAccountCreationIx(
						spotMarketAccount.mint,
						associatedTokenAddress,
						this.getTokenProgramForSpotMarket(spotMarketAccount)
					);

				withdrawIxs.push(createAssociatedTokenAccountIx);
			}
		}

		const withdrawCollateralIx = await this.getWithdrawIx(
			amount,
			spotMarketAccount.marketIndex,
			associatedTokenAddress,
			reduceOnly,
			subAccountId
		);

		withdrawIxs.push(withdrawCollateralIx);

		// Close the wrapped sol account at the end of the transaction
		if (createWSOLTokenAccount) {
			withdrawIxs.push(
				createCloseAccountInstruction(
					associatedTokenAddress,
					authority,
					authority,
					[]
				)
			);
		}

		return withdrawIxs;
	}

	/**
	 * Withdraws from a user account. If deposit doesn't already exist, creates a borrow
	 * @param amount
	 * @param marketIndex
	 * @param associatedTokenAddress - the token account to withdraw to. can be the wallet public key if using native sol
	 * @param reduceOnly
	 */
	public async withdraw(
		amount: BN,
		marketIndex: number,
		associatedTokenAddress: PublicKey,
		reduceOnly = false,
		subAccountId?: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const additionalSigners: Array<Signer> = [];

		const withdrawIxs = await this.getWithdrawalIxs(
			amount,
			marketIndex,
			associatedTokenAddress,
			reduceOnly,
			subAccountId
		);

		const tx = await this.buildTransaction(
			withdrawIxs,
			txParams ?? this.txParams
		);

		const { txSig, slot } = await this.sendTransaction(
			tx,
			additionalSigners,
			this.opts
		);
		this.spotMarketLastSlotCache.set(marketIndex, slot);
		return txSig;
	}

	public async withdrawAllDustPositions(
		subAccountId?: number,
		txParams?: TxParams,
		opts?: {
			dustPositionCountCallback?: (count: number) => void;
		}
	): Promise<TransactionSignature | undefined> {
		const user = this.getUser(subAccountId);

		const dustPositionSpotMarketAccounts =
			user.getSpotMarketAccountsWithDustPosition();

		if (
			!dustPositionSpotMarketAccounts ||
			dustPositionSpotMarketAccounts.length === 0
		) {
			opts?.dustPositionCountCallback?.(0);
			return undefined;
		}

		opts?.dustPositionCountCallback?.(dustPositionSpotMarketAccounts.length);

		let allWithdrawIxs: anchor.web3.TransactionInstruction[] = [];

		for (const position of dustPositionSpotMarketAccounts) {
			const tokenAccount = await getAssociatedTokenAddress(
				position.mint,
				this.wallet.publicKey
			);

			const tokenAmount = await user.getTokenAmount(position.marketIndex);

			const withdrawIxs = await this.getWithdrawalIxs(
				tokenAmount.muln(2), //  2x to ensure all dust is withdrawn
				position.marketIndex,
				tokenAccount,
				true, // reduce-only true to ensure all dust is withdrawn
				subAccountId
			);

			allWithdrawIxs = allWithdrawIxs.concat(withdrawIxs);
		}

		const tx = await this.buildTransaction(
			allWithdrawIxs,
			txParams ?? this.txParams
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getWithdrawIx(
		amount: BN,
		marketIndex: number,
		userTokenAccount: PublicKey,
		reduceOnly = false,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		const user = await this.getUserAccountPublicKey(subAccountId);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(subAccountId)],
			useMarketLastSlotCache: true,
			writableSpotMarketIndexes: [marketIndex],
			readableSpotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
		});

		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);

		this.addTokenMintToRemainingAccounts(spotMarketAccount, remainingAccounts);
		const tokenProgram = this.getTokenProgramForSpotMarket(spotMarketAccount);

		return await this.program.instruction.withdraw(
			marketIndex,
			amount,
			reduceOnly,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					spotMarket: spotMarketAccount.pubkey,
					spotMarketVault: spotMarketAccount.vault,
					driftSigner: this.getSignerPublicKey(),
					user,
					userStats: this.getUserStatsAccountPublicKey(),
					userTokenAccount: userTokenAccount,
					authority: this.wallet.publicKey,
					tokenProgram,
				},
				remainingAccounts,
			}
		);
	}

	/**
	 * Withdraws from the fromSubAccount and deposits into the toSubAccount
	 * @param amount
	 * @param marketIndex
	 * @param fromSubAccountId
	 * @param toSubAccountId
	 * @param txParams
	 */
	public async transferDeposit(
		amount: BN,
		marketIndex: number,
		fromSubAccountId: number,
		toSubAccountId: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getTransferDepositIx(
					amount,
					marketIndex,
					fromSubAccountId,
					toSubAccountId
				),
				txParams
			),
			[],
			this.opts
		);
		if (
			fromSubAccountId === this.activeSubAccountId ||
			toSubAccountId === this.activeSubAccountId
		) {
			this.spotMarketLastSlotCache.set(marketIndex, slot);
		}
		return txSig;
	}

	public async getTransferDepositIx(
		amount: BN,
		marketIndex: number,
		fromSubAccountId: number,
		toSubAccountId: number
	): Promise<TransactionInstruction> {
		const fromUser = await getUserAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			fromSubAccountId
		);
		const toUser = await getUserAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			toSubAccountId
		);

		let remainingAccounts;

		const userMapKey = this.getUserMapKey(
			fromSubAccountId,
			this.wallet.publicKey
		);
		if (this.users.has(userMapKey)) {
			remainingAccounts = this.getRemainingAccounts({
				userAccounts: [this.users.get(userMapKey).getUserAccount()],
				useMarketLastSlotCache: true,
				writableSpotMarketIndexes: [marketIndex],
			});
		} else {
			const userAccountPublicKey = getUserAccountPublicKeySync(
				this.program.programId,
				this.authority,
				fromSubAccountId
			);

			const fromUserAccount = (await this.program.account.user.fetch(
				userAccountPublicKey
			)) as UserAccount;
			remainingAccounts = this.getRemainingAccounts({
				userAccounts: [fromUserAccount],
				useMarketLastSlotCache: true,
				writableSpotMarketIndexes: [marketIndex],
			});
		}

		return await this.program.instruction.transferDeposit(marketIndex, amount, {
			accounts: {
				authority: this.wallet.publicKey,
				fromUser,
				toUser,
				userStats: this.getUserStatsAccountPublicKey(),
				state: await this.getStatePublicKey(),
				spotMarketVault: this.getSpotMarketAccount(marketIndex).vault,
			},
			remainingAccounts,
		});
	}

	public async updateSpotMarketCumulativeInterest(
		marketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.updateSpotMarketCumulativeInterestIx(marketIndex),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async updateSpotMarketCumulativeInterestIx(
		marketIndex: number
	): Promise<TransactionInstruction> {
		const spotMarket = this.getSpotMarketAccount(marketIndex);
		return await this.program.instruction.updateSpotMarketCumulativeInterest({
			accounts: {
				state: await this.getStatePublicKey(),
				spotMarket: spotMarket.pubkey,
				spotMarketVault: spotMarket.vault,
				oracle: spotMarket.oracle,
			},
		});
	}

	public async settleLP(
		settleeUserAccountPublicKey: PublicKey,
		marketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.settleLPIx(settleeUserAccountPublicKey, marketIndex),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async settleLPIx(
		settleeUserAccountPublicKey: PublicKey,
		marketIndex: number
	): Promise<TransactionInstruction> {
		const settleeUserAccount = (await this.program.account.user.fetch(
			settleeUserAccountPublicKey
		)) as UserAccount;

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [settleeUserAccount],
			writablePerpMarketIndexes: [marketIndex],
		});

		return this.program.instruction.settleLp(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: settleeUserAccountPublicKey,
			},
			remainingAccounts: remainingAccounts,
		});
	}

	public async removePerpLpShares(
		marketIndex: number,
		sharesToBurn?: BN,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getRemovePerpLpSharesIx(
					marketIndex,
					sharesToBurn,
					subAccountId
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async removePerpLpSharesInExpiringMarket(
		marketIndex: number,
		userAccountPublicKey: PublicKey,
		sharesToBurn?: BN,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getRemovePerpLpSharesInExpiringMarket(
					marketIndex,
					userAccountPublicKey,
					sharesToBurn
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getRemovePerpLpSharesInExpiringMarket(
		marketIndex: number,
		userAccountPublicKey: PublicKey,
		sharesToBurn?: BN
	): Promise<TransactionInstruction> {
		const userAccount = (await this.program.account.user.fetch(
			userAccountPublicKey
		)) as UserAccount;

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [userAccount],
			useMarketLastSlotCache: true,
			writablePerpMarketIndexes: [marketIndex],
		});

		if (sharesToBurn == undefined) {
			const perpPosition = userAccount.perpPositions.filter(
				(position) => position.marketIndex === marketIndex
			)[0];
			sharesToBurn = perpPosition.lpShares;
			console.log('burning lp shares:', sharesToBurn.toString());
		}

		return this.program.instruction.removePerpLpSharesInExpiringMarket(
			sharesToBurn,
			marketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: userAccountPublicKey,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async getRemovePerpLpSharesIx(
		marketIndex: number,
		sharesToBurn?: BN,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		const user = await this.getUserAccountPublicKey(subAccountId);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(subAccountId)],
			useMarketLastSlotCache: true,
			writablePerpMarketIndexes: [marketIndex],
		});

		if (sharesToBurn == undefined) {
			const userAccount = this.getUserAccount(subAccountId);
			const perpPosition = userAccount.perpPositions.filter(
				(position) => position.marketIndex === marketIndex
			)[0];
			sharesToBurn = perpPosition.lpShares;
			console.log('burning lp shares:', sharesToBurn.toString());
		}

		return this.program.instruction.removePerpLpShares(
			sharesToBurn,
			marketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user,
					authority: this.wallet.publicKey,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async addPerpLpShares(
		amount: BN,
		marketIndex: number,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getAddPerpLpSharesIx(amount, marketIndex, subAccountId),
				txParams
			),
			[],
			this.opts
		);
		this.perpMarketLastSlotCache.set(marketIndex, slot);
		return txSig;
	}

	public async getAddPerpLpSharesIx(
		amount: BN,
		marketIndex: number,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		const user = await this.getUserAccountPublicKey(subAccountId);
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(subAccountId)],
			useMarketLastSlotCache: true,
			writablePerpMarketIndexes: [marketIndex],
		});

		return this.program.instruction.addPerpLpShares(amount, marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				user,
				authority: this.wallet.publicKey,
			},
			remainingAccounts: remainingAccounts,
		});
	}

	public getQuoteValuePerLpShare(marketIndex: number): BN {
		const perpMarketAccount = this.getPerpMarketAccount(marketIndex);

		const openBids = BN.max(
			perpMarketAccount.amm.baseAssetReserve.sub(
				perpMarketAccount.amm.minBaseAssetReserve
			),
			ZERO
		);

		const openAsks = BN.max(
			perpMarketAccount.amm.maxBaseAssetReserve.sub(
				perpMarketAccount.amm.baseAssetReserve
			),
			ZERO
		);

		const oraclePriceData = this.getOracleDataForPerpMarket(marketIndex);

		const maxOpenBidsAsks = BN.max(openBids, openAsks);
		const quoteValuePerLpShare = maxOpenBidsAsks
			.mul(oraclePriceData.price)
			.mul(QUOTE_PRECISION)
			.div(PRICE_PRECISION)
			.div(perpMarketAccount.amm.sqrtK);

		return quoteValuePerLpShare;
	}

	/**
	 * @deprecated use {@link placePerpOrder} or {@link placeAndTakePerpOrder} instead
	 */
	public async openPosition(
		direction: PositionDirection,
		amount: BN,
		marketIndex: number,
		limitPrice?: BN,
		subAccountId?: number
	): Promise<TransactionSignature> {
		return await this.placeAndTakePerpOrder(
			{
				orderType: OrderType.MARKET,
				marketIndex,
				direction,
				baseAssetAmount: amount,
				price: limitPrice,
			},
			undefined,
			undefined,
			undefined,
			subAccountId
		);
	}

	public async sendSignedTx(
		tx: Transaction | VersionedTransaction,
		opts?: ConfirmOptions
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			tx,
			undefined,
			opts ?? this.opts,
			true
		);

		return txSig;
	}

	public async prepareMarketOrderTxs(
		orderParams: OptionalOrderParams,
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		makerInfo?: MakerInfo | MakerInfo[],
		txParams?: TxParams,
		bracketOrdersParams = new Array<OptionalOrderParams>(),
		referrerInfo?: ReferrerInfo,
		cancelExistingOrders?: boolean,
		settlePnl?: boolean
	): Promise<{
		cancelExistingOrdersTx?: Transaction | VersionedTransaction;
		settlePnlTx?: Transaction | VersionedTransaction;
		fillTx?: Transaction | VersionedTransaction;
		marketOrderTx: Transaction | VersionedTransaction;
	}> {
		type TxKeys =
			| 'cancelExistingOrdersTx'
			| 'settlePnlTx'
			| 'fillTx'
			| 'marketOrderTx';

		const marketIndex = orderParams.marketIndex;
		const orderId = userAccount.nextOrderId;

		const ixPromisesForTxs: Record<TxKeys, Promise<TransactionInstruction>> = {
			cancelExistingOrdersTx: undefined,
			settlePnlTx: undefined,
			fillTx: undefined,
			marketOrderTx: undefined,
		};

		const txKeys = Object.keys(ixPromisesForTxs);

		ixPromisesForTxs.marketOrderTx = this.getPlaceOrdersIx(
			[orderParams, ...bracketOrdersParams],
			userAccount.subAccountId
		);

		/* Cancel open orders in market if requested */
		if (cancelExistingOrders && isVariant(orderParams.marketType, 'perp')) {
			ixPromisesForTxs.cancelExistingOrdersTx = this.getCancelOrdersIx(
				orderParams.marketType,
				orderParams.marketIndex,
				null,
				userAccount.subAccountId
			);
		}

		/* Settle PnL after fill if requested */
		if (settlePnl && isVariant(orderParams.marketType, 'perp')) {
			ixPromisesForTxs.settlePnlTx = this.settlePNLIx(
				userAccountPublicKey,
				userAccount,
				marketIndex
			);
		}

		// use versioned transactions if there is a lookup table account and wallet is compatible
		if (this.txVersion === 0) {
			ixPromisesForTxs.fillTx = this.getFillPerpOrderIx(
				userAccountPublicKey,
				userAccount,
				{
					orderId,
					marketIndex,
				},
				makerInfo,
				referrerInfo,
				userAccount.subAccountId
			);
		}

		const ixs = await Promise.all(Object.values(ixPromisesForTxs));

		const ixsMap = ixs.reduce((acc, ix, i) => {
			acc[txKeys[i]] = ix;
			return acc;
		}, {}) as MappedRecord<typeof ixPromisesForTxs, TransactionInstruction>;

		const txsMap = (await this.buildTransactionsMap(
			ixsMap,
			txParams
		)) as MappedRecord<typeof ixsMap, Transaction | VersionedTransaction>;

		return txsMap;
	}

	/**
	 * Sends a market order and returns a signed tx which can fill the order against the vamm, which the caller can use to fill their own order if required.
	 * @param orderParams
	 * @param userAccountPublicKey
	 * @param userAccount
	 * @param makerInfo
	 * @param txParams
	 * @param bracketOrdersParams
	 * @param cancelExistingOrders - Builds and returns an extra transaciton to cancel the existing orders in the same perp market. Intended use is to auto-cancel TP/SL orders when closing a position. Ignored if orderParams.marketType is not MarketType.PERP
	 * @returns
	 */
	public async sendMarketOrderAndGetSignedFillTx(
		orderParams: OptionalOrderParams,
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		makerInfo?: MakerInfo | MakerInfo[],
		txParams?: TxParams,
		bracketOrdersParams = new Array<OptionalOrderParams>(),
		referrerInfo?: ReferrerInfo,
		cancelExistingOrders?: boolean,
		settlePnl?: boolean
	): Promise<{
		txSig: TransactionSignature;
		signedFillTx?: Transaction;
		signedCancelExistingOrdersTx?: Transaction;
		signedSettlePnlTx?: Transaction;
	}> {
		const preppedTxs = await this.prepareMarketOrderTxs(
			orderParams,
			userAccountPublicKey,
			userAccount,
			makerInfo,
			txParams,
			bracketOrdersParams,
			referrerInfo,
			cancelExistingOrders,
			settlePnl
		);

		const signedTxs = (
			await this.txHandler.getSignedTransactionMap(preppedTxs, this.wallet)
		).signedTxMap;

		const { txSig, slot } = await this.sendTransaction(
			signedTxs.marketOrderTx,
			[],
			this.opts,
			true
		);

		this.perpMarketLastSlotCache.set(orderParams.marketIndex, slot);

		return {
			txSig,
			signedFillTx: signedTxs.fillTx as Transaction,
			signedCancelExistingOrdersTx:
				signedTxs.cancelExistingOrdersTx as Transaction,
			signedSettlePnlTx: signedTxs.settlePnlTx as Transaction,
		};
	}

	public async placePerpOrder(
		orderParams: OptionalOrderParams,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getPlacePerpOrderIx(orderParams, subAccountId),
				txParams
			),
			[],
			this.opts
		);
		this.perpMarketLastSlotCache.set(orderParams.marketIndex, slot);
		return txSig;
	}

	public async getPlacePerpOrderIx(
		orderParams: OptionalOrderParams,
		subAccountId?: number,
		isDepositToTradeTx?: boolean
	): Promise<TransactionInstruction> {
		orderParams = getOrderParams(orderParams, { marketType: MarketType.PERP });

		const user = isDepositToTradeTx ? getUserAccountPublicKeySync(
			this.program.programId,
			this.authority,
			subAccountId
		) : await this.getUserAccountPublicKey(subAccountId);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: isDepositToTradeTx ? [] : [this.getUserAccount(subAccountId)],
			useMarketLastSlotCache: true,
			readablePerpMarketIndex: orderParams.marketIndex,
			userAccountNotAvailable: isDepositToTradeTx
		});

		return await this.program.instruction.placePerpOrder(orderParams, {
			accounts: {
				state: await this.getStatePublicKey(),
				user,
				userStats: this.getUserStatsAccountPublicKey(),
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async updateAMMs(
		marketIndexes: number[],
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getUpdateAMMsIx(marketIndexes),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getUpdateAMMsIx(
		marketIndexes: number[]
	): Promise<TransactionInstruction> {
		for (let i = marketIndexes.length; i < 5; i++) {
			marketIndexes.push(100);
		}
		const marketAccountInfos = [];
		const oracleAccountInfos = [];
		for (const marketIndex of marketIndexes) {
			if (marketIndex !== 100) {
				const market = this.getPerpMarketAccount(marketIndex);
				marketAccountInfos.push({
					pubkey: market.pubkey,
					isWritable: true,
					isSigner: false,
				});
				oracleAccountInfos.push({
					pubkey: market.amm.oracle,
					isWritable: false,
					isSigner: false,
				});
			}
		}
		const remainingAccounts = oracleAccountInfos.concat(marketAccountInfos);

		return await this.program.instruction.updateAmms(marketIndexes, {
			accounts: {
				state: await this.getStatePublicKey(),
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async settleExpiredMarket(
		marketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getSettleExpiredMarketIx(marketIndex),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getSettleExpiredMarketIx(
		marketIndex: number
	): Promise<TransactionInstruction> {
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [],
			writablePerpMarketIndexes: [marketIndex],
			writableSpotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
		});

		return await this.program.instruction.settleExpiredMarket(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async settleExpiredMarketPoolsToRevenuePool(
		perpMarketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);

		const spotMarketPublicKey = await getSpotMarketPublicKey(
			this.program.programId,
			QUOTE_SPOT_MARKET_INDEX
		);

		const ix =
			await this.program.instruction.settleExpiredMarketPoolsToRevenuePool({
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.isSubscribed
						? this.getStateAccount().admin
						: this.wallet.publicKey,
					spotMarket: spotMarketPublicKey,
					perpMarket: perpMarketPublicKey,
				},
			});

		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(ix, txParams),
			[],
			this.opts
		);

		return txSig;
	}

	public async cancelOrder(
		orderId?: number,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getCancelOrderIx(orderId, subAccountId),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getCancelOrderIx(
		orderId?: number,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		const user = await this.getUserAccountPublicKey(subAccountId);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(subAccountId)],
			useMarketLastSlotCache: true,
		});

		return await this.program.instruction.cancelOrder(orderId ?? null, {
			accounts: {
				state: await this.getStatePublicKey(),
				user,
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async cancelOrderByUserId(
		userOrderId: number,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getCancelOrderByUserIdIx(userOrderId, subAccountId),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getCancelOrderByUserIdIx(
		userOrderId: number,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		const user = await this.getUserAccountPublicKey(subAccountId);

		const order = this.getOrderByUserId(userOrderId);
		const oracle = this.getPerpMarketAccount(order.marketIndex).amm.oracle;

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(subAccountId)],
			useMarketLastSlotCache: true,
		});

		return await this.program.instruction.cancelOrderByUserId(userOrderId, {
			accounts: {
				state: await this.getStatePublicKey(),
				user,
				authority: this.wallet.publicKey,
				oracle,
			},
			remainingAccounts,
		});
	}

	public async cancelOrdersByIds(
		orderIds?: number[],
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getCancelOrdersByIdsIx(orderIds, subAccountId),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getCancelOrdersByIdsIx(
		orderIds?: number[],
		subAccountId?: number
	): Promise<TransactionInstruction> {
		const user = await this.getUserAccountPublicKey(subAccountId);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(subAccountId)],
			useMarketLastSlotCache: true,
		});

		return await this.program.instruction.cancelOrdersByIds(orderIds, {
			accounts: {
				state: await this.getStatePublicKey(),
				user,
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async cancelOrders(
		marketType?: MarketType,
		marketIndex?: number,
		direction?: PositionDirection,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getCancelOrdersIx(
					marketType,
					marketIndex,
					direction,
					subAccountId
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getCancelOrdersIx(
		marketType: MarketType | null,
		marketIndex: number | null,
		direction: PositionDirection | null,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		const user = await this.getUserAccountPublicKey(subAccountId);

		let readablePerpMarketIndex = undefined;
		let readableSpotMarketIndexes = undefined;

		if (typeof marketIndex === 'number') {
			if (marketType && isVariant(marketType, 'perp')) {
				readablePerpMarketIndex = marketIndex;
			} else if (marketType && isVariant(marketType, 'spot')) {
				readableSpotMarketIndexes = [marketIndex];
			}
		}

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(subAccountId)],
			readablePerpMarketIndex,
			readableSpotMarketIndexes,
			useMarketLastSlotCache: true,
		});

		return await this.program.instruction.cancelOrders(
			marketType ?? null,
			marketIndex ?? null,
			direction ?? null,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user,
					authority: this.wallet.publicKey,
				},
				remainingAccounts,
			}
		);
	}

	public async cancelAndPlaceOrders(
		cancelOrderParams: {
			marketType?: MarketType;
			marketIndex?: number;
			direction?: PositionDirection;
		},
		placeOrderParams: OrderParams[],
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const ixs = [
			await this.getCancelOrdersIx(
				cancelOrderParams.marketType,
				cancelOrderParams.marketIndex,
				cancelOrderParams.direction,
				subAccountId
			),
			await this.getPlaceOrdersIx(placeOrderParams, subAccountId),
		];
		const tx = await this.buildTransaction(ixs, txParams);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async placeOrders(
		params: OrderParams[],
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			(await this.preparePlaceOrdersTx(params, txParams, subAccountId))
				.placeOrdersTx,
			[],
			this.opts,
			false
		);
		return txSig;
	}

	public async preparePlaceOrdersTx(
		params: OrderParams[],
		txParams?: TxParams,
		subAccountId?: number
	) {
		const tx = await this.buildTransaction(
			await this.getPlaceOrdersIx(params, subAccountId),
			txParams
		);

		return {
			placeOrdersTx: tx,
		};
	}

	public async getPlaceOrdersIx(
		params: OptionalOrderParams[],
		subAccountId?: number
	): Promise<TransactionInstruction> {
		const user = await this.getUserAccountPublicKey(subAccountId);

		const readablePerpMarketIndex: number[] = [];
		const readableSpotMarketIndexes: number[] = [];
		for (const param of params) {
			if (!param.marketType) {
				throw new Error('must set param.marketType');
			}
			if (isVariant(param.marketType, 'perp')) {
				readablePerpMarketIndex.push(param.marketIndex);
			} else {
				readableSpotMarketIndexes.push(param.marketIndex);
			}
		}

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(subAccountId)],
			readablePerpMarketIndex,
			readableSpotMarketIndexes,
			useMarketLastSlotCache: true,
		});

		const formattedParams = params.map((item) => getOrderParams(item));

		return await this.program.instruction.placeOrders(formattedParams, {
			accounts: {
				state: await this.getStatePublicKey(),
				user,
				userStats: this.getUserStatsAccountPublicKey(),
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async fillPerpOrder(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		order?: Pick<Order, 'marketIndex' | 'orderId'>,
		makerInfo?: MakerInfo | MakerInfo[],
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams,
		fillerPublicKey?: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getFillPerpOrderIx(
					userAccountPublicKey,
					user,
					order,
					makerInfo,
					referrerInfo,
					fillerPublicKey
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getFillPerpOrderIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		order: Pick<Order, 'marketIndex' | 'orderId'>,
		makerInfo?: MakerInfo | MakerInfo[],
		referrerInfo?: ReferrerInfo,
		fillerSubAccountId?: number
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const filler = await this.getUserAccountPublicKey(fillerSubAccountId);
		const fillerStatsPublicKey = this.getUserStatsAccountPublicKey();

		const marketIndex = order
			? order.marketIndex
			: userAccount.orders.find(
					(order) => order.orderId === userAccount.nextOrderId - 1
			  ).marketIndex;

		makerInfo = Array.isArray(makerInfo)
			? makerInfo
			: makerInfo
			? [makerInfo]
			: [];

		const userAccounts = [userAccount];
		for (const maker of makerInfo) {
			userAccounts.push(maker.makerUserAccount);
		}
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts,
			writablePerpMarketIndexes: [marketIndex],
		});

		for (const maker of makerInfo) {
			remainingAccounts.push({
				pubkey: maker.maker,
				isWritable: true,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: maker.makerStats,
				isWritable: true,
				isSigner: false,
			});
		}

		if (referrerInfo) {
			const referrerIsMaker =
				makerInfo.find((maker) => maker.maker.equals(referrerInfo.referrer)) !==
				undefined;
			if (!referrerIsMaker) {
				remainingAccounts.push({
					pubkey: referrerInfo.referrer,
					isWritable: true,
					isSigner: false,
				});
				remainingAccounts.push({
					pubkey: referrerInfo.referrerStats,
					isWritable: true,
					isSigner: false,
				});
			}
		}

		const orderId = order.orderId;
		return await this.program.instruction.fillPerpOrder(orderId, null, {
			accounts: {
				state: await this.getStatePublicKey(),
				filler,
				fillerStats: fillerStatsPublicKey,
				user: userAccountPublicKey,
				userStats: userStatsPublicKey,
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async getRevertFillIx(
		fillerPublicKey?: PublicKey
	): Promise<TransactionInstruction> {
		const filler = fillerPublicKey ?? (await this.getUserAccountPublicKey());
		const fillerStatsPublicKey = this.getUserStatsAccountPublicKey();

		return this.program.instruction.revertFill({
			accounts: {
				state: await this.getStatePublicKey(),
				filler,
				fillerStats: fillerStatsPublicKey,
				authority: this.wallet.publicKey,
			},
		});
	}

	public async placeSpotOrder(
		orderParams: OptionalOrderParams,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			(await this.preparePlaceSpotOrderTx(orderParams, txParams, subAccountId))
				.placeSpotOrderTx,
			[],
			this.opts,
			false
		);
		this.spotMarketLastSlotCache.set(orderParams.marketIndex, slot);
		this.spotMarketLastSlotCache.set(QUOTE_SPOT_MARKET_INDEX, slot);
		return txSig;
	}

	public async preparePlaceSpotOrderTx(
		orderParams: OptionalOrderParams,
		txParams?: TxParams,
		subAccountId?: number
	) {
		const tx = await this.buildTransaction(
			await this.getPlaceSpotOrderIx(orderParams, subAccountId),
			txParams
		);

		return {
			placeSpotOrderTx: tx,
		};
	}

	public async getPlaceSpotOrderIx(
		orderParams: OptionalOrderParams,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		orderParams = getOrderParams(orderParams, { marketType: MarketType.SPOT });
		const userAccountPublicKey = await this.getUserAccountPublicKey(
			subAccountId
		);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(subAccountId)],
			useMarketLastSlotCache: true,
			readableSpotMarketIndexes: [
				orderParams.marketIndex,
				QUOTE_SPOT_MARKET_INDEX,
			],
		});

		return await this.program.instruction.placeSpotOrder(orderParams, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				userStats: this.getUserStatsAccountPublicKey(),
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async fillSpotOrder(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		order?: Order,
		fulfillmentConfig?:
			| SerumV3FulfillmentConfigAccount
			| PhoenixV1FulfillmentConfigAccount
			| OpenbookV2FulfillmentConfigAccount,
		makerInfo?: MakerInfo | MakerInfo[],
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getFillSpotOrderIx(
					userAccountPublicKey,
					user,
					order,
					fulfillmentConfig,
					makerInfo,
					referrerInfo
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getFillSpotOrderIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		order?: Order,
		fulfillmentConfig?:
			| SerumV3FulfillmentConfigAccount
			| PhoenixV1FulfillmentConfigAccount
			| OpenbookV2FulfillmentConfigAccount,
		makerInfo?: MakerInfo | MakerInfo[],
		referrerInfo?: ReferrerInfo,
		fillerPublicKey?: PublicKey
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const filler = fillerPublicKey ?? (await this.getUserAccountPublicKey());
		const fillerStatsPublicKey = this.getUserStatsAccountPublicKey();

		const marketIndex = order
			? order.marketIndex
			: userAccount.orders.find(
					(order) => order.orderId === userAccount.nextOrderId - 1
			  ).marketIndex;

		makerInfo = Array.isArray(makerInfo)
			? makerInfo
			: makerInfo
			? [makerInfo]
			: [];

		const userAccounts = [userAccount];
		for (const maker of makerInfo) {
			userAccounts.push(maker.makerUserAccount);
		}
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts,
			writableSpotMarketIndexes: [marketIndex, QUOTE_SPOT_MARKET_INDEX],
		});

		for (const maker of makerInfo) {
			remainingAccounts.push({
				pubkey: maker.maker,
				isWritable: true,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: maker.makerStats,
				isWritable: true,
				isSigner: false,
			});
		}

		const orderId = order.orderId;

		this.addSpotFulfillmentAccounts(
			marketIndex,
			remainingAccounts,
			fulfillmentConfig
		);

		return await this.program.instruction.fillSpotOrder(
			orderId,
			fulfillmentConfig ? fulfillmentConfig.fulfillmentType : null,
			null,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					filler,
					fillerStats: fillerStatsPublicKey,
					user: userAccountPublicKey,
					userStats: userStatsPublicKey,
					authority: this.wallet.publicKey,
				},
				remainingAccounts,
			}
		);
	}

	addSpotFulfillmentAccounts(
		marketIndex: number,
		remainingAccounts: AccountMeta[],
		fulfillmentConfig?:
			| SerumV3FulfillmentConfigAccount
			| PhoenixV1FulfillmentConfigAccount
			| OpenbookV2FulfillmentConfigAccount
	): void {
		if (fulfillmentConfig) {
			if ('serumProgramId' in fulfillmentConfig) {
				this.addSerumRemainingAccounts(
					marketIndex,
					remainingAccounts,
					fulfillmentConfig
				);
			} else if ('phoenixProgramId' in fulfillmentConfig) {
				this.addPhoenixRemainingAccounts(
					marketIndex,
					remainingAccounts,
					fulfillmentConfig
				);
			} else if ('openbookV2ProgramId' in fulfillmentConfig) {
				this.addOpenbookRemainingAccounts(
					marketIndex,
					remainingAccounts,
					fulfillmentConfig
				);
			} else {
				throw Error('Invalid fulfillment config type');
			}
		} else {
			remainingAccounts.push({
				pubkey: this.getSpotMarketAccount(marketIndex).vault,
				isWritable: false,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: this.getQuoteSpotMarketAccount().vault,
				isWritable: false,
				isSigner: false,
			});
		}
	}

	addSerumRemainingAccounts(
		marketIndex: number,
		remainingAccounts: AccountMeta[],
		fulfillmentConfig: SerumV3FulfillmentConfigAccount
	): void {
		remainingAccounts.push({
			pubkey: fulfillmentConfig.pubkey,
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.serumProgramId,
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.serumMarket,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.serumRequestQueue,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.serumEventQueue,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.serumBids,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.serumAsks,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.serumBaseVault,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.serumQuoteVault,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.serumOpenOrders,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: getSerumSignerPublicKey(
				fulfillmentConfig.serumProgramId,
				fulfillmentConfig.serumMarket,
				fulfillmentConfig.serumSignerNonce
			),
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: this.getSignerPublicKey(),
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: TOKEN_PROGRAM_ID,
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: this.getSpotMarketAccount(marketIndex).vault,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: this.getQuoteSpotMarketAccount().vault,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: this.getStateAccount().srmVault,
			isWritable: false,
			isSigner: false,
		});
	}

	addPhoenixRemainingAccounts(
		marketIndex: number,
		remainingAccounts: AccountMeta[],
		fulfillmentConfig: PhoenixV1FulfillmentConfigAccount
	): void {
		remainingAccounts.push({
			pubkey: fulfillmentConfig.pubkey,
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.phoenixProgramId,
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.phoenixLogAuthority,
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.phoenixMarket,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: this.getSignerPublicKey(),
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.phoenixBaseVault,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.phoenixQuoteVault,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: this.getSpotMarketAccount(marketIndex).vault,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: this.getQuoteSpotMarketAccount().vault,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: TOKEN_PROGRAM_ID,
			isWritable: false,
			isSigner: false,
		});
	}

	addOpenbookRemainingAccounts(
		marketIndex: number,
		remainingAccounts: AccountMeta[],
		fulfillmentConfig: OpenbookV2FulfillmentConfigAccount
	): void {
		remainingAccounts.push({
			pubkey: fulfillmentConfig.pubkey,
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: this.getSignerPublicKey(),
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.openbookV2ProgramId,
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.openbookV2Market,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.openbookV2MarketAuthority,
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.openbookV2EventHeap,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.openbookV2Bids,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.openbookV2Asks,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.openbookV2BaseVault,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: fulfillmentConfig.openbookV2QuoteVault,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: this.getSpotMarketAccount(marketIndex).vault,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: this.getQuoteSpotMarketAccount().vault,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: TOKEN_PROGRAM_ID,
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: SystemProgram.programId,
			isWritable: false,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: this.getSpotMarketAccount(marketIndex).pubkey,
			isWritable: true,
			isSigner: false,
		});
		remainingAccounts.push({
			pubkey: this.getQuoteSpotMarketAccount().pubkey,
			isWritable: true,
			isSigner: false,
		});

		if (fulfillmentConfig.remainingAccounts) {
			for (const remainingAccount of fulfillmentConfig.remainingAccounts) {
				remainingAccounts.push({
					pubkey: remainingAccount,
					isWritable: true,
					isSigner: false,
				});
			}
		}
	}

	/**
	 * Swap tokens in drift account using jupiter
	 * @param jupiterClient jupiter client to find routes and jupiter instructions
	 * @param outMarketIndex the market index of the token you're buying
	 * @param inMarketIndex the market index of the token you're selling
	 * @param outAssociatedTokenAccount the token account to receive the token being sold on jupiter
	 * @param inAssociatedTokenAccount the token account to
	 * @param amount the amount of TokenIn, regardless of swapMode
	 * @param slippageBps the max slippage passed to jupiter api
	 * @param swapMode jupiter swapMode (ExactIn or ExactOut), default is ExactIn
	 * @param route the jupiter route to use for the swap
	 * @param reduceOnly specify if In or Out token on the drift account must reduceOnly, checked at end of swap
	 * @param txParams
	 */
	public async swap({
		jupiterClient,
		outMarketIndex,
		inMarketIndex,
		outAssociatedTokenAccount,
		inAssociatedTokenAccount,
		amount,
		slippageBps,
		swapMode,
		route,
		reduceOnly,
		txParams,
		v6,
		onlyDirectRoutes = false,
	}: {
		jupiterClient: JupiterClient;
		outMarketIndex: number;
		inMarketIndex: number;
		outAssociatedTokenAccount?: PublicKey;
		inAssociatedTokenAccount?: PublicKey;
		amount: BN;
		slippageBps?: number;
		swapMode?: SwapMode;
		route?: Route;
		reduceOnly?: SwapReduceOnly;
		txParams?: TxParams;
		onlyDirectRoutes?: boolean;
		v6?: {
			quote?: QuoteResponse;
		};
	}): Promise<TransactionSignature> {
		let ixs: anchor.web3.TransactionInstruction[];
		let lookupTables: anchor.web3.AddressLookupTableAccount[];

		if (v6) {
			const res = await this.getJupiterSwapIxV6({
				jupiterClient,
				outMarketIndex,
				inMarketIndex,
				outAssociatedTokenAccount,
				inAssociatedTokenAccount,
				amount,
				slippageBps,
				swapMode,
				quote: v6.quote,
				reduceOnly,
				onlyDirectRoutes,
			});
			ixs = res.ixs;
			lookupTables = res.lookupTables;
		} else {
			const res = await this.getJupiterSwapIx({
				jupiterClient,
				outMarketIndex,
				inMarketIndex,
				outAssociatedTokenAccount,
				inAssociatedTokenAccount,
				amount,
				slippageBps,
				swapMode,
				route,
				reduceOnly,
			});
			ixs = res.ixs;
			lookupTables = res.lookupTables;
		}

		const tx = (await this.buildTransaction(
			ixs,
			txParams,
			0,
			lookupTables
		)) as VersionedTransaction;

		const { txSig, slot } = await this.sendTransaction(tx);
		this.spotMarketLastSlotCache.set(outMarketIndex, slot);
		this.spotMarketLastSlotCache.set(inMarketIndex, slot);

		return txSig;
	}

	public async getJupiterSwapIx({
		jupiterClient,
		outMarketIndex,
		inMarketIndex,
		outAssociatedTokenAccount,
		inAssociatedTokenAccount,
		amount,
		slippageBps,
		swapMode,
		onlyDirectRoutes,
		route,
		reduceOnly,
		userAccountPublicKey,
	}: {
		jupiterClient: JupiterClient;
		outMarketIndex: number;
		inMarketIndex: number;
		outAssociatedTokenAccount?: PublicKey;
		inAssociatedTokenAccount?: PublicKey;
		amount: BN;
		slippageBps?: number;
		swapMode?: SwapMode;
		onlyDirectRoutes?: boolean;
		route?: Route;
		reduceOnly?: SwapReduceOnly;
		userAccountPublicKey?: PublicKey;
	}): Promise<{
		ixs: TransactionInstruction[];
		lookupTables: AddressLookupTableAccount[];
	}> {
		const outMarket = this.getSpotMarketAccount(outMarketIndex);
		const inMarket = this.getSpotMarketAccount(inMarketIndex);

		if (!route) {
			const routes = await jupiterClient.getRoutes({
				inputMint: inMarket.mint,
				outputMint: outMarket.mint,
				amount,
				slippageBps,
				swapMode,
				onlyDirectRoutes,
			});

			if (!routes || routes.length === 0) {
				throw new Error('No jupiter routes found');
			}

			route = routes[0];
		}

		const transaction = await jupiterClient.getSwapTransaction({
			route,
			userPublicKey: this.provider.wallet.publicKey,
			slippageBps,
		});

		const { transactionMessage, lookupTables } =
			await jupiterClient.getTransactionMessageAndLookupTables({
				transaction,
			});

		const jupiterInstructions = jupiterClient.getJupiterInstructions({
			transactionMessage,
			inputMint: inMarket.mint,
			outputMint: outMarket.mint,
		});

		const preInstructions = [];
		if (!outAssociatedTokenAccount) {
			const tokenProgram = this.getTokenProgramForSpotMarket(outMarket);
			outAssociatedTokenAccount = await this.getAssociatedTokenAccount(
				outMarket.marketIndex,
				false,
				tokenProgram
			);

			const accountInfo = await this.connection.getAccountInfo(
				outAssociatedTokenAccount
			);
			if (!accountInfo) {
				preInstructions.push(
					this.createAssociatedTokenAccountIdempotentInstruction(
						outAssociatedTokenAccount,
						this.provider.wallet.publicKey,
						this.provider.wallet.publicKey,
						outMarket.mint,
						tokenProgram
					)
				);
			}
		}

		if (!inAssociatedTokenAccount) {
			const tokenProgram = this.getTokenProgramForSpotMarket(outMarket);
			inAssociatedTokenAccount = await this.getAssociatedTokenAccount(
				inMarket.marketIndex,
				false,
				tokenProgram
			);

			const accountInfo = await this.connection.getAccountInfo(
				inAssociatedTokenAccount
			);
			if (!accountInfo) {
				preInstructions.push(
					this.createAssociatedTokenAccountIdempotentInstruction(
						inAssociatedTokenAccount,
						this.provider.wallet.publicKey,
						this.provider.wallet.publicKey,
						inMarket.mint,
						tokenProgram
					)
				);
			}
		}

		const { beginSwapIx, endSwapIx } = await this.getSwapIx({
			outMarketIndex,
			inMarketIndex,
			amountIn: new BN(route.inAmount),
			inTokenAccount: inAssociatedTokenAccount,
			outTokenAccount: outAssociatedTokenAccount,
			reduceOnly,
			userAccountPublicKey,
		});

		const ixs = [
			...preInstructions,
			beginSwapIx,
			...jupiterInstructions,
			endSwapIx,
		];

		return { ixs, lookupTables };
	}

	public async getJupiterSwapIxV6({
		jupiterClient,
		outMarketIndex,
		inMarketIndex,
		outAssociatedTokenAccount,
		inAssociatedTokenAccount,
		amount,
		slippageBps,
		swapMode,
		onlyDirectRoutes,
		quote,
		reduceOnly,
		userAccountPublicKey,
	}: {
		jupiterClient: JupiterClient;
		outMarketIndex: number;
		inMarketIndex: number;
		outAssociatedTokenAccount?: PublicKey;
		inAssociatedTokenAccount?: PublicKey;
		amount: BN;
		slippageBps?: number;
		swapMode?: SwapMode;
		onlyDirectRoutes?: boolean;
		quote?: QuoteResponse;
		reduceOnly?: SwapReduceOnly;
		userAccountPublicKey?: PublicKey;
	}): Promise<{
		ixs: TransactionInstruction[];
		lookupTables: AddressLookupTableAccount[];
	}> {
		const outMarket = this.getSpotMarketAccount(outMarketIndex);
		const inMarket = this.getSpotMarketAccount(inMarketIndex);

		if (!quote) {
			const fetchedQuote = await jupiterClient.getQuote({
				inputMint: inMarket.mint,
				outputMint: outMarket.mint,
				amount,
				slippageBps,
				swapMode,
				onlyDirectRoutes,
			});

			quote = fetchedQuote;
		}

		if (!quote) {
			throw new Error("Could not fetch Jupiter's quote. Please try again.");
		}

		const isExactOut = swapMode === 'ExactOut' || quote.swapMode === 'ExactOut';
		const amountIn = new BN(quote.inAmount);
		const exactOutBufferedAmountIn = amountIn.muln(1001).divn(1000); // Add 10bp buffer

		const transaction = await jupiterClient.getSwap({
			quote,
			userPublicKey: this.provider.wallet.publicKey,
			slippageBps,
		});

		const { transactionMessage, lookupTables } =
			await jupiterClient.getTransactionMessageAndLookupTables({
				transaction,
			});

		const jupiterInstructions = jupiterClient.getJupiterInstructions({
			transactionMessage,
			inputMint: inMarket.mint,
			outputMint: outMarket.mint,
		});

		const preInstructions = [];
		if (!outAssociatedTokenAccount) {
			const tokenProgram = this.getTokenProgramForSpotMarket(outMarket);
			outAssociatedTokenAccount = await this.getAssociatedTokenAccount(
				outMarket.marketIndex,
				false,
				tokenProgram
			);

			const accountInfo = await this.connection.getAccountInfo(
				outAssociatedTokenAccount
			);
			if (!accountInfo) {
				preInstructions.push(
					this.createAssociatedTokenAccountIdempotentInstruction(
						outAssociatedTokenAccount,
						this.provider.wallet.publicKey,
						this.provider.wallet.publicKey,
						outMarket.mint,
						tokenProgram
					)
				);
			}
		}

		if (!inAssociatedTokenAccount) {
			const tokenProgram = this.getTokenProgramForSpotMarket(inMarket);
			inAssociatedTokenAccount = await this.getAssociatedTokenAccount(
				inMarket.marketIndex,
				false,
				tokenProgram
			);

			const accountInfo = await this.connection.getAccountInfo(
				inAssociatedTokenAccount
			);
			if (!accountInfo) {
				preInstructions.push(
					this.createAssociatedTokenAccountIdempotentInstruction(
						inAssociatedTokenAccount,
						this.provider.wallet.publicKey,
						this.provider.wallet.publicKey,
						inMarket.mint,
						tokenProgram
					)
				);
			}
		}

		const { beginSwapIx, endSwapIx } = await this.getSwapIx({
			outMarketIndex,
			inMarketIndex,
			amountIn: isExactOut ? exactOutBufferedAmountIn : amountIn,
			inTokenAccount: inAssociatedTokenAccount,
			outTokenAccount: outAssociatedTokenAccount,
			reduceOnly,
			userAccountPublicKey,
		});

		const ixs = [
			...preInstructions,
			beginSwapIx,
			...jupiterInstructions,
			endSwapIx,
		];

		return { ixs, lookupTables };
	}

	/**
	 * Get the drift begin_swap and end_swap instructions
	 *
	 * @param outMarketIndex the market index of the token you're buying
	 * @param inMarketIndex the market index of the token you're selling
	 * @param amountIn the amount of the token to sell
	 * @param inTokenAccount the token account to move the tokens being sold
	 * @param outTokenAccount the token account to receive the tokens being bought
	 * @param limitPrice the limit price of the swap
	 * @param reduceOnly
	 * @param userAccountPublicKey optional, specify a custom userAccountPublicKey to use instead of getting the current user account; can be helpful if the account is being created within the current tx
	 */
	public async getSwapIx({
		outMarketIndex,
		inMarketIndex,
		amountIn,
		inTokenAccount,
		outTokenAccount,
		limitPrice,
		reduceOnly,
		userAccountPublicKey,
	}: {
		outMarketIndex: number;
		inMarketIndex: number;
		amountIn: BN;
		inTokenAccount: PublicKey;
		outTokenAccount: PublicKey;
		limitPrice?: BN;
		reduceOnly?: SwapReduceOnly;
		userAccountPublicKey?: PublicKey;
	}): Promise<{
		beginSwapIx: TransactionInstruction;
		endSwapIx: TransactionInstruction;
	}> {
		const userAccountPublicKeyToUse =
			userAccountPublicKey || (await this.getUserAccountPublicKey());

		const userAccounts = [];
		try {
			if (this.hasUser() && this.getUser().getUserAccountAndSlot()) {
				userAccounts.push(this.getUser().getUserAccountAndSlot()!.data);
			}
		} catch (err) {
			// ignore
		}

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts,
			writableSpotMarketIndexes: [outMarketIndex, inMarketIndex],
			readableSpotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
		});

		const outSpotMarket = this.getSpotMarketAccount(outMarketIndex);
		const inSpotMarket = this.getSpotMarketAccount(inMarketIndex);

		const outTokenProgram = this.getTokenProgramForSpotMarket(outSpotMarket);
		const inTokenProgram = this.getTokenProgramForSpotMarket(inSpotMarket);

		if (!outTokenProgram.equals(inTokenProgram)) {
			remainingAccounts.push({
				pubkey: outTokenProgram,
				isWritable: false,
				isSigner: false,
			});
		}

		if (outSpotMarket.tokenProgram === 1 || inSpotMarket.tokenProgram === 1) {
			remainingAccounts.push({
				pubkey: inSpotMarket.mint,
				isWritable: false,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: outSpotMarket.mint,
				isWritable: false,
				isSigner: false,
			});
		}

		const beginSwapIx = await this.program.instruction.beginSwap(
			inMarketIndex,
			outMarketIndex,
			amountIn,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: userAccountPublicKeyToUse,
					userStats: this.getUserStatsAccountPublicKey(),
					authority: this.wallet.publicKey,
					outSpotMarketVault: outSpotMarket.vault,
					inSpotMarketVault: inSpotMarket.vault,
					inTokenAccount,
					outTokenAccount,
					tokenProgram: inTokenProgram,
					driftSigner: this.getStateAccount().signer,
					instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
				},
				remainingAccounts,
			}
		);

		const endSwapIx = await this.program.instruction.endSwap(
			inMarketIndex,
			outMarketIndex,
			limitPrice ?? null,
			reduceOnly ?? null,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: userAccountPublicKeyToUse,
					userStats: this.getUserStatsAccountPublicKey(),
					authority: this.wallet.publicKey,
					outSpotMarketVault: outSpotMarket.vault,
					inSpotMarketVault: inSpotMarket.vault,
					inTokenAccount,
					outTokenAccount,
					tokenProgram: inTokenProgram,
					driftSigner: this.getStateAccount().signer,
					instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
				},
				remainingAccounts,
			}
		);

		return { beginSwapIx, endSwapIx };
	}

	public async stakeForMSOL({ amount }: { amount: BN }): Promise<TxSigAndSlot> {
		const ixs = await this.getStakeForMSOLIx({ amount });
		const tx = await this.buildTransaction(ixs);
		return this.sendTransaction(tx);
	}

	public async getStakeForMSOLIx({
		amount,
		userAccountPublicKey,
	}: {
		amount: BN;
		userAccountPublicKey?: PublicKey;
	}): Promise<TransactionInstruction[]> {
		const wSOLMint = this.getSpotMarketAccount(1).mint;
		const mSOLAccount = await this.getAssociatedTokenAccount(2);
		const wSOLAccount = await this.getAssociatedTokenAccount(1, false);

		const wSOLAccountExists = await this.checkIfAccountExists(wSOLAccount);

		const closeWSOLIx = createCloseAccountInstruction(
			wSOLAccount,
			this.wallet.publicKey,
			this.wallet.publicKey
		);

		const createWSOLIx =
			await this.createAssociatedTokenAccountIdempotentInstruction(
				wSOLAccount,
				this.wallet.publicKey,
				this.wallet.publicKey,
				wSOLMint
			);

		const { beginSwapIx, endSwapIx } = await this.getSwapIx({
			inMarketIndex: 1,
			outMarketIndex: 2,
			amountIn: amount,
			inTokenAccount: wSOLAccount,
			outTokenAccount: mSOLAccount,
			userAccountPublicKey,
		});

		const program = getMarinadeFinanceProgram(this.provider);
		const depositIx = await getMarinadeDepositIx({
			program,
			mSOLAccount: mSOLAccount,
			transferFrom: this.wallet.publicKey,
			amount,
		});

		const ixs = [];

		if (!wSOLAccountExists) {
			ixs.push(createWSOLIx);
		}
		ixs.push(beginSwapIx, closeWSOLIx, depositIx, createWSOLIx, endSwapIx);

		return ixs;
	}

	public async triggerOrder(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		order: Order,
		txParams?: TxParams,
		fillerPublicKey?: PublicKey
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getTriggerOrderIx(
					userAccountPublicKey,
					user,
					order,
					fillerPublicKey
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getTriggerOrderIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		order: Order,
		fillerPublicKey?: PublicKey
	): Promise<TransactionInstruction> {
		const filler = fillerPublicKey ?? (await this.getUserAccountPublicKey());

		let remainingAccountsParams;
		if (isVariant(order.marketType, 'perp')) {
			remainingAccountsParams = {
				userAccounts: [userAccount],
				writablePerpMarketIndexes: [order.marketIndex],
			};
		} else {
			remainingAccountsParams = {
				userAccounts: [userAccount],
				writableSpotMarketIndexes: [order.marketIndex, QUOTE_SPOT_MARKET_INDEX],
			};
		}

		const remainingAccounts = this.getRemainingAccounts(
			remainingAccountsParams
		);

		const orderId = order.orderId;
		return await this.program.instruction.triggerOrder(orderId, {
			accounts: {
				state: await this.getStatePublicKey(),
				filler,
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async forceCancelOrders(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		txParams?: TxParams,
		fillerPublicKey?: PublicKey
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getForceCancelOrdersIx(
					userAccountPublicKey,
					user,
					fillerPublicKey
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getForceCancelOrdersIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		fillerPublicKey?: PublicKey
	): Promise<TransactionInstruction> {
		const filler = fillerPublicKey ?? (await this.getUserAccountPublicKey());

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [userAccount],
			writableSpotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
		});

		return await this.program.instruction.forceCancelOrders({
			accounts: {
				state: await this.getStatePublicKey(),
				filler,
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async updateUserIdle(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		txParams?: TxParams,
		fillerPublicKey?: PublicKey
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getUpdateUserIdleIx(
					userAccountPublicKey,
					user,
					fillerPublicKey
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getUpdateUserIdleIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		fillerPublicKey?: PublicKey
	): Promise<TransactionInstruction> {
		const filler = fillerPublicKey ?? (await this.getUserAccountPublicKey());

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [userAccount],
		});

		return await this.program.instruction.updateUserIdle({
			accounts: {
				state: await this.getStatePublicKey(),
				filler,
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async updateUserOpenOrdersCount(
		userAccountPublicKey: PublicKey,
		user: UserAccount,
		txParams?: TxParams,
		fillerPublicKey?: PublicKey
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getUpdateUserOpenOrdersCountIx(
					userAccountPublicKey,
					user,
					fillerPublicKey
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getUpdateUserOpenOrdersCountIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		fillerPublicKey?: PublicKey
	): Promise<TransactionInstruction> {
		const filler = fillerPublicKey ?? (await this.getUserAccountPublicKey());

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [userAccount],
		});

		return await this.program.instruction.updateUserOpenOrdersCount({
			accounts: {
				state: await this.getStatePublicKey(),
				filler,
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async placeAndTakePerpOrder(
		orderParams: OptionalOrderParams,
		makerInfo?: MakerInfo | MakerInfo[],
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getPlaceAndTakePerpOrderIx(
					orderParams,
					makerInfo,
					referrerInfo,
					subAccountId
				),
				txParams
			),
			[],
			this.opts
		);
		this.perpMarketLastSlotCache.set(orderParams.marketIndex, slot);
		return txSig;
	}

	public async preparePlaceAndTakePerpOrderWithAdditionalOrders(
		orderParams: OptionalOrderParams,
		makerInfo?: MakerInfo | MakerInfo[],
		referrerInfo?: ReferrerInfo,
		bracketOrdersParams = new Array<OptionalOrderParams>(),
		txParams?: TxParams,
		subAccountId?: number,
		cancelExistingOrders?: boolean,
		settlePnl?: boolean,
		exitEarlyIfSimFails?: boolean
	): Promise<{
		placeAndTakeTx: Transaction | VersionedTransaction;
		cancelExistingOrdersTx: Transaction | VersionedTransaction;
		settlePnlTx: Transaction | VersionedTransaction;
	}> {
		const placeAndTakeIxs: TransactionInstruction[] = [];

		type TxKeys = 'placeAndTakeTx' | 'cancelExistingOrdersTx' | 'settlePnlTx';

		const txsToSign: Record<TxKeys, Transaction | VersionedTransaction> = {
			placeAndTakeTx: undefined,
			cancelExistingOrdersTx: undefined,
			settlePnlTx: undefined,
		};

		// Get recent block hash so that we can re-use it for all transactions. Makes this logic run faster with fewer RPC requests
		const recentBlockHash =
			await this.txHandler.getLatestBlockhashForTransaction();

		let earlyExitFailedPlaceAndTakeSim = false;

		const prepPlaceAndTakeTx = async () => {
			const placeAndTakeIx = await this.getPlaceAndTakePerpOrderIx(
				orderParams,
				makerInfo,
				referrerInfo,
				subAccountId
			);

			placeAndTakeIxs.push(placeAndTakeIx);

			if (bracketOrdersParams.length > 0) {
				const bracketOrdersIx = await this.getPlaceOrdersIx(
					bracketOrdersParams,
					subAccountId
				);
				placeAndTakeIxs.push(bracketOrdersIx);
			}

			const shouldUseSimulationComputeUnits =
				txParams?.useSimulatedComputeUnits;
			const shouldExitIfSimulationFails = exitEarlyIfSimFails;

			const txParamsWithoutImplicitSimulation: TxParams = {
				...txParams,
				useSimulatedComputeUnits: false,
			};

			if (shouldUseSimulationComputeUnits || shouldExitIfSimulationFails) {
				const placeAndTakeTxToSim = (await this.buildTransaction(
					placeAndTakeIxs,
					txParams,
					undefined,
					undefined,
					true,
					recentBlockHash
				)) as VersionedTransaction;

				const simulationResult =
					await TransactionParamProcessor.getTxSimComputeUnits(
						placeAndTakeTxToSim,
						this.connection,
						txParams.computeUnitsBufferMultiplier ?? 1.2,
						txParams.lowerBoundCu
					);

				if (shouldExitIfSimulationFails && !simulationResult.success) {
					earlyExitFailedPlaceAndTakeSim = true;
					return;
				}

				txsToSign.placeAndTakeTx = await this.buildTransaction(
					placeAndTakeIxs,
					{
						...txParamsWithoutImplicitSimulation,
						computeUnits: simulationResult.computeUnits,
					},
					undefined,
					undefined,
					undefined,
					recentBlockHash
				);
			} else {
				txsToSign.placeAndTakeTx = await this.buildTransaction(
					placeAndTakeIxs,
					txParams,
					undefined,
					undefined,
					undefined,
					recentBlockHash
				);
			}

			return;
		};

		const prepCancelOrderTx = async () => {
			if (cancelExistingOrders && isVariant(orderParams.marketType, 'perp')) {
				const cancelOrdersIx = await this.getCancelOrdersIx(
					orderParams.marketType,
					orderParams.marketIndex,
					null,
					subAccountId
				);

				txsToSign.cancelExistingOrdersTx = await this.buildTransaction(
					[cancelOrdersIx],
					txParams,
					this.txVersion,
					undefined,
					undefined,
					recentBlockHash
				);
			}

			return;
		};

		const prepSettlePnlTx = async () => {
			if (settlePnl && isVariant(orderParams.marketType, 'perp')) {
				const userAccountPublicKey = await this.getUserAccountPublicKey(
					subAccountId
				);

				const settlePnlIx = await this.settlePNLIx(
					userAccountPublicKey,
					this.getUserAccount(subAccountId),
					orderParams.marketIndex
				);

				txsToSign.settlePnlTx = await this.buildTransaction(
					[settlePnlIx],
					txParams,
					this.txVersion,
					undefined,
					undefined,
					recentBlockHash
				);
			}
			return;
		};

		await Promise.all([
			prepPlaceAndTakeTx(),
			prepCancelOrderTx(),
			prepSettlePnlTx(),
		]);

		if (earlyExitFailedPlaceAndTakeSim) {
			return null;
		}

		return txsToSign;
	}

	public async placeAndTakePerpWithAdditionalOrders(
		orderParams: OptionalOrderParams,
		makerInfo?: MakerInfo | MakerInfo[],
		referrerInfo?: ReferrerInfo,
		bracketOrdersParams = new Array<OptionalOrderParams>(),
		txParams?: TxParams,
		subAccountId?: number,
		cancelExistingOrders?: boolean,
		settlePnl?: boolean,
		exitEarlyIfSimFails?: boolean
	): Promise<{
		txSig: TransactionSignature;
		signedCancelExistingOrdersTx?: Transaction;
		signedSettlePnlTx?: Transaction;
	}> {
		const txsToSign =
			await this.preparePlaceAndTakePerpOrderWithAdditionalOrders(
				orderParams,
				makerInfo,
				referrerInfo,
				bracketOrdersParams,
				txParams,
				subAccountId,
				cancelExistingOrders,
				settlePnl,
				exitEarlyIfSimFails
			);

		if (!txsToSign) {
			return null;
		}

		const signedTxs = (
			await this.txHandler.getSignedTransactionMap(
				txsToSign,
				this.provider.wallet
			)
		).signedTxMap;

		const { txSig, slot } = await this.sendTransaction(
			signedTxs.placeAndTakeTx,
			[],
			this.opts,
			true
		);

		this.perpMarketLastSlotCache.set(orderParams.marketIndex, slot);

		return {
			txSig,
			signedCancelExistingOrdersTx:
				signedTxs.cancelExistingOrdersTx as Transaction,
			signedSettlePnlTx: signedTxs.settlePnlTx as Transaction,
		};
	}

	public async getPlaceAndTakePerpOrderIx(
		orderParams: OptionalOrderParams,
		makerInfo?: MakerInfo | MakerInfo[],
		referrerInfo?: ReferrerInfo,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		orderParams = getOrderParams(orderParams, { marketType: MarketType.PERP });
		const userStatsPublicKey = await this.getUserStatsAccountPublicKey();
		const user = await this.getUserAccountPublicKey(subAccountId);

		makerInfo = Array.isArray(makerInfo)
			? makerInfo
			: makerInfo
			? [makerInfo]
			: [];

		const userAccounts = [this.getUserAccount(subAccountId)];
		for (const maker of makerInfo) {
			userAccounts.push(maker.makerUserAccount);
		}

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts,
			useMarketLastSlotCache: true,
			writablePerpMarketIndexes: [orderParams.marketIndex],
		});

		for (const maker of makerInfo) {
			remainingAccounts.push({
				pubkey: maker.maker,
				isWritable: true,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: maker.makerStats,
				isWritable: true,
				isSigner: false,
			});
		}

		if (referrerInfo) {
			const referrerIsMaker =
				makerInfo.find((maker) => maker.maker.equals(referrerInfo.referrer)) !==
				undefined;
			if (!referrerIsMaker) {
				remainingAccounts.push({
					pubkey: referrerInfo.referrer,
					isWritable: true,
					isSigner: false,
				});
				remainingAccounts.push({
					pubkey: referrerInfo.referrerStats,
					isWritable: true,
					isSigner: false,
				});
			}
		}

		return await this.program.instruction.placeAndTakePerpOrder(
			orderParams,
			null,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user,
					userStats: userStatsPublicKey,
					authority: this.wallet.publicKey,
				},
				remainingAccounts,
			}
		);
	}

	public async placeAndMakePerpOrder(
		orderParams: OptionalOrderParams,
		takerInfo: TakerInfo,
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getPlaceAndMakePerpOrderIx(
					orderParams,
					takerInfo,
					referrerInfo,
					subAccountId
				),
				txParams
			),
			[],
			this.opts
		);

		this.perpMarketLastSlotCache.set(orderParams.marketIndex, slot);

		return txSig;
	}

	public async getPlaceAndMakePerpOrderIx(
		orderParams: OptionalOrderParams,
		takerInfo: TakerInfo,
		referrerInfo?: ReferrerInfo,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		orderParams = getOrderParams(orderParams, { marketType: MarketType.PERP });
		const userStatsPublicKey = this.getUserStatsAccountPublicKey();
		const user = await this.getUserAccountPublicKey(subAccountId);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [
				this.getUserAccount(subAccountId),
				takerInfo.takerUserAccount,
			],
			useMarketLastSlotCache: true,
			writablePerpMarketIndexes: [orderParams.marketIndex],
		});

		if (referrerInfo) {
			remainingAccounts.push({
				pubkey: referrerInfo.referrer,
				isWritable: true,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: referrerInfo.referrerStats,
				isWritable: true,
				isSigner: false,
			});
		}

		const takerOrderId = takerInfo.order.orderId;
		return await this.program.instruction.placeAndMakePerpOrder(
			orderParams,
			takerOrderId,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user,
					userStats: userStatsPublicKey,
					taker: takerInfo.taker,
					takerStats: takerInfo.takerStats,
					authority: this.wallet.publicKey,
				},
				remainingAccounts,
			}
		);
	}

	public async preparePlaceAndTakeSpotOrder(
		orderParams: OptionalOrderParams,
		fulfillmentConfig?: SerumV3FulfillmentConfigAccount,
		makerInfo?: MakerInfo,
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams,
		subAccountId?: number
	) {
		const tx = await this.buildTransaction(
			await this.getPlaceAndTakeSpotOrderIx(
				orderParams,
				fulfillmentConfig,
				makerInfo,
				referrerInfo,
				subAccountId
			),
			txParams
		);

		return {
			placeAndTakeSpotOrderTx: tx,
		};
	}

	public async placeAndTakeSpotOrder(
		orderParams: OptionalOrderParams,
		fulfillmentConfig?: SerumV3FulfillmentConfigAccount,
		makerInfo?: MakerInfo,
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			(
				await this.preparePlaceAndTakeSpotOrder(
					orderParams,
					fulfillmentConfig,
					makerInfo,
					referrerInfo,
					txParams,
					subAccountId
				)
			).placeAndTakeSpotOrderTx,
			[],
			this.opts,
			false
		);
		this.spotMarketLastSlotCache.set(orderParams.marketIndex, slot);
		this.spotMarketLastSlotCache.set(QUOTE_SPOT_MARKET_INDEX, slot);
		return txSig;
	}

	public async getPlaceAndTakeSpotOrderIx(
		orderParams: OptionalOrderParams,
		fulfillmentConfig?: SerumV3FulfillmentConfigAccount,
		makerInfo?: MakerInfo,
		referrerInfo?: ReferrerInfo,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		orderParams = getOrderParams(orderParams, { marketType: MarketType.SPOT });
		const userStatsPublicKey = this.getUserStatsAccountPublicKey();
		const user = await this.getUserAccountPublicKey(subAccountId);

		const userAccounts = [this.getUserAccount(subAccountId)];
		if (makerInfo !== undefined) {
			userAccounts.push(makerInfo.makerUserAccount);
		}
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts,
			useMarketLastSlotCache: true,
			writableSpotMarketIndexes: [
				orderParams.marketIndex,
				QUOTE_SPOT_MARKET_INDEX,
			],
		});

		let makerOrderId = null;
		if (makerInfo) {
			makerOrderId = makerInfo.order.orderId;
			remainingAccounts.push({
				pubkey: makerInfo.maker,
				isSigner: false,
				isWritable: true,
			});
			remainingAccounts.push({
				pubkey: makerInfo.makerStats,
				isSigner: false,
				isWritable: true,
			});
		}

		if (referrerInfo) {
			remainingAccounts.push({
				pubkey: referrerInfo.referrer,
				isWritable: true,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: referrerInfo.referrerStats,
				isWritable: true,
				isSigner: false,
			});
		}

		this.addSpotFulfillmentAccounts(
			orderParams.marketIndex,
			remainingAccounts,
			fulfillmentConfig
		);

		return await this.program.instruction.placeAndTakeSpotOrder(
			orderParams,
			fulfillmentConfig ? fulfillmentConfig.fulfillmentType : null,
			makerOrderId,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user,
					userStats: userStatsPublicKey,
					authority: this.wallet.publicKey,
				},
				remainingAccounts,
			}
		);
	}

	public async placeAndMakeSpotOrder(
		orderParams: OptionalOrderParams,
		takerInfo: TakerInfo,
		fulfillmentConfig?: SerumV3FulfillmentConfigAccount,
		referrerInfo?: ReferrerInfo,
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getPlaceAndMakeSpotOrderIx(
					orderParams,
					takerInfo,
					fulfillmentConfig,
					referrerInfo,
					subAccountId
				),
				txParams
			),
			[],
			this.opts
		);
		this.spotMarketLastSlotCache.set(orderParams.marketIndex, slot);
		this.spotMarketLastSlotCache.set(QUOTE_SPOT_MARKET_INDEX, slot);
		return txSig;
	}

	public async getPlaceAndMakeSpotOrderIx(
		orderParams: OptionalOrderParams,
		takerInfo: TakerInfo,
		fulfillmentConfig?: SerumV3FulfillmentConfigAccount,
		referrerInfo?: ReferrerInfo,
		subAccountId?: number
	): Promise<TransactionInstruction> {
		orderParams = getOrderParams(orderParams, { marketType: MarketType.SPOT });
		const userStatsPublicKey = this.getUserStatsAccountPublicKey();
		const user = await this.getUserAccountPublicKey(subAccountId);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [
				this.getUserAccount(subAccountId),
				takerInfo.takerUserAccount,
			],
			useMarketLastSlotCache: true,
			writableSpotMarketIndexes: [
				orderParams.marketIndex,
				QUOTE_SPOT_MARKET_INDEX,
			],
		});

		if (referrerInfo) {
			remainingAccounts.push({
				pubkey: referrerInfo.referrer,
				isWritable: true,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: referrerInfo.referrerStats,
				isWritable: true,
				isSigner: false,
			});
		}

		this.addSpotFulfillmentAccounts(
			orderParams.marketIndex,
			remainingAccounts,
			fulfillmentConfig
		);

		const takerOrderId = takerInfo.order.orderId;
		return await this.program.instruction.placeAndMakeSpotOrder(
			orderParams,
			takerOrderId,
			fulfillmentConfig ? fulfillmentConfig.fulfillmentType : null,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user,
					userStats: userStatsPublicKey,
					taker: takerInfo.taker,
					takerStats: takerInfo.takerStats,
					authority: this.wallet.publicKey,
				},
				remainingAccounts,
			}
		);
	}

	/**
	 * @deprecated use {@link placePerpOrder} or {@link placeAndTakePerpOrder} instead
	 */
	public async closePosition(
		marketIndex: number,
		limitPrice?: BN,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const userPosition =
			this.getUser(subAccountId).getPerpPosition(marketIndex);
		if (!userPosition) {
			throw Error(`No position in market ${marketIndex.toString()}`);
		}

		return await this.placeAndTakePerpOrder(
			{
				orderType: OrderType.MARKET,
				marketIndex,
				direction: findDirectionToClose(userPosition),
				baseAssetAmount: userPosition.baseAssetAmount.abs(),
				reduceOnly: true,
				price: limitPrice,
			},
			undefined,
			undefined,
			undefined,
			subAccountId
		);
	}

	/**
	 * Modifies an open order by closing it and replacing it with a new order.
	 * @deprecated use modifyOrder instead
	 * @param orderId: The open order to modify
	 * @param newBaseAmount: The new base amount for the order. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @param newLimitPice: The new limit price for the order. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @param newOraclePriceOffset: The new oracle price offset for the order. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @returns
	 */
	public async modifyPerpOrder(
		orderId: number,
		newBaseAmount?: BN,
		newLimitPrice?: BN,
		newOraclePriceOffset?: number
	): Promise<TransactionSignature> {
		return this.modifyOrder({
			orderId,
			newBaseAmount,
			newLimitPrice,
			newOraclePriceOffset,
		});
	}

	/**
	 * Modifies an open order by closing it and replacing it with a new order.
	 * @deprecated use modifyOrderByUserOrderId instead
	 * @param userOrderId: The open order to modify
	 * @param newBaseAmount: The new base amount for the order. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @param newLimitPice: The new limit price for the order. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @param newOraclePriceOffset: The new oracle price offset for the order. One of [newBaseAmount|newLimitPrice|newOraclePriceOffset] must be provided.
	 * @returns
	 */
	public async modifyPerpOrderByUserOrderId(
		userOrderId: number,
		newBaseAmount?: BN,
		newLimitPrice?: BN,
		newOraclePriceOffset?: number
	): Promise<TransactionSignature> {
		return this.modifyOrderByUserOrderId({
			userOrderId,
			newBaseAmount,
			newLimitPrice,
			newOraclePriceOffset,
		});
	}

	/**
	 * Modifies an open order (spot or perp) by closing it and replacing it with a new order.
	 * @param orderParams.orderId: The open order to modify
	 * @param orderParams.newDirection: The new direction for the order
	 * @param orderParams.newBaseAmount: The new base amount for the order
	 * @param orderParams.newLimitPice: The new limit price for the order
	 * @param orderParams.newOraclePriceOffset: The new oracle price offset for the order
	 * @param orderParams.newTriggerPrice: Optional - Thew new trigger price for the order.
	 * @param orderParams.auctionDuration:
	 * @param orderParams.auctionStartPrice:
	 * @param orderParams.auctionEndPrice:
	 * @param orderParams.reduceOnly:
	 * @param orderParams.postOnly:
	 * @param orderParams.immediateOrCancel:
	 * @param orderParams.policy:
	 * @param orderParams.maxTs:
	 * @returns
	 */
	public async modifyOrder(
		orderParams: {
			orderId: number;
			newDirection?: PositionDirection;
			newBaseAmount?: BN;
			newLimitPrice?: BN;
			newOraclePriceOffset?: number;
			newTriggerPrice?: BN;
			newTriggerCondition?: OrderTriggerCondition;
			auctionDuration?: number;
			auctionStartPrice?: BN;
			auctionEndPrice?: BN;
			reduceOnly?: boolean;
			postOnly?: boolean;
			immediateOrCancel?: boolean;
			maxTs?: BN;
			policy?: ModifyOrderPolicy;
		},
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getModifyOrderIx(orderParams, subAccountId),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getModifyOrderIx(
		{
			orderId,
			newDirection,
			newBaseAmount,
			newLimitPrice,
			newOraclePriceOffset,
			newTriggerPrice,
			newTriggerCondition,
			auctionDuration,
			auctionStartPrice,
			auctionEndPrice,
			reduceOnly,
			postOnly,
			immediateOrCancel,
			maxTs,
			policy,
		}: {
			orderId: number;
			newDirection?: PositionDirection;
			newBaseAmount?: BN;
			newLimitPrice?: BN;
			newOraclePriceOffset?: number;
			newTriggerPrice?: BN;
			newTriggerCondition?: OrderTriggerCondition;
			auctionDuration?: number;
			auctionStartPrice?: BN;
			auctionEndPrice?: BN;
			reduceOnly?: boolean;
			postOnly?: boolean;
			immediateOrCancel?: boolean;
			maxTs?: BN;
			policy?: ModifyOrderPolicy;
		},
		subAccountId?: number
	): Promise<TransactionInstruction> {
		const user = await this.getUserAccountPublicKey(subAccountId);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(subAccountId)],
			useMarketLastSlotCache: true,
		});

		const orderParams: ModifyOrderParams = {
			baseAssetAmount: newBaseAmount || null,
			direction: newDirection || null,
			price: newLimitPrice || null,
			oraclePriceOffset: newOraclePriceOffset || null,
			triggerPrice: newTriggerPrice || null,
			triggerCondition: newTriggerCondition || null,
			auctionDuration: auctionDuration || null,
			auctionStartPrice: auctionStartPrice || null,
			auctionEndPrice: auctionEndPrice || null,
			reduceOnly: reduceOnly != undefined ? reduceOnly : null,
			postOnly: postOnly != undefined ? postOnly : null,
			immediateOrCancel:
				immediateOrCancel != undefined ? immediateOrCancel : null,
			policy: policy || null,
			maxTs: maxTs || null,
		};

		return await this.program.instruction.modifyOrder(orderId, orderParams, {
			accounts: {
				state: await this.getStatePublicKey(),
				user,
				userStats: this.getUserStatsAccountPublicKey(),
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	/**
	 * Modifies an open order by closing it and replacing it with a new order.
	 * @param orderParams.userOrderId: The open order to modify
	 * @param orderParams.newDirection: The new direction for the order
	 * @param orderParams.newBaseAmount: The new base amount for the order
	 * @param orderParams.newLimitPice: The new limit price for the order
	 * @param orderParams.newOraclePriceOffset: The new oracle price offset for the order
	 * @param orderParams.newTriggerPrice: Optional - Thew new trigger price for the order.
	 * @param orderParams.auctionDuration: Only required if order type changed to market from something else
	 * @param orderParams.auctionStartPrice: Only required if order type changed to market from something else
	 * @param orderParams.auctionEndPrice: Only required if order type changed to market from something else
	 * @param orderParams.reduceOnly:
	 * @param orderParams.postOnly:
	 * @param orderParams.immediateOrCancel:
	 * @param orderParams.policy:
	 * @param orderParams.maxTs:
	 * @returns
	 */
	public async modifyOrderByUserOrderId(
		orderParams: {
			userOrderId: number;
			newDirection?: PositionDirection;
			newBaseAmount?: BN;
			newLimitPrice?: BN;
			newOraclePriceOffset?: number;
			newTriggerPrice?: BN;
			newTriggerCondition?: OrderTriggerCondition;
			auctionDuration?: number;
			auctionStartPrice?: BN;
			auctionEndPrice?: BN;
			reduceOnly?: boolean;
			postOnly?: boolean;
			immediateOrCancel?: boolean;
			policy?: ModifyOrderPolicy;
			maxTs?: BN;
		},
		txParams?: TxParams,
		subAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getModifyOrderByUserIdIx(orderParams, subAccountId),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getModifyOrderByUserIdIx(
		{
			userOrderId,
			newDirection,
			newBaseAmount,
			newLimitPrice,
			newOraclePriceOffset,
			newTriggerPrice,
			newTriggerCondition,
			auctionDuration,
			auctionStartPrice,
			auctionEndPrice,
			reduceOnly,
			postOnly,
			immediateOrCancel,
			maxTs,
			policy,
		}: {
			userOrderId: number;
			newDirection?: PositionDirection;
			newBaseAmount?: BN;
			newLimitPrice?: BN;
			newOraclePriceOffset?: number;
			newTriggerPrice?: BN;
			newTriggerCondition?: OrderTriggerCondition;
			auctionDuration?: number;
			auctionStartPrice?: BN;
			auctionEndPrice?: BN;
			reduceOnly?: boolean;
			postOnly?: boolean;
			immediateOrCancel?: boolean;
			policy?: ModifyOrderPolicy;
			maxTs?: BN;
			txParams?: TxParams;
		},
		subAccountId?: number
	): Promise<TransactionInstruction> {
		const user = await this.getUserAccountPublicKey(subAccountId);

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(subAccountId)],
			useMarketLastSlotCache: true,
		});

		const orderParams: ModifyOrderParams = {
			baseAssetAmount: newBaseAmount || null,
			direction: newDirection || null,
			price: newLimitPrice || null,
			oraclePriceOffset: newOraclePriceOffset || null,
			triggerPrice: newTriggerPrice || null,
			triggerCondition: newTriggerCondition || null,
			auctionDuration: auctionDuration || null,
			auctionStartPrice: auctionStartPrice || null,
			auctionEndPrice: auctionEndPrice || null,
			reduceOnly: reduceOnly || false,
			postOnly: postOnly || null,
			immediateOrCancel: immediateOrCancel || false,
			policy: policy || null,
			maxTs: maxTs || null,
		};

		return await this.program.instruction.modifyOrderByUserId(
			userOrderId,
			orderParams,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user,
					userStats: this.getUserStatsAccountPublicKey(),
					authority: this.wallet.publicKey,
				},
				remainingAccounts,
			}
		);
	}

	public async settlePNLs(
		users: {
			settleeUserAccountPublicKey: PublicKey;
			settleeUserAccount: UserAccount;
		}[],
		marketIndexes: number[],
		opts?: {
			filterInvalidMarkets?: boolean;
		},
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const filterInvalidMarkets = opts?.filterInvalidMarkets;

		// # Filter market indexes by markets with valid oracle
		const marketIndexToSettle: number[] = filterInvalidMarkets
			? []
			: marketIndexes;

		if (filterInvalidMarkets) {
			for (const marketIndex of marketIndexes) {
				const perpMarketAccount = this.getPerpMarketAccount(marketIndex);
				const oraclePriceData = this.getOracleDataForPerpMarket(marketIndex);
				const stateAccountAndSlot =
					this.accountSubscriber.getStateAccountAndSlot();
				const oracleGuardRails = stateAccountAndSlot.data.oracleGuardRails;

				const isValid = isOracleValid(
					perpMarketAccount,
					oraclePriceData,
					oracleGuardRails,
					stateAccountAndSlot.slot
				);

				if (isValid) {
					marketIndexToSettle.push(marketIndex);
				}
			}
		}

		// # Settle filtered market indexes
		const ixs = await this.getSettlePNLsIxs(users, marketIndexToSettle);

		const tx = await this.buildTransaction(
			ixs,
			txParams ?? {
				computeUnits: 1_400_000,
			}
		);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getSettlePNLsIxs(
		users: {
			settleeUserAccountPublicKey: PublicKey;
			settleeUserAccount: UserAccount;
		}[],
		marketIndexes: number[]
	): Promise<Array<TransactionInstruction>> {
		const ixs = [];
		for (const { settleeUserAccountPublicKey, settleeUserAccount } of users) {
			for (const marketIndex of marketIndexes) {
				ixs.push(
					await this.settlePNLIx(
						settleeUserAccountPublicKey,
						settleeUserAccount,
						marketIndex
					)
				);
			}
		}

		return ixs;
	}

	public async settlePNL(
		settleeUserAccountPublicKey: PublicKey,
		settleeUserAccount: UserAccount,
		marketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.settlePNLIx(
					settleeUserAccountPublicKey,
					settleeUserAccount,
					marketIndex
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async settlePNLIx(
		settleeUserAccountPublicKey: PublicKey,
		settleeUserAccount: UserAccount,
		marketIndex: number
	): Promise<TransactionInstruction> {
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [settleeUserAccount],
			writablePerpMarketIndexes: [marketIndex],
			writableSpotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
		});

		return await this.program.instruction.settlePnl(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				authority: this.wallet.publicKey,
				user: settleeUserAccountPublicKey,
				spotMarketVault: this.getQuoteSpotMarketAccount().vault,
			},
			remainingAccounts: remainingAccounts,
		});
	}

	public async settleMultiplePNLs(
		settleeUserAccountPublicKey: PublicKey,
		settleeUserAccount: UserAccount,
		marketIndexes: number[],
		mode: SettlePnlMode,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.settleMultiplePNLsIx(
					settleeUserAccountPublicKey,
					settleeUserAccount,
					marketIndexes,
					mode
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async settleMultiplePNLsIx(
		settleeUserAccountPublicKey: PublicKey,
		settleeUserAccount: UserAccount,
		marketIndexes: number[],
		mode: SettlePnlMode
	): Promise<TransactionInstruction> {
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [settleeUserAccount],
			writablePerpMarketIndexes: marketIndexes,
			writableSpotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
		});

		return await this.program.instruction.settleMultiplePnls(
			marketIndexes,
			mode,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: this.wallet.publicKey,
					user: settleeUserAccountPublicKey,
					spotMarketVault: this.getQuoteSpotMarketAccount().vault,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async getSetUserStatusToBeingLiquidatedIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount
	): Promise<TransactionInstruction> {
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [userAccount],
		});
		return await this.program.instruction.setUserStatusToBeingLiquidated({
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
			},
			remainingAccounts,
		});
	}

	public async setUserStatusToBeingLiquidated(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getSetUserStatusToBeingLiquidatedIx(
					userAccountPublicKey,
					userAccount
				)
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async liquidatePerp(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		maxBaseAssetAmount: BN,
		limitPrice?: BN,
		txParams?: TxParams,
		liquidatorSubAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getLiquidatePerpIx(
					userAccountPublicKey,
					userAccount,
					marketIndex,
					maxBaseAssetAmount,
					limitPrice,
					liquidatorSubAccountId
				),
				txParams
			),
			[],
			this.opts
		);
		this.perpMarketLastSlotCache.set(marketIndex, slot);
		return txSig;
	}

	public async getLiquidatePerpIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		maxBaseAssetAmount: BN,
		limitPrice?: BN,
		liquidatorSubAccountId?: number
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const liquidator = await this.getUserAccountPublicKey(
			liquidatorSubAccountId
		);
		const liquidatorStatsPublicKey = this.getUserStatsAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(liquidatorSubAccountId), userAccount],
			useMarketLastSlotCache: true,
			writablePerpMarketIndexes: [marketIndex],
		});

		return await this.program.instruction.liquidatePerp(
			marketIndex,
			maxBaseAssetAmount,
			limitPrice ?? null,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: this.wallet.publicKey,
					user: userAccountPublicKey,
					userStats: userStatsPublicKey,
					liquidator,
					liquidatorStats: liquidatorStatsPublicKey,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async liquidatePerpWithFill(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		makerInfos: MakerInfo[],
		txParams?: TxParams,
		liquidatorSubAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getLiquidatePerpWithFillIx(
					userAccountPublicKey,
					userAccount,
					marketIndex,
					makerInfos,
					liquidatorSubAccountId
				),
				txParams
			),
			[],
			this.opts
		);
		this.perpMarketLastSlotCache.set(marketIndex, slot);
		return txSig;
	}

	public async getLiquidatePerpWithFillIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		makerInfos: MakerInfo[],
		liquidatorSubAccountId?: number
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const liquidator = await this.getUserAccountPublicKey(
			liquidatorSubAccountId
		);
		const liquidatorStatsPublicKey = this.getUserStatsAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(liquidatorSubAccountId), userAccount],
			useMarketLastSlotCache: true,
			writablePerpMarketIndexes: [marketIndex],
		});

		for (const makerInfo of makerInfos) {
			remainingAccounts.push({
				pubkey: makerInfo.maker,
				isSigner: false,
				isWritable: true,
			});
			remainingAccounts.push({
				pubkey: makerInfo.makerStats,
				isSigner: false,
				isWritable: true,
			});
		}

		return await this.program.instruction.liquidatePerpWithFill(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				authority: this.wallet.publicKey,
				user: userAccountPublicKey,
				userStats: userStatsPublicKey,
				liquidator,
				liquidatorStats: liquidatorStatsPublicKey,
			},
			remainingAccounts: remainingAccounts,
		});
	}

	public async liquidateSpot(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		assetMarketIndex: number,
		liabilityMarketIndex: number,
		maxLiabilityTransfer: BN,
		limitPrice?: BN,
		txParams?: TxParams,
		liquidatorSubAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getLiquidateSpotIx(
					userAccountPublicKey,
					userAccount,
					assetMarketIndex,
					liabilityMarketIndex,
					maxLiabilityTransfer,
					limitPrice,
					liquidatorSubAccountId
				),
				txParams
			),
			[],
			this.opts
		);
		this.spotMarketLastSlotCache.set(assetMarketIndex, slot);
		this.spotMarketLastSlotCache.set(liabilityMarketIndex, slot);
		return txSig;
	}

	public async getLiquidateSpotIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		assetMarketIndex: number,
		liabilityMarketIndex: number,
		maxLiabilityTransfer: BN,
		limitPrice?: BN,
		liquidatorSubAccountId?: number
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const liquidator = await this.getUserAccountPublicKey(
			liquidatorSubAccountId
		);
		const liquidatorStatsPublicKey = this.getUserStatsAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(liquidatorSubAccountId), userAccount],
			useMarketLastSlotCache: true,
			writableSpotMarketIndexes: [liabilityMarketIndex, assetMarketIndex],
		});

		return await this.program.instruction.liquidateSpot(
			assetMarketIndex,
			liabilityMarketIndex,
			maxLiabilityTransfer,
			limitPrice || null,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: this.wallet.publicKey,
					user: userAccountPublicKey,
					userStats: userStatsPublicKey,
					liquidator,
					liquidatorStats: liquidatorStatsPublicKey,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async liquidateBorrowForPerpPnl(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		perpMarketIndex: number,
		liabilityMarketIndex: number,
		maxLiabilityTransfer: BN,
		limitPrice?: BN,
		txParams?: TxParams,
		liquidatorSubAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getLiquidateBorrowForPerpPnlIx(
					userAccountPublicKey,
					userAccount,
					perpMarketIndex,
					liabilityMarketIndex,
					maxLiabilityTransfer,
					limitPrice,
					liquidatorSubAccountId
				),
				txParams
			),
			[],
			this.opts
		);
		this.perpMarketLastSlotCache.set(perpMarketIndex, slot);
		this.spotMarketLastSlotCache.set(liabilityMarketIndex, slot);
		return txSig;
	}

	public async getLiquidateBorrowForPerpPnlIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		perpMarketIndex: number,
		liabilityMarketIndex: number,
		maxLiabilityTransfer: BN,
		limitPrice?: BN,
		liquidatorSubAccountId?: number
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const liquidator = await this.getUserAccountPublicKey(
			liquidatorSubAccountId
		);
		const liquidatorStatsPublicKey = this.getUserStatsAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(liquidatorSubAccountId), userAccount],
			writablePerpMarketIndexes: [perpMarketIndex],
			writableSpotMarketIndexes: [liabilityMarketIndex],
		});

		return await this.program.instruction.liquidateBorrowForPerpPnl(
			perpMarketIndex,
			liabilityMarketIndex,
			maxLiabilityTransfer,
			limitPrice || null,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: this.wallet.publicKey,
					user: userAccountPublicKey,
					userStats: userStatsPublicKey,
					liquidator,
					liquidatorStats: liquidatorStatsPublicKey,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async liquidatePerpPnlForDeposit(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		perpMarketIndex: number,
		assetMarketIndex: number,
		maxPnlTransfer: BN,
		limitPrice?: BN,
		txParams?: TxParams,
		liquidatorSubAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig, slot } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getLiquidatePerpPnlForDepositIx(
					userAccountPublicKey,
					userAccount,
					perpMarketIndex,
					assetMarketIndex,
					maxPnlTransfer,
					limitPrice,
					liquidatorSubAccountId
				),
				txParams
			),
			[],
			this.opts
		);
		this.perpMarketLastSlotCache.set(perpMarketIndex, slot);
		this.spotMarketLastSlotCache.set(assetMarketIndex, slot);
		return txSig;
	}

	public async getLiquidatePerpPnlForDepositIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		perpMarketIndex: number,
		assetMarketIndex: number,
		maxPnlTransfer: BN,
		limitPrice?: BN,
		liquidatorSubAccountId?: number
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const liquidator = await this.getUserAccountPublicKey(
			liquidatorSubAccountId
		);
		const liquidatorStatsPublicKey = this.getUserStatsAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(liquidatorSubAccountId), userAccount],
			writablePerpMarketIndexes: [perpMarketIndex],
			writableSpotMarketIndexes: [assetMarketIndex],
		});

		return await this.program.instruction.liquidatePerpPnlForDeposit(
			perpMarketIndex,
			assetMarketIndex,
			maxPnlTransfer,
			limitPrice || null,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: this.wallet.publicKey,
					user: userAccountPublicKey,
					userStats: userStatsPublicKey,
					liquidator,
					liquidatorStats: liquidatorStatsPublicKey,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async resolvePerpBankruptcy(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		txParams?: TxParams,
		liquidatorSubAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getResolvePerpBankruptcyIx(
					userAccountPublicKey,
					userAccount,
					marketIndex,
					liquidatorSubAccountId
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getResolvePerpBankruptcyIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		liquidatorSubAccountId?: number
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const liquidator = await this.getUserAccountPublicKey(
			liquidatorSubAccountId
		);
		const liquidatorStatsPublicKey = this.getUserStatsAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(liquidatorSubAccountId), userAccount],
			writablePerpMarketIndexes: [marketIndex],
			writableSpotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
		});

		const spotMarket = this.getQuoteSpotMarketAccount();

		return await this.program.instruction.resolvePerpBankruptcy(
			QUOTE_SPOT_MARKET_INDEX,
			marketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: this.wallet.publicKey,
					user: userAccountPublicKey,
					userStats: userStatsPublicKey,
					liquidator,
					liquidatorStats: liquidatorStatsPublicKey,
					spotMarketVault: spotMarket.vault,
					insuranceFundVault: spotMarket.insuranceFund.vault,
					driftSigner: this.getSignerPublicKey(),
					tokenProgram: TOKEN_PROGRAM_ID,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async resolveSpotBankruptcy(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		txParams?: TxParams,
		liquidatorSubAccountId?: number
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getResolveSpotBankruptcyIx(
					userAccountPublicKey,
					userAccount,
					marketIndex,
					liquidatorSubAccountId
				),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getResolveSpotBankruptcyIx(
		userAccountPublicKey: PublicKey,
		userAccount: UserAccount,
		marketIndex: number,
		liquidatorSubAccountId?: number
	): Promise<TransactionInstruction> {
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			userAccount.authority
		);

		const liquidator = await this.getUserAccountPublicKey(
			liquidatorSubAccountId
		);
		const liquidatorStatsPublicKey = this.getUserStatsAccountPublicKey();

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount(liquidatorSubAccountId), userAccount],
			writableSpotMarketIndexes: [marketIndex],
		});

		const spotMarket = this.getSpotMarketAccount(marketIndex);

		this.addTokenMintToRemainingAccounts(spotMarket, remainingAccounts);

		return await this.program.instruction.resolveSpotBankruptcy(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				authority: this.wallet.publicKey,
				user: userAccountPublicKey,
				userStats: userStatsPublicKey,
				liquidatorStats: liquidatorStatsPublicKey,
				liquidator,
				spotMarketVault: spotMarket.vault,
				insuranceFundVault: spotMarket.insuranceFund.vault,
				driftSigner: this.getSignerPublicKey(),
				tokenProgram: TOKEN_PROGRAM_ID,
			},
			remainingAccounts: remainingAccounts,
		});
	}

	public async updateFundingRate(
		perpMarketIndex: number,
		oracle: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getUpdateFundingRateIx(perpMarketIndex, oracle),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getUpdateFundingRateIx(
		perpMarketIndex: number,
		oracle: PublicKey
	): Promise<TransactionInstruction> {
		const perpMarketPublicKey = await getPerpMarketPublicKey(
			this.program.programId,
			perpMarketIndex
		);
		return await this.program.instruction.updateFundingRate(perpMarketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				perpMarket: perpMarketPublicKey,
				oracle: oracle,
			},
		});
	}

	public async updatePrelaunchOracle(
		perpMarketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getUpdatePrelaunchOracleIx(perpMarketIndex),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getUpdatePrelaunchOracleIx(
		perpMarketIndex: number
	): Promise<TransactionInstruction> {
		const perpMarket = this.getPerpMarketAccount(perpMarketIndex);

		if (!isVariant(perpMarket.amm.oracleSource, 'prelaunch')) {
			throw new Error(`Wrong oracle source ${perpMarket.amm.oracleSource}`);
		}

		return await this.program.instruction.updatePrelaunchOracle({
			accounts: {
				state: await this.getStatePublicKey(),
				perpMarket: perpMarket.pubkey,
				oracle: perpMarket.amm.oracle,
			},
		});
	}

	public async updatePerpBidAskTwap(
		perpMarketIndex: number,
		makers: [PublicKey, PublicKey][],
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getUpdatePerpBidAskTwapIx(perpMarketIndex, makers),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getUpdatePerpBidAskTwapIx(
		perpMarketIndex: number,
		makers: [PublicKey, PublicKey][]
	): Promise<TransactionInstruction> {
		const perpMarket = this.getPerpMarketAccount(perpMarketIndex);

		const remainingAccounts = [];
		for (const [maker, makerStats] of makers) {
			remainingAccounts.push({
				pubkey: maker,
				isWritable: false,
				isSigner: false,
			});
			remainingAccounts.push({
				pubkey: makerStats,
				isWritable: false,
				isSigner: false,
			});
		}

		return await this.program.instruction.updatePerpBidAskTwap({
			accounts: {
				state: await this.getStatePublicKey(),
				perpMarket: perpMarket.pubkey,
				oracle: perpMarket.amm.oracle,
				authority: this.wallet.publicKey,
				keeperStats: this.getUserStatsAccountPublicKey(),
			},
			remainingAccounts,
		});
	}

	public async settleFundingPayment(
		userAccountPublicKey: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getSettleFundingPaymentIx(userAccountPublicKey),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getSettleFundingPaymentIx(
		userAccountPublicKey: PublicKey
	): Promise<TransactionInstruction> {
		const userAccount = (await this.program.account.user.fetch(
			userAccountPublicKey
		)) as UserAccount;

		const writablePerpMarketIndexes = [];
		for (const position of userAccount.perpPositions) {
			if (!positionIsAvailable(position)) {
				writablePerpMarketIndexes.push(position.marketIndex);
			}
		}

		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [userAccount],
			writablePerpMarketIndexes,
		});

		return await this.program.instruction.settleFundingPayment({
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
			},
			remainingAccounts,
		});
	}

	public triggerEvent(eventName: keyof DriftClientAccountEvents, data?: any) {
		this.eventEmitter.emit(eventName, data);
	}

	public getOracleDataForPerpMarket(marketIndex: number): OraclePriceData {
		return this.accountSubscriber.getOraclePriceDataAndSlotForPerpMarket(
			marketIndex
		).data;
	}

	public getOracleDataForSpotMarket(marketIndex: number): OraclePriceData {
		return this.accountSubscriber.getOraclePriceDataAndSlotForSpotMarket(
			marketIndex
		).data;
	}

	public async initializeInsuranceFundStake(
		marketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getInitializeInsuranceFundStakeIx(marketIndex),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getInitializeInsuranceFundStakeIx(
		marketIndex: number
	): Promise<TransactionInstruction> {
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			marketIndex
		);

		return await this.program.instruction.initializeInsuranceFundStake(
			marketIndex,
			{
				accounts: {
					insuranceFundStake: ifStakeAccountPublicKey,
					spotMarket: this.getSpotMarketAccount(marketIndex).pubkey,
					userStats: this.getUserStatsAccountPublicKey(),
					authority: this.wallet.publicKey,
					payer: this.wallet.publicKey,
					rent: anchor.web3.SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async getAddInsuranceFundStakeIx(
		marketIndex: number,
		amount: BN,
		collateralAccountPublicKey: PublicKey
	): Promise<TransactionInstruction> {
		const spotMarket = this.getSpotMarketAccount(marketIndex);
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			marketIndex
		);

		const remainingAccounts = [];
		this.addTokenMintToRemainingAccounts(spotMarket, remainingAccounts);
		const tokenProgram = this.getTokenProgramForSpotMarket(spotMarket);
		const ix = this.program.instruction.addInsuranceFundStake(
			marketIndex,
			amount,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					spotMarket: spotMarket.pubkey,
					insuranceFundStake: ifStakeAccountPublicKey,
					userStats: this.getUserStatsAccountPublicKey(),
					authority: this.wallet.publicKey,
					spotMarketVault: spotMarket.vault,
					insuranceFundVault: spotMarket.insuranceFund.vault,
					driftSigner: this.getSignerPublicKey(),
					userTokenAccount: collateralAccountPublicKey,
					tokenProgram,
				},
				remainingAccounts,
			}
		);

		return ix;
	}

	/**
	 * Add to an insurance fund stake and optionally initialize the account
	 */
	public async addInsuranceFundStake({
		marketIndex,
		amount,
		collateralAccountPublicKey,
		initializeStakeAccount,
		fromSubaccount,
		txParams,
	}: {
		/**
		 * Spot market index
		 */
		marketIndex: number;
		amount: BN;
		/**
		 * The account where the funds to stake come from. Usually an associated token account
		 */
		collateralAccountPublicKey: PublicKey;
		/**
		 * Add instructions to initialize the staking account -- required if its the first time the currrent authority has staked in this market
		 */
		initializeStakeAccount?: boolean;
		/**
		 * Optional -- withdraw from current subaccount to fund stake amount, instead of wallet balance
		 */
		fromSubaccount?: boolean;
		txParams?: TxParams;
	}): Promise<TransactionSignature> {
		const addIfStakeIxs = [];

		const additionalSigners: Array<Signer> = [];
		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);
		const isSolMarket = spotMarketAccount.mint.equals(WRAPPED_SOL_MINT);
		const createWSOLTokenAccount =
			isSolMarket && collateralAccountPublicKey.equals(this.wallet.publicKey);

		let tokenAccount;

		if (
			!(await this.checkIfAccountExists(this.getUserStatsAccountPublicKey()))
		) {
			addIfStakeIxs.push(await this.getInitializeUserStatsIx());
		}

		if (createWSOLTokenAccount) {
			const { ixs, pubkey } = await this.getWrappedSolAccountCreationIxs(
				amount,
				true
			);
			tokenAccount = pubkey;
			ixs.forEach((ix) => {
				addIfStakeIxs.push(ix);
			});
		} else {
			tokenAccount = collateralAccountPublicKey;
		}

		if (fromSubaccount) {
			const withdrawIx = await this.getWithdrawIx(
				amount,
				marketIndex,
				tokenAccount
			);
			addIfStakeIxs.push(withdrawIx);
		}

		if (initializeStakeAccount) {
			const initializeIx = await this.getInitializeInsuranceFundStakeIx(
				marketIndex
			);
			addIfStakeIxs.push(initializeIx);
		}

		const addFundsIx = await this.getAddInsuranceFundStakeIx(
			marketIndex,
			amount,
			tokenAccount
		);

		addIfStakeIxs.push(addFundsIx);

		if (createWSOLTokenAccount) {
			addIfStakeIxs.push(
				createCloseAccountInstruction(
					tokenAccount,
					this.wallet.publicKey,
					this.wallet.publicKey,
					[]
				)
			);
		}

		const tx = await this.buildTransaction(addIfStakeIxs, txParams);

		const { txSig } = await this.sendTransaction(
			tx,
			additionalSigners,
			this.opts
		);

		return txSig;
	}

	public async requestRemoveInsuranceFundStake(
		marketIndex: number,
		amount: BN,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			marketIndex
		);

		const ix = await this.program.instruction.requestRemoveInsuranceFundStake(
			marketIndex,
			amount,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					spotMarket: spotMarketAccount.pubkey,
					insuranceFundStake: ifStakeAccountPublicKey,
					userStats: this.getUserStatsAccountPublicKey(),
					authority: this.wallet.publicKey,
					insuranceFundVault: spotMarketAccount.insuranceFund.vault,
				},
			}
		);

		const tx = await this.buildTransaction(ix, txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async cancelRequestRemoveInsuranceFundStake(
		marketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			marketIndex
		);

		const ix =
			await this.program.instruction.cancelRequestRemoveInsuranceFundStake(
				marketIndex,
				{
					accounts: {
						state: await this.getStatePublicKey(),
						spotMarket: spotMarketAccount.pubkey,
						insuranceFundStake: ifStakeAccountPublicKey,
						userStats: this.getUserStatsAccountPublicKey(),
						authority: this.wallet.publicKey,
						insuranceFundVault: spotMarketAccount.insuranceFund.vault,
					},
				}
			);

		const tx = await this.buildTransaction(ix, txParams);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async removeInsuranceFundStake(
		marketIndex: number,
		collateralAccountPublicKey: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const removeIfStakeIxs = [];
		const spotMarketAccount = this.getSpotMarketAccount(marketIndex);
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey,
			marketIndex
		);

		const additionalSigners: Array<Signer> = [];
		const isSolMarket = spotMarketAccount.mint.equals(WRAPPED_SOL_MINT);
		const createWSOLTokenAccount =
			isSolMarket && collateralAccountPublicKey.equals(this.wallet.publicKey);

		let tokenAccount;

		if (createWSOLTokenAccount) {
			const { ixs, pubkey } = await this.getWrappedSolAccountCreationIxs(
				ZERO,
				true
			);
			tokenAccount = pubkey;
			ixs.forEach((ix) => {
				removeIfStakeIxs.push(ix);
			});
		} else {
			tokenAccount = collateralAccountPublicKey;
			const tokenAccountExists = await this.checkIfAccountExists(tokenAccount);
			if (!tokenAccountExists) {
				const createTokenAccountIx =
					await this.createAssociatedTokenAccountIdempotentInstruction(
						tokenAccount,
						this.wallet.publicKey,
						this.wallet.publicKey,
						spotMarketAccount.mint
					);
				removeIfStakeIxs.push(createTokenAccountIx);
			}
		}

		const remainingAccounts = [];
		this.addTokenMintToRemainingAccounts(spotMarketAccount, remainingAccounts);
		const tokenProgram = this.getTokenProgramForSpotMarket(spotMarketAccount);
		const removeStakeIx =
			await this.program.instruction.removeInsuranceFundStake(marketIndex, {
				accounts: {
					state: await this.getStatePublicKey(),
					spotMarket: spotMarketAccount.pubkey,
					insuranceFundStake: ifStakeAccountPublicKey,
					userStats: this.getUserStatsAccountPublicKey(),
					authority: this.wallet.publicKey,
					insuranceFundVault: spotMarketAccount.insuranceFund.vault,
					driftSigner: this.getSignerPublicKey(),
					userTokenAccount: tokenAccount,
					tokenProgram,
				},
				remainingAccounts,
			});

		removeIfStakeIxs.push(removeStakeIx);

		// Close the wrapped sol account at the end of the transaction
		if (createWSOLTokenAccount) {
			removeIfStakeIxs.push(
				createCloseAccountInstruction(
					tokenAccount,
					this.wallet.publicKey,
					this.wallet.publicKey,
					[]
				)
			);
		}

		const tx = await this.buildTransaction(removeIfStakeIxs, txParams);

		const { txSig } = await this.sendTransaction(
			tx,
			additionalSigners,
			this.opts
		);
		return txSig;
	}

	public async updateUserQuoteAssetInsuranceStake(
		authority: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const tx = await this.buildTransaction(
			await this.getUpdateUserQuoteAssetInsuranceStakeIx(authority),
			txParams
		);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getUpdateUserQuoteAssetInsuranceStakeIx(
		authority: PublicKey
	): Promise<TransactionInstruction> {
		const marketIndex = QUOTE_SPOT_MARKET_INDEX;
		const spotMarket = this.getSpotMarketAccount(marketIndex);
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			authority,
			marketIndex
		);
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			authority
		);

		const ix = this.program.instruction.updateUserQuoteAssetInsuranceStake({
			accounts: {
				state: await this.getStatePublicKey(),
				spotMarket: spotMarket.pubkey,
				insuranceFundStake: ifStakeAccountPublicKey,
				userStats: userStatsPublicKey,
				signer: this.wallet.publicKey,
				insuranceFundVault: spotMarket.insuranceFund.vault,
			},
		});

		return ix;
	}

	public async updateUserGovTokenInsuranceStake(
		authority: PublicKey,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const tx = await this.buildTransaction(
			await this.getUpdateUserGovTokenInsuranceStakeIx(authority),
			txParams
		);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getUpdateUserGovTokenInsuranceStakeIx(
		authority: PublicKey
	): Promise<TransactionInstruction> {
		const marketIndex = GOV_SPOT_MARKET_INDEX;
		const spotMarket = this.getSpotMarketAccount(marketIndex);
		const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
			this.program.programId,
			authority,
			marketIndex
		);
		const userStatsPublicKey = getUserStatsAccountPublicKey(
			this.program.programId,
			authority
		);

		const ix = this.program.instruction.updateUserGovTokenInsuranceStake({
			accounts: {
				state: await this.getStatePublicKey(),
				spotMarket: spotMarket.pubkey,
				insuranceFundStake: ifStakeAccountPublicKey,
				userStats: userStatsPublicKey,
				signer: this.wallet.publicKey,
				insuranceFundVault: spotMarket.insuranceFund.vault,
			},
		});

		return ix;
	}

	public async settleRevenueToInsuranceFund(
		spotMarketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const tx = await this.buildTransaction(
			await this.getSettleRevenueToInsuranceFundIx(spotMarketIndex),
			txParams
		);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public async getSettleRevenueToInsuranceFundIx(
		spotMarketIndex: number
	): Promise<TransactionInstruction> {
		const spotMarketAccount = this.getSpotMarketAccount(spotMarketIndex);
		const remainingAccounts = [];
		this.addTokenMintToRemainingAccounts(spotMarketAccount, remainingAccounts);
		const ix = await this.program.instruction.settleRevenueToInsuranceFund(
			spotMarketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					spotMarket: spotMarketAccount.pubkey,
					spotMarketVault: spotMarketAccount.vault,
					driftSigner: this.getSignerPublicKey(),
					insuranceFundVault: spotMarketAccount.insuranceFund.vault,
					tokenProgram: TOKEN_PROGRAM_ID,
				},
				remainingAccounts,
			}
		);
		return ix;
	}

	public async resolvePerpPnlDeficit(
		spotMarketIndex: number,
		perpMarketIndex: number,
		txParams?: TxParams
	): Promise<TransactionSignature> {
		const { txSig } = await this.sendTransaction(
			await this.buildTransaction(
				await this.getResolvePerpPnlDeficitIx(spotMarketIndex, perpMarketIndex),
				txParams
			),
			[],
			this.opts
		);
		return txSig;
	}

	public async getResolvePerpPnlDeficitIx(
		spotMarketIndex: number,
		perpMarketIndex: number
	): Promise<TransactionInstruction> {
		const remainingAccounts = this.getRemainingAccounts({
			userAccounts: [this.getUserAccount()],
			useMarketLastSlotCache: true,
			writablePerpMarketIndexes: [perpMarketIndex],
			writableSpotMarketIndexes: [spotMarketIndex],
		});

		const spotMarket = this.getSpotMarketAccount(spotMarketIndex);

		return await this.program.instruction.resolvePerpPnlDeficit(
			spotMarketIndex,
			perpMarketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					authority: this.wallet.publicKey,
					spotMarketVault: spotMarket.vault,
					insuranceFundVault: spotMarket.insuranceFund.vault,
					driftSigner: this.getSignerPublicKey(),
					tokenProgram: TOKEN_PROGRAM_ID,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async getDepositIntoSpotMarketRevenuePoolIx(
		marketIndex: number,
		amount: BN,
		userTokenAccountPublicKey: PublicKey
	): Promise<TransactionInstruction> {
		const spotMarket = await this.getSpotMarketAccount(marketIndex);

		const remainingAccounts = [];
		this.addTokenMintToRemainingAccounts(spotMarket, remainingAccounts);
		const tokenProgram = this.getTokenProgramForSpotMarket(spotMarket);
		const ix = await this.program.instruction.depositIntoSpotMarketRevenuePool(
			amount,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					spotMarket: spotMarket.pubkey,
					authority: this.wallet.publicKey,
					spotMarketVault: spotMarket.vault,
					userTokenAccount: userTokenAccountPublicKey,
					tokenProgram,
				},
			}
		);

		return ix;
	}

	public async depositIntoSpotMarketRevenuePool(
		marketIndex: number,
		amount: BN,
		userTokenAccountPublicKey: PublicKey
	): Promise<TransactionSignature> {
		const ix = await this.getDepositIntoSpotMarketRevenuePoolIx(
			marketIndex,
			amount,
			userTokenAccountPublicKey
		);
		const tx = await this.buildTransaction([ix]);

		const { txSig } = await this.sendTransaction(tx, [], this.opts);
		return txSig;
	}

	public getPerpMarketExtendedInfo(
		marketIndex: number
	): PerpMarketExtendedInfo {
		const marketAccount = this.getPerpMarketAccount(marketIndex);
		const quoteAccount = this.getSpotMarketAccount(QUOTE_SPOT_MARKET_INDEX);

		const extendedInfo: PerpMarketExtendedInfo = {
			marketIndex,
			minOrderSize: marketAccount.amm?.minOrderSize,
			marginMaintenance: marketAccount.marginRatioMaintenance,
			pnlPoolValue: getTokenAmount(
				marketAccount.pnlPool?.scaledBalance,
				quoteAccount,
				SpotBalanceType.DEPOSIT
			),
			contractTier: marketAccount.contractTier,
			availableInsurance: calculateMarketMaxAvailableInsurance(
				marketAccount,
				quoteAccount
			),
		};

		return extendedInfo;
	}

	/**
	 * Calculates taker / maker fee (as a percentage, e.g. .001 = 10 basis points) for particular marketType
	 * @param marketType
	 * @param positionMarketIndex
	 * @returns : {takerFee: number, makerFee: number} Precision None
	 */
	public getMarketFees(
		marketType: MarketType,
		marketIndex?: number,
		user?: User
	) {
		let feeTier;
		if (user) {
			feeTier = user.getUserFeeTier(marketType);
		} else {
			const state = this.getStateAccount();
			feeTier = isVariant(marketType, 'perp')
				? state.perpFeeStructure.feeTiers[0]
				: state.spotFeeStructure.feeTiers[0];
		}

		let takerFee = feeTier.feeNumerator / feeTier.feeDenominator;
		let makerFee =
			feeTier.makerRebateNumerator / feeTier.makerRebateDenominator;

		if (marketIndex !== undefined) {
			let marketAccount = null;
			if (isVariant(marketType, 'perp')) {
				marketAccount = this.getPerpMarketAccount(marketIndex);
			} else {
				marketAccount = this.getSpotMarketAccount(marketIndex);
			}
			takerFee += (takerFee * marketAccount.feeAdjustment) / 100;
			makerFee += (makerFee * marketAccount.feeAdjustment) / 100;
		}

		return {
			takerFee,
			makerFee,
		};
	}

	/**
	 * Returns the market index and type for a given market name
	 * E.g. "SOL-PERP" -> { marketIndex: 0, marketType: MarketType.PERP }
	 *
	 * @param name
	 */
	getMarketIndexAndType(
		name: string
	): { marketIndex: number; marketType: MarketType } | undefined {
		name = name.toUpperCase();
		for (const perpMarketAccount of this.getPerpMarketAccounts()) {
			if (decodeName(perpMarketAccount.name).toUpperCase() === name) {
				return {
					marketIndex: perpMarketAccount.marketIndex,
					marketType: MarketType.PERP,
				};
			}
		}

		for (const spotMarketAccount of this.getSpotMarketAccounts()) {
			if (decodeName(spotMarketAccount.name).toUpperCase() === name) {
				return {
					marketIndex: spotMarketAccount.marketIndex,
					marketType: MarketType.SPOT,
				};
			}
		}

		return undefined;
	}

	public getReceiverProgram(): Program<PythSolanaReceiver> {
		if (this.receiverProgram === undefined) {
			this.receiverProgram = new Program(
				pythSolanaReceiverIdl as PythSolanaReceiver,
				DEFAULT_RECEIVER_PROGRAM_ID,
				this.provider
			);
		}
		return this.receiverProgram;
	}

	public getSwitchboardOnDemandProgram(): Program30<Idl30> {
		if (this.sbOnDemandProgram === undefined) {
			this.sbOnDemandProgram = new Program30(
				switchboardOnDemandIdl as Idl30,
				this.provider
			);
		}
		return this.sbOnDemandProgram;
	}

	public async postPythPullOracleUpdateAtomic(
		vaaString: string,
		feedId: string
	): Promise<TransactionSignature> {
		const postIxs = await this.getPostPythPullOracleUpdateAtomicIxs(
			vaaString,
			feedId
		);
		const tx = await this.buildTransaction(postIxs);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async postMultiPythPullOracleUpdatesAtomic(
		vaaString: string,
		feedIds: string[]
	): Promise<TransactionSignature> {
		const postIxs = await this.getPostPythPullOracleUpdateAtomicIxs(
			vaaString,
			feedIds
		);
		const tx = await this.buildTransaction(postIxs);
		const { txSig } = await this.sendTransaction(tx, [], this.opts);

		return txSig;
	}

	public async getPostPythPullOracleUpdateAtomicIxs(
		vaaString: string,
		feedIds: string | string[],
		numSignatures = 2
	): Promise<TransactionInstruction[]> {
		const accumulatorUpdateData = parseAccumulatorUpdateData(
			Buffer.from(vaaString, 'base64')
		);
		const guardianSetIndex = accumulatorUpdateData.vaa.readUInt32BE(1);
		const guardianSet = getGuardianSetPda(
			guardianSetIndex,
			DEFAULT_WORMHOLE_PROGRAM_ID
		);
		const trimmedVaa = trimVaaSignatures(
			accumulatorUpdateData.vaa,
			numSignatures
		);

		const postIxs: TransactionInstruction[] = [];
		if (accumulatorUpdateData.updates.length > 1) {
			const encodedParams = this.getReceiverProgram().coder.types.encode(
				'PostMultiUpdatesAtomicParams',
				{
					vaa: trimmedVaa,
					merklePriceUpdates: accumulatorUpdateData.updates,
				}
			);
			const feedIdsToUse: string[] =
				typeof feedIds === 'string' ? [feedIds] : feedIds;
			const pubkeys = feedIdsToUse.map((feedId) => {
				return getPythPullOraclePublicKey(
					this.program.programId,
					getFeedIdUint8Array(feedId)
				);
			});

			const remainingAccounts: Array<AccountMeta> = pubkeys.map((pubkey) => {
				return {
					pubkey,
					isSigner: false,
					isWritable: true,
				};
			});
			postIxs.push(
				this.program.instruction.postMultiPythPullOracleUpdatesAtomic(
					encodedParams,
					{
						accounts: {
							keeper: this.wallet.publicKey,
							pythSolanaReceiver: DRIFT_ORACLE_RECEIVER_ID,
							guardianSet,
						},
						remainingAccounts,
					}
				)
			);
		} else {
			let feedIdToUse = typeof feedIds === 'string' ? feedIds : feedIds[0];
			feedIdToUse = trimFeedId(feedIdToUse);
			postIxs.push(
				await this.getSinglePostPythPullOracleAtomicIx(
					{
						vaa: trimmedVaa,
						merklePriceUpdate: accumulatorUpdateData.updates[0],
					},
					feedIdToUse,
					guardianSet
				)
			);
		}
		return postIxs;
	}

	private async getSinglePostPythPullOracleAtomicIx(
		params: {
			vaa: Buffer;
			merklePriceUpdate: {
				message: Buffer;
				proof: number[][];
			};
		},
		feedId: string,
		guardianSet: PublicKey
	): Promise<TransactionInstruction> {
		const feedIdBuffer = getFeedIdUint8Array(feedId);
		const receiverProgram = this.getReceiverProgram();

		const encodedParams = receiverProgram.coder.types.encode(
			'PostUpdateAtomicParams',
			params
		);

		return this.program.instruction.postPythPullOracleUpdateAtomic(
			feedIdBuffer,
			encodedParams,
			{
				accounts: {
					keeper: this.wallet.publicKey,
					pythSolanaReceiver: DRIFT_ORACLE_RECEIVER_ID,
					guardianSet,
					priceFeed: getPythPullOraclePublicKey(
						this.program.programId,
						feedIdBuffer
					),
				},
			}
		);
	}

	public async updatePythPullOracle(
		vaaString: string,
		feedId: string
	): Promise<TransactionSignature> {
		feedId = trimFeedId(feedId);
		const accumulatorUpdateData = parseAccumulatorUpdateData(
			Buffer.from(vaaString, 'base64')
		);
		const guardianSetIndex = accumulatorUpdateData.vaa.readUInt32BE(1);
		const guardianSet = getGuardianSetPda(
			guardianSetIndex,
			DEFAULT_WORMHOLE_PROGRAM_ID
		);

		const [postIxs, encodedVaaAddress] = await this.getBuildEncodedVaaIxs(
			accumulatorUpdateData.vaa,
			guardianSet
		);

		for (const update of accumulatorUpdateData.updates) {
			postIxs.push(
				await this.getUpdatePythPullOracleIxs(
					{
						merklePriceUpdate: update,
					},
					feedId,
					encodedVaaAddress.publicKey
				)
			);
		}

		const tx = await this.buildTransaction(postIxs);
		const { txSig } = await this.sendTransaction(
			tx,
			[encodedVaaAddress],
			this.opts
		);

		return txSig;
	}

	public async getUpdatePythPullOracleIxs(
		params: {
			merklePriceUpdate: {
				message: Buffer;
				proof: number[][];
			};
		},
		feedId: string,
		encodedVaaAddress: PublicKey
	): Promise<TransactionInstruction> {
		const feedIdBuffer = getFeedIdUint8Array(feedId);
		const receiverProgram = this.getReceiverProgram();

		const encodedParams = receiverProgram.coder.types.encode(
			'PostUpdateParams',
			params
		);

		return this.program.instruction.updatePythPullOracle(
			feedIdBuffer,
			encodedParams,
			{
				accounts: {
					keeper: this.wallet.publicKey,
					pythSolanaReceiver: DRIFT_ORACLE_RECEIVER_ID,
					encodedVaa: encodedVaaAddress,
					priceFeed: getPythPullOraclePublicKey(
						this.program.programId,
						feedIdBuffer
					),
				},
			}
		);
	}

	public async getPostSwitchboardOnDemandUpdateAtomicIx(
		feed: PublicKey,
		numSignatures = 3
	): Promise<TransactionInstruction | undefined> {
		const program = this.getSwitchboardOnDemandProgram();
		const feedAccount = new PullFeed(program, feed);
		if (!this.sbProgramFeedConfigs) {
			this.sbProgramFeedConfigs = new Map();
		}
		if (!this.sbProgramFeedConfigs.has(feedAccount.pubkey.toString())) {
			const feedConfig = await feedAccount.loadConfigs();
			this.sbProgramFeedConfigs.set(feed.toString(), feedConfig);
		}

		const [pullIx, _responses, success] = await feedAccount.fetchUpdateIx({
			numSignatures,
			// @ts-ignore :: TODO someone needs to look at this
			feedConfigs: this.sbProgramFeedConfigs.get(feed.toString()),
		});
		if (!success) {
			return undefined;
		}
		return pullIx;
	}

	public async postSwitchboardOnDemandUpdate(
		feed: PublicKey,
		numSignatures = 3
	): Promise<TransactionSignature> {
		const pullIx = await this.getPostSwitchboardOnDemandUpdateAtomicIx(
			feed,
			numSignatures
		);
		if (!pullIx) {
			return undefined;
		}
		const tx = await asV0Tx({
			connection: this.connection,
			ixs: [pullIx],
			payer: this.wallet.publicKey,
			computeUnitLimitMultiple: 1.3,
			lookupTables: [await this.fetchMarketLookupTableAccount()],
		});
		const { txSig } = await this.sendTransaction(tx, [], {
			commitment: 'processed',
			skipPreflight: true,
			maxRetries: 0,
		});
		return txSig;
	}

	private async getBuildEncodedVaaIxs(
		vaa: Buffer,
		guardianSet: PublicKey
	): Promise<[TransactionInstruction[], Keypair]> {
		const postIxs: TransactionInstruction[] = [];

		if (this.wormholeProgram === undefined) {
			this.wormholeProgram = new Program(
				wormholeCoreBridgeIdl,
				DEFAULT_WORMHOLE_PROGRAM_ID,
				this.provider
			);
		}

		const encodedVaaKeypair = new Keypair();
		postIxs.push(
			await this.wormholeProgram.account.encodedVaa.createInstruction(
				encodedVaaKeypair,
				vaa.length + 46
			)
		);

		// Why do we need this too?
		postIxs.push(
			await this.wormholeProgram.methods
				.initEncodedVaa()
				.accounts({
					encodedVaa: encodedVaaKeypair.publicKey,
				})
				.instruction()
		);

		// Split the write into two ixs
		postIxs.push(
			await this.wormholeProgram.methods
				.writeEncodedVaa({
					index: 0,
					data: vaa.subarray(0, 755),
				})
				.accounts({
					draftVaa: encodedVaaKeypair.publicKey,
				})
				.instruction()
		);

		postIxs.push(
			await this.wormholeProgram.methods
				.writeEncodedVaa({
					index: 755,
					data: vaa.subarray(755),
				})
				.accounts({
					draftVaa: encodedVaaKeypair.publicKey,
				})
				.instruction()
		);

		// Verify
		postIxs.push(
			await this.wormholeProgram.methods
				.verifyEncodedVaaV1()
				.accounts({
					guardianSet,
					draftVaa: encodedVaaKeypair.publicKey,
				})
				.instruction()
		);

		return [postIxs, encodedVaaKeypair];
	}

	private handleSignedTransaction(signedTxs: SignedTxData[]) {
		if (this.enableMetricsEvents && this.metricsEventEmitter) {
			this.metricsEventEmitter.emit('txSigned', signedTxs);
		}
	}

	private handlePreSignedTransaction() {
		if (this.enableMetricsEvents && this.metricsEventEmitter) {
			this.metricsEventEmitter.emit('preTxSigned');
		}
	}

	private isVersionedTransaction(
		tx: Transaction | VersionedTransaction
	): boolean {
		return isVersionedTransaction(tx);
	}

	sendTransaction(
		tx: Transaction | VersionedTransaction,
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions,
		preSigned?: boolean
	): Promise<TxSigAndSlot> {
		const isVersionedTx = this.isVersionedTransaction(tx);

		if (isVersionedTx) {
			return this.txSender.sendVersionedTransaction(
				tx as VersionedTransaction,
				additionalSigners,
				opts,
				preSigned
			);
		} else {
			return this.txSender.send(
				tx as Transaction,
				additionalSigners,
				opts,
				preSigned
			);
		}
	}

	async buildTransaction(
		instructions: TransactionInstruction | TransactionInstruction[],
		txParams?: TxParams,
		txVersion?: TransactionVersion,
		lookupTables?: AddressLookupTableAccount[],
		forceVersionedTransaction?: boolean,
		recentBlockhash?: BlockhashWithExpiryBlockHeight
	): Promise<Transaction | VersionedTransaction> {
		return this.txHandler.buildTransaction({
			instructions,
			txVersion: txVersion ?? this.txVersion,
			txParams: txParams ?? this.txParams,
			connection: this.connection,
			preFlightCommitment: this.opts.preflightCommitment,
			fetchMarketLookupTableAccount:
				this.fetchMarketLookupTableAccount.bind(this),
			lookupTables,
			forceVersionedTransaction,
			recentBlockhash,
		});
	}

	async buildBulkTransactions(
		instructions: (TransactionInstruction | TransactionInstruction[])[],
		txParams?: TxParams,
		txVersion?: TransactionVersion,
		lookupTables?: AddressLookupTableAccount[],
		forceVersionedTransaction?: boolean
	): Promise<(Transaction | VersionedTransaction)[]> {
		return this.txHandler.buildBulkTransactions({
			instructions,
			txVersion: txVersion ?? this.txVersion,
			txParams: txParams ?? this.txParams,
			connection: this.connection,
			preFlightCommitment: this.opts.preflightCommitment,
			fetchMarketLookupTableAccount:
				this.fetchMarketLookupTableAccount.bind(this),
			lookupTables,
			forceVersionedTransaction,
		});
	}

	async buildTransactionsMap(
		instructionsMap: Record<
			string,
			TransactionInstruction | TransactionInstruction[]
		>,
		txParams?: TxParams,
		txVersion?: TransactionVersion,
		lookupTables?: AddressLookupTableAccount[],
		forceVersionedTransaction?: boolean
	) {
		return this.txHandler.buildTransactionsMap({
			instructionsMap,
			txVersion: txVersion ?? this.txVersion,
			txParams: txParams ?? this.txParams,
			connection: this.connection,
			preFlightCommitment: this.opts.preflightCommitment,
			fetchMarketLookupTableAccount:
				this.fetchMarketLookupTableAccount.bind(this),
			lookupTables,
			forceVersionedTransaction,
		});
	}

	async buildAndSignTransactionsMap(
		instructionsMap: Record<
			string,
			TransactionInstruction | TransactionInstruction[]
		>,
		txParams?: TxParams,
		txVersion?: TransactionVersion,
		lookupTables?: AddressLookupTableAccount[],
		forceVersionedTransaction?: boolean
	) {
		return this.txHandler.buildAndSignTransactionMap({
			instructionsMap,
			txVersion: txVersion ?? this.txVersion,
			txParams: txParams ?? this.txParams,
			connection: this.connection,
			preFlightCommitment: this.opts.preflightCommitment,
			fetchMarketLookupTableAccount:
				this.fetchMarketLookupTableAccount.bind(this),
			lookupTables,
			forceVersionedTransaction,
		});
	}
}
