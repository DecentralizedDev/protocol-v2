import {
	ConfirmOptions,
	Signer,
	Transaction,
	TransactionSignature,
	VersionedTransaction,
} from '@solana/web3.js';
import { IWallet } from '../types';

export enum ConfirmationStrategy {
	WebSocket = 'websocket',
	Polling = 'polling',
	Combo = 'combo',
}

export type TxSigAndSlot = {
	txSig: TransactionSignature;
	slot: number;
};

export interface TxSender {
	wallet: IWallet;

	send(
		tx: Transaction,
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions,
		preSigned?: boolean
	): Promise<TxSigAndSlot>;

	sendVersionedTransaction(
		tx: VersionedTransaction,
		additionalSigners?: Array<Signer>,
		opts?: ConfirmOptions,
		preSigned?: boolean
	): Promise<TxSigAndSlot>;

	sendRawTransaction(
		rawTransaction: Buffer | Uint8Array,
		opts: ConfirmOptions
	): Promise<TxSigAndSlot>;

	simulateTransaction(tx: VersionedTransaction): Promise<boolean>;

	getTimeoutCount(): number;
}

export class TxSendError extends Error {
	constructor(
		public message: string,
		public code: number
	) {
		super(message);
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, TxSendError);
		}
	}
}
