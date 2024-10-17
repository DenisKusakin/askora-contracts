import {
    Blockchain,
    internal,
    printTransactionFees,
    SandboxContract,
    SmartContract,
    TreasuryContract,
} from '@ton/sandbox';
import { Address, beginCell, Cell, fromNano, toNano, TupleBuilder } from '@ton/core';
import { Paynquiry } from '../wrappers/Paynquiry';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { Account } from '../wrappers/Account';
import { Question } from '../wrappers/Question';
import { randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';

const TON_STEP = 0.01;
const MIN_QUESTION_BALANCE = 1 * TON_STEP;
const MIN_ACCOUNT_BALANCE = 3 * TON_STEP;
const MIN_ROOT_BALANCE = 1 * TON_STEP;

describe('Paynquiry', () => {
    let rootCode: Cell;
    let accountCode: Cell;
    let questionCode: Cell;
    let questionRefCode: Cell;

    beforeAll(async () => {
        rootCode = await compile('Paynquiry');
        accountCode = await compile('account');
        questionCode = await compile('question');
        questionRefCode = await compile('question-ref');
    });

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let paynquiry: SandboxContract<Paynquiry>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();

        // blockchain.verbosity = {
        //     blockchainLogs: true,
        //     vmLogs: 'vm_logs_full',
        //     debugLogs: true,
        //     print: true
        // }

        deployer = await blockchain.treasury('deployer', { balance: toNano('10') });

        paynquiry = blockchain.openContract(
            Paynquiry.createFromConfig(
                {
                    accountCode,
                    questionCode,
                    questionRefCode,
                },
                rootCode,
            ),
        );

        const deployResult = await paynquiry.sendDeploy(deployer.getSender(), toNano('0.5'));
        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: paynquiry.address,
            deploy: true,
            success: true,
        });
    });

    it('should deploy root contract', async () => {
        // the check is done inside beforeEach
        // blockchain and paynquiry are ready to use
        let c: SmartContract = await blockchain.getContract(paynquiry.address);
        expect(parseFloat(fromNano(c.balance))).toBeCloseTo(0.5);
    });

    async function createNewAccount(username: string | undefined = undefined, price: bigint = toNano('10')) {
        let user = await blockchain.treasury(username || 'user-1');
        let op = BigInt("0x5f0ec1a3");
        let queryId = 1234;

        let res = await blockchain.sendMessage(
            internal({
                from: user.address,
                to: paynquiry.address,
                value: toNano('1'),
                body: beginCell().storeUint(op, 32).storeUint(queryId, 64).storeCoins(price).endCell(),
            }),
        );
        let accountAddrReceived = await paynquiry.getAccountAddress(user.getSender().address);
        let accountContract = await blockchain.openContract(Account.createFromAddress(accountAddrReceived));

        return accountContract;
    }

    async function createNewAccount2(
        blockchain: Blockchain,
        paynquiry: SandboxContract<Paynquiry>,
        sender: SandboxContract<TreasuryContract>,
        price: bigint = toNano('10'),
    ) {
        let op = BigInt("0x5f0ec1a3");
        let queryId = 1234;

        sender.send({
            to: paynquiry.address,
            value: toNano('1'),
            body: beginCell().storeUint(op, 32).storeUint(queryId, 64).storeCoins(price).endCell(),
        });

        let accountAddrReceived = await paynquiry.getAccountAddress(sender.address);
        let accountContract = blockchain.openContract(Account.createFromAddress(accountAddrReceived));

        return accountContract;
    }

    it('should deploy account', async () => {
        let user = await blockchain.treasury('user-1');

        let op = BigInt("0x5f0ec1a3");
        let queryId = 1234;
        await blockchain.sendMessage(
            internal({
                from: user.getSender().address,
                to: paynquiry.address,
                value: toNano('1.5'),
                body: beginCell().storeUint(op, 32).storeUint(queryId, 64).storeCoins(toNano('10')).endCell(),
            }),
        );
        let accountAddrReceived = await paynquiry.getAccountAddress(user.getSender().address);
        let accountContract = await blockchain.getContract(accountAddrReceived);

        let actualFullData = await blockchain.openContract(Account.createFromAddress(accountAddrReceived)).getAllData()
        let actualFullData2 = {
            owner: actualFullData.owner.toRawString(),
            minPrice: actualFullData.minPrice,
            assignedQuestionsCount: actualFullData.assignedQuestionsCount,
            submittedQuestionsCount: actualFullData.submittedQuestionsCount
        }
        let expectedFullData = {
            owner: user.address.toRawString(),
            minPrice: toNano(10),
            assignedQuestionsCount: 0,
            submittedQuestionsCount: 0
        }

        expect(toTon(accountContract.balance)).toBeCloseTo(MIN_ACCOUNT_BALANCE, 1);
        expect(await getAccountPrice(accountContract)).toBe(toNano('10'));
    });

    async function getAccountPrice(account: SmartContract) {
        let getRes = (await account.get('get_price')).stackReader;
        let price = getRes.readBigNumber();

        return price;
    }

    async function getQuestionAddrFromRef(questionRef: SmartContract) {
        let getRes = (await questionRef.get('get_question_addr')).stackReader;
        return getRes.readAddress();
    }

    it('should create question', async () => {
        let time = Math.floor(Date.now() / 1000);
        blockchain.now = time;

        let account = await createNewAccount();

        expect(await account.getNextId()).toBe(0n);
        let user = await blockchain.treasury('user-2');
        await blockchain.sendMessage(
            internal({
                from: user.address,
                to: account.address,
                value: toNano('10.6'),
                body: beginCell()
                    .storeUint(BigInt("0x28b1e47a"), 32)
                    .storeRef(beginCell().storeStringTail('test content').endCell())
                    .endCell(),
            }),
        );

        let submitterAccountAddr = await paynquiry.getAccountAddress(user.address);
        let submitterAccountContract = blockchain.openContract(Account.createFromAddress(submitterAccountAddr));

        expect(await account.getNextId()).toBe(1n);
        expect(await submitterAccountContract.getNextSubmittedQuestionId()).toBe(1n);

        let questionContractAddr = await account.getQuestionAccAddr(0);
        let questionRefAddr = await submitterAccountContract.getQuestionRefAddress(0);
        let questionRefContract = await blockchain.getContract(questionRefAddr);
        let questionContractAddrFromSubmitterAccount = await getQuestionAddrFromRef(questionRefContract);

        expect(questionContractAddr.toRawString()).toBe(questionContractAddrFromSubmitterAccount.toRawString());

        let questionContract = await account.getQuestion(0);
        expect(await questionContract.getContent()).toBe('test content');
        expect(await questionContract.getIsClosed()).toBe(false);
        expect(toTon((await blockchain.getContract(questionContract.address)).balance)).toBeCloseTo(10.5, 0);

        let actualQuestionFullData = await questionContract.getAllData();
        let actualQuestionFullData2 = {
            isClosed: actualQuestionFullData.isClosed,
            isRejected: actualQuestionFullData.isRejected,
            content: actualQuestionFullData.content,
            replyContent: actualQuestionFullData.replyContent,
            submitterAddr: actualQuestionFullData.submitterAddr.toRawString(),
            accountAddr: actualQuestionFullData.accountAddr.toRawString(),
        };
        let expectedQuestionFullData = {
            isClosed: false,
            isRejected: false,
            content: 'test content',
            replyContent: '',
            submitterAddr: user.address.toRawString(),
            accountAddr: account.address.toRawString(),
        };

        expect(actualQuestionFullData2).toStrictEqual(expectedQuestionFullData);
        expect(parseFloat(fromNano(actualQuestionFullData.balance))).toBeCloseTo(10.5, 0);
        expect(actualQuestionFullData.createdAt).toBe(time)
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
                    .storeUint(BigInt("0x28b1e47a"), 32)
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
        await sender.send({
            to: accountAddr,
            value: amount,
            body: beginCell().storeUint(BigInt("0x28b1e47a"), 32).storeRef(beginCell().storeStringTail(content).endCell()).endCell(),
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
            body: beginCell().storeUint(BigInt("0xfda8c6e0"), 32).storeRef(beginCell().storeStringTail(replyContent).endCell()).endCell(),
        });
    }

    async function withdraw(sender: SandboxContract<TreasuryContract>, appContractAddr: Address = paynquiry.address) {
        return await sender.send({
            to: appContractAddr,
            value: toNano('0.3'),
            body: beginCell().storeUint(BigInt("0xa17c9cd6"), 32).storeUint(123, 64).endCell(),
        });
    }

    async function rejectQuestion(sender: SandboxContract<TreasuryContract>, questionAddr: Address) {
        let res = await sender.send({
            to: questionAddr,
            value: toNano('0.8'),
            body: beginCell().storeUint(BigInt("0xa5c566b9"), 32).endCell(),
        });
    }

    it('should close question on reply', async () => {
        let account = await createNewAccount('account-user');
        let user = await blockchain.treasury('user-3');

        await submitQuestion(user, account.address, toNano('11.6'));

        let questionContractAddr = await account.getQuestionAccAddr(0);
        let questionContract = await account.getQuestion(0);

        expect(await questionContract.getIsClosed()).toBeFalsy();

        let accountOwner = await blockchain.treasury('account-user');
        await replyToQuestion(accountOwner, questionContractAddr, 'reply content 1');
        expect(await questionContract.getIsClosed()).toBeTruthy();
        expect(await questionContract.getReplyContent()).toBe('reply content 1');
    });

    it('anyone could cancel the question after expiration', async () => {
        let time1 = Math.floor(Date.now() / 1000);
        let time2 = time1 + 8 * 24 * 60 * 60; //8 days

        blockchain.now = time1;

        let account = await createNewAccount('account-user-111');
        let user = await blockchain.treasury('user-321', {balance: toNano(15)});

        await submitQuestion(user, account.address, toNano('10.5'));

        let questionContractAddr = await account.getQuestionAccAddr(0);
        let questionContract = await account.getQuestion(0);

        expect(await questionContract.getIsClosed()).toBeFalsy();
        expect(toTon(await user.getBalance())).toBeCloseTo(15 - 10.5);

        let otherUser = await blockchain.treasury('other-user-3211');
        blockchain.now = time2;
        await otherUser.send({
            to: questionContractAddr,
            value: toNano(0.01),
            body: beginCell()
                .storeUint(BigInt("0x5616c572"), 32)
                .endCell()
        })
        expect(toTon(await user.getBalance())).toBeCloseTo(15 - MIN_QUESTION_BALANCE, 1);
    });

    it('should not be able to cancel the question before expiration', async () => {
        let time1 = Math.floor(Date.now() / 1000);
        let time2 = time1 + 6 * 24 * 60 * 60; //6 days

        blockchain.now = time1;

        let account = await createNewAccount('account-user-111');
        let user = await blockchain.treasury('user-322', {balance: toNano(15)});

        await submitQuestion(user, account.address, toNano('10.5'));

        let questionContractAddr = await account.getQuestionAccAddr(0);
        let questionContract = await account.getQuestion(0);

        expect(await questionContract.getIsClosed()).toBeFalsy();
        expect(toTon(await user.getBalance())).toBeCloseTo(15 - 10.5);

        let otherUser = await blockchain.treasury('other-user-3212');
        blockchain.now = time2;
        let res = await otherUser.send({
            to: questionContractAddr,
            value: toNano(0.01),
            body: beginCell()
                .storeUint(BigInt("0x5616c572"), 32)
                .endCell()
        })
        expect(res.transactions).toHaveTransaction({
            from: otherUser.address,
            to: questionContractAddr,
            success: false
        })
        expect(toTon(await user.getBalance())).toBeCloseTo(15 - 10.5, 1);
    });

    it('user should be able to change the price', async () => {
        let account = await createNewAccount('account-user', toNano('10'));
        let accountUser = await blockchain.treasury('account-user')

        expect(await account.getPrice()).toBe(toNano(10))
        let res = await accountUser.send({
            to: account.address,
            value: toNano(0.01),
            body: beginCell()
                .storeUint(BigInt("0xaaacc05b"), 32)
                .storeCoins(toNano(15))
                .endCell()
        })
        expect(await account.getPrice()).toBe(toNano(15))
    });

    async function getRootBalance() {
        return (await blockchain.getContract(paynquiry.address)).balance;
    }

    function toTon(amount: bigint) {
        return parseFloat(fromNano(amount));
    }

    it('should send reward and service fee on reply', async () => {
        let accountOwner = await blockchain.treasury('account-user-2');
        let account = await createNewAccount('account-user-2', toNano('15'));
        let accountOwnerBalanceBefore = await accountOwner.getBalance();
        let rootBalanceBefore = await getRootBalance();
        let user = await blockchain.treasury('user-4');

        //in addition to question price, user should also pay for a new account + question
        await submitQuestion(user, account.address, toNano(20 + MIN_ACCOUNT_BALANCE + MIN_QUESTION_BALANCE));

        let questionContract = await account.getQuestion(0);
        let replyRes = await replyToQuestion(accountOwner, questionContract.address, 'reply', toNano('0.01'));

        let accountBalanceAfter = await accountOwner.getBalance();
        let expectedServiceFee = 1; //5%
        let ownerBalanceDiff = toTon(accountBalanceAfter - accountOwnerBalanceBefore);
        let rootBalanceDiff = toTon((await getRootBalance()) - rootBalanceBefore);

        let accountContractBalance = (await blockchain.getContract(account.address)).balance;
        let questionContractBalance = (await blockchain.getContract(questionContract.address)).balance;

        expect(toTon(accountContractBalance)).toBeCloseTo(MIN_ACCOUNT_BALANCE, 1);
        expect(toTon(questionContractBalance)).toBeCloseTo(MIN_QUESTION_BALANCE);
        expect(rootBalanceDiff).toBeCloseTo(expectedServiceFee, 1);
        expect(ownerBalanceDiff).toBeCloseTo(20 - expectedServiceFee, 1);
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
        await rejectQuestion(accountOwner, questionContractAddr);

        expect(await questionContract.getIsRejected()).toBeTruthy();
        expect(await questionContract.getIsClosed()).toBeTruthy();

        let accountOwnerBalanceAfter = (await blockchain.getContract(accountOwner.address)).balance;
        let userBalanceAfter = await user.getBalance();
        let ownerBalanceDiff = parseFloat(fromNano(accountOwnerBalanceAfter - accountOwnerBalanceBefore));

        //only transaction fees will be deducted
        expect(ownerBalanceDiff).toBeLessThan(0);
        expect(ownerBalanceDiff).toBeCloseTo(0);

        expect(toTon((await blockchain.getContract(questionContractAddr)).balance)).toBeCloseTo(MIN_QUESTION_BALANCE);
        //user should pay for his new account + question + fw_fee
        expect(toTon(userBalanceAfter - userBalanceBefore)).toBeCloseTo(
            -(MIN_ACCOUNT_BALANCE + MIN_QUESTION_BALANCE + TON_STEP),
        );
    });

    it('submit-reply-withdraw flow', async () => {
        let accountOwner = await blockchain.treasury('account-user-21');
        let account = await createNewAccount('account-user-21', toNano('15'));
        let user = await blockchain.treasury('user-41');

        await submitQuestion(user, account.address, toNano('200'));
        let questionContractAddr = await account.getQuestionAccAddr(0);

        await replyToQuestion(accountOwner, questionContractAddr);
        let appOwnerBalanceBeforeWithdraw = await deployer.getBalance();
        await withdraw(deployer);

        let appOwnerBalance = await deployer.getBalance();
        let appBalance = await getRootBalance();

        //0.5 - initial balance of root
        expect(toTon(appOwnerBalance - appOwnerBalanceBeforeWithdraw)).toBeCloseTo(10 + (0.5 - MIN_ROOT_BALANCE), 1); //10=200*5/100
        expect(toTon(appBalance)).toBeCloseTo(MIN_ROOT_BALANCE);
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

        let userAccount = await paynquiry.getAccount(user.address);
        expect(await userAccount.getNextSubmittedQuestionId()).toBe(10n);

        for (let i = 0; i < 5; i++) {
            let question = await (await userAccount.getQuestionRef(i)).getQuestion();
            expect(await question.getIsClosed()).toBe(false);
            expect(await question.getIsRejected()).toBe(false);
            expect(await question.getContent()).toBe(`question 1 ${i}`);
            expect((await question.getSubmitterAddr()).toRawString()).toBe(user.address.toRawString());
            expect((await question.getOwnerAddr()).toRawString()).toBe(account1User.address.toRawString());
        }
        for (let i = 5; i < 10; i++) {
            let question = await (await userAccount.getQuestionRef(i)).getQuestion();
            expect(await question.getIsClosed()).toBe(false);
            expect(await question.getIsRejected()).toBe(false);
            expect(await question.getContent()).toBe(`question 2 ${i - 5}`);
            expect((await question.getSubmitterAddr()).toRawString()).toBe(user.address.toRawString());
            expect((await question.getOwnerAddr()).toRawString()).toBe(account2User.address.toRawString());
        }
    });

    it('it should be cheap to submit question to zero-priced account - 0.05 TON', async () => {
        let account = await createNewAccount('test-account-owner', 0n);
        let accountUser = await blockchain.treasury('test-account-owner');
        let user = await blockchain.treasury('t-user-1');
        let transactionValue = 0.05; //MIN_ACCOUNT_BALANCE + MIN_QUESTION_BALANCE + 0.01
        await submitQuestion(user, account.address, toNano(transactionValue))
        let questionContract = await account.getQuestion(0)
        let questionContractBalance = (await blockchain.getContract(questionContract.address)).balance

        expect(await questionContract.getIsClosed()).toBe(false)
        expect(toTon(questionContractBalance)).toBeCloseTo(MIN_QUESTION_BALANCE)
    })

    it('long running test', async () => {
        let blockchain = await Blockchain.create();
        let appOwnerUser = await blockchain.treasury('app-owner', { balance: toNano('50') });
        let appContract = blockchain.openContract(
            Paynquiry.createFromConfig(
                {
                    accountCode,
                    questionCode,
                    questionRefCode,
                },
                rootCode,
            ),
        );
        await appContract.sendDeploy(appOwnerUser.getSender(), toNano('0.5'));
        let accounts = 3;
        let questionsPerAccount = 11;
        let amount = 120;
        for (let i = 0; i < accounts; i++) {
            let accountUsername = `account-${i}`;
            let accountOwnerUser = await blockchain.treasury(accountUsername);
            let accountContract = await createNewAccount2(blockchain, appContract, accountOwnerUser, toNano('100'));

            for (let j = 0; j < questionsPerAccount; j++) {
                let userName = `user-${i}-${j}`;
                let user = await blockchain.treasury(userName, { balance: toNano('200') });
                await submitQuestion(user, accountContract.address, toNano(amount));
                let questionAddr = await accountContract.getQuestionAccAddr(j);
                await replyToQuestion(accountOwnerUser, questionAddr, "default reply", toNano(0.01));
            }
        }

        await withdraw(appOwnerUser, appContract.address);
        let actualAppOwnerBalance = await appOwnerUser.getBalance();

        expect(toTon(actualAppOwnerBalance) - 50 - MIN_ROOT_BALANCE).toBeCloseTo(
            accounts * questionsPerAccount * amount * (5 / 100),
            0,
        );
    });

    it('many questions to one account', async () => {
        let blockchain = await Blockchain.create();
        let appOwnerUser = await blockchain.treasury('app-owner', { balance: toNano('50') });
        let appContract = blockchain.openContract(
            Paynquiry.createFromConfig(
                {
                    accountCode,
                    questionCode,
                    questionRefCode,
                },
                rootCode,
            ),
        );
        await appContract.sendDeploy(appOwnerUser.getSender(), toNano('0.5'));
        let questionsPerAccount = 23;
        let amount = 100;
        let accountUsername = `account-i-11`;
        let accountOwnerUser = await blockchain.treasury(accountUsername);
        let accountContract = await createNewAccount2(blockchain, appContract, accountOwnerUser, toNano('100'));

        for (let j = 0; j < questionsPerAccount; j++) {
            let userName = `user-i-1-${j}`;
            let user = await blockchain.treasury(userName, { balance: toNano('2000') });
            await submitQuestion(user, accountContract.address, toNano(amount + 0.1));
            let questionAddr = await accountContract.getQuestionAccAddr(j);
            await replyToQuestion(accountOwnerUser, questionAddr, "default reply", toNano(0.01));
        }

        let accountFullData = await accountContract.getAllData();
        expect(accountFullData.assignedQuestionsCount).toBe(questionsPerAccount);
        expect(accountFullData.submittedQuestionsCount).toBe(0);

        for (let j = 0; j < questionsPerAccount; j++) {
            let userName = `user-i-1-${j}`;
            let user = await blockchain.treasury(userName, { balance: toNano('2000') });
            let account = await appContract.getAccount(user.address)
            let fullData = await account.getAllData()
            expect(fullData.submittedQuestionsCount).toBe(1);
            expect(fullData.assignedQuestionsCount).toBe(0);
        }

        await withdraw(appOwnerUser, appContract.address);
        let actualAppOwnerBalance = await appOwnerUser.getBalance();
        expect(toTon(actualAppOwnerBalance) - 50 - MIN_ROOT_BALANCE).toBeCloseTo(
            questionsPerAccount * amount * (5 / 100),
            0,
        );
    });

    it('account storage fee should be around 0.03 TON/year', async () => {
        let blockchain = await Blockchain.create();
        const time1 = Math.floor(Date.now() / 1000);
        const time2 = time1 + 365 * 24 * 60 * 60;

        blockchain.now = time1;
        let appOwnerUser = await blockchain.treasury('app-owner-2', { balance: toNano('50') });
        let appContract = blockchain.openContract(
            Paynquiry.createFromConfig(
                {
                    accountCode,
                    questionCode,
                    questionRefCode,
                },
                rootCode,
            ),
        );
        await appContract.sendDeploy(appOwnerUser.getSender(), toNano('0.5'));
        blockchain.now = time2;

        let res = await blockchain.sendMessage(
            internal({
                from: appOwnerUser.address,
                to: appContract.address,
                value: toNano('0.05'),
            }),
        );
        // @ts-ignore
        expect(toTon(res.transactions[0].description.storagePhase?.storageFeesCollected)).toBeCloseTo(0.03);
    });

    it('question storage fee during one year should be around 0.03 TON', async () => {
        let blockchain = await Blockchain.create();
        const time1 = Math.floor(Date.now() / 1000);
        const time2 = time1 + 365 * 24 * 60 * 60;

        let appOwnerUser = await blockchain.treasury('app-owner-21', { balance: toNano('50') });
        let appContract = blockchain.openContract(
            Paynquiry.createFromConfig(
                {
                    accountCode,
                    questionCode,
                    questionRefCode,
                },
                rootCode,
            ),
        );

        blockchain.now = time1;
        await appContract.sendDeploy(appOwnerUser.getSender(), toNano('0.5'));
        const accountOwner = await blockchain.treasury('test-account-owner');
        const accountContract = await createNewAccount2(blockchain, appContract, accountOwner, toNano(20));

        const user = await blockchain.treasury('test-user');
        await submitQuestion(user, accountContract.address, toNano(22), randomBytes(280).toString('hex'));
        let questionContractAddr = (await accountContract.getQuestion(0)).address;
        blockchain.now = time2;

        let res = await replyToQuestion(accountOwner, questionContractAddr);
        // @ts-ignore
        expect(toTon(res.transactions[0].description.storagePhase?.storageFeesCollected)).toBeCloseTo(0.002);
    });
});
