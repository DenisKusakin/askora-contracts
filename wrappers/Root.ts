import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Sender,
    SendMode,
    TupleBuilder
} from '@ton/core';
import { Account } from './Account';

export type RootConfig = {
    accountCode: Cell,
    questionCode: Cell,
    questionRefCode: Cell,
};

export function rootConfigToCell(config: RootConfig): Cell {
    return beginCell()
        .storeRef(config.accountCode)
        .storeRef(config.questionCode)
        .storeRef(config.questionRefCode)
        .endCell();
}

export class Root implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new Root(address);
    }

    static createFromConfig(config: RootConfig, code: Cell, workchain = 0) {
        const data = rootConfigToCell(config);
        const init = { code, data };
        return new Root(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(BigInt("0x1783f31b"), 32).storeUint(123, 64).endCell(),
        });
    }

    async getAccountAddress(provider: ContractProvider, owner: Address) {
        let builder = new TupleBuilder();
        builder.writeAddress(owner);
        let source = (await provider.get("get_account_addr", builder.build())).stack;

        return source.readAddress();
    }

    async getAccount(provider: ContractProvider, owner: Address) {
        let addr = await this.getAccountAddress(provider, owner);

        return provider.open(Account.createFromAddress(addr));
    }
}
