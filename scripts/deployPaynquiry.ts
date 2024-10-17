import { toNano } from '@ton/core';
import { Paynquiry } from '../wrappers/Paynquiry';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    let rootCode = await compile('Paynquiry');
    let accountCode = await compile('account');
    let questionCode = await compile('question');
    let questionRefCode = await compile('question-ref');

    const paynquiry = provider.open(Paynquiry.createFromConfig({
            accountCode,
            questionCode,
            questionRefCode
        },
        rootCode));

    await paynquiry.sendDeploy(provider.sender(), toNano('0.6'));

    await provider.waitForDeploy(paynquiry.address);

    // run methods on `paynquiry`
}
