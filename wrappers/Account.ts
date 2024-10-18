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
import { Question } from './Question';
import { QuestionRef } from './QuestionRef';

export type AccountConfig = {
    serviceOwner: Address,
    owner: Address
};

export function accountConfigToCell(config: AccountConfig): Cell {
    return beginCell()
        .storeAddress(config.owner)
        .storeAddress(config.serviceOwner)
        .endCell();
}

export class Account implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new Account(address);
    }

    static createFromConfig(config: AccountConfig, code: Cell, workchain = 0) {
        const data = accountConfigToCell(config);
        const init = { code, data };
        return new Account(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint, conf: {minPrice: bigint, questionCode: Cell, questionRefCode: Cell}) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(BigInt("0x3922d770"), 32)
                .storeCoins(conf.minPrice)
                .storeRef(conf.questionCode)
                .storeRef(conf.questionRefCode)
                .endCell(),
        });
    }

    async getNextId(provider: ContractProvider) {
        let source = (await provider.get("get_next_id", [])).stack;

        return source.readBigNumber();
    }

    async getNextSubmittedQuestionId(provider: ContractProvider) {
        let getRes = (await provider.get('get_next_submitted_question_id', [])).stack;
        let nextId = getRes.readBigNumber();

        return nextId;
    }

    async getQuestionRefAddress(provider: ContractProvider, id: number) {
        let tb = new TupleBuilder();
        tb.writeNumber(id);
        let getRes = (await provider.get('get_submitted_question_address', tb.build())).stack;
        return getRes.readAddress();
    }

    async getPrice(provider: ContractProvider){
        let getRes = (await provider.get('get_price', [])).stack;
        let price = getRes.readBigNumber()

        return price;
    }

    async getAllData(provider: ContractProvider) {
        let getRes = (await provider.get('get_all_data', [])).stack;
        let rootCell = getRes.readCell().beginParse();
        let owner = rootCell.loadAddress();
        let minPrice = rootCell.loadCoins();
        let assignedQuestionsCount = rootCell.loadUint(32);
        let submittedQuestionsCount = rootCell.loadUint(32);

        return {
            owner, minPrice, assignedQuestionsCount, submittedQuestionsCount
        }
    }

    async getQuestionAccAddr(provider: ContractProvider, id: number) {
        let tb = new TupleBuilder();
        tb.writeNumber(id);
        let getRes = (await provider.get('get_question_addr', tb.build())).stack;
        return getRes.readAddress();
    }

    async getQuestion(provider: ContractProvider, id: number){
        let addr = await this.getQuestionAccAddr(provider, id);
        return provider.open(Question.createFromAddress(addr));
    }

    async getQuestionRef(provider: ContractProvider, id: number){
        let addr = await this.getQuestionRefAddress(provider, id);
        return provider.open(QuestionRef.createFromAddress(addr));
    }
}
