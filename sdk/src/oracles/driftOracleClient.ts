import { Connection, PublicKey } from '@solana/web3.js';
import { OracleClient, OraclePriceData } from './types';
import {Program} from '@coral-xyz/anchor';
import {
	ZERO,
} from '../constants/numericConstants';
import {DriftOracle} from "../types";

export class DriftOracleClient implements OracleClient {
	private connection: Connection;
	private program: Program;

	public constructor(
		connection: Connection,
		program: Program,
	) {
		this.connection = connection;
		this.program = program;
	}

	public async getOraclePriceData(
		pricePublicKey: PublicKey
	): Promise<OraclePriceData> {
		const accountInfo = await this.connection.getAccountInfo(pricePublicKey);
		return this.getOraclePriceDataFromBuffer(accountInfo.data);
	}

	public getOraclePriceDataFromBuffer(buffer: Buffer): OraclePriceData {
		const driftOracle = this.program.account.driftOracle.coder.accounts.decodeUnchecked('DriftOracle', buffer) as DriftOracle;

		return {
			price: driftOracle.price,
			slot: driftOracle.slot,
			confidence: driftOracle.confidence,
			hasSufficientNumberOfDataPoints: true,
		};
	}
}