import { Address, Cell, Contract, ContractProvider } from '@ton/core';
import { Question } from './Question';

export class QuestionRef implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {
    }

    static createFromAddress(address: Address) {
        return new QuestionRef(address);
    }

    async getQuestionAddress(provider: ContractProvider) {
        let res = (await provider.get('get_question_addr', [])).stack
        return res.readAddress();
    }

    async getQuestion(provider: ContractProvider) {
        let addr = await this.getQuestionAddress(provider);

        return provider.open(Question.createFromAddress(addr));
    }
}