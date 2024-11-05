import { Address, Cell, Contract, ContractProvider } from '@ton/core';

export class Question implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new Question(address);
    }

    async getAllData(provider: ContractProvider) {
        let getRes = (await provider.get('get_all_data', [])).stack;
        let rootCell = getRes.readCell().beginParse();

        let c1 = rootCell.loadRef().beginParse();
        let id = c1.loadUint(32);
        let isClosed = c1.loadBoolean();
        let isRejected = c1.loadBoolean();
        let createdAt = c1.loadUint(64);
        let minPrice = c1.loadCoins();

        let c2 = rootCell.loadRef().beginParse();
        let content = c2.loadRef().beginParse().loadStringTail();
        let replyContent = c2.loadRef().beginParse().loadStringTail();

        let c3 = rootCell.loadRef().beginParse();
        let submitterAddr = c3.loadAddress();
        let accountAddr = c3.loadAddress();
        let ownerAddr = c3.loadAddress();

        return {
            id,
            isClosed,
            isRejected,
            content,
            replyContent,
            submitterAddr,
            accountAddr,
            createdAt,
            ownerAddr,
            minPrice,
        };
    }
}
