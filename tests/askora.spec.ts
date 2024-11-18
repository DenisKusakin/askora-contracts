import {
    Blockchain,
    internal,
    printTransactionFees,
    SandboxContract,
    SmartContract,
    TreasuryContract,
} from '@ton/sandbox';
import { Address, beginCell, Cell, contractAddress, fromNano, SendMode, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { randomBytes } from 'node:crypto';
import { Root } from '../wrappers/Root';
import { findTransaction } from '@ton/test-utils';
import { MessageValue } from '@ton/core/dist/types/Message';

const TON_STEP = 0.01;
const MIN_QUESTION_BALANCE = TON_STEP;
const MIN_ACCOUNT_BALANCE = 3 * TON_STEP;
const MIN_ROOT_BALANCE = 5 * TON_STEP;
const NOTIFICATION_AMOUNT = 0.003;

const INITIAL_ROOT_BALANCE = 0.5;

const SPONSOR_CONTRACT_INITIAL_BALANCE = 10;

describe('All tests', () => {
    let rootCode: Cell;
    let accountCode: Cell;
    let questionCode: Cell;
    let questionRefCode: Cell;

    beforeAll(async () => {
        rootCode = await compile('root');
        accountCode = await compile('account');
        questionCode = await compile('question');
        questionRefCode = await compile('question-ref');
    });

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let sponsor: SandboxContract<TreasuryContract>;
    let root: SandboxContract<Root>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();

        deployer = await blockchain.treasury('deployer', { balance: toNano('10') });
        sponsor = await blockchain.treasury('sponsor', { balance: toNano(SPONSOR_CONTRACT_INITIAL_BALANCE) });
        root = blockchain.openContract(
            Root.createFromConfig(
                {
                    accountCode,
                    questionCode,
                    questionRefCode,
                },
                rootCode,
            ),
        );
        root.sendDeploy(deployer.getSender(), toNano(INITIAL_ROOT_BALANCE), sponsor.address);
    });

    async function createNewAccount(
        username: string | undefined = undefined,
        price: bigint = toNano('10'),
        description: string = 'test description',
    ) {
        let user = await blockchain.treasury(username || 'user-1');
        await user.send({
            value: toNano(0.5),
            to: root.address,
            body: beginCell()
                .storeUint(BigInt('0x5f0ec1a3'), 32)
                .storeCoins(price)
                .storeRef(beginCell().storeStringTail(description).endCell())
                .endCell(),
        });
        return root.getAccount(user.address);
    }

    async function createNewAccountSponsored(
        ownerAddr: Address,
        price: bigint = toNano('10'),
        description: string = 'test description',
        amount = toNano(0.5),
    ) {
        let res = await sponsor.send({
            value: amount,
            to: root.address,
            body: beginCell()
                .storeUint(BigInt('0x74385f77'), 32)
                .storeAddress(ownerAddr)
                .storeCoins(price)
                .storeRef(beginCell().storeStringTail(description).endCell())
                .endCell(),
        });
        const accountContract = await root.getAccount(ownerAddr);
        return { accountContract, transactionsRes: res };
    }

    async function createNewAccountViaQuestionSubmit(
        username: string | undefined = undefined,
        price: bigint = toNano('10'),
        description: string = 'test description',
    ) {
        let user = await blockchain.treasury(username || 'user-1');
        let otherUser = await blockchain.treasury(username || 'user-23');

        await otherUser.send({
            value: toNano(0.5),
            to: root.address,
            body: beginCell()
                .storeUint(BigInt('0x5f0ec1a3'), 32)
                .storeCoins(price)
                .storeRef(beginCell().storeStringTail(description).endCell())
                .endCell(),
        });
        let otherAccountContractAddress = await root.getAccountAddress(otherUser.address);

        await submitQuestion(user, otherAccountContractAddress, toNano('11'));
        return await root.getAccount(user.address);
    }

    it('should deploy account', async () => {
        let user = await blockchain.treasury('user-1');

        let accountContract = await createNewAccount('user-1', toNano(10));
        let accountContractAddr = accountContract.address;

        let actualFullData = await accountContract.getAllData();
        let actualFullData2 = {
            owner: actualFullData.owner.toRawString(),
            minPrice: actualFullData.minPrice,
            assignedQuestionsCount: actualFullData.assignedQuestionsCount,
            submittedQuestionsCount: actualFullData.submittedQuestionsCount,
            description: actualFullData.description,
        };
        let expectedFullData = {
            owner: user.address.toRawString(),
            minPrice: toNano(10),
            assignedQuestionsCount: 0,
            submittedQuestionsCount: 0,
            description: 'test description',
        };

        expect(toTon((await blockchain.getContract(accountContractAddr)).balance)).toBeCloseTo(MIN_ACCOUNT_BALANCE, 1);
        expect(await accountContract.getPrice()).toBe(toNano('10'));
        expect(actualFullData2).toStrictEqual(expectedFullData);
    });

    it('should deploy account using sponsored transaction', async () => {
        let user = await blockchain.treasury('user-1');

        let { accountContract, transactionsRes } = await createNewAccountSponsored(
            user.address,
            toNano(10),
            'test description',
            toNano(0.05),
        );
        let accountContractAddr = accountContract.address;
        let actualFullData = await accountContract.getAllData();
        let actualFullData2 = {
            owner: actualFullData.owner.toRawString(),
            minPrice: actualFullData.minPrice,
            assignedQuestionsCount: actualFullData.assignedQuestionsCount,
            submittedQuestionsCount: actualFullData.submittedQuestionsCount,
            description: actualFullData.description,
        };
        let expectedFullData = {
            owner: user.address.toRawString(),
            minPrice: toNano(10),
            assignedQuestionsCount: 0,
            submittedQuestionsCount: 0,
            description: 'test description',
        };

        expect(toTon((await blockchain.getContract(accountContractAddr)).balance)).toBeCloseTo(MIN_ACCOUNT_BALANCE, 1);
        expect(await accountContract.getPrice()).toBe(toNano('10'));
        expect(actualFullData2).toStrictEqual(expectedFullData);
        expect(transactionsRes.transactions).toHaveTransaction({
            from: accountContractAddr,
            to: root.address,
            success: true,
        });
        let excessReturnTransaction = findTransaction(transactionsRes.transactions, {
            from: accountContractAddr,
            to: root.address,
        });
        //@ts-ignore
        const coinsInTransaction = toTon(excessReturnTransaction.inMessage.info.value.coins);
        expect(coinsInTransaction).toBeCloseTo(0.05 - MIN_ACCOUNT_BALANCE, 1);
    });

    it('service owner should change sponsor', async () => {
        let user = await blockchain.treasury('user-1');
        let newSponsor = await blockchain.treasury('new-sponsor');
        await deployer.send({
            to: root.address,
            value: toNano(0.01),
            body: beginCell().storeUint(BigInt('0x718b6b7d'), 32).storeAddress(newSponsor.address).endCell(),
        });

        //New sponsor could create an account
        await newSponsor.send({
            value: toNano(0.1),
            to: root.address,
            body: beginCell()
                .storeUint(BigInt('0x74385f77'), 32)
                .storeAddress(user.address)
                .storeCoins(toNano(10))
                .storeRef(beginCell().storeStringTail('test').endCell())
                .endCell(),
        });

        let accountContract = await root.getAccount(user.address);
        let actualAccountDataRaw = await accountContract.getAllData();
        let actualAccountData = {
            owner: actualAccountDataRaw.owner.toRawString(),
            submittedQuestionsCount: actualAccountDataRaw.submittedQuestionsCount,
            assignedQuestionsCount: actualAccountDataRaw.assignedQuestionsCount,
            minPrice: actualAccountDataRaw.minPrice,
            description: actualAccountDataRaw.description,
        };
        expect(actualAccountData).toStrictEqual({
            owner: user.address.toRawString(),
            submittedQuestionsCount: 0,
            assignedQuestionsCount: 0,
            minPrice: toNano(10),
            description: 'test',
        });
    });

    async function getQuestionAddrFromRef(questionRef: SmartContract) {
        let getRes = (await questionRef.get('get_question_addr')).stackReader;
        return getRes.readAddress();
    }

    it('should create question', async () => {
        let time = Math.floor(Date.now() / 1000);
        blockchain.now = time;

        let account = await createNewAccount('user-1');
        expect(await account.getNextId()).toBe(0n);
        //0.06 - transaction cost + 10 + 0.5(=10*5/100) = 10.56
        let user = await blockchain.treasury('user-2');
        let submitQuestionRes = await user.send({
            to: account.address,
            value: toNano('10.6'),
            body: beginCell()
                .storeUint(BigInt('0x28b1e47a'), 32)
                .storeRef(beginCell().storeStringTail('test content').endCell())
                .endCell(),
        });

        let submitterAccountContract = await root.getAccount(user.address);

        expect(await account.getNextId()).toBe(1n);
        expect(await submitterAccountContract.getNextSubmittedQuestionId()).toBe(1n);
        expect((await submitterAccountContract.getAllData()).description).toBe('');

        let questionContractAddr = await account.getQuestionAccAddr(0);
        let questionRefAddr = await submitterAccountContract.getQuestionRefAddress(0);
        let questionRefContract = await blockchain.getContract(questionRefAddr);
        let questionContractAddrFromSubmitterAccount = await getQuestionAddrFromRef(questionRefContract);

        expect(questionContractAddr.toRawString()).toBe(questionContractAddrFromSubmitterAccount.toRawString());

        let questionContract = await account.getQuestion(0);
        expect((await questionContract.getAllData()).content).toBe('test content');
        expect((await questionContract.getAllData()).isClosed).toBe(false);
        expect(toTon((await blockchain.getContract(questionContract.address)).balance)).toBeCloseTo(10.5, 0);

        let actualQuestionFullDataRaw = await questionContract.getAllData();
        let actualQuestionFullData = {
            isClosed: actualQuestionFullDataRaw.isClosed,
            isRejected: actualQuestionFullDataRaw.isRejected,
            content: actualQuestionFullDataRaw.content,
            replyContent: actualQuestionFullDataRaw.replyContent,
            submitterAddr: actualQuestionFullDataRaw.submitterAddr.toRawString(),
            accountAddr: actualQuestionFullDataRaw.accountAddr.toRawString(),
            minPrice: actualQuestionFullDataRaw.minPrice,
        };
        let expectedQuestionFullData = {
            isClosed: false,
            isRejected: false,
            content: 'test content',
            replyContent: '',
            submitterAddr: user.address.toRawString(),
            accountAddr: account.address.toRawString(),
            minPrice: toNano(10),
        };

        expect(actualQuestionFullData).toStrictEqual(expectedQuestionFullData);
        expect(toTon((await blockchain.getContract(questionContract.address)).balance)).toBeCloseTo(10.5, 0);
        expect(actualQuestionFullDataRaw.createdAt).toBe(time);

        expect(submitQuestionRes.transactions).toHaveTransaction({
            from: questionContractAddr,
            to: root.address,
            success: true,
            exitCode: 0,
            op: 0x5d2c2cd5,
            value: toNano(NOTIFICATION_AMOUNT),
        });
    });

    it('user should NOT be able to deploy question account directly', async () => {
        let account = await createNewAccount('user-1');

        expect(await account.getNextId()).toBe(0n);

        let user = await blockchain.treasury('user-2');

        //Real question creation
        await user.send({
            to: account.address,
            value: toNano('10.6'),
            body: beginCell()
                .storeUint(BigInt('0x28b1e47a'), 32)
                .storeRef(beginCell().storeStringTail('test content').endCell())
                .endCell(),
        });

        //Prepare fake deploy question message
        let fakeUser = await blockchain.treasury('fake-user');

        let questionContractData = beginCell().storeAddress(account.address).storeUint(0, 32).endCell();

        let qAddrFromAcc = await account.getQuestionAccAddr(0);
        let fakeQAddr = contractAddress(0, { code: questionCode, data: questionContractData });

        //Fake contract has the same address
        expect(qAddrFromAcc.toString()).toBe(fakeQAddr.toString());

        //Try to deploy fake question with intent to override state
        await user.send({
            to: fakeQAddr,
            value: toNano('10.6'),
            body: beginCell()
                .storeUint(BigInt('0x370d4b02'), 32)
                .storeRef(beginCell().storeStringTail('fake content').endCell())
                .storeAddress(user.address)
                .storeRef(
                    beginCell()
                        .storeAddress(fakeUser.address)
                        .storeAddress(fakeUser.address)
                        .storeCoins(toNano(10))
                        .endCell(),
                )
                .endCell(),
            init: {
                code: questionCode,
                data: questionContractData,
            },
        });
        expect((await (await account.getQuestion(0)).getAllData()).content).toBe('test content');
    });

    it('user should NOT be able to forge question deployed message', async () => {
        let user = await blockchain.treasury('user-1');
        let account = await createNewAccount('user-1');

        //0 messages were send
        expect(await account.getNextSubmittedQuestionId()).toBe(0n);

        //Prepare fake deploy of question created notification
        let fakeUser = await blockchain.treasury('fake-user');
        //Random question contract address
        let fakeQuestionContractAddr = await account.getQuestionAccAddr(13);

        let data = beginCell()
            .storeAddress(user.address)
            .storeAddress(root.address)
            .storeRef(questionCode)
            .storeRef(questionRefCode)
            .endCell();

        //Try to deploy fake question with intent to override state
        await fakeUser.send({
            to: account.address,
            value: toNano('10.6'),
            body: beginCell()
                .storeUint(BigInt('0xb6d5bbc2'), 32)
                .storeAddress(fakeUser.address)
                .storeAddress(fakeQuestionContractAddr)
                .endCell(),
            init: {
                code: accountCode,
                data: data,
            },
        });
        expect(await account.getNextSubmittedQuestionId()).toBe(0n);
    });

    it('user should NOT be able to forge question-ref', async () => {
        let user = await blockchain.treasury('user-1');
        let account = await createNewAccount('user-1');

        //0 messages were send
        expect(await account.getNextSubmittedQuestionId()).toBe(0n);

        //Prepare fake deploy of question created notification
        let fakeUser = await blockchain.treasury('fake-user');
        //Random question contract address
        let fakeQuestionContractAddr = await account.getQuestionAccAddr(13);

        let data = beginCell().storeAddress(account.address).storeUint(0, 32).endCell();
        let fakeQuestionRefAddr = contractAddress(0, { data, code: questionRefCode });

        expect((await account.getQuestionRefAddress(0)).toString()).toBe(fakeQuestionRefAddr.toString());

        //Try to deploy fake question-ref
        await fakeUser.send({
            to: contractAddress(0, { data, code: questionRefCode }),
            value: toNano('10.6'),
            body: beginCell().storeAddress(fakeQuestionContractAddr).endCell(),
            init: {
                code: questionRefCode,
                data: data,
            },
        });
        let questionRefContract = await account.getQuestionRef(0);
        let questionAddrFromRef = null;
        try {
            questionAddrFromRef = await questionRefContract.getQuestionAddress();
        } catch {}

        expect(questionAddrFromRef).toBeNull();
    });

    it('should create multiple questions', async () => {
        let account = await createNewAccount('user-1');
        expect(await account.getNextId()).toBe(0n);
        await createNewAccount('user-2');
        let user = await blockchain.treasury('user-2');
        await user.send({
            to: account.address,
            value: toNano('10.6'),
            body: beginCell()
                .storeUint(BigInt('0x28b1e47a'), 32)
                .storeRef(beginCell().storeStringTail('test content').endCell())
                .endCell(),
        });
        await user.send({
            to: account.address,
            value: toNano('10.6'),
            body: beginCell()
                .storeUint(BigInt('0x28b1e47a'), 32)
                .storeRef(beginCell().storeStringTail('test content').endCell())
                .endCell(),
        });

        let submitterAccountContract = await root.getAccount(user.address);

        expect(await account.getNextId()).toBe(2n);
        expect(await submitterAccountContract.getNextSubmittedQuestionId()).toBe(2n);
    });

    it('should create cheap question', async () => {
        let time = Math.floor(Date.now() / 1000);
        blockchain.now = time;

        let account = await createNewAccount('user-1', toNano(0.8));

        expect(await account.getNextId()).toBe(0n);

        await createNewAccount('user-2', toNano(2));
        let user = await blockchain.treasury('user-2');
        await user.send({
            to: account.address,
            value: toNano(0.8 + (0.8 * 5) / 100 + 0.06),
            body: beginCell()
                .storeUint(BigInt('0x28b1e47a'), 32)
                .storeRef(beginCell().storeStringTail('test content').endCell())
                .endCell(),
        });

        let submitterAccountContract = await root.getAccount(user.address);

        expect(await account.getNextId()).toBe(1n);

        expect(await submitterAccountContract.getNextSubmittedQuestionId()).toBe(1n);

        let questionContractAddr = await account.getQuestionAccAddr(0);
        let questionRefAddr = await submitterAccountContract.getQuestionRefAddress(0);
        let questionRefContract = await blockchain.getContract(questionRefAddr);
        let questionContractAddrFromSubmitterAccount = await getQuestionAddrFromRef(questionRefContract);

        expect(questionContractAddr.toRawString()).toBe(questionContractAddrFromSubmitterAccount.toRawString());

        let questionContract = await account.getQuestion(0);
        expect((await questionContract.getAllData()).content).toBe('test content');
        expect((await questionContract.getAllData()).isClosed).toBe(false);
        expect(toTon((await blockchain.getContract(questionContract.address)).balance)).toBeCloseTo(
            0.8 + (5 * 0.8) / 100 + MIN_QUESTION_BALANCE,
        );

        let actualQuestionFullDataRaw = await questionContract.getAllData();
        let actualQuestionFullData = {
            isClosed: actualQuestionFullDataRaw.isClosed,
            isRejected: actualQuestionFullDataRaw.isRejected,
            content: actualQuestionFullDataRaw.content,
            replyContent: actualQuestionFullDataRaw.replyContent,
            submitterAddr: actualQuestionFullDataRaw.submitterAddr.toRawString(),
            accountAddr: actualQuestionFullDataRaw.accountAddr.toRawString(),
            minPrice: actualQuestionFullDataRaw.minPrice,
        };
        let expectedQuestionFullData = {
            isClosed: false,
            isRejected: false,
            content: 'test content',
            replyContent: '',
            submitterAddr: user.address.toRawString(),
            accountAddr: account.address.toRawString(),
            minPrice: toNano(0.8),
        };

        expect(actualQuestionFullData).toStrictEqual(expectedQuestionFullData);
        expect(actualQuestionFullDataRaw.createdAt).toBe(time);
    });

    it('should NOT create question if not enough money', async () => {
        let account = await createNewAccount();

        expect(await account.getNextId()).toBe(0n);

        let user = await blockchain.treasury('user-2');

        let res = await blockchain.sendMessage(
            internal({
                from: user.address,
                to: account.address,
                value: toNano('10.0'),
                body: beginCell()
                    .storeUint(BigInt('0x28b1e47a'), 32)
                    .storeRef(beginCell().storeStringTail('test content').endCell())
                    .endCell(),
            }),
        );
        expect(res.transactions).toHaveTransaction({
            from: user.address,
            to: account.address,
            success: false,
        });
        expect(await account.getNextId()).toBe(0n);
    });

    async function submitQuestion(
        sender: SandboxContract<TreasuryContract>,
        accountAddr: Address,
        amount: bigint,
        content: string = 'test content',
    ) {
        return await sender.send({
            to: accountAddr,
            value: amount,
            body: beginCell()
                .storeUint(BigInt('0x28b1e47a'), 32)
                .storeRef(beginCell().storeStringTail(content).endCell())
                .endCell(),
        });
    }

    async function replyToQuestion(
        sender: SandboxContract<TreasuryContract>,
        questionAddr: Address,
        replyContent: string = 'default reply',
        amount: bigint = toNano('0.6'),
    ) {
        return await sender.send({
            to: questionAddr,
            value: amount,
            body: beginCell()
                .storeUint(BigInt('0xfda8c6e0'), 32)
                .storeRef(beginCell().storeStringTail(replyContent).endCell())
                .endCell(),
        });
    }

    async function replyToQuestionSponsored(
        account_owner: Address,
        q_id: number,
        replyContent: string = 'default reply',
        amount: bigint = toNano('0.6'),
    ) {
        return await sponsor.send({
            to: root.address,
            value: amount,
            body: beginCell()
                .storeUint(BigInt('0xd9c2a251'), 32)
                .storeAddress(account_owner)
                .storeUint(q_id, 32)
                .storeRef(beginCell().storeStringTail(replyContent).endCell())
                .endCell(),
        });
    }

    async function rejectQuestion(sender: SandboxContract<TreasuryContract>, questionAddr: Address) {
        return await sender.send({
            to: questionAddr,
            value: toNano('0.1'),
            body: beginCell().storeUint(BigInt('0xa5c566b9'), 32).endCell(),
        });
    }

    async function rejectQuestionSponsored(owner: Address, qId: number) {
        return await sponsor.send({
            to: root.address,
            value: toNano('0.1'),
            body: beginCell().storeUint(BigInt('0x23b39f85'), 32).storeAddress(owner).storeUint(qId, 32).endCell(),
        });
    }

    it('should close question on reply', async () => {
        let account = await createNewAccount('account-user', toNano(10));
        let user = await blockchain.treasury('user-3');

        let accountOwner = await blockchain.treasury('account-user');
        let accountOwnerBalanceBeforeReply = await accountOwner.getBalance()

        let res = await submitQuestion(user, account.address, toNano('11.6'));
        let questionContractAddr = await account.getQuestionAccAddr(0);

        let questionContract = await account.getQuestion(0);

        expect((await questionContract.getAllData()).isClosed).toBeFalsy();
        let replyRes = await replyToQuestion(accountOwner, questionContractAddr, 'reply content 1', toNano(0.6));
        let accountOwnerBalanceAfterReply = await accountOwner.getBalance();

        expect(toTon(accountOwnerBalanceAfterReply - accountOwnerBalanceBeforeReply)).toBeCloseTo(10 - MIN_QUESTION_BALANCE)
        expect((await questionContract.getAllData()).isClosed).toBeTruthy();
        expect((await questionContract.getAllData()).replyContent).toBe('reply content 1');
        let actualAllData = await questionContract.getAllData();
        let actualAllData2 = {
            isRejected: actualAllData.isRejected,
            isClosed: actualAllData.isClosed,
            content: actualAllData.content,
            replyContent: actualAllData.replyContent,
            submitterAdd: actualAllData.submitterAddr.toString(),
        };
        let expectedAllData = {
            isRejected: false,
            isClosed: true,
            content: 'test content',
            replyContent: 'reply content 1',
            submitterAdd: user.address.toString(),
        };
        expect(actualAllData2).toStrictEqual(expectedAllData);
        //Notify person who submitted the question
        expect(replyRes.transactions).toHaveTransaction({
            from: questionContractAddr,
            to: root.address,
            success: true,
            exitCode: 0,
            op: 0xb67beedd,
            value: toNano(NOTIFICATION_AMOUNT),
        });
    });

    it('anyone could cancel the question after expiration. submitted by other user', async () => {
        let time1 = Math.floor(Date.now() / 1000);
        let time2 = time1 + 8 * 24 * 60 * 60; //8 days

        blockchain.now = time1;

        let account = await createNewAccount('account-user-111', toNano(10));
        let userInitialBalance = 50;
        let user = await blockchain.treasury('user-321', { balance: toNano(userInitialBalance) });

        await submitQuestion(user, account.address, toNano('20'));

        let questionContractAddr = await account.getQuestionAccAddr(0);
        let questionContract = await account.getQuestion(0);

        expect((await questionContract.getAllData()).isClosed).toBeFalsy();
        expect(toTon(await user.getBalance())).toBeCloseTo(
            userInitialBalance - 10 - 0.5 - MIN_ACCOUNT_BALANCE - MIN_QUESTION_BALANCE,
            1,
        );

        let otherUser = await blockchain.treasury('other-user-3211');
        let otherUserBalanceBefore = await otherUser.getBalance();
        blockchain.now = time2;
        await otherUser.send({
            to: questionContractAddr,
            value: toNano(0.1),
            body: beginCell().storeUint(BigInt('0x5616c572'), 32).endCell(),
        });
        let otherUserBalanceAfter = await otherUser.getBalance();
        let questionData = await questionContract.getAllData()
        expect(questionData.isClosed).toBeTruthy();
        expect(questionData.isRejected).toBeTruthy();
        //almost all the coins should be returned to the original submitter
        expect(toTon(await user.getBalance())).toBeCloseTo(userInitialBalance - MIN_QUESTION_BALANCE, 1);
        //msg remaining value should be returned to the submitter
        expect(toTon(otherUserBalanceBefore)).toBeCloseTo(toTon(otherUserBalanceAfter), 1);

        let questionContractBalance = (await blockchain.getContract(questionContractAddr)).balance;
        expect(toTon(questionContractBalance)).toBeCloseTo(MIN_QUESTION_BALANCE);
    });

    it('anyone could cancel the question after expiration. submitted by the same user who submitted the question', async () => {
        let time1 = Math.floor(Date.now() / 1000);
        let time2 = time1 + 8 * 24 * 60 * 60; //8 days

        blockchain.now = time1;

        let account = await createNewAccount('account-user-111', toNano(10));
        let userInitialBalance = 50;
        let user = await blockchain.treasury('user-321', { balance: toNano(userInitialBalance) });

        await submitQuestion(user, account.address, toNano('20'));

        let questionContractAddr = await account.getQuestionAccAddr(0);
        let questionContract = await account.getQuestion(0);

        expect((await questionContract.getAllData()).isClosed).toBeFalsy();
        //this is probably not related to the test but means that excess should be returned on question submit
        expect(toTon(await user.getBalance())).toBeCloseTo(
            userInitialBalance - 10 - 0.5 - MIN_ACCOUNT_BALANCE - MIN_QUESTION_BALANCE,
            1,
        );

        blockchain.now = time2;
        await user.send({
            to: questionContractAddr,
            value: toNano(0.5),
            body: beginCell().storeUint(BigInt('0x5616c572'), 32).endCell(),
        });
        let userBalanceAfterRefund = await user.getBalance();

        let questionData = await questionContract.getAllData()
        expect(questionData.isClosed).toBeTruthy();
        expect(questionData.isRejected).toBeTruthy();
        //since user haven't got an answer, all the funds are returned to him minus processing fees
        expect(userInitialBalance).toBeCloseTo(toTon(userBalanceAfterRefund) + MIN_QUESTION_BALANCE + MIN_ACCOUNT_BALANCE, 1);

        let questionContractBalance = (await blockchain.getContract(questionContractAddr)).balance;
        expect(toTon(questionContractBalance)).toBeCloseTo(MIN_QUESTION_BALANCE);
    });

    it('should not be able to cancel the question before expiration', async () => {
        let time1 = Math.floor(Date.now() / 1000);
        let time2 = time1 + 6 * 24 * 60 * 60; //6 days

        blockchain.now = time1;

        let account = await createNewAccount('account-user-111');
        let user = await blockchain.treasury('user-322', { balance: toNano(15) });

        await submitQuestion(user, account.address, toNano('12'));

        let questionContractAddr = await account.getQuestionAccAddr(0);
        let questionContract = await account.getQuestion(0);

        expect((await questionContract.getAllData()).isClosed).toBeFalsy();
        expect(toTon(await user.getBalance())).toBeCloseTo(15 - 10.5 - MIN_ACCOUNT_BALANCE, 1);

        let otherUser = await blockchain.treasury('other-user-3212');
        blockchain.now = time2;
        let res = await otherUser.send({
            to: questionContractAddr,
            value: toNano(0.01),
            body: beginCell().storeUint(BigInt('0x5616c572'), 32).endCell(),
        });
        expect(res.transactions).toHaveTransaction({
            from: otherUser.address,
            to: questionContractAddr,
            success: false,
        });
        expect(toTon(await user.getBalance())).toBeCloseTo(15 - 10.5 - MIN_ACCOUNT_BALANCE, 1);
    });

    it('user should be able to change the price', async () => {
        let account = await createNewAccount('account-user', toNano('10'));
        let accountUser = await blockchain.treasury('account-user');

        expect(await account.getPrice()).toBe(toNano(10));
        await accountUser.send({
            to: account.address,
            value: toNano(0.01),
            body: beginCell().storeUint(BigInt('0xaaacc05b'), 32).storeCoins(toNano(15)).endCell(),
        });
        expect(await account.getPrice()).toBe(toNano(15));
    });

    it('user should be able to change the price using sponsored transaction', async () => {
        let account = await createNewAccount('account-user', toNano('10'));
        let accountUser = await blockchain.treasury('account-user');

        expect(await account.getPrice()).toBe(toNano(10));
        let res = await sponsor.send({
            to: root.address,
            value: toNano(0.01),
            body: beginCell()
                .storeUint(BigInt('0xbef672d6'), 32)
                .storeAddress(accountUser.address)
                .storeCoins(toNano(15))
                .endCell(),
        });
        expect(await account.getPrice()).toBe(toNano(15));
    });

    it('user should be able to change account description', async () => {
        let account = await createNewAccount('account-user', toNano('10'));
        let accountUser = await blockchain.treasury('account-user');

        expect(await account.getPrice()).toBe(toNano(10));
        await accountUser.send({
            to: account.address,
            value: toNano(0.01),
            body: beginCell().storeUint(BigInt('0x901bca3e'), 32).storeStringRefTail('new description').endCell(),
        });
        expect((await account.getAllData()).description).toBe('new description');
    });

    it('user should be able to change account description using sponsored transaction', async () => {
        let account = await createNewAccount('account-user', toNano('10'));
        let accountUser = await blockchain.treasury('account-user');

        expect(await account.getPrice()).toBe(toNano(10));
        await sponsor.send({
            to: root.address,
            value: toNano(0.01),
            body: beginCell()
                .storeUint(BigInt('0xcc3612de'), 32)
                .storeAddress(accountUser.address)
                .storeStringRefTail('new description')
                .endCell(),
        });
        expect((await account.getAllData()).description).toBe('new description');
    });

    it('user still could receive and send questions after changing the price', async () => {
        let senderUser = await blockchain.treasury('test-user');

        let account = await createNewAccount('account-user', toNano('10'));
        let accountUser = await blockchain.treasury('account-user');
        let senderAccount = await root.getAccount(senderUser.address);

        await submitQuestion(senderUser, account.address, toNano(20));
        expect(await senderAccount.getNextSubmittedQuestionId()).toBe(1n);
        expect(await account.getNextId()).toBe(1n);

        await accountUser.send({
            to: account.address,
            value: toNano(0.01),
            body: beginCell().storeUint(BigInt('0xaaacc05b'), 32).storeCoins(toNano(15)).endCell(),
        });
        //
        await submitQuestion(senderUser, account.address, toNano(20));
        expect(await senderAccount.getNextSubmittedQuestionId()).toBe(2n);
        expect(await account.getNextId()).toBe(2n);

        //Vice versa
        await submitQuestion(accountUser, senderAccount.address, toNano(23));
        expect(await account.getNextSubmittedQuestionId()).toBe(1n);
    });

    function toTon(amount: bigint) {
        return parseFloat(fromNano(amount));
    }

    async function getRootBalance() {
        return (await blockchain.getContract(root.address)).balance;
    }

    it.each([
        ['create account explicitly', createNewAccount],
        ['create account via q submit', createNewAccountViaQuestionSubmit],
    ])('should send reward and service fee on reply. %s', async (text, createAccountF) => {
        let accountOwner = await blockchain.treasury('account-user-2');
        let account = await createAccountF('account-user-2', toNano('15'));
        let accountOwnerBalanceBefore = await accountOwner.getBalance();
        let rootBalanceBefore = await getRootBalance();
        let user = await blockchain.treasury('user-4');

        //in addition to question price, user should also pay for a new account + question
        await submitQuestion(user, account.address, toNano(20));

        let questionContract = await account.getQuestion(0);
        await replyToQuestion(accountOwner, questionContract.address, 'reply', toNano('0.01'));

        let accountBalanceAfter = await accountOwner.getBalance();
        let expectedServiceFee = (15 * 5) / 100; //5%
        let ownerBalanceDiff = toTon(accountBalanceAfter - accountOwnerBalanceBefore);
        let rootBalanceDiff = toTon((await getRootBalance()) - rootBalanceBefore);

        let accountContractBalance = (await blockchain.getContract(account.address)).balance;
        let questionContractBalance = (await blockchain.getContract(questionContract.address)).balance;

        expect(toTon(accountContractBalance)).toBeCloseTo(MIN_ACCOUNT_BALANCE, 1);
        expect(toTon(questionContractBalance)).toBeCloseTo(MIN_QUESTION_BALANCE);
        expect(rootBalanceDiff).toBeCloseTo(expectedServiceFee, 1);
        expect(ownerBalanceDiff).toBeCloseTo(15 - 0.01); //TODO: 0.01 - amount in reply transaction, it is transferred to the service, need to send back to sender along with reward
        expect(toTon((await blockchain.getContract(questionContract.address)).balance)).toBeCloseTo(
            MIN_QUESTION_BALANCE,
        );
    });

    it('user should be able to reply to question using sponsored transaction', async () => {
        let accountOwner = await blockchain.treasury('account-user-2');
        let account = await createNewAccount('account-user-2', toNano('15'));
        let accountOwnerBalanceBefore = await accountOwner.getBalance();
        let rootBalanceBefore = await getRootBalance();
        let user = await blockchain.treasury('user-4');

        //in addition to question price, user should also pay for a new account + question
        await submitQuestion(user, account.address, toNano(20));

        let questionContract = await account.getQuestion(0);
        await replyToQuestionSponsored(accountOwner.address, 0, 'reply', toNano('0.01'));

        let accountBalanceAfter = await accountOwner.getBalance();
        let expectedServiceFee = (15 * 5) / 100; //5%
        let ownerBalanceDiff = toTon(accountBalanceAfter - accountOwnerBalanceBefore);
        let rootBalanceDiff = toTon((await getRootBalance()) - rootBalanceBefore);

        let accountContractBalance = (await blockchain.getContract(account.address)).balance;
        let questionContractBalance = (await blockchain.getContract(questionContract.address)).balance;

        expect(toTon(accountContractBalance)).toBeCloseTo(MIN_ACCOUNT_BALANCE, 1);
        expect(toTon(questionContractBalance)).toBeCloseTo(MIN_QUESTION_BALANCE);
        expect(rootBalanceDiff).toBeCloseTo(expectedServiceFee, 1);
        expect(ownerBalanceDiff).toBeCloseTo(15 - MIN_QUESTION_BALANCE);
        expect(toTon((await blockchain.getContract(questionContract.address)).balance)).toBeCloseTo(
            MIN_QUESTION_BALANCE,
        );
    });

    it('owner should be able to reject a question', async () => {
        let accountOwner = await blockchain.treasury('account-user-3', { balance: toNano('4') });
        let account = await createNewAccount('account-user-3', toNano('15'));
        let user = await blockchain.treasury('user-5');
        let userBalanceBefore = await user.getBalance();
        await submitQuestion(user, account.address, toNano('20'));

        let accountOwnerBalanceBefore = await accountOwner.getBalance();

        let questionContractAddr = await account.getQuestionAccAddr(0);

        let questionContract = await account.getQuestion(0);
        let rejectQuestionRes = await rejectQuestion(accountOwner, questionContractAddr);

        expect((await questionContract.getAllData()).isRejected).toBeTruthy();
        expect((await questionContract.getAllData()).isClosed).toBeTruthy();

        let accountOwnerBalanceAfter = (await blockchain.getContract(accountOwner.address)).balance;
        let userBalanceAfter = await user.getBalance();
        let ownerBalanceDiff = parseFloat(fromNano(accountOwnerBalanceAfter - accountOwnerBalanceBefore));

        //only transaction fees will be deducted + MIN_QUESTION_BALANCE
        expect(ownerBalanceDiff).toBeLessThan(0);
        expect(ownerBalanceDiff).toBeCloseTo(-MIN_QUESTION_BALANCE);

        //TODO: This is not accurate, probably it should be closeTo(MIN_QUESTION_BALANCE)
        expect(toTon((await blockchain.getContract(questionContractAddr)).balance)).toBeGreaterThan(0.001);
        //user should pay for his new account + question + fw_fee
        expect(toTon(userBalanceAfter - userBalanceBefore)).toBeCloseTo(
            -(MIN_ACCOUNT_BALANCE + MIN_QUESTION_BALANCE),
            1,
        );
        expect(rejectQuestionRes.transactions).toHaveTransaction({
            from: questionContractAddr,
            to: root.address,
            success: true,
            exitCode: 0,
            op: 0xd7f75248,
            value: toNano(NOTIFICATION_AMOUNT),
        });
    });

    it('owner should be able to reject a question using sponsored transaction', async () => {
        let accountOwner = await blockchain.treasury('account-user-3', { balance: toNano('4') });
        let account = await createNewAccount('account-user-3', toNano('15'));
        let user = await blockchain.treasury('user-5');
        let userBalanceBefore = await user.getBalance();
        await submitQuestion(user, account.address, toNano('20'));

        let accountOwnerBalanceBefore = await accountOwner.getBalance();

        let questionContractAddr = await account.getQuestionAccAddr(0);

        let questionContract = await account.getQuestion(0);
        let rejectQuestionRes = await rejectQuestionSponsored(accountOwner.address, 0);

        expect((await questionContract.getAllData()).isRejected).toBeTruthy();
        expect((await questionContract.getAllData()).isClosed).toBeTruthy();

        let accountOwnerBalanceAfter = (await blockchain.getContract(accountOwner.address)).balance;
        let userBalanceAfter = await user.getBalance();
        let ownerBalanceDiff = parseFloat(fromNano(accountOwnerBalanceAfter - accountOwnerBalanceBefore));

        expect(ownerBalanceDiff).toBe(0);

        //TODO: This is not accurate, probably it should be closeTo(MIN_QUESTION_BALANCE)
        expect(toTon((await blockchain.getContract(questionContractAddr)).balance)).toBeGreaterThan(0.001);
        //user should pay for his new account + question + fw_fee
        expect(toTon(userBalanceAfter - userBalanceBefore)).toBeCloseTo(
            -(MIN_ACCOUNT_BALANCE + MIN_QUESTION_BALANCE),
            1,
        );
        expect(rejectQuestionRes.transactions).toHaveTransaction({
            from: questionContractAddr,
            to: root.address,
            success: true,
            exitCode: 0,
            op: 0xd7f75248,
            value: toNano(NOTIFICATION_AMOUNT),
        });
    });

    it('submit-reply-withdraw flow', async () => {
        let accountOwner = await blockchain.treasury('account-user-21');
        let account = await createNewAccount('account-user-21', toNano('15'));
        let user = await blockchain.treasury('user-41');

        await submitQuestion(user, account.address, toNano('200'));
        let questionContractAddr = await account.getQuestionAccAddr(0);

        let appOwnerBalanceBeforeWithdraw = await deployer.getBalance();
        await replyToQuestion(accountOwner, questionContractAddr, 'default reply', toNano(0.1));
        await deployer.send({
            to: root.address,
            value: toNano(0.01),
            body: beginCell().storeUint(BigInt('0xa17c9cd6'), 32).storeUint(123, 64).endCell(),
        });

        let appOwnerBalance = await deployer.getBalance();

        //0.05 - initial root account balance, TON_STEP - min root balance
        //TODO: 0.1 is taken from reply, this should not be the case
        expect(toTon(appOwnerBalance - appOwnerBalanceBeforeWithdraw)).toBeCloseTo(
            (15 * 5) / 100 + (INITIAL_ROOT_BALANCE - MIN_ROOT_BALANCE),
            1,
        );
    });

    it('submit multiple questions from one account. counterpart user account does not exist', async () => {
        let account1 = await createNewAccount('account-owner-11', toNano('15'));
        let account2 = await createNewAccount('account-owner-12', toNano('15'));

        let account1User = await blockchain.treasury('account-owner-11');
        let account2User = await blockchain.treasury('account-owner-12');

        let user = await blockchain.treasury('user-e-1');

        for (let i = 0; i < 5; i++) {
            await submitQuestion(user, account1.address, toNano('20'), `question 1 ${i}`);
        }
        for (let i = 0; i < 5; i++) {
            await submitQuestion(user, account2.address, toNano('20'), `question 2 ${i}`);
        }

        let userAccount = await root.getAccount(user.address);
        expect(await userAccount.getNextSubmittedQuestionId()).toBe(10n);

        for (let i = 0; i < 5; i++) {
            let question = await (await userAccount.getQuestionRef(i)).getQuestion();
            expect((await question.getAllData()).isClosed).toBe(false);
            expect((await question.getAllData()).isRejected).toBe(false);
            expect((await question.getAllData()).content).toBe(`question 1 ${i}`);
            expect((await question.getAllData()).submitterAddr.toRawString()).toBe(user.address.toRawString());
            expect((await question.getAllData()).ownerAddr.toRawString()).toBe(account1User.address.toRawString());
        }
        for (let i = 5; i < 10; i++) {
            let question = await (await userAccount.getQuestionRef(i)).getQuestion();
            expect((await question.getAllData()).isClosed).toBe(false);
            expect((await question.getAllData()).isRejected).toBe(false);
            expect((await question.getAllData()).content).toBe(`question 2 ${i - 5}`);
            expect((await question.getAllData()).submitterAddr.toRawString()).toBe(user.address.toRawString());
            expect((await question.getAllData()).ownerAddr.toRawString()).toBe(account2User.address.toRawString());
        }
    });

    it('it should be cheap to submit question to zero-priced account - 0.06 TON', async () => {
        let account = await createNewAccount('test-account-owner', 0n);
        let accountUser = await blockchain.treasury('test-account-owner');
        let user = await blockchain.treasury('t-user-1');
        let transactionValue = 0.06; //MIN_ACCOUNT_BALANCE + MIN_QUESTION_BALANCE + 0.01
        await submitQuestion(user, account.address, toNano(transactionValue));
        let questionContract = await account.getQuestion(0);
        let questionContractBalance = (await blockchain.getContract(questionContract.address)).balance;

        expect((await questionContract.getAllData()).isClosed).toBe(false);
        expect(toTon(questionContractBalance)).toBeCloseTo(MIN_QUESTION_BALANCE);
    });

    it.each([
        ['create account explicitly', createNewAccount],
        ['create account via q submit', createNewAccountViaQuestionSubmit],
    ])('long running test. %s', async (text, createAccountF) => {
        let initialBalance = await getRootBalance();
        let accounts = 3;
        let questionsPerAccount = 11;
        let amount = 120;
        for (let i = 0; i < accounts; i++) {
            let accountUsername = `account-${i}`;
            let accountOwnerUser = await blockchain.treasury(accountUsername);
            let accountContract = await createAccountF(accountUsername, toNano('100'));

            for (let j = 0; j < questionsPerAccount; j++) {
                let userName = `user-${i}-${j}`;
                let user = await blockchain.treasury(userName, { balance: toNano('200') });
                await submitQuestion(user, accountContract.address, toNano(amount));
                let questionAddr = await accountContract.getQuestionAccAddr(j);
                await replyToQuestion(accountOwnerUser, questionAddr, 'default reply', toNano(0.01));
            }
        }

        let actualAppOwnerBalance = await getRootBalance();

        //TODO: Why -INITIAL_ROOT_BALANCE
        expect(toTon(actualAppOwnerBalance - initialBalance) - INITIAL_ROOT_BALANCE).toBeCloseTo(
            accounts * questionsPerAccount * 100 * (5 / 100),
            0,
        );
    });

    it('many questions to one account', async () => {
        let initialBalance = await getRootBalance();
        let questionsPerAccount = 23;
        let amount = 100;
        let accountUsername = `account-i-11`;
        let accountOwnerUser = await blockchain.treasury(accountUsername);
        let accountContract = await createNewAccount(accountUsername, toNano('100'));

        for (let j = 0; j < questionsPerAccount; j++) {
            let userName = `user-i-1-${j}`;
            let user = await blockchain.treasury(userName, { balance: toNano('2000') });
            await submitQuestion(user, accountContract.address, toNano(110));
            let questionAddr = await accountContract.getQuestionAccAddr(j);
            await replyToQuestion(accountOwnerUser, questionAddr, 'default reply', toNano(0.01));
        }

        let accountFullData = await accountContract.getAllData();
        expect(accountFullData.assignedQuestionsCount).toBe(questionsPerAccount);
        expect(accountFullData.submittedQuestionsCount).toBe(0);

        for (let j = 0; j < questionsPerAccount; j++) {
            let userName = `user-i-1-${j}`;
            let user = await blockchain.treasury(userName, { balance: toNano('2000') });
            let account = await root.getAccount(user.address);
            let fullData = await account.getAllData();
            expect(fullData.submittedQuestionsCount).toBe(1);
            expect(fullData.assignedQuestionsCount).toBe(0);
        }

        let actualAppOwnerBalance = await getRootBalance();
        let accountContractBalance = (await blockchain.getContract(accountContract.address)).balance;
        expect(toTon(accountContractBalance)).toBeCloseTo(MIN_ACCOUNT_BALANCE, 1);
        //TODO: why - INITIAL_ROOT_BALANCE
        expect(toTon(actualAppOwnerBalance - initialBalance) - INITIAL_ROOT_BALANCE).toBeCloseTo(
            questionsPerAccount * amount * (5 / 100),
            0,
        );
    });

    it('account storage fee should be around 0.026 TON/year', async () => {
        const time1 = Math.floor(Date.now() / 1000);
        const time2 = time1 + 365 * 24 * 60 * 60;

        blockchain.now = time1;
        let account = await createNewAccount('my-test-user');
        blockchain.now = time2;
        let otherUser = await blockchain.treasury('other-user');

        let res = await blockchain.sendMessage(
            internal({
                from: otherUser.address,
                to: account.address,
                value: toNano(0.03),
            }),
        );
        // @ts-ignore
        expect(toTon(res.transactions[0].description.storagePhase?.storageFeesCollected)).toBeCloseTo(0.026);
    });

    it('question storage fee during one year should be around 0.002 TON', async () => {
        // let blockchain = await Blockchain.create();
        const time1 = Math.floor(Date.now() / 1000);
        const time2 = time1 + 365 * 24 * 60 * 60;

        blockchain.now = time1;
        const accountOwner = await blockchain.treasury('test-account-owner');
        const accountContract = await createNewAccount('test-account-owner', toNano(20));

        const user = await blockchain.treasury('test-user');
        await submitQuestion(user, accountContract.address, toNano(22), randomBytes(280).toString('hex'));
        let questionContractAddr = (await accountContract.getQuestion(0)).address;
        blockchain.now = time2;

        let res = await replyToQuestion(accountOwner, questionContractAddr);
        // @ts-ignore
        expect(toTon(res.transactions[0].description.storagePhase?.storageFeesCollected)).toBeCloseTo(0.002);
    });

    it('account could exist for a long time if receives question every 6 months', async () => {
        const time1 = Math.floor(Date.now() / 1000);
        const delta = 0.5 * 365 * 24 * 60 * 60;

        blockchain.now = time1;
        const accountContract = await createNewAccount('test-account-owner', toNano(20));

        for (let i = 1; i <= 60; i++) {
            blockchain.now = time1 + i * delta;
            const user = await blockchain.treasury(`test-user-${i}`);

            await submitQuestion(user, accountContract.address, toNano(21.1), randomBytes(280).toString('hex'));
            let question = await accountContract.getQuestion(i - 1);
            expect(toTon((await blockchain.getContract(question.address)).balance)).toBeCloseTo(21, 0);
        }
        let balance = (await blockchain.getContract(accountContract.address)).balance;
        let status = (await blockchain.getContract(accountContract.address)).accountState?.type;

        expect(status).toBe('active');
        expect(toTon(balance)).toBeCloseTo(MIN_ACCOUNT_BALANCE, 1);
        expect(await accountContract.getNextId()).toBe(60n);
    });

    //TODO: Tests to add:
    // - more test cases for zero-priced account
    // - estimate processing fee for various transactions
});
